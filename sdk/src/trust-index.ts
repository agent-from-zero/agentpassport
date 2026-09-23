// Index-backed trust signals: what the AgentPassport HyperIndex indexer (Envio, see ../../indexer)
// derives from every JobEscrow / AgentPassport / ERC-8004 event, joined with Nansen wallet
// intelligence about the people behind the money (hirers) and the agent (owner / agentWallet).
//
// The on-chain `AgentPassport.meets(agentId, policy)` stays the source of truth for hard counts.
// The index adds what a contract cannot cheaply know: how many *different* hirers paid, whether one
// hirer is most of the volume, what share of the agent's ERC-8004 feedback is escrow-backed, and,
// through Nansen, whether a hirer has any real on-chain history or is linked to the agent itself.
//
// Two sources, one shape: a published snapshot (`agentpassport/index-snapshot@1` JSON, e.g.
// https://agentfromzero.netlify.app/agentpassport/index.json) or a live self-hosted GraphQL
// endpoint (the Hasura in front of the indexer, e.g. http://localhost:8088/v1/graphql).

export const INDEX_SNAPSHOT_SCHEMA = "agentpassport/index-snapshot@1";

/** Nansen profile of one EVM address (mainnets Nansen covers, incl. Monad mainnet; not testnets). */
export interface CounterpartyIntel {
  address: string;
  /** Earliest address that sent this wallet native gas, with Nansen's label for it. */
  firstFunder: { address: string; name: string | null; chain: string; tx: string | null; at: string | null } | null;
  /** Sum of current token balances across Nansen-covered chains, in USD (null = not queried). */
  footprintUsd: number | null;
  /** Chains with a non-zero balance. */
  chains: string[];
  /** Wallets Nansen relates to this one (funding, deployer, …), with labels. */
  related: Array<{ address: string; label: string | null; relation: string; chain: string }>;
  /** Risk words found in funder / related-wallet labels (mixer, exploit, scam, …). */
  flags: string[];
  /** Nansen sees any history for this address. */
  visible: boolean;
  fetchedAt: string;
}

export interface IndexedHirer {
  address: string;
  jobsSettled: number;
  volumeSettled: string;
  /** Hirer is the agent's owner / wallet, was funded by it, or Nansen relates the two. */
  linkedToAgent: boolean;
  /** Counts toward `minWeightedHirers`: Nansen-visible, not linked, not flagged. */
  weighted: boolean;
  intel: CounterpartyIntel | null;
}

export interface IndexedAgent {
  agentId: string;
  owner: string | null;
  agentWallet: string | null;
  agentURI: string | null;
  jobs: { opened: number; delivered: number; settled: number; refunded: number; disputed: number };
  volumeSettled: string;
  settledHirers: number;
  repeatHirers: number;
  topHirerShareBps: number;
  feedback: { count: number; escrowBacked: number; revoked: number; escrowBackedShareBps: number };
  avgDeliverySeconds: number;
  onTimeDeliveries: number;
  /** Index score v1, 0-100 (indexer/src/lib/score.ts). */
  score: number;
  scoreBreakdown?: Record<string, number | null>;
  firstJobAt: string | null;
  lastSettledAt: string | null;
  hirers: IndexedHirer[];
  intel: {
    owner: CounterpartyIntel | null;
    weightedHirers: number;
    linkedHirers: number;
    flagged: string[];
    /** "nansen" when every counterparty was profiled, "partial" / "none" otherwise. */
    coverage: "nansen" | "partial" | "none";
  };
}

export interface IndexSnapshot {
  schema: typeof INDEX_SNAPSHOT_SCHEMA;
  generatedAt: string;
  chainId: number;
  indexer: { engine: string; mode: string; graphql: string | null };
  block: { number: number; time: string | null };
  protocol: Record<string, unknown>;
  agents: Record<string, IndexedAgent>;
  nansen: { provider: string; plan: string | null; creditsRemaining: number | null; addressesProfiled: number; note: string } | null;
}

