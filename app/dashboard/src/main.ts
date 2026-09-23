// AgentPassport dashboard. Everything on the page comes from Monad testnet over public RPC (through
// @agentfromzero/agentpassport-sdk) or from the published Envio index snapshot. The only write path
// is the hire flow, signed by the visitor's own injected wallet (EIP-6963 / window.ethereum), and
// it always goes to JobEscrow v2 (MONAD_TESTNET). JobEscrow v1 is read for its closed history jobs.
import {
  type Address,
  type EIP1193Provider,
  type Hex,
  type WalletClient,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  formatEther,
  http,
  parseEventLogs,
} from "viem";
import {
  AgentPassportClient,
  AGENTFROMZERO_AGENT_ID,
  JobStatus,
  MONAD_TESTNET as D,
  MONAD_TESTNET_V1 as D_V1,
  POLICIES,
  type Deployment,
  type IndexSnapshot,
  type IndexedAgent,
  type Job,
  type Policy,
  type Scorecard,
  agentPassportAbi,
  fetchIndexSnapshot,
  formatUsdc,
  hashContent,
  jobEscrowAbi,
  jobStatusName,
  monadTestnet,
  parseUsdc,
  toPolicy,
  usdcAbi,
} from "@agentfromzero/agentpassport-sdk";
import presets from "./presets.json";

const EXPLORER = "https://testnet.monadvision.com";
const API = "https://agentfromzero.netlify.app";
const SNAPSHOT_URLS = [`${API}/agentpassport/index.json`, "/index-snapshot.json"];
const DYNAMIC_VERIFIER = "0xf02Aa56969f5C71D77d89eb85D962E72A01B3b11";
const AGENT = AGENTFROMZERO_AGENT_ID;
const CHAIN_HEX = "0x279f"; // 10143
const TICK_MS = 2500;
const BACKFILL_BLOCKS = 3000n; // ~20 min of Monad blocks, walked 6 windows per tick
const SECURITY_DOC = "https://github.com/agent-from-zero/agentpassport/blob/main/docs/SECURITY.md";
// What a hire from this page commits to. JobEscrow v2 rejects reviewWindow > 30 days
// (BadReviewWindow) and an endpoint label over 256 bytes (EndpointTooLong).
const HIRE_ENDPOINT = "scorecard";
const HIRE_REVIEW_WINDOW = 3600n;
const MAX_REVIEW_WINDOW = 30n * 86400n;
const MAX_ENDPOINT_BYTES = 256;

const POLICY_SETS: Record<string, { label: string; policy: Policy }> = {
  proven: { label: "proven", policy: POLICIES.proven },
  active: { label: "active", policy: POLICIES.active },
  track: { label: "track record", policy: toPolicy({ minJobsSettled: 3, minVolumeSettled: 1_000_000, maxJobsDisputed: 0 }) },
};

// ───────────────────────────── clients ─────────────────────────────

const publicClient = createPublicClient({
  chain: monadTestnet,
  // Public Monad RPCs allow ~15 req/s: batch concurrent reads into one Multicall3 call, retry politely.
  transport: http(undefined, { retryCount: 4, retryDelay: 500 }),
  batch: { multicall: { wait: 25 } },
  pollingInterval: 1000,
});
const ap = new AgentPassportClient({ publicClient }); // JobEscrow v2: every new job, the hire flow

// Two escrows share one AgentPassport. v2 (current) replaced v1 after the security review; v1 holds
// the first jobs (the ones in the demo video), all closed. Job ids restart at 1 on each escrow, so a
// job is always keyed and labelled by escrow: "v2 #1", "v1 #5".
type Ver = "v1" | "v2";
interface Escrow { ver: Ver; label: string; d: Deployment; client: AgentPassportClient }
const ESCROWS: Record<Ver, Escrow> = {
  v2: { ver: "v2", label: "JobEscrow v2", d: D, client: ap },
  v1: { ver: "v1", label: "JobEscrow v1", d: D_V1, client: new AgentPassportClient({ publicClient, deployment: D_V1 }) },
};
const ESCROW_LIST = [ESCROWS.v2, ESCROWS.v1];
const escrowAt = (a?: string | null) => ESCROW_LIST.find((e) => !!a && e.d.jobEscrow.toLowerCase() === a.toLowerCase());
const jobKey = (ver: Ver, id: bigint | string) => `${ver}:${id}`;

// ───────────────────────────── state ─────────────────────────────

interface TxInfo {
  openTx?: Hex;
  acceptTx?: Hex;
  deliverTx?: Hex;
  closeTx?: Hex;
  closedBy?: string;
  deliverableURI?: string;
  deliverableHash?: Hex;
  openedAt?: number; // unix seconds
}
/** acceptedAt: unix seconds, 0n = not accepted yet, null on v1 (no acceptance step). */
type Row = Job & { jobId: bigint; ver: Ver; acceptedAt: bigint | null };
interface RecentJob { jobId: string; escrow?: string; hirer_id?: string; amount?: string; openTx?: Hex; deliverTx?: Hex; closeTx?: Hex; releasedBy?: string; deliverableURI?: string; openedAt?: string }
type Snapshot = IndexSnapshot & { recentJobs?: RecentJob[] };

let snapshot: Snapshot | null = null;
const txInfo = new Map<string, TxInfo>();
const jobs = new Map<string, Row>();
const seenJobs = new Set<string>();
let head = 0n;
let tailed = 0n; // last block whose escrow events were read
let firstJobsRender = true;

interface WalletState { provider: EIP1193Provider; name: string; address: Address; client: WalletClient; writer: AgentPassportClient; mon: bigint; usdc: bigint; allowance: bigint; chainOk: boolean }
let wallet: WalletState | null = null;
const discovered: Array<{ name: string; provider: EIP1193Provider }> = [];
let hireBusy = false;

