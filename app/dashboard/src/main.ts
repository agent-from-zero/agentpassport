// AgentPassport dashboard. Everything on the page comes from Monad testnet over public RPC (through
// @agentfromzero/agentpassport-sdk) or from the published Envio index snapshot. The only write path
// is the hire flow, signed by the visitor's own injected wallet (EIP-6963 / window.ethereum).
import {
  type Address,
  type EIP1193Provider,
  type Hex,
  type WalletClient,
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
  POLICIES,
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
const BACKFILL_BLOCKS = 500n;

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
const ap = new AgentPassportClient({ publicClient });

// ───────────────────────────── state ─────────────────────────────

interface TxInfo {
  openTx?: Hex;
  deliverTx?: Hex;
  closeTx?: Hex;
  closedBy?: string;
  deliverableURI?: string;
  deliverableHash?: Hex;
  openedAt?: number; // unix seconds
}
type Row = Job & { jobId: bigint };
interface RecentJob { jobId: string; openTx?: Hex; deliverTx?: Hex; closeTx?: Hex; releasedBy?: string; deliverableURI?: string; openedAt?: string }
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
const errText = (e: unknown) => {
  const x = e as { shortMessage?: string; message?: string; code?: number; cause?: { code?: number } };
  if (x?.code === 4001 || x?.cause?.code === 4001) return "Request rejected in the wallet.";
  return (x?.shortMessage ?? x?.message ?? String(e)).split("\n")[0]!;
};
function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3500);
}
const info = (id: bigint | string) => {
  const k = String(id);
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
    if (tailed === 0n) tailed = b - BACKFILL_BLOCKS;
    // Public RPCs cap eth_getLogs at 100 blocks; walk forward at most 6 windows per tick.
    for (let i = 0; i < 6 && tailed < b; i++) {
      const from = tailed + 1n;
      const to = from + 99n < b ? from + 99n : b;
      const events = await publicClient.getContractEvents({ address: D.jobEscrow, abi: jobEscrowAbi, fromBlock: from, toBlock: to });
      for (const ev of events) {
        changed = true;
        const a = ev.args as Record<string, unknown>;
        const j = info(a.jobId as bigint);
        if (ev.eventName === "JobOpened") {
          j.openTx = ev.transactionHash;
          if (!j.openedAt) j.openedAt = Math.floor(Date.now() / 1000) - Math.round(Number(b - ev.blockNumber) * 0.4);
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

async function refreshJobs(force = false) {
  const count = await ap.jobCount();
  const ids: bigint[] = [];
  for (let i = 1n; i <= count; i++) {
    const cur = jobs.get(String(i));
    // Released / Refunded / Disputed are final; everything else is re-read.
    if (force || !cur || cur.status < JobStatus.Released) ids.push(i);
  }
  const rows = await Promise.all(ids.map(async (jobId) => ({ jobId, ...(await ap.getJob(jobId)) })));
  for (const r of rows) jobs.set(String(r.jobId), r);
  renderJobs();
  renderKpis();
  renderWalletJobs();
}

function renderJobs() {
  const rows = [...jobs.values()].sort((a, b) => Number(b.jobId - a.jobId));
  const tb = $("jobs").querySelector("tbody")!;
  tb.innerHTML = rows
    .map((j) => {
      const k = String(j.jobId);
      const t = txInfo.get(k) ?? {};
      const name = jobStatusName(j.status);
      const fresh = !firstJobsRender && !seenJobs.has(`${k}:${j.status}`);
      seenJobs.add(`${k}:${j.status}`);
      const txs = [t.openTx && txLink(t.openTx, "open"), t.deliverTx && txLink(t.deliverTx, "deliver"), t.closeTx && txLink(t.closeTx, name.toLowerCase())].filter(Boolean).join("");
      const verifier = j.verifier !== "0x0000000000000000000000000000000000000000" ? ` <span class="muted small" title="delegated release verifier ${j.verifier}">+verifier</span>` : "";
      const deliverable = isHttp(t.deliverableURI)
        ? `<a href="${esc(t.deliverableURI)}" target="_blank" rel="noopener">deliverable.json</a>`
        : j.status === JobStatus.Delivered || j.status === JobStatus.Released
          ? `<button class="btn small" data-find="${k}">locate</button>`
          : j.status === JobStatus.Open
            ? `<span class="muted">pending</span>`
            : `<span class="muted">—</span>`;
      return `<tr class="${fresh ? "fresh" : ""}"><td>#${k}</td><td><a href="#agent=${j.agentId}">${j.agentId}</a></td><td>${addrLink(j.hirer)}</td><td>${usdc(j.amount)}</td>` +
        `<td><span class="status s-${name}">${name}</span>${verifier}</td><td>${when(t.openedAt)}</td><td class="txs">${txs || '<span class="muted">—</span>'}</td><td>${deliverable}</td></tr>`;
    })
    .join("") || `<tr><td colspan="8" class="muted">No jobs yet.</td></tr>`;
  firstJobsRender = false;
  $("jobs-meta").textContent = `${rows.length} jobs · JobEscrow state over RPC, tailing events to block ${tailed.toLocaleString("en-US")}`;
}

$("jobs").addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-find]");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "searching…";
  try {
    const d = await ap.getDelivery(BigInt(btn.dataset.find!));
    if (d) Object.assign(info(d.jobId), { deliverTx: d.transactionHash, deliverableURI: d.deliverableURI, deliverableHash: d.deliverableHash });
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
    [String(all.length), "jobs opened in escrow (live)"],
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
      for (const r of snapshot.recentJobs ?? []) {
        const j = info(r.jobId);
        j.openTx ??= r.openTx;
        j.deliverTx ??= r.deliverTx;
        j.closeTx ??= r.closeTx;
        j.closedBy ??= r.releasedBy;
        j.deliverableURI ??= r.deliverableURI;
        if (r.openedAt && !j.openedAt) j.openedAt = Math.floor(Date.parse(r.openedAt) / 1000);
      }
      renderIndex(url);
      return;
    } catch {
      /* try the next copy */
    }
  }
  $("index").querySelector("tbody")!.innerHTML = `<tr><td colspan="7" class="muted">The index snapshot could not be loaded. Live chain reads above still work.</td></tr>`;
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
  const mine = [...jobs.values()].filter((j) => j.hirer.toLowerCase() === wallet!.address.toLowerCase() && (j.status === JobStatus.Open || j.status === JobStatus.Delivered));
  const now = BigInt(Math.floor(Date.now() / 1000));
  box.innerHTML = mine.length
    ? `<p class="small muted" style="margin:12px 0 6px">Your unfinished jobs:</p>` +
      mine.map((j) => `<div class="wallet-line small">#${j.jobId} · ${usdc(j.amount)} USDC · ${jobStatusName(j.status)} ` +
        (j.status === JobStatus.Delivered ? `<button class="btn small" data-resume="${j.jobId}">verify + release</button>` : j.deadline < now ? `<button class="btn small" data-refund="${j.jobId}">refund</button>` : `<button class="btn small" data-resume="${j.jobId}">follow</button>`) + `</div>`).join("")
    : "";
}

$("wallet").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const resume = t.closest<HTMLButtonElement>("button[data-resume]");
  const refund = t.closest<HTMLButtonElement>("button[data-refund]");
  if (resume) void followJob(BigInt(resume.dataset.resume!));
  if (refund) void refundJob(BigInt(refund.dataset.refund!));
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
    const params = ap.toOpenParams({ agentId: AGENT, amount, specHash: preset.specHash as Hex, endpoint: "scorecard", deadline, reviewWindow: 3600n });
    log(`Hiring agentfromzero (ERC-8004 agent ${AGENT}) for <b>${usdc(amount)} USDC</b>: "${esc(preset.title)}", specHash <code>${esc(short(preset.specHash, 6))}</code>`, "big");
    if (wallet.allowance < amount) await send("USDC approve", { address: D.usdc, abi: usdcAbi, functionName: "approve", args: [D.jobEscrow, amount] });
    const opened = await send("JobEscrow.open", { address: D.jobEscrow, abi: jobEscrowAbi, functionName: "open", args: [params] });
    const [ev] = parseEventLogs({ abi: jobEscrowAbi, logs: opened.logs as never, eventName: "JobOpened" });
    const jobId = ev!.args.jobId;
    Object.assign(info(jobId), { openTx: opened.hash, openedAt: Math.floor(Date.now() / 1000) });
    log(`<b>Job #${jobId} is open.</b> ${usdc(amount)} USDC is locked in JobEscrow until the agent delivers.`, "big");
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

/** Waits for delivery, verifies the bytes against the on-chain hash, then offers release. */
async function followJob(jobId: bigint, fromHire = false) {
  if (!fromHire) {
    $("progress").innerHTML = "";
    t0.v = Date.now();
    log(`Following job #${jobId}.`, "big");
  }
  hireBusy = true;
  setStep("wallet", "done");
  setStep("open", "done");
  setStep("deliver", "active");
  const waitLine = log("Waiting for agentfromzero's worker to pick up the job, run the skill and deliver…");
  const started = Date.now();
  let job = await ap.getJob(jobId);
  while (job.status === JobStatus.Open) {
    const s = Math.round((Date.now() - started) / 1000);
    waitLine.lastElementChild!.textContent = `Waiting for agentfromzero's worker to pick up the job, run the skill and deliver… ${s}s`;
    await sleep(2000);
    job = await ap.getJob(jobId);
  }
  if (job.status !== JobStatus.Delivered) {
    log(`Job #${jobId} is ${jobStatusName(job.status)}.`);
    setStep("deliver", "done");
    hireBusy = false;
    return;
  }
  // The live tail normally has the JobDelivered event already; otherwise locate it on chain.
  let t = info(jobId);
  for (let i = 0; i < 6 && !t.deliverableURI; i++) {
    await tick();
    t = info(jobId);
    if (!t.deliverableURI) await sleep(1000);
  }
  if (!t.deliverableURI) {
    const d = await ap.getDelivery(jobId);
    if (d) Object.assign(t, { deliverTx: d.transactionHash, deliverableURI: d.deliverableURI, deliverableHash: d.deliverableHash });
  }
  waitLine.lastElementChild!.innerHTML = `<b>Delivered</b> after ${Math.round((Date.now() - started) / 1000)}s · ${txLink(t.deliverTx, "deliver tx")} · committed hash <code>${esc(short(job.deliverableHash, 8))}</code>`;
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
    info(jobId).closeTx = r.hash;
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

async function refundJob(jobId: bigint) {
  $("progress").innerHTML = "";
  t0.v = Date.now();
  try {
    await send("JobEscrow.refund", { address: D.jobEscrow, abi: jobEscrowAbi, functionName: "refund", args: [jobId] });
    log(`Job #${jobId} refunded to your wallet.`, "big");
    await refreshJobs();
    await refreshBalances();
  } catch (e) {
    log(`<span class="bad">${esc(errText(e))}</span>`);
  }
}

$("hire").addEventListener("click", () => void hire());

// ───────────────────────────── contracts table ─────────────────────────────

function renderContracts() {
  const rows: Array<[string, string]> = [
    ["AgentPassport", addrLink(D.agentPassport, D.agentPassport)],
    ["JobEscrow", addrLink(D.jobEscrow, D.jobEscrow)],
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