/** Index / Nansen rules. Every field optional; unset rules are not checked. */
export interface IndexPolicy {
  minIndexScore?: number;
  /** Distinct hirers that paid (settled) this agent. */
  minDistinctHirers?: number;
  /** Largest single hirer's share of settled volume, basis points. */
  maxTopHirerShareBps?: number;
  /** Escrow-backed share of the agent's ERC-8004 feedback, basis points. */
  minEscrowBackedFeedbackShareBps?: number;
  /** Nansen: settled hirers with visible on-chain history that are not linked to the agent. */
  minWeightedHirers?: number;
  /** Nansen: settled hirers linked to the agent (self-dealing). */
  maxLinkedHirers?: number;
  /** Nansen: reject if a hirer or the owner carries a risk flag. */
  forbidFlagged?: boolean;
  /** Reject a stale index (seconds between the indexed block time and now). */
  maxIndexAgeSeconds?: number;
}

export const INDEX_POLICY_FIELDS = [
  "minIndexScore",
  "minDistinctHirers",
  "maxTopHirerShareBps",
  "minEscrowBackedFeedbackShareBps",
  "minWeightedHirers",
  "maxLinkedHirers",
  "forbidFlagged",
  "maxIndexAgeSeconds",
] as const satisfies ReadonlyArray<keyof IndexPolicy>;

export interface IndexCheck {
  rule: keyof IndexPolicy;
  source: "envio-index" | "nansen";
  required: string;
  actual: string;
  ok: boolean;
}

/** Splits a loose object into on-chain policy fields and index policy fields (validated). */
export function toIndexPolicy(input: Record<string, unknown>): IndexPolicy {
  const out: IndexPolicy = {};
  for (const k of INDEX_POLICY_FIELDS) {
    const v = input[k];
    if (v === undefined) continue;
    if (k === "forbidFlagged") {
      if (typeof v !== "boolean") throw new Error("policy.forbidFlagged must be true or false");
      out.forbidFlagged = v;
      continue;
    }
    if (!/^\d+$/.test(String(v))) throw new Error(`policy.${k} must be a non-negative integer`);
    out[k] = Number(v);
  }
  return out;
}

/** Evaluates index / Nansen rules for one agent. An agent the index has never seen fails every rule. */
export function evaluateIndexPolicy(
  agent: IndexedAgent | undefined,
  policy: IndexPolicy,
  meta: { blockTime: string | null; now?: Date } = { blockTime: null },
): { ok: boolean; checks: IndexCheck[] } {
  const checks: IndexCheck[] = [];
  const add = (rule: keyof IndexPolicy, source: IndexCheck["source"], required: string, actual: string, ok: boolean) =>
    checks.push({ rule, source, required, actual, ok });
  const a = agent;
  const none = "not indexed";
  if (policy.minIndexScore !== undefined) add("minIndexScore", "envio-index", `>= ${policy.minIndexScore}`, a ? `${a.score}` : none, !!a && a.score >= policy.minIndexScore);
  if (policy.minDistinctHirers !== undefined)
    add("minDistinctHirers", "envio-index", `>= ${policy.minDistinctHirers}`, a ? `${a.settledHirers}` : none, !!a && a.settledHirers >= policy.minDistinctHirers);
  if (policy.maxTopHirerShareBps !== undefined)
    add(
      "maxTopHirerShareBps",
      "envio-index",
      `<= ${policy.maxTopHirerShareBps} bps`,
      a ? `${a.topHirerShareBps} bps` : none,
      !!a && a.settledHirers > 0 && a.topHirerShareBps <= policy.maxTopHirerShareBps,
    );
  if (policy.minEscrowBackedFeedbackShareBps !== undefined)
    add(
      "minEscrowBackedFeedbackShareBps",
      "envio-index",
      `>= ${policy.minEscrowBackedFeedbackShareBps} bps`,
      a ? `${a.feedback.escrowBackedShareBps} bps (${a.feedback.escrowBacked}/${a.feedback.count})` : none,
      !!a && a.feedback.count > 0 && a.feedback.escrowBackedShareBps >= policy.minEscrowBackedFeedbackShareBps,
    );
  if (policy.maxIndexAgeSeconds !== undefined) {
    const now = (meta.now ?? new Date()).getTime();
    const age = meta.blockTime ? Math.max(0, Math.round((now - Date.parse(meta.blockTime)) / 1000)) : null;
    add("maxIndexAgeSeconds", "envio-index", `<= ${policy.maxIndexAgeSeconds}s`, age === null ? "unknown" : `${age}s`, age !== null && age <= policy.maxIndexAgeSeconds);
  }
  const covered = !!a && a.intel.coverage !== "none";
  if (policy.minWeightedHirers !== undefined)
    add(
      "minWeightedHirers",
      "nansen",
      `>= ${policy.minWeightedHirers}`,
      !a ? none : covered ? `${a.intel.weightedHirers} of ${a.settledHirers} hirers` : "no Nansen data",
      covered && a!.intel.weightedHirers >= policy.minWeightedHirers,
    );
  if (policy.maxLinkedHirers !== undefined)
    add(
      "maxLinkedHirers",
      "nansen",
      `<= ${policy.maxLinkedHirers}`,
      !a ? none : covered ? `${a.intel.linkedHirers}` : "no Nansen data",
      covered && a!.intel.linkedHirers <= policy.maxLinkedHirers,
    );
  if (policy.forbidFlagged)
    add(
      "forbidFlagged",
      "nansen",
      "no risk flags",
      !a ? none : covered ? (a.intel.flagged.length ? a.intel.flagged.join("; ") : "none") : "no Nansen data",
      covered && a!.intel.flagged.length === 0,
    );
  return { ok: checks.every((c) => c.ok), checks };
}

