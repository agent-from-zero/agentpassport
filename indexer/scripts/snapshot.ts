// Publishes the indexer's view as one JSON document (agentpassport/index-snapshot@1) that a static
// site / API can serve without running Postgres: every indexed agent with its escrow aggregates,
// score breakdown, per-hirer rows and, when NANSEN_API_KEY is set, Nansen intel on the hirers and
// the agent owner joined into weighted / linked / flagged hirer counts.
//
//   GRAPHQL_URL=http://localhost:8088/v1/graphql  OUT=./snapshot/index.json \
//   [NANSEN_API_KEY=… NANSEN_CACHE=./snapshot/nansen-cache.json NANSEN_MAX_CREDITS=30 NANSEN_TTL_DAYS=14] \
//   node scripts/snapshot.ts
//
// Exit code 2 when the indexer is not ready or lags the chain head by more than MAX_LAG_BLOCKS.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fromRawAgent, INDEX_SNAPSHOT_SCHEMA, type IndexSnapshot, type RawAgent } from "../../sdk/src/trust-index.ts";
import { scoreBreakdown } from "../src/lib/score.ts";
import { NansenIntel } from "./nansen.ts";

const GRAPHQL_URL = process.env.GRAPHQL_URL ?? "http://localhost:8088/v1/graphql";
const OUT = process.env.OUT ?? "./snapshot/index.json";
const MAX_LAG_BLOCKS = Number(process.env.MAX_LAG_BLOCKS ?? 2000);
const log = (msg: string) => console.error(`[snapshot] ${msg}`);

const QUERY = /* GraphQL */ `
  {
    Agent(order_by: { agentId: asc }) {
      id owner agentWallet agentURI jobsOpened jobsDelivered jobsSettled jobsRefunded jobsDisputed
      volumeSettled settledHirers repeatHirers topHirerShareBps feedbackCount feedbackEscrowBacked
      feedbackRevoked escrowBackedShareBps avgDeliverySeconds onTimeDeliveries score firstJobAt lastSettledAt
      hirers(order_by: { volumeSettled: desc }) { hirer_id jobsSettled volumeSettled }
    }
    Protocol {
      jobsOpened jobsDelivered jobsReleased jobsRefunded jobsDisputed gaslessOpens passkeyReleases
      volumeEscrowed volumeSettled agentsSeen agentsWithStamps hirers feedbackTotal feedbackEscrowBacked
      mirrorFailures lastEventBlock lastEventAt
    }
    Job(order_by: { jobId: desc }, limit: 20) {
      jobId agent_id hirer_id amount status releasePath releasedBy gasless endpoint openedAt deliveredAt closedAt
      openTx deliverTx closeTx deliverableURI
    }
    _meta { chainId progressBlock progressBlockTime sourceBlock isReady eventsProcessed }
  }
`;

type Meta = { chainId: number; progressBlock: number; progressBlockTime: string | null; sourceBlock: number; isReady: boolean; eventsProcessed: number };

const res = await fetch(GRAPHQL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: QUERY }) });
if (!res.ok) throw new Error(`GraphQL ${GRAPHQL_URL}: HTTP ${res.status}`);
const body = (await res.json()) as { data?: { Agent: RawAgent[]; Protocol: Array<Record<string, unknown>>; Job: Array<Record<string, unknown>>; _meta: Meta[] }; errors?: unknown };
if (!body.data) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors).slice(0, 500)}`);
const { Agent: agents, Protocol, Job: recentJobs, _meta } = body.data;
const meta = _meta[0]!;
if (!meta.isReady || meta.sourceBlock - meta.progressBlock > MAX_LAG_BLOCKS) {
  log(`indexer not caught up: ready=${meta.isReady} progress=${meta.progressBlock} source=${meta.sourceBlock}`);
  process.exit(2);
}

// Nansen: agent owners (identity behind the agent) and every hirer that settled a job (the money).
let nansen: NansenIntel | null = null;
if (process.env.NANSEN_API_KEY) {
  nansen = new NansenIntel({
    apiKey: process.env.NANSEN_API_KEY,
    cacheFile: process.env.NANSEN_CACHE ?? "./snapshot/nansen-cache.json",
    maxCredits: Number(process.env.NANSEN_MAX_CREDITS ?? 30),
    ttlDays: Number(process.env.NANSEN_TTL_DAYS ?? 14),
    log,
  });
  const hirers = new Set(agents.flatMap((a) => a.hirers.filter((h) => h.jobsSettled > 0).map((h) => h.hirer_id.toLowerCase())));
  const owners = new Set(agents.map((a) => a.owner?.toLowerCase()).filter((x): x is string => !!x && !hirers.has(x)));
  // Hirers first: they decide weighted / linked counts; owners only add context.
  for (const h of hirers) await nansen.profile(h, true);
  for (const o of owners) await nansen.profile(o, false);
  nansen.save();
  log(`nansen: ${nansen.spent} credits spent this run, ${nansen.creditsRemaining ?? "?"} left, ${Object.keys(nansen.profiled).length} addresses cached`);
}

const intel = nansen?.profiled ?? {};
const snapshot: IndexSnapshot & { recentJobs: unknown[] } = {
  schema: INDEX_SNAPSHOT_SCHEMA,
  generatedAt: new Date().toISOString(),
  chainId: meta.chainId,
  indexer: {
    engine: "Envio HyperIndex 3.12.1 (RPC source)",
    mode: "self-hosted (docker compose: Postgres + Hasura GraphQL + rpc-proxy + indexer)",
    graphql: process.env.PUBLIC_GRAPHQL_URL ?? null,
  },
  block: { number: meta.progressBlock, time: meta.progressBlockTime },
  protocol: Protocol[0] ?? {},
  agents: Object.fromEntries(
    agents.map((r) => {
      const a = fromRawAgent(r, intel);
      const { score: _s, ...parts } = scoreBreakdown({
        jobsSettled: r.jobsSettled,
        jobsRefunded: r.jobsRefunded,
        jobsDisputed: r.jobsDisputed,
        volumeSettled: BigInt(r.volumeSettled),
        settledHirers: r.settledHirers,
        repeatHirers: r.repeatHirers,
        topHirerShareBps: r.topHirerShareBps,
      });
      return [r.id, { ...a, scoreBreakdown: parts }];
    }),
  ),
  nansen: nansen
    ? {
        provider: "Nansen API (profiler: first-funder, current-balance, related-wallets)",
        plan: "free",
        creditsRemaining: nansen.creditsRemaining,
        addressesProfiled: Object.keys(intel).length,
        note: "Nansen covers mainnets (incl. Monad mainnet), not Monad testnet: a wallet that only ever lived on testnet has no Nansen history, so it cannot count as a weighted hirer.",
      }
    : null,
  recentJobs,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + "\n");
log(`wrote ${OUT}: ${agents.length} agents, block ${meta.progressBlock} (${meta.progressBlockTime})`);