// ───────────────────────────── helpers ─────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const short = (a?: string | null, n = 4) => (a ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : "—");
const txLink = (h?: string, label?: string) => (h ? `<a href="${EXPLORER}/tx/${h}" target="_blank" rel="noopener" title="${h}">${esc(label ?? short(h))}</a>` : "");
const addrLink = (a?: string | null, label?: string) => (a ? `<a class="mono" href="${EXPLORER}/address/${a}" target="_blank" rel="noopener" title="${a}">${esc(label ?? short(a))}</a>` : "—");
const usdc = (v: bigint | string) => Number(formatUsdc(BigInt(v))).toLocaleString("en-US", { maximumFractionDigits: 3 });
const isHttp = (u?: string | null) => !!u && /^https?:\/\//.test(u);
const when = (unix?: number) => {
  if (!unix) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return new Date(unix * 1000).toISOString().slice(0, 10);
};
const utc = (unix: bigint | number) => new Date(Number(unix) * 1000).toISOString().slice(11, 16) + " UTC";
// JobEscrow custom errors, decoded from the simulation, in words.
const REVERTS: Record<string, string> = {
  DeadlinePassed: "The job's deadline has passed: the agent can no longer accept or deliver it.",
  DeadlineNotPassed: "The agent accepted this job, so a refund opens only after its deadline.",
  AlreadyAccepted: "The agent has already accepted this job.",
  BadReviewWindow: "The review window is too long (JobEscrow v2 allows at most 30 days).",
  EndpointTooLong: "The endpoint label is too long (JobEscrow v2 allows at most 256 bytes).",
  BadDeadline: "The deadline must be in the future.",
  InvalidStatus: "The job is no longer in a state that allows this (it was delivered or closed meanwhile).",
  NotHirer: "Only the wallet that opened the job can do this.",
  ReviewWindowClosed: "The review window has closed.",
  ZeroAmount: "The amount must be above zero.",
};
const errText = (e: unknown) => {
  const x = e as { shortMessage?: string; message?: string; code?: number; cause?: { code?: number } };
  if (x?.code === 4001 || x?.cause?.code === 4001) return "Request rejected in the wallet.";
  const rev = e instanceof BaseError ? (e.walk((c) => c instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null) : null;
  const name = rev?.data?.errorName;
  if (name) return REVERTS[name] ?? `JobEscrow reverted: ${name}`;
  return (x?.shortMessage ?? x?.message ?? String(e)).split("\n")[0]!;
};
function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3500);
}
const info = (ver: Ver, id: bigint | string) => {
  const k = jobKey(ver, id);
  if (!txInfo.has(k)) txInfo.set(k, {});
  return txInfo.get(k)!;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── network + event tail ─────────────────────────────

async function tick() {
  try {
    const b = await publicClient.getBlockNumber({ cacheTime: 0 });
    head = b;
    const pill = $("net");
    pill.classList.add("live");
    pill.querySelector("span")!.textContent = `Monad testnet · block ${b.toLocaleString("en-US")}`;
    let changed = false;
    if (tailed === 0n) tailed = b - BACKFILL_BLOCKS > D.fromBlock ? b - BACKFILL_BLOCKS : D.fromBlock - 1n;
    // Public RPCs cap eth_getLogs at 100 blocks; walk forward at most 6 windows per tick. One
    // eth_getLogs covers both escrows (address list); each log's address says which one it is.
    for (let i = 0; i < 6 && tailed < b; i++) {
      const from = tailed + 1n;
      const to = from + 99n < b ? from + 99n : b;
      const events = await publicClient.getContractEvents({ address: [D.jobEscrow, D_V1.jobEscrow], abi: jobEscrowAbi, fromBlock: from, toBlock: to });
      for (const ev of events) {
        const e = escrowAt(ev.address);
        if (!e) continue;
        changed = true;
        const a = ev.args as Record<string, unknown>;
        const j = info(e.ver, a.jobId as bigint);
        if (ev.eventName === "JobOpened") {
          j.openTx = ev.transactionHash;
          if (!j.openedAt) j.openedAt = Math.floor(Date.now() / 1000) - Math.round(Number(b - ev.blockNumber) * 0.4);
        } else if (ev.eventName === "JobAccepted") {
          j.acceptTx = ev.transactionHash;
        } else if (ev.eventName === "JobDelivered") {
          j.deliverTx = ev.transactionHash;
          j.deliverableURI = a.deliverableURI as string;
          j.deliverableHash = a.deliverableHash as Hex;
        } else if (ev.eventName === "JobReleased" || ev.eventName === "JobRefunded" || ev.eventName === "JobDisputed") {
          j.closeTx = ev.transactionHash;
          j.closedBy = (a.releasedBy ?? a.by) as string | undefined;
        }
      }
      tailed = to;
    }
    return changed;
  } catch {
    $("net").classList.remove("live");
    return false;
  }
}

// ───────────────────────────── jobs ─────────────────────────────

async function readJob(e: Escrow, jobId: bigint): Promise<Row> {
  const [job, acceptedAt] = await Promise.all([e.client.getJob(jobId), e.ver === "v1" ? Promise.resolve(null) : e.client.acceptedAt(jobId)]);
  return { ...job, jobId, ver: e.ver, acceptedAt };
}

async function refreshJobs(force = false) {
  // Both jobCounts and every getJob / acceptedAt below go out as one Multicall3 eth_call each round.
  const counts = await Promise.all(ESCROW_LIST.map(async (e) => [e, await e.client.jobCount()] as const));
  const reads: Array<Promise<Row>> = [];
  for (const [e, count] of counts) {
    for (let i = 1n; i <= count; i++) {
      const cur = jobs.get(jobKey(e.ver, i));
      // Released / Refunded / Disputed are final; everything else is re-read.
      if (force || !cur || cur.status < JobStatus.Released) reads.push(readJob(e, i));
    }
  }
  for (const r of await Promise.all(reads)) jobs.set(jobKey(r.ver, r.jobId), r);
  mergeSnapshot();
  renderJobs();
  renderKpis();
  renderWalletJobs();
}

/** Status pill plus, for an open v2 job, whether the agent has taken it. */
function statusCell(j: Row, now: bigint) {
  if (j.ver === "v2" && j.status === JobStatus.Refunded && j.acceptedAt === 0n) {
    return `<span class="status s-Cancelled" title="Cancelled by the hirer before the agent accepted it: no passport entry">Cancelled</span>`;
  }
  const name = jobStatusName(j.status);
  const pill = `<span class="status s-${name}">${name}</span>`;
  if (j.status !== JobStatus.Open || j.acceptedAt === null) return pill;
  const late = j.deadline < now;
  const sub = j.acceptedAt
    ? late
      ? `<span class="bad small" title="accepted ${utc(j.acceptedAt)}, deadline ${utc(j.deadline)}">accepted · past deadline</span>`
      : `<span class="ok small" title="accepted ${utc(j.acceptedAt)}; the agent has until ${utc(j.deadline)} to deliver">accepted</span>`
    : late
      ? `<span class="muted small" title="deadline ${utc(j.deadline)}">never accepted</span>`
      : `<span class="warn small" title="the hirer can cancel until the agent accepts">waiting for agent</span>`;
  return `${pill} ${sub}`;
}

function renderJobs() {
  const byId = (a: Row, b: Row) => Number(b.jobId - a.jobId);
  const all = [...jobs.values()];
  const v2 = all.filter((j) => j.ver === "v2").sort(byId);
  const v1 = all.filter((j) => j.ver === "v1").sort(byId);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const row = (j: Row) => {
    const k = jobKey(j.ver, j.jobId);
    const e = ESCROWS[j.ver];
    const t = txInfo.get(k) ?? {};
    const name = jobStatusName(j.status);
    const fresh = !firstJobsRender && !seenJobs.has(`${k}:${j.status}:${j.acceptedAt ? 1 : 0}`);
    seenJobs.add(`${k}:${j.status}:${j.acceptedAt ? 1 : 0}`);
    const closeLabel = j.ver === "v2" && j.status === JobStatus.Refunded && j.acceptedAt === 0n ? "cancel" : name.toLowerCase();
    const txs = [t.openTx && txLink(t.openTx, "open"), t.acceptTx && txLink(t.acceptTx, "accept"), t.deliverTx && txLink(t.deliverTx, "deliver"), t.closeTx && txLink(t.closeTx, closeLabel)].filter(Boolean).join("");
    const verifier = j.verifier !== "0x0000000000000000000000000000000000000000" ? ` <span class="muted small" title="delegated release verifier ${j.verifier}">+verifier</span>` : "";
    const deliverable = isHttp(t.deliverableURI)
      ? `<a href="${esc(t.deliverableURI)}" target="_blank" rel="noopener">deliverable.json</a>`
      : j.status === JobStatus.Delivered || j.status === JobStatus.Released
        ? `<button class="btn small" data-find="${k}">locate</button>`
        : j.status === JobStatus.Open
          ? `<span class="muted">pending</span>`
          : `<span class="muted">—</span>`;
    const ref = `<a class="jobref ${j.ver}" href="${EXPLORER}/address/${e.d.jobEscrow}" target="_blank" rel="noopener" title="${e.label} ${e.d.jobEscrow}">${j.ver} #${j.jobId}</a>`;
    return `<tr class="${fresh ? "fresh" : ""}" data-job="${k}"><td>${ref}</td><td><a href="#agent=${j.agentId}">${j.agentId}</a></td><td>${addrLink(j.hirer)}</td><td>${usdc(j.amount)}</td>` +
      `<td>${statusCell(j, now)}${verifier}</td><td>${when(t.openedAt)}</td><td class="txs">${txs || '<span class="muted">—</span>'}</td><td>${deliverable}</td></tr>`;
  };
  const sep = (html: string) => `<tr class="sep"><td colspan="8">${html}</td></tr>`;
  const tb = $("jobs").querySelector("tbody")!;
  tb.innerHTML =
    (v2.length ? v2.map(row).join("") : `<tr><td colspan="8" class="muted">No jobs on JobEscrow v2 yet. Hire agentfromzero above to open the first one.</td></tr>`) +
    (v1.length
      ? sep(`<b>JobEscrow v1</b> · history: the jobs from the demo video, all closed. v2 replaced it after a <a href="${SECURITY_DOC}" target="_blank" rel="noopener">security review</a>; the passports keep these stamps.`) + v1.map(row).join("")
      : "");
  firstJobsRender = false;
  $("jobs-meta").textContent = `${v2.length} on v2 + ${v1.length} on v1 (history) · JobEscrow state over RPC, tailing both escrows to block ${tailed.toLocaleString("en-US")}`;
}

$("jobs").addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-find]");
  if (!btn) return;
  const [ver, id] = btn.dataset.find!.split(":") as [Ver, string];
  btn.disabled = true;
  btn.textContent = "searching…";
  try {
    const d = await ESCROWS[ver].client.getDelivery(BigInt(id));
    if (d) Object.assign(info(ver, d.jobId), { deliverTx: d.transactionHash, deliverableURI: d.deliverableURI, deliverableHash: d.deliverableHash });
    renderJobs();
  } catch (err) {
    toast(errText(err));
    btn.textContent = "locate";
    btn.disabled = false;
  }
});

