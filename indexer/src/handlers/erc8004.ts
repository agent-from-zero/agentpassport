/**
 * ERC-8004 registry handlers. Every agent that registers, changes its wallet/URI or receives
 * feedback gets an Agent row, so any ERC-8004 agent on Monad testnet has a passport view - even
 * one that has never been hired through the escrow (its escrow counters are simply zero).
 *
 * Feedback is split into escrow-backed (written by the AgentPassport contract, feedbackHash = a
 * stamp's jobRef, i.e. money moved) and everything else (anyone can post it, nothing backs it).
 */
import { indexer } from "envio";
import { readIdentity } from "../lib/effects.js";
import { derive, loadAgent, loadDays, loadProtocol } from "../lib/store.js";
import { AGENT_PASSPORT, ZERO_ADDRESS, decodeAgentWallet, toDate } from "../lib/util.js";

indexer.onEvent(
  { contract: "IdentityRegistry", event: "Registered", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const protocol = await loadProtocol(context, event.block.number, ts);
    const { agent } = await loadAgent(context, event.params.agentId, protocol);
    context.Agent.set({
      ...agent,
      owner: event.params.owner,
      agentURI: event.params.agentURI || agent.agentURI,
      registeredAt: toDate(ts),
      registrationIndexed: true,
      lastActivityAt: agent.lastActivityAt ?? toDate(ts),
    });
    context.Protocol.set(protocol);
  },
);

indexer.onEvent(
  { contract: "IdentityRegistry", event: "MetadataSet", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    if (event.params.metadataKey !== "agentWallet") return;
    const protocol = await loadProtocol(context, event.block.number, event.block.timestamp);
    const { agent } = await loadAgent(context, event.params.agentId, protocol);
    context.Agent.set({ ...agent, agentWallet: decodeAgentWallet(event.params.metadataValue) });
    context.Protocol.set(protocol);
  },
);

indexer.onEvent(
  { contract: "IdentityRegistry", event: "URIUpdated", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const protocol = await loadProtocol(context, event.block.number, event.block.timestamp);
    const { agent } = await loadAgent(context, event.params.agentId, protocol);
    context.Agent.set({ ...agent, agentURI: event.params.newURI });
    context.Protocol.set(protocol);
  },
);

indexer.onEvent(
  { contract: "IdentityRegistry", event: "Transfer", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const { from, to, tokenId } = event.params;
    if (to === ZERO_ADDRESS) return; // burns are not part of the registry's lifecycle today
    const protocol = await loadProtocol(context, event.block.number, event.block.timestamp);
    const { agent } = await loadAgent(context, tokenId, protocol);
    // On a real transfer the registry clears agentWallet (and emits MetadataSet for it).
    context.Agent.set({ ...agent, owner: to, agentWallet: from === ZERO_ADDRESS ? agent.agentWallet : undefined });
    context.Protocol.set(protocol);
  },
);

indexer.onEvent(
  { contract: "ReputationRegistry", event: "NewFeedback", fields: { transaction: ["hash"], block: ["timestamp"] } },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const p = event.params;
    const hash = p.feedbackHash.toLowerCase();
    const protocol = await loadProtocol(context, event.block.number, ts);
    const { agent: found, created } = await loadAgent(context, p.agentId, protocol);
    const stamp = p.clientAddress === AGENT_PASSPORT ? await context.Stamp.get(hash) : undefined;
    const { agentDay, protocolDay } = await loadDays(context, found.id, ts);

    let agent = found;
    if (created) {
      const id = await context.effect(readIdentity, agent.id);
      agent = { ...agent, owner: id.owner ?? undefined, agentWallet: id.agentWallet ?? undefined, agentURI: id.agentURI ?? undefined };
    }
    const escrowBacked = stamp !== undefined;

    context.Feedback.set({
      id: `${agent.id}-${p.clientAddress}-${p.feedbackIndex}`,
      agent_id: agent.id,
      client: p.clientAddress,
      feedbackIndex: p.feedbackIndex,
      value: p.value,
      valueDecimals: Number(p.valueDecimals),
      tag1: p.tag1,
      tag2: p.tag2,
      endpoint: p.endpoint,
      feedbackURI: p.feedbackURI,
      feedbackHash: hash,
      escrowBacked,
      stamp_id: stamp?.id,
      revoked: false,
      timestamp: toDate(ts),
      block: event.block.number,
      tx: event.transaction.hash,
    });
    context.Agent.set(
      derive({
        ...agent,
        feedbackCount: agent.feedbackCount + 1,
        feedbackEscrowBacked: agent.feedbackEscrowBacked + (escrowBacked ? 1 : 0),
        lastActivityAt: toDate(ts),
      }),
    );
    context.AgentDay.set({ ...agentDay, feedback: agentDay.feedback + 1 });
    context.ProtocolDay.set({ ...protocolDay, feedback: protocolDay.feedback + 1 });
    protocol.feedbackTotal += 1;
    if (escrowBacked) protocol.feedbackEscrowBacked += 1;
    context.Protocol.set(protocol);
  },
);

indexer.onEvent(
  { contract: "ReputationRegistry", event: "FeedbackRevoked" },
  async ({ event, context }) => {
    const p = event.params;
    const id = `${p.agentId}-${p.clientAddress}-${p.feedbackIndex}`;
    const [feedback, agent] = await Promise.all([context.Feedback.get(id), context.Agent.get(p.agentId.toString())]);
    if (!feedback || feedback.revoked) return;
    context.Feedback.set({ ...feedback, revoked: true });
    if (agent) {
      context.Agent.set(
        derive({
          ...agent,
          feedbackRevoked: agent.feedbackRevoked + 1,
          feedbackEscrowBacked: agent.feedbackEscrowBacked - (feedback.escrowBacked ? 1 : 0),
        }),
      );
    }
  },
);