/** Loads a published snapshot and checks its schema. */
export async function fetchIndexSnapshot(url: string, fetchImpl: typeof fetch = fetch): Promise<IndexSnapshot> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`index snapshot ${url}: HTTP ${res.status}`);
  const snap = (await res.json()) as IndexSnapshot;
  if (snap?.schema !== INDEX_SNAPSHOT_SCHEMA) throw new Error(`index snapshot ${url}: unexpected schema ${String(snap?.schema)}`);
  return snap;
}

/** The GraphQL query the snapshot is built from (Hasura over the HyperIndex Postgres schema). */
export const INDEX_AGENT_QUERY = /* GraphQL */ `
  query AgentTrust($id: String!) {
    Agent(where: { id: { _eq: $id } }) {
      id owner agentWallet agentURI jobsOpened jobsDelivered jobsSettled jobsRefunded jobsDisputed
      volumeSettled settledHirers repeatHirers topHirerShareBps feedbackCount feedbackEscrowBacked
      feedbackRevoked escrowBackedShareBps avgDeliverySeconds onTimeDeliveries score firstJobAt lastSettledAt
      hirers(order_by: { volumeSettled: desc }) { hirer_id jobsSettled volumeSettled }
    }
    _meta { progressBlock progressBlockTime }
  }
`;

/**
 * Reads one agent straight from a live indexer GraphQL endpoint (index fields only; Nansen intel
 * lives in snapshots because it costs API credits and needs a key).
 */