function renderKpis() {
  const all = [...jobs.values()];
  const settled = all.filter((j) => j.status === JobStatus.Released);
  const volume = settled.reduce((s, j) => s + j.amount, 0n);
  const agentsWithJobs = new Set(all.map((j) => String(j.agentId))).size;
  const p = snapshot?.protocol as Record<string, number> | undefined;
  const kpis: Array<[string, string]> = [
    [String(all.length), "jobs opened in escrow (v1 + v2, live)"],
    [String(settled.length), "settled and stamped (live)"],
    [usdc(volume), "USDC paid to agents (live)"],
    [String(agentsWithJobs), "agents hired so far"],
  ];
  if (p) {
    kpis.push([String(p.agentsSeen ?? "—"), "ERC-8004 agents indexed"]);
    kpis.push([`${p.feedbackEscrowBacked ?? 0} / ${p.feedbackTotal ?? 0}`, "ERC-8004 feedback backed by escrow"]);
  }
  $("kpis").innerHTML = kpis.map(([v, l]) => `<div class="kpi"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("");
}

// ───────────────────────────── trust index ─────────────────────────────

async function loadSnapshot() {
  for (const url of SNAPSHOT_URLS) {
    try {
      snapshot = (await fetchIndexSnapshot(url)) as Snapshot;
      mergeSnapshot();
      renderIndex(url);
      return;
    } catch {
      /* try the next copy */
    }
  }
  $("index").querySelector("tbody")!.innerHTML = `<tr><td colspan="7" class="muted">The index snapshot could not be loaded. Live chain reads above still work.</td></tr>`;
}

/**
 * Copies tx hashes from the index snapshot's recent jobs onto the matching live rows. The index
 * predates v2, so a record without an `escrow` field is a v1 job; a record is only used if its
 * hirer and amount match what the chain says for that escrow + id (ids collide across escrows).
 */
function mergeSnapshot() {
  for (const r of snapshot?.recentJobs ?? []) {
    const ver = r.escrow ? escrowAt(r.escrow)?.ver : "v1";
    const row = ver && jobs.get(jobKey(ver, r.jobId));
    if (!ver || !row) continue;
    if ((r.hirer_id && r.hirer_id.toLowerCase() !== row.hirer.toLowerCase()) || (r.amount && r.amount !== String(row.amount))) continue;
    const j = info(ver, r.jobId);
    j.openTx ??= r.openTx ?? undefined;
    j.deliverTx ??= r.deliverTx ?? undefined;
    j.closeTx ??= r.closeTx ?? undefined;
    j.closedBy ??= r.releasedBy ?? undefined;
    j.deliverableURI ??= r.deliverableURI ?? undefined;
    if (r.openedAt && !j.openedAt) j.openedAt = Math.floor(Date.parse(r.openedAt) / 1000);
  }
}

function renderIndex(source: string) {
  if (!snapshot) return;
  const agents = Object.values(snapshot.agents).sort((a, b) => b.score - a.score || b.feedback.count - a.feedback.count || Number(a.agentId) - Number(b.agentId));
  $("index").querySelector("tbody")!.innerHTML = agents
    .map((a) => {
      const n = a.intel;
      const nansen = n.coverage === "none" ? '<span class="muted">not profiled</span>' : `${n.weightedHirers} weighted · ${n.linkedHirers} linked${n.flagged.length ? ` · <span class="bad">${n.flagged.length} flagged</span>` : ""}`;
      return `<tr data-agent="${esc(a.agentId)}"><td><b>${esc(a.agentId)}</b>${a.agentId === String(AGENT) ? ' <span class="muted small">agentfromzero</span>' : ""}</td><td>${a.score}</td>` +
        `<td>${a.jobs.settled} · ${usdc(a.volumeSettled)} USDC</td><td>${a.settledHirers}</td><td>${a.feedback.escrowBacked} of ${a.feedback.count}</td><td>${nansen}</td><td>${addrLink(a.owner)}</td></tr>`;
    })
    .join("");
  const t = snapshot.block.time ? snapshot.block.time.replace("T", " ").slice(0, 16) + " UTC" : "";
  $("index-meta").innerHTML = `${esc(snapshot.indexer.engine)} · block ${snapshot.block.number.toLocaleString("en-US")} ${esc(t)} · <a href="${esc(source.startsWith("http") ? source : API + "/agentpassport/index.json")}" target="_blank" rel="noopener">snapshot</a>`;
}

$("index").addEventListener("click", (e) => {
  const tr = (e.target as HTMLElement).closest<HTMLTableRowElement>("tr[data-agent]");
  if (!tr || (e.target as HTMLElement).closest("a")) return;
  location.hash = `agent=${tr.dataset.agent}`;
});

// ───────────────────────────── agent lookup ─────────────────────────────

async function lookup(idRaw: string, policyKey: string) {
  const box = $("agent");
  const id = idRaw.trim();
  if (!/^\d{1,12}$/.test(id)) {
    box.className = "card empty";
    box.textContent = "An agentId is a whole number, like 1908.";
    return;
  }
  const set = POLICY_SETS[policyKey] ?? POLICY_SETS.proven!;
  box.className = "card empty";
  box.textContent = `Reading agent ${id} from Monad testnet…`;
  let sc: Scorecard;
  try {
    sc = await ap.scorecard(BigInt(id), set.policy);
  } catch (e) {
    box.textContent = `Could not read agent ${id}: ${errText(e)}`;
    return;
  }
  if (!sc.identity) {
    box.textContent = `There is no ERC-8004 agent with id ${id} in the Identity Registry on Monad testnet.`;
    return;
  }
  const idx = snapshot?.agents[id];
  box.className = "card";
  box.innerHTML = renderScorecard(sc, set.label, idx);
}

function renderScorecard(sc: Scorecard, policyLabel: string, idx?: IndexedAgent) {
  const p = sc.passport;
  const ts = (s: string | null) => (s ? s.replace("T", " ").slice(0, 16) + " UTC" : "never");
  // Volumes are USDC base units and ages are seconds on chain; show them in human units.
  const human = (rule: string, v: string) =>
    v.replace(/\d+/, (n) => (rule === "minVolumeSettled" ? `${usdc(n)} USDC` : rule === "maxAgeOfLastSettlement" ? (n === "0" ? "off" : `${Math.round(Number(n) / 86400)} d`) : n));
  const checks = sc.checks.map((c) => `<tr><td><code>${esc(c.rule)}</code></td><td>${esc(human(c.rule, c.required))}</td><td>${esc(human(c.rule, c.actual))}</td><td class="${c.ok ? "ok" : "bad"}">${c.ok ? "pass" : "fail"}</td></tr>`).join("");
  const left = `
    <div class="verdict">
      <span class="badge ${sc.meets ? "ok" : "bad"}">${sc.meets ? "✓ meets" : "✗ does not meet"} ${esc(policyLabel)}</span>
      <span class="muted small">AgentPassport.meets(${esc(sc.agentId)}, policy) at block ${Number(sc.blockNumber).toLocaleString("en-US")}</span>
    </div>
    <div class="stats">
      <div class="stat"><b>${esc(p.jobsSettled)}</b><span>settled jobs</span></div>
      <div class="stat"><b>${usdc(p.volumeSettled)}</b><span>USDC settled</span></div>
      <div class="stat"><b>${esc(p.jobsRefunded)}</b><span>refunded</span></div>
      <div class="stat"><b class="${p.jobsDisputed !== "0" ? "bad" : ""}">${esc(p.jobsDisputed)}</b><span>lost disputes</span></div>
    </div>
    <table class="kv"><tr><td>rule</td><td>required</td><td>actual</td><td></td></tr>${checks}</table>
    <table class="kv" style="margin-top:10px">
      <tr><td>first job</td><td>${ts(p.firstSeen)}</td></tr>
      <tr><td>last settlement</td><td>${ts(p.lastSettled)}</td></tr>
    </table>`;
  const idn = sc.identity!;
  const card = isHttp(idn.agentURI) ? `<a href="${esc(idn.agentURI)}" target="_blank" rel="noopener">${esc(idn.agentURI)}</a>` : `<span class="mono">${esc(idn.agentURI || "—")}</span>`;
  let index = `<p class="muted small">Not in the index snapshot yet.</p>`;
  if (idx) {
    const b = idx.scoreBreakdown ?? {};
    const bar = (k: string, max: number, neg = false) => {
      const v = Number(b[k] ?? 0);
      return `<div class="bar${neg ? " neg" : ""}"><span>${k}</span><i style="--w:${Math.min(100, (Math.abs(v) / max) * 100)}%"></i><span>${neg && v ? "−" : ""}${Math.abs(v)}</span></div>`;
    };
    const n = idx.intel;
    index = `
      <table class="kv">
        <tr><td>index score</td><td><b>${idx.score}</b> / 100</td></tr>
        <tr><td>distinct hirers</td><td>${idx.settledHirers} (repeat ${idx.repeatHirers}, top hirer ${(idx.topHirerShareBps / 100).toFixed(0)}% of volume)</td></tr>
        <tr><td>ERC-8004 feedback</td><td>${idx.feedback.escrowBacked} of ${idx.feedback.count} backed by an escrow settlement</td></tr>
        <tr><td>Nansen</td><td>${n.coverage === "none" ? "not profiled" : `${n.weightedHirers} weighted hirers, ${n.linkedHirers} linked to the agent; owner ${n.owner?.visible ? `visible ($${Math.round(n.owner.footprintUsd ?? 0)})` : "has no mainnet history"}`}${n.flagged.length ? `; <span class="bad">flagged: ${esc(n.flagged.join(", "))}</span>` : ""}</td></tr>
      </table>
      <div class="bars">${bar("activity", 25)}${bar("volume", 20)}${bar("diversity", 25)}${bar("repeat", 10)}${bar("reliability", 20)}${bar("disputePenalty", 30, true)}${bar("concentrationPenalty", 30, true)}</div>
      <p class="muted small">Envio index at block ${snapshot!.block.number.toLocaleString("en-US")}. Score v1: activity, volume, hirer diversity, repeat hirers and on-time delivery, minus disputes and hirer concentration.</p>`;
  }
  const right = `
    <h3>ERC-8004 identity</h3>
    <table class="kv">
      <tr><td>agentId</td><td><b>${esc(sc.agentId)}</b>${sc.agentId === String(AGENT) ? " · agentfromzero (AI agent, disclosed)" : ""}</td></tr>
      <tr><td>owner</td><td>${addrLink(idn.owner, idn.owner)}</td></tr>
      <tr><td>payment wallet</td><td>${idn.agentWallet ? addrLink(idn.agentWallet, idn.agentWallet) : '<span class="muted">not set (pays the owner)</span>'}</td></tr>
      <tr><td>agent card</td><td>${card}</td></tr>
      <tr><td>escrow-backed reputation</td><td>${esc(sc.reputation.count)} feedback entries written by AgentPassport${sc.reputation.summaryValue ? `, average ${esc(sc.reputation.summaryValue)}` : ""}</td></tr>
    </table>
    <h3 style="margin-top:16px">Trust index</h3>
    ${index}`;
  return `<div class="agent-grid"><div>${left}</div><div>${right}</div></div>`;
}

$("lookup").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $<HTMLInputElement>("agentId").value.trim();
  if (location.hash === `#agent=${id}`) void lookup(id, $<HTMLSelectElement>("policy").value);
  else location.hash = `agent=${id}`;
});
$("policy").addEventListener("change", () => void lookup($<HTMLInputElement>("agentId").value, $<HTMLSelectElement>("policy").value));

