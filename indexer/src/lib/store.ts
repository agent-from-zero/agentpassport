import type {
  Agent,
  AgentDay,
  AgentHirer,
  EvmOnEventContext,
  Hirer,
  Protocol,
  ProtocolDay,
} from "envio";
import { SCORE_VERSION, computeScore } from "./score.js";
import { bps, dayOf, isoDate, toDate } from "./util.js";

export type Ctx = EvmOnEventContext;
/** Entities come back readonly; handlers build a mutable copy and `set` it once. */
export type Mut<T> = { -readonly [K in keyof T]: T[K] };

export const PROTOCOL_ID = "10143";

export function blankAgent(id: string): Agent {
  return {
    id,
    agentId: BigInt(id),
    owner: undefined,
    agentWallet: undefined,
    agentURI: undefined,
    registeredAt: undefined,
    registrationIndexed: false,
    jobsOpened: 0,
    jobsAccepted: 0,
    jobsDelivered: 0,
    jobsSettled: 0,
    jobsRefunded: 0,
    jobsCancelled: 0,
    jobsDisputed: 0,
    volumeEscrowed: 0n,
    volumeSettled: 0n,
    firstJobAt: undefined,
    lastSettledAt: undefined,
    deliverySecondsTotal: 0n,
    avgDeliverySeconds: 0,
    onTimeDeliveries: 0,
    settledHirers: 0,
    repeatHirers: 0,
    topHirerVolume: 0n,
    topHirerShareBps: 0,
    feedbackCount: 0,
    feedbackEscrowBacked: 0,
    feedbackRevoked: 0,
    escrowBackedShareBps: 0,
    score: 0,
    scoreVersion: SCORE_VERSION,
    lastActivityAt: undefined,
  };
}

export function blankHirer(id: string, ts: number): Hirer {
  return {
    id,
    jobsOpened: 0,
    jobsSettled: 0,
    jobsRefunded: 0,
    jobsCancelled: 0,
    jobsDisputed: 0,
    volumeEscrowed: 0n,
    volumeSettled: 0n,
    agentsHired: 0,
    gaslessOpens: 0,
    passkeyRegistered: false,
    passkeyReleases: 0,
    firstSeenAt: toDate(ts),
    lastSeenAt: toDate(ts),
  };
}

function blankProtocol(ts: number): Protocol {
  return {
    id: PROTOCOL_ID,
    jobsOpened: 0,
    jobsAccepted: 0,
    jobsDelivered: 0,
    jobsReleased: 0,
    jobsRefunded: 0,
    jobsCancelled: 0,
    jobsDisputed: 0,
    gaslessOpens: 0,
    passkeyReleases: 0,
    volumeEscrowed: 0n,
    volumeSettled: 0n,
    agentsSeen: 0,
    agentsWithStamps: 0,
    hirers: 0,
    feedbackTotal: 0,
    feedbackEscrowBacked: 0,
    mirrorFailures: 0,
    lastEventBlock: 0,
    lastEventAt: toDate(ts),
  };
}

/** Loads the protocol singleton and stamps it with the current event position. */
export async function loadProtocol(ctx: Ctx, block: number, ts: number): Promise<Mut<Protocol>> {
  const p = (await ctx.Protocol.get(PROTOCOL_ID)) ?? blankProtocol(ts);
  return block >= p.lastEventBlock ? { ...p, lastEventBlock: block, lastEventAt: toDate(ts) } : p;
}

/** Loads an agent, creating it (and counting it on the protocol) on first sight. */
export async function loadAgent(ctx: Ctx, agentId: bigint, protocol: { agentsSeen: number }): Promise<{ agent: Agent; created: boolean }> {
  const id = agentId.toString();
  const found = await ctx.Agent.get(id);
  if (found) return { agent: found, created: false };
  protocol.agentsSeen += 1;
  return { agent: blankAgent(id), created: true };
}

export async function loadHirer(ctx: Ctx, address: string, ts: number, protocol: { hirers: number }): Promise<Hirer> {
  const found = await ctx.Hirer.get(address);
  if (found) return found;
  protocol.hirers += 1;
  return blankHirer(address, ts);
}

export async function loadPair(ctx: Ctx, agentId: string, hirer: string, ts: number): Promise<{ pair: AgentHirer; created: boolean }> {
  const id = `${agentId}-${hirer}`;
  const found = await ctx.AgentHirer.get(id);
  if (found) return { pair: found, created: false };
  return {
    pair: { id, agent_id: agentId, hirer_id: hirer, jobsOpened: 0, jobsSettled: 0, volumeSettled: 0n, firstAt: toDate(ts), lastAt: toDate(ts) },
    created: true,
  };
}

/** Per-agent and protocol-wide day buckets; a new agent-day counts as one active agent that day. */
export async function loadDays(ctx: Ctx, agentId: string, ts: number): Promise<{ agentDay: AgentDay; protocolDay: ProtocolDay }> {
  const day = dayOf(ts);
  const [agentDayFound, protocolDayFound] = await Promise.all([
    ctx.AgentDay.get(`${agentId}-${day}`),
    ctx.ProtocolDay.get(String(day)),
  ]);
  let protocolDay: ProtocolDay = protocolDayFound ?? {
    id: String(day),
    day,
    date: isoDate(day),
    jobsOpened: 0,
    jobsSettled: 0,
    jobsRefunded: 0,
    jobsDisputed: 0,
    volumeEscrowed: 0n,
    volumeSettled: 0n,
    activeAgents: 0,
    feedback: 0,
  };
  const agentDay: AgentDay = agentDayFound ?? {
    id: `${agentId}-${day}`,
    agent_id: agentId,
    day,
    date: isoDate(day),
    jobsOpened: 0,
    jobsSettled: 0,
    jobsRefunded: 0,
    jobsDisputed: 0,
    volumeSettled: 0n,
    feedback: 0,
  };
  if (!agentDayFound) protocolDay = { ...protocolDay, activeAgents: protocolDay.activeAgents + 1 };
  return { agentDay, protocolDay };
}

/** Recomputes every derived field of an agent from its counters. */
export function derive(a: Agent): Agent {
  const topHirerShareBps = bps(a.topHirerVolume, a.volumeSettled);
  const live = a.feedbackCount - a.feedbackRevoked;
  const escrowBackedShareBps = live > 0 ? Math.floor((a.feedbackEscrowBacked * 10000) / live) : 0;
  const avgDeliverySeconds = a.jobsDelivered > 0 ? Number(a.deliverySecondsTotal / BigInt(a.jobsDelivered)) : 0;
  const score = computeScore({
    jobsSettled: a.jobsSettled,
    jobsRefunded: a.jobsRefunded,
    jobsDisputed: a.jobsDisputed,
    volumeSettled: a.volumeSettled,
    settledHirers: a.settledHirers,
    repeatHirers: a.repeatHirers,
    topHirerShareBps,
  });
  return { ...a, topHirerShareBps, escrowBackedShareBps, avgDeliverySeconds, score, scoreVersion: SCORE_VERSION };
}
