/**
 * AgentPassport handlers. `Attested` is the single source of truth for outcome counters: it fires
 * exactly when the on-chain passport changes, so Agent.jobsSettled / jobsRefunded / jobsDisputed /
 * volumeSettled always equal `passportOf(agentId)`. On top of that it maintains the counterparty
 * structure the contract does not store: distinct paying hirers, repeat hirers and the largest
 * hirer's share of volume - the signals that separate real demand from one wallet paying itself.
 */
import { indexer, type Agent, type AgentDay, type AgentHirer, type Hirer, type ProtocolDay } from "envio";
import { readIdentity } from "../lib/effects.js";
import { type Mut, derive, loadAgent, loadDays, loadHirer, loadPair, loadProtocol } from "../lib/store.js";
import { toDate } from "../lib/util.js";

const OUTCOMES = ["Settled", "Refunded", "Disputed"] as const;

indexer.onEvent(
  { contract: "AgentPassport", event: "Attested", fields: { transaction: ["hash"], block: ["timestamp"] } },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const { agentId, attester, jobRef, outcome: rawOutcome, token, amount, hirer } = event.params;
    const outcome = OUTCOMES[Number(rawOutcome)];
    if (!outcome) {
      context.log.error(`Attested with unknown outcome ${rawOutcome}`);
      return;
    }
    const ref = jobRef.toLowerCase();
    const protocol = await loadProtocol(context, event.block.number, ts);
    const { agent: found, created } = await loadAgent(context, agentId, protocol);
    const hirerEntity = await loadHirer(context, hirer, ts, protocol);
    const { pair } = await loadPair(context, found.id, hirer, ts);
    const { agentDay, protocolDay } = await loadDays(context, found.id, ts);
    const jobLink = await context.JobRef.get(ref);

    let agent = found;
    if (created) {
      const id = await context.effect(readIdentity, agent.id);
      agent = { ...agent, owner: id.owner ?? undefined, agentWallet: id.agentWallet ?? undefined, agentURI: id.agentURI ?? undefined };
    }
    const firstStamp = agent.jobsSettled + agent.jobsRefunded + agent.jobsDisputed === 0;

    context.Stamp.set({
      id: ref,
      agent_id: agent.id,
      attester,
      outcome,
      token,
      amount,
      hirer,
      job_id: jobLink?.job_id,
      mirrored: undefined,
      timestamp: toDate(ts),
      block: event.block.number,
      tx: event.transaction.hash,
    });

    const next: Mut<Agent> = { ...agent, lastActivityAt: toDate(ts) };
    const nextHirer: Mut<Hirer> = { ...hirerEntity, lastSeenAt: toDate(ts) };
    const nextPair: Mut<AgentHirer> = { ...pair, lastAt: toDate(ts) };
    const nextAgentDay: Mut<AgentDay> = { ...agentDay };
    const nextProtocolDay: Mut<ProtocolDay> = { ...protocolDay };

    if (outcome === "Settled") {
      nextPair.jobsSettled += 1;
      nextPair.volumeSettled += amount;
      next.jobsSettled += 1;
      next.volumeSettled += amount;
      next.lastSettledAt = toDate(ts);
      if (nextPair.jobsSettled === 1) next.settledHirers += 1;
      if (nextPair.jobsSettled === 2) next.repeatHirers += 1;
      if (nextPair.volumeSettled > next.topHirerVolume) next.topHirerVolume = nextPair.volumeSettled;
      nextHirer.jobsSettled += 1;
      nextHirer.volumeSettled += amount;
      nextAgentDay.jobsSettled += 1;
      nextAgentDay.volumeSettled += amount;
      nextProtocolDay.jobsSettled += 1;
      nextProtocolDay.volumeSettled += amount;
      protocol.volumeSettled += amount;
    } else if (outcome === "Refunded") {
      next.jobsRefunded += 1;
      nextHirer.jobsRefunded += 1;
      nextAgentDay.jobsRefunded += 1;
      nextProtocolDay.jobsRefunded += 1;
      protocol.jobsRefunded += 1;
    } else {
      next.jobsDisputed += 1;
      nextHirer.jobsDisputed += 1;
      nextAgentDay.jobsDisputed += 1;
      nextProtocolDay.jobsDisputed += 1;
      protocol.jobsDisputed += 1;
    }
    if (firstStamp) protocol.agentsWithStamps += 1;

    context.Agent.set(derive(next));
    context.Hirer.set(nextHirer);
    context.AgentHirer.set(nextPair);
    context.AgentDay.set(nextAgentDay);
    context.ProtocolDay.set(nextProtocolDay);
    context.Protocol.set(protocol);
  },
);

indexer.onEvent(
  { contract: "AgentPassport", event: "FeedbackMirrored", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const ref = event.params.jobRef.toLowerCase();
    const stamp = await context.Stamp.get(ref);
    if (stamp) context.Stamp.set({ ...stamp, mirrored: event.params.ok });
    if (!event.params.ok) {
      const protocol = await loadProtocol(context, event.block.number, event.block.timestamp);
      protocol.mirrorFailures += 1;
      context.Protocol.set(protocol);
    }
  },
);

indexer.onEvent(
  { contract: "AgentPassport", event: "AttesterSet", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    context.Attester.set({ id: event.params.attester, allowed: event.params.allowed, updatedAt: toDate(event.block.timestamp) });
  },
);