function route() {
  const m = /agent=(\d+)/.exec(location.hash);
  if (!m) return;
  $<HTMLInputElement>("agentId").value = m[1]!;
  void lookup(m[1]!, $<HTMLSelectElement>("policy").value);
  $("lookup-section").scrollIntoView({ behavior: "smooth", block: "start" });
}
window.addEventListener("hashchange", route);

// ───────────────────────────── wallet ─────────────────────────────

window.addEventListener("eip6963:announceProvider", (e) => {
  const d = (e as CustomEvent<{ info: { name: string; uuid: string }; provider: EIP1193Provider }>).detail;
  if (d && !discovered.some((x) => x.provider === d.provider)) discovered.push({ name: d.info.name, provider: d.provider });
  renderWallet();
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

function pickProvider(): { name: string; provider: EIP1193Provider } | null {
  if (discovered.length) return discovered[0]!;
  const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  return eth ? { name: "Browser wallet", provider: eth } : null;
}

async function ensureChain(provider: EIP1193Provider) {
  const id = (await provider.request({ method: "eth_chainId" })) as string;
  if (id.toLowerCase() === CHAIN_HEX) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: CHAIN_HEX, chainName: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: ["https://testnet-rpc.monad.xyz"], blockExplorerUrls: [EXPLORER] }],
    });
  }
}