export async function queryIndexedAgent(
  graphqlUrl: string,
  agentId: bigint | number | string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ agent: IndexedAgent | undefined; block: { number: number; time: string | null } }> {
  const res = await fetchImpl(graphqlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: INDEX_AGENT_QUERY, variables: { id: String(agentId) } }),
  });
  if (!res.ok) throw new Error(`indexer GraphQL ${graphqlUrl}: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { Agent: RawAgent[]; _meta: Array<{ progressBlock: number; progressBlockTime: string | null }> }; errors?: unknown };
  if (!body.data) throw new Error(`indexer GraphQL error: ${JSON.stringify(body.errors).slice(0, 300)}`);
  const meta = body.data._meta[0];
  const raw = body.data.Agent[0];
  return { agent: raw ? fromRawAgent(raw) : undefined, block: { number: meta?.progressBlock ?? 0, time: meta?.progressBlockTime ?? null } };
}

/** Row shape returned by INDEX_AGENT_QUERY. */
export interface RawAgent {
  id: string;
  owner: string | null;
  agentWallet: string | null;
  agentURI: string | null;
  jobsOpened: number;
  jobsDelivered: number;
  jobsSettled: number;
  jobsRefunded: number;
  jobsDisputed: number;
  volumeSettled: string;
  settledHirers: number;
  repeatHirers: number;
  topHirerShareBps: number;
  feedbackCount: number;
  feedbackEscrowBacked: number;
  feedbackRevoked: number;
  escrowBackedShareBps: number;
  avgDeliverySeconds: number;
  onTimeDeliveries: number;
  score: number;
  firstJobAt: string | null;
  lastSettledAt: string | null;
  hirers: Array<{ hirer_id: string; jobsSettled: number; volumeSettled: string }>;
}

/** Index row -> IndexedAgent, optionally joined with Nansen profiles keyed by lowercase address. */
export function fromRawAgent(r: RawAgent, intel: Record<string, CounterpartyIntel> = {}): IndexedAgent {
  const lc = (s: string | null) => (s ? s.toLowerCase() : null);
  const self = new Set([lc(r.owner), lc(r.agentWallet)].filter((x): x is string => !!x));
  const hirers: IndexedHirer[] = r.hirers
    .filter((h) => h.jobsSettled > 0)
    .map((h) => {
      const address = h.hirer_id.toLowerCase();
      const p = intel[address] ?? null;
      const linkedToAgent =
        self.has(address) ||
        (!!p?.firstFunder && self.has(p.firstFunder.address.toLowerCase())) ||
        (!!p && p.related.some((w) => self.has(w.address.toLowerCase())));
      return {
        address,
        jobsSettled: h.jobsSettled,
        volumeSettled: String(h.volumeSettled),
        linkedToAgent,
        weighted: !!p && p.visible && !linkedToAgent && p.flags.length === 0,
        intel: p,
      };
    });
  const owner = r.owner ? (intel[r.owner.toLowerCase()] ?? null) : null;
  const profiled = hirers.filter((h) => h.intel).length + (owner ? 1 : 0);
  const wanted = hirers.length + (r.owner ? 1 : 0);
  const flagged = [
    ...(owner?.flags.length ? [`owner ${r.owner}: ${owner.flags.join(", ")}`] : []),
    ...hirers.filter((h) => h.intel?.flags.length).map((h) => `hirer ${h.address}: ${h.intel!.flags.join(", ")}`),
  ];
  return {
    agentId: r.id,
    owner: lc(r.owner),
    agentWallet: lc(r.agentWallet),
    agentURI: r.agentURI,
    jobs: { opened: r.jobsOpened, delivered: r.jobsDelivered, settled: r.jobsSettled, refunded: r.jobsRefunded, disputed: r.jobsDisputed },
    volumeSettled: String(r.volumeSettled),
    settledHirers: r.settledHirers,
    repeatHirers: r.repeatHirers,
    topHirerShareBps: r.topHirerShareBps,
    feedback: { count: r.feedbackCount, escrowBacked: r.feedbackEscrowBacked, revoked: r.feedbackRevoked, escrowBackedShareBps: r.escrowBackedShareBps },
    avgDeliverySeconds: r.avgDeliverySeconds,
    onTimeDeliveries: r.onTimeDeliveries,
    score: r.score,
    firstJobAt: r.firstJobAt,
    lastSettledAt: r.lastSettledAt,
    hirers,
    intel: {
      owner,
      weightedHirers: hirers.filter((h) => h.weighted).length,
      linkedHirers: hirers.filter((h) => h.linkedToAgent).length,
      flagged,
      coverage: profiled === 0 ? "none" : profiled >= wanted ? "nansen" : "partial",
    },
  };
}