async function connect() {
  const p = pickProvider();
  if (!p) {
    toast("No browser wallet found. Install an EVM wallet (MetaMask, Rabby, …) to hire; everything else works without one.");
    return;
  }
  try {
    const [address] = (await p.provider.request({ method: "eth_requestAccounts" })) as Address[];
    if (!address) throw new Error("The wallet returned no account.");
    await ensureChain(p.provider);
    const client = createWalletClient({ account: address, chain: monadTestnet, transport: custom(p.provider) });
    wallet = { provider: p.provider, name: p.name, address, client, writer: new AgentPassportClient({ publicClient, walletClient: client }), mon: 0n, usdc: 0n, allowance: 0n, chainOk: true };
    const w = p.provider as EIP1193Provider & { on?: (ev: string, fn: (...a: unknown[]) => void) => void };
    w.on?.("accountsChanged", () => void connect());
    w.on?.("chainChanged", (id) => {
      if (wallet) wallet.chainOk = String(id).toLowerCase() === CHAIN_HEX;
      renderWallet();
    });
    await refreshBalances();
    setStep("wallet", "done");
    setStep("open", "active");
  } catch (e) {
    toast(errText(e));
  }
}

async function refreshBalances() {
  if (!wallet) return;
  const [mon, bal, allowance] = await Promise.all([
    publicClient.getBalance({ address: wallet.address }),
    publicClient.readContract({ address: D.usdc, abi: usdcAbi, functionName: "balanceOf", args: [wallet.address] }),
    publicClient.readContract({ address: D.usdc, abi: usdcAbi, functionName: "allowance", args: [wallet.address, D.jobEscrow] }),
  ]);
  Object.assign(wallet, { mon, usdc: bal as bigint, allowance: allowance as bigint });
  renderWallet();
}

function renderWallet() {
  const box = $("wallet");
  const btn = $<HTMLButtonElement>("connect");
  if (!wallet) {
    const p = pickProvider();
    box.innerHTML = `<h3>Wallet</h3><p class="muted small">${p ? `Found <b>${esc(p.name)}</b>. Connect it to hire agentfromzero on Monad testnet.` : "No injected wallet detected. You can read everything on this page without one. To hire, open it in a browser with an EVM wallet (MetaMask, Rabby, …)."}</p>` +
      (p ? `<button class="btn primary" id="connect2">Connect ${esc(p.name)}</button>` : "");
    $("connect2")?.addEventListener("click", () => void connect());
    btn.textContent = "Connect wallet";
    $<HTMLButtonElement>("hire").disabled = true;
    return;
  }
  btn.textContent = short(wallet.address);
  box.innerHTML = `<h3>Wallet · ${esc(wallet.name)}</h3>
    <div class="wallet-line"><span>${addrLink(wallet.address, wallet.address)}</span>
    <span><b>${Number(formatEther(wallet.mon)).toFixed(3)}</b> MON</span><span><b>${usdc(wallet.usdc)}</b> USDC</span>
    <span class="${wallet.chainOk ? "ok" : "bad"}">${wallet.chainOk ? "on Monad testnet" : "wrong network: switch to Monad testnet (10143)"}</span></div>
    <div id="my-jobs"></div>`;
  $<HTMLButtonElement>("hire").disabled = hireBusy || !wallet.chainOk;
  renderWalletJobs();
}

function renderWalletJobs() {
  const box = document.getElementById("my-jobs");
  if (!box || !wallet || hireBusy) return;
  // Only v2 can have unfinished jobs (every v1 job is closed), so resume / cancel / refund act on v2.
  const mine = [...jobs.values()]
    .filter((j) => j.ver === "v2" && j.hirer.toLowerCase() === wallet!.address.toLowerCase() && (j.status === JobStatus.Open || j.status === JobStatus.Delivered))
    .sort((a, b) => Number(b.jobId - a.jobId));
  const now = BigInt(Math.floor(Date.now() / 1000));
  const follow = (j: Row) => `<button class="btn small" data-resume="${j.jobId}">follow</button>`;
  const actions = (j: Row) => {
    if (j.status === JobStatus.Delivered) return `delivered <button class="btn small" data-resume="${j.jobId}">verify + release</button>`;
    const late = j.deadline < now;
    // Unaccepted: the hirer may cancel at any time (no passport entry).
    if (!j.acceptedAt) return `${late ? "never accepted" : "waiting for the agent to accept"} ${late ? "" : follow(j)}<button class="btn small" data-refund="${j.jobId}">cancel</button>`;
    // Accepted: the agent has until the deadline; after it, the refund is recorded on its passport.
    return late
      ? `accepted, not delivered by the deadline <button class="btn small" data-refund="${j.jobId}">refund</button>`
      : `accepted ${follow(j)}<span class="muted">refund possible after ${utc(j.deadline)}</span>`;
  };
  box.innerHTML = mine.length
    ? `<p class="small muted" style="margin:12px 0 6px">Your unfinished jobs:</p>` +
      mine.map((j) => `<div class="wallet-line small">v2 #${j.jobId} · ${usdc(j.amount)} USDC · ${actions(j)}</div>`).join("")
    : "";
}

$("wallet").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const resume = t.closest<HTMLButtonElement>("button[data-resume]");
  const refund = t.closest<HTMLButtonElement>("button[data-refund]");
  if (resume) void followJob(BigInt(resume.dataset.resume!)); // v2 job id
  if (refund) void refundJob(BigInt(refund.dataset.refund!), refund); // v2 job id
});
$("connect").addEventListener("click", () => (wallet ? void refreshBalances() : void connect()));

// ───────────────────────────── hire flow ─────────────────────────────

function renderPresets() {
  $("presets").innerHTML = presets
    .map((p, i) => `<label class="preset"><input type="radio" name="preset" value="${esc(p.id)}" ${i === 0 ? "checked" : ""}><div><b>${esc(p.title)}</b><p>${esc(p.summary)}</p>` +
      `<p class="mono">skill scorecard · agents ${esc(p.agentIds.join(", "))} · specHash <a href="/specs/${esc(p.specHash)}.json" target="_blank" rel="noopener">${esc(short(p.specHash, 6))}</a></p></div></label>`)
    .join("");
}

function setStep(step: string, state: "active" | "done" | "") {
  const li = $("steps").querySelector<HTMLElement>(`li[data-step="${step}"]`);
  if (!li) return;
  li.classList.remove("active", "done");
  if (state) li.classList.add(state);
}

const t0 = { v: 0 };
function log(html: string, cls = "") {
  const box = $("progress");
  box.hidden = false;
  const s = t0.v ? `+${((Date.now() - t0.v) / 1000).toFixed(1)}s` : "";
  box.insertAdjacentHTML("beforeend", `<div class="line ${cls}"><span class="t">${s}</span><span>${html}</span></div>`);
  return box.lastElementChild as HTMLElement;
}

async function send(label: string, req: Parameters<typeof publicClient.simulateContract>[0]): Promise<{ hash: Hex; logs: readonly import("viem").Log[]; block: bigint }> {
  const w = wallet!;
  const { request } = await publicClient.simulateContract({ ...req, account: w.address } as never);
  const line = log(`${esc(label)}: waiting for the wallet signature…`);
  const hash = await w.client.writeContract({ ...(request as object), account: w.address, chain: monadTestnet } as never);
  line.lastElementChild!.innerHTML = `${esc(label)}: submitted ${txLink(hash)}`;
  const r = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 400 });
  if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
  line.lastElementChild!.innerHTML = `${esc(label)}: confirmed in block ${r.blockNumber.toLocaleString("en-US")} · ${txLink(hash)}`;
  return { hash, logs: r.logs, block: r.blockNumber };
}

async function hire() {
  if (!wallet || hireBusy) return;
  const preset = presets.find((p) => p.id === (document.querySelector<HTMLInputElement>('input[name="preset"]:checked')?.value ?? ""));
  if (!preset) return toast("Pick a job first.");
  let amount: bigint;
  try {
    amount = parseUsdc($<HTMLInputElement>("amount").value.trim());
  } catch {
    return toast("Enter an amount in USDC, like 0.25.");
  }
  if (amount <= 0n) return toast("The amount must be above zero.");
  await refreshBalances();
  if (wallet.usdc < amount) return toast(`This wallet holds ${usdc(wallet.usdc)} USDC. Get test USDC at faucet.circle.com.`);
  if (wallet.mon === 0n) return toast("This wallet has no MON for gas. Get some at faucet.monad.xyz.");
  hireBusy = true;
  $<HTMLButtonElement>("hire").disabled = true;
  $("progress").innerHTML = "";
  t0.v = Date.now();
  try {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + Number($<HTMLSelectElement>("deadline").value));
    if (HIRE_REVIEW_WINDOW > MAX_REVIEW_WINDOW || new TextEncoder().encode(HIRE_ENDPOINT).length > MAX_ENDPOINT_BYTES) throw new Error("The hire parameters exceed JobEscrow v2's limits.");
    // ap is bound to MONAD_TESTNET, i.e. JobEscrow v2.
    const params = ap.toOpenParams({ agentId: AGENT, amount, specHash: preset.specHash as Hex, endpoint: HIRE_ENDPOINT, deadline, reviewWindow: HIRE_REVIEW_WINDOW });
    log(`Hiring agentfromzero (ERC-8004 agent ${AGENT}) for <b>${usdc(amount)} USDC</b>: "${esc(preset.title)}", specHash <code>${esc(short(preset.specHash, 6))}</code>`, "big");
    if (wallet.allowance < amount) await send("USDC approve", { address: D.usdc, abi: usdcAbi, functionName: "approve", args: [D.jobEscrow, amount] });
    const opened = await send("JobEscrow.open", { address: D.jobEscrow, abi: jobEscrowAbi, functionName: "open", args: [params] });
    const [ev] = parseEventLogs({ abi: jobEscrowAbi, logs: opened.logs as never, eventName: "JobOpened" });
    const jobId = ev!.args.jobId;
    Object.assign(info("v2", jobId), { openTx: opened.hash, openedAt: Math.floor(Date.now() / 1000) });
    log(`<b>Job #${jobId} is open</b> on JobEscrow v2 (v2 #${jobId}). ${usdc(amount)} USDC is locked until the agent delivers. Until agentfromzero accepts the job you can cancel it at any time.`, "big");
    setStep("open", "done");
    await refreshBalances();
    void refreshJobs();
    await followJob(jobId, true);
  } catch (e) {
    log(`<span class="bad">${esc(errText(e))}</span>`);
  } finally {
    hireBusy = false;
    renderWallet();
  }
}

/**
 * Follows a JobEscrow v2 job: waits for the agent to accept it (offering the hirer a cancel until
 * then), waits for delivery, verifies the bytes against the on-chain hash, then offers release.
 * Only v2 jobs can still be open, so this always reads through `ap` (JobEscrow v2).
 */
async function followJob(jobId: bigint, fromHire = false) {
  if (!fromHire) {
    if (hireBusy) return toast("Already following a job.");
    $("progress").innerHTML = "";
    t0.v = Date.now();
    log(`Following job v2 #${jobId}.`, "big");
  }
  hireBusy = true;
  setStep("wallet", "done");
  setStep("open", "done");
  setStep("accept", "active");
  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 1000);
  let [job, acceptedAt] = await Promise.all([ap.getJob(jobId), ap.acceptedAt(jobId)]);
  const isHirer = () => !!wallet && wallet.address.toLowerCase() === job.hirer.toLowerCase();
  const reclaimButton = (label: string, note: string) => {
    const l = log(`<button class="btn small">${esc(label)}</button> <span class="muted">${note}</span>`);
    l.querySelector("button")!.addEventListener("click", (e) => void refundJob(jobId, e.currentTarget as HTMLButtonElement, false));
    return l;
  };
  const waitLine = log("Waiting for agentfromzero's worker to accept the job…");
  let cancelLine: HTMLElement | null = null;
  let deliverLine: HTMLElement | null = null;
  while (job.status === JobStatus.Open && BigInt(Math.floor(Date.now() / 1000)) <= job.deadline) {
    if (!acceptedAt) {
      waitLine.lastElementChild!.textContent = `Waiting for agentfromzero's worker to accept the job… ${secs()}s`;
      if (!cancelLine && isHirer()) cancelLine = reclaimButton("Cancel the job", "Allowed until the agent accepts: the USDC comes back and the agent's passport gets no entry.");
    } else {
      if (!deliverLine) {
        cancelLine?.remove();
        cancelLine = null;
        const t = info("v2", jobId);
        waitLine.lastElementChild!.innerHTML = `<b>Accepted</b> by agentfromzero at ${utc(acceptedAt)}${t.acceptTx ? ` · ${txLink(t.acceptTx, "accept tx")}` : ""}. It has until ${utc(job.deadline)} to deliver; the job can no longer be cancelled, only refunded after that deadline.`;
        setStep("accept", "done");
        setStep("deliver", "active");
        deliverLine = log("agentfromzero is running the skill and delivering…");
      }
      deliverLine.lastElementChild!.textContent = `agentfromzero is running the skill and delivering… ${secs()}s`;
    }
    await sleep(2000);
    [job, acceptedAt] = await Promise.all([ap.getJob(jobId), ap.acceptedAt(jobId)]);
  }
  cancelLine?.remove();
  if (job.status === JobStatus.Open) {
    // The deadline passed with no delivery: the agent can no longer act, the hirer can reclaim.
    const accepted = !!acceptedAt;
    log(accepted
      ? `The deadline (${utc(job.deadline)}) passed without a delivery. The hirer can refund the job; the refund is recorded on the agent's passport.`
      : `The deadline (${utc(job.deadline)}) passed and the agent never accepted the job. The hirer can cancel it; the agent's passport gets no entry.`);
    if (isHirer()) reclaimButton(accepted ? "Refund" : "Cancel the job", "returns the USDC to your wallet");
    hireBusy = false;
    renderWallet();
    return;
  }
  if (job.status !== JobStatus.Delivered) {
    const cancelled = job.status === JobStatus.Refunded && !acceptedAt;
    waitLine.lastElementChild!.textContent = `Job v2 #${jobId} is ${cancelled ? "cancelled (never accepted)" : jobStatusName(job.status)}.`;
    hireBusy = false;
    renderWallet();
    return;
  }
  setStep("accept", "done");
  setStep("deliver", "active");
  // The live tail normally has the JobDelivered event already; otherwise locate it on chain.
  let t = info("v2", jobId);
  for (let i = 0; i < 6 && !t.deliverableURI; i++) {
    await tick();
    t = info("v2", jobId);
    if (!t.deliverableURI) await sleep(1000);
  }
  if (!t.deliverableURI) {
    const d = await ap.getDelivery(jobId);
    if (d) Object.assign(t, { deliverTx: d.transactionHash, deliverableURI: d.deliverableURI, deliverableHash: d.deliverableHash });
  }
  (deliverLine ?? waitLine).lastElementChild!.innerHTML = `<b>Delivered</b> after ${secs()}s${deliverLine ? "" : " (accepted in the same transaction)"} · ${txLink(t.deliverTx, "deliver tx")} · committed hash <code>${esc(short(job.deliverableHash, 8))}</code>`;
  setStep("deliver", "done");
  void refreshJobs();

  setStep("verify", "active");
  const vLine = log(`Downloading <a href="${esc(t.deliverableURI)}" target="_blank" rel="noopener">${esc(t.deliverableURI)}</a> and hashing it…`);
  let ok = false;
  let body: Record<string, unknown> | null = null;
  try {
    const res = await fetch(t.deliverableURI!, { cache: "no-store" });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const h = hashContent(bytes);
    ok = h === job.deliverableHash;
    body = JSON.parse(new TextDecoder().decode(bytes));
    vLine.lastElementChild!.innerHTML = ok
      ? `<span class="ok"><b>✓ keccak256(deliverable) matches the hash on chain</b></span> <code>${esc(short(h, 8))}</code> · ${bytes.length.toLocaleString("en-US")} bytes`
      : `<span class="bad"><b>✗ hash mismatch</b>: served bytes hash to <code>${esc(short(h, 8))}</code>, chain has <code>${esc(short(job.deliverableHash, 8))}</code></span>`;
  } catch (e) {
    vLine.lastElementChild!.innerHTML = `<span class="bad">Could not download the deliverable: ${esc(errText(e))}</span>`;
  }
  if (body) log(renderDeliverable(body));
  setStep("verify", ok ? "done" : "active");
  hireBusy = false;
  if (!wallet || wallet.address.toLowerCase() !== job.hirer.toLowerCase()) {
    log("Connect the hirer wallet to release or dispute this job.");
    return;
  }
  setStep("release", "active");
  const line = log(ok
    ? `<button class="btn primary" id="release">Release ${usdc(job.amount)} USDC to agentfromzero</button>`
    : `<button class="btn" id="dispute">Dispute (refund + negative stamp)</button> <span class="muted">The review window is open until ${new Date(Number(job.deliveredAt + job.reviewWindow) * 1000).toISOString().slice(11, 16)} UTC.</span>`);
  line.querySelector("#release")?.addEventListener("click", (e) => void release(jobId, job, e.currentTarget as HTMLButtonElement));
  line.querySelector("#dispute")?.addEventListener("click", async (e) => {
    (e.currentTarget as HTMLButtonElement).disabled = true;
    try {
      await send("JobEscrow.dispute", { address: D.jobEscrow, abi: jobEscrowAbi, functionName: "dispute", args: [jobId] });
      void refreshJobs();
    } catch (err) {
      log(`<span class="bad">${esc(errText(err))}</span>`);
    }
  });
}

function renderDeliverable(d: Record<string, unknown>) {
  const out = d.output as { blockNumber?: string; summary?: { agents: number; meeting: number }; results?: Array<{ agentId: string; meets: boolean; passport?: { jobsSettled: string; volumeSettled: string } | null; identity?: unknown }> } | undefined;
  if (!out?.results) return `<span class="muted">Deliverable type ${esc(d.type)}</span>`;
  const rows = out.results.map((r) => `<tr><td>agent ${esc(r.agentId)}</td><td class="${r.meets ? "ok" : "bad"}">${r.meets ? "meets" : "does not meet"}</td><td>${esc(r.passport?.jobsSettled ?? "0")} settled</td><td>${r.passport ? usdc(r.passport.volumeSettled) : "0"} USDC</td></tr>`).join("");
  return `<div class="deliverable">Scorecard at block ${Number(out.blockNumber ?? 0).toLocaleString("en-US")}: ${out.summary?.meeting ?? 0} of ${out.summary?.agents ?? 0} agents meet the policy.<table>${rows}</table><span class="muted">produced by ${esc(d.producedBy)}</span></div>`;
}

async function release(jobId: bigint, job: Job, btn: HTMLButtonElement) {
  btn.disabled = true;
  hireBusy = true;
  try {
    const before = await ap.getPassport(job.agentId);
    const r = await send("JobEscrow.release", { address: D.jobEscrow, abi: jobEscrowAbi, functionName: "release", args: [jobId] });
    info("v2", jobId).closeTx = r.hash;
    const mirrored = parseEventLogs({ abi: agentPassportAbi, logs: r.logs as never, eventName: "FeedbackMirrored" })[0];
    const after = await ap.getPassport(job.agentId, r.block);
    log(`<b>Paid.</b> Passport of agent ${job.agentId}: settled jobs ${before.jobsSettled} → <b>${after.jobsSettled}</b>, volume ${usdc(before.volumeSettled)} → <b>${usdc(after.volumeSettled)} USDC</b>.` +
      (mirrored ? ` ERC-8004 ReputationRegistry feedback ${mirrored.args.ok ? '<span class="ok">mirrored</span>' : '<span class="bad">not mirrored</span>'} in the same tx.` : ""), "big");
    setStep("release", "done");
    toast(`Job #${jobId} settled. agentfromzero's passport was stamped.`);
    await refreshJobs();
    await refreshBalances();
    if ($<HTMLInputElement>("agentId").value === String(job.agentId)) void lookup(String(job.agentId), $<HTMLSelectElement>("policy").value);
  } catch (e) {
    log(`<span class="bad">${esc(errText(e))}</span>`);
    btn.disabled = false;
  } finally {
    hireBusy = false;
  }
}

/**
 * Hirer reclaims an undelivered JobEscrow v2 job. Before the agent accepts it, this is a cancel
 * (allowed at any time, no passport entry); after acceptance only once the deadline has passed,
 * and the refund is recorded on the agent's passport.
 */
async function refundJob(jobId: bigint, btn?: HTMLButtonElement, clear = true) {
  if (btn) btn.disabled = true;
  if (clear) {
    $("progress").innerHTML = "";
    t0.v = Date.now();
  }
  try {
    const [job, acceptedAt] = await Promise.all([ap.getJob(jobId), ap.acceptedAt(jobId)]);
    const accepted = !!acceptedAt;
    if (accepted && BigInt(Math.floor(Date.now() / 1000)) <= job.deadline) {
      throw new Error(`The agent accepted job v2 #${jobId} at ${utc(acceptedAt!)}, so a refund opens only after its deadline (${utc(job.deadline)}).`);
    }
    const r = await send(accepted ? "JobEscrow.refund" : "JobEscrow.refund (cancel)", { address: D.jobEscrow, abi: jobEscrowAbi, functionName: "refund", args: [jobId] });
    info("v2", jobId).closeTx = r.hash;
    log(accepted
      ? `Job v2 #${jobId} refunded to your wallet. The refund is recorded on agent ${job.agentId}'s passport.`
      : `Job v2 #${jobId} cancelled: the USDC is back in your wallet, and agent ${job.agentId}'s passport has no entry for it.`, "big");
    await refreshJobs();
    await refreshBalances();
  } catch (e) {
    log(`<span class="bad">${esc(errText(e))}</span>`);
    if (btn) btn.disabled = false;
  }
}

$("hire").addEventListener("click", () => void hire());

// ───────────────────────────── contracts table ─────────────────────────────

function renderContracts() {
  const rows: Array<[string, string]> = [
    ["AgentPassport", addrLink(D.agentPassport, D.agentPassport)],
    ["JobEscrow v2 (current)", `${addrLink(D.jobEscrow, D.jobEscrow)} <span class="muted small">· every new job and the hire flow · from block ${D.fromBlock.toLocaleString("en-US")}</span>`],
    ["JobEscrow v1 (history)", `${addrLink(D_V1.jobEscrow, D_V1.jobEscrow)} <span class="muted small">· jobs v1 #1–#5 from the demo video, all closed · from block ${D_V1.fromBlock.toLocaleString("en-US")}</span>`],
    ["Security review", `<a href="${SECURITY_DOC}" target="_blank" rel="noopener">docs/SECURITY.md</a> <span class="muted small">· why v2 replaced v1: the agent accepts a job before working, no delivery after the deadline, a hirer cancels an unaccepted job at any time (no passport mark) and refunds an accepted one only after the deadline</span>`],
    ["ERC-8004 IdentityRegistry", addrLink(D.identityRegistry, D.identityRegistry)],
    ["ERC-8004 ReputationRegistry", addrLink(D.reputationRegistry, D.reputationRegistry)],
    ["Circle USDC (settlement token)", addrLink(D.usdc, D.usdc)],
    ["Dynamic MPC release verifier", addrLink(DYNAMIC_VERIFIER, DYNAMIC_VERIFIER)],
    ["SDK", `<a href="https://www.npmjs.com/package/@agentfromzero/agentpassport-sdk" target="_blank" rel="noopener">@agentfromzero/agentpassport-sdk</a> (MIT)`],
    ["x402 API", `<a href="${API}/agentpassport/" target="_blank" rel="noopener">${API.replace("https://", "")}</a> · free <code>GET /v1/agent/{id}</code>, paid <code>POST /v1/agent/verify</code> (0.001 USDC)`],
    ["Videos", `<a href="https://vimeo.com/1229505127" target="_blank" rel="noopener">demo (2:47)</a> · <a href="https://vimeo.com/1229506111" target="_blank" rel="noopener">pitch (1:56)</a>`],
    ["agentfromzero agent card", `<a href="${API}/.well-known/agent-card.json" target="_blank" rel="noopener">/.well-known/agent-card.json</a>`],
  ];
  $("contracts").innerHTML = rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("");
}

// ───────────────────────────── boot ─────────────────────────────

async function loop() {
  let n = 0;
  for (;;) {
    const changed = await tick();
    if (changed || n % 4 === 0) await refreshJobs().catch(() => undefined);
    n++;
    await sleep(TICK_MS);
  }
}

renderPresets();
renderContracts();
renderWallet();
renderKpis();
await loadSnapshot();
renderKpis();
if (/agent=\d+/.test(location.hash)) route();
else void lookup(String(AGENT), "proven");
void loop();
