/**
 * JobEscrow handlers: the job lifecycle (open -> deliver -> release | refund | dispute).
 *
 * Outcome counters (settled / refunded / disputed, volumes, hirer structure, score) are driven by
 * the AgentPassport `Attested` event in passport.ts, so the indexed passport always equals the
 * on-chain `passportOf`. This file records *how* each job happened: who opened it and whether
 * gaslessly, delivery latency and punctuality, and which path released the money.
 */
import { indexer } from "envio";
import { readIdentity, readJobVerifier } from "../lib/effects.js";
import { derive, loadAgent, loadDays, loadHirer, loadPair, loadProtocol } from "../lib/store.js";
import { SELECTOR, jobRefOf, selectorOf, toDate } from "../lib/util.js";

indexer.onEvent(
  { contract: "JobEscrow", event: "JobOpened", fields: { transaction: ["hash", "from", "input"], block: ["timestamp"] } },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const { jobId, agentId, hirer, token, amount, deadline, specHash, endpoint } = event.params;
    const protocol = await loadProtocol(context, event.block.number, ts);
    const { agent: found, created } = await loadAgent(context, agentId, protocol);
    const hirerEntity = await loadHirer(context, hirer, ts, protocol);
    const { pair, created: newPair } = await loadPair(context, found.id, hirer, ts);
    const { agentDay, protocolDay } = await loadDays(context, found.id, ts);

    let agent = found;
    if (created || (!agent.registrationIndexed && agent.owner === undefined)) {
      // Registered before our start block: take identity from chain state once.
      const id = await context.effect(readIdentity, agent.id);
      agent = { ...agent, owner: id.owner ?? undefined, agentWallet: id.agentWallet ?? undefined, agentURI: id.agentURI ?? undefined };
    }

    const sel = selectorOf(event.transaction.input);
    const from = event.transaction.from?.toLowerCase() ?? hirer;
    // Direct openWithAuthorization, or a relayed/wrapped call that the hirer did not send itself.
    const gasless = sel === SELECTOR.openWithAuthorization || (sel !== SELECTOR.open && from !== hirer);

    const jobRef = jobRefOf(jobId, event.srcAddress);
    context.JobRef.set({ id: jobRef, job_id: jobId.toString() });
    context.Job.set({
      id: jobId.toString(),
      jobId,
      agent_id: agent.id,
      hirer_id: hirer,
      token,
      amount,
      deadline: toDate(Number(deadline)),
      specHash,
      endpoint,
      status: "Open",
      jobRef,
      gasless,
      openedBy: from,
      openedAt: toDate(ts),
      openedBlock: event.block.number,
      openTx: event.transaction.hash,
      deliveredAt: undefined,
      deliveredBy: undefined,
      deliverableHash: undefined,
      deliverableURI: undefined,
      deliverTx: undefined,
      deliverySeconds: undefined,
      onTime: undefined,
      closedAt: undefined,
      closeTx: undefined,
      releasedBy: undefined,
      releasePath: undefined,
      stamp_id: undefined,
    });

    context.Agent.set(
      derive({
        ...agent,
        jobsOpened: agent.jobsOpened + 1,
        volumeEscrowed: agent.volumeEscrowed + amount,
        firstJobAt: agent.firstJobAt ?? toDate(ts),
        lastActivityAt: toDate(ts),
      }),
    );
    context.Hirer.set({
      ...hirerEntity,
      jobsOpened: hirerEntity.jobsOpened + 1,
      volumeEscrowed: hirerEntity.volumeEscrowed + amount,
      agentsHired: hirerEntity.agentsHired + (newPair ? 1 : 0),
      gaslessOpens: hirerEntity.gaslessOpens + (gasless ? 1 : 0),
      lastSeenAt: toDate(ts),
    });
    context.AgentHirer.set({ ...pair, jobsOpened: pair.jobsOpened + 1, lastAt: toDate(ts) });
    context.AgentDay.set({ ...agentDay, jobsOpened: agentDay.jobsOpened + 1 });
    context.ProtocolDay.set({
      ...protocolDay,
      jobsOpened: protocolDay.jobsOpened + 1,
      volumeEscrowed: protocolDay.volumeEscrowed + amount,
    });
    protocol.jobsOpened += 1;
    protocol.volumeEscrowed += amount;
    if (gasless) protocol.gaslessOpens += 1;
    context.Protocol.set(protocol);
  },
);

indexer.onEvent(
  { contract: "JobEscrow", event: "JobDelivered", fields: { transaction: ["hash", "from"], block: ["timestamp"] } },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const { jobId, agentId, deliverableHash, deliverableURI } = event.params;
    const [job, agent, protocol] = await Promise.all([
      context.Job.get(jobId.toString()),
      context.Agent.get(agentId.toString()),
      loadProtocol(context, event.block.number, ts),
    ]);
    if (!job || !agent) {
      context.log.warn(`JobDelivered for unknown job ${jobId}`);
      return;
    }
    const deliverySeconds = Math.max(0, ts - Math.floor(job.openedAt.getTime() / 1000));
    const onTime = ts <= Math.floor(job.deadline.getTime() / 1000);
    context.Job.set({
      ...job,
      status: "Delivered",
      deliveredAt: toDate(ts),
      deliveredBy: event.transaction.from?.toLowerCase(),
      deliverableHash,
      deliverableURI,
      deliverTx: event.transaction.hash,
      deliverySeconds,
      onTime,
    });
    context.Agent.set(
      derive({
        ...agent,
        jobsDelivered: agent.jobsDelivered + 1,
        deliverySecondsTotal: agent.deliverySecondsTotal + BigInt(deliverySeconds),
        onTimeDeliveries: agent.onTimeDeliveries + (onTime ? 1 : 0),
        lastActivityAt: toDate(ts),
      }),
    );
    protocol.jobsDelivered += 1;
    context.Protocol.set(protocol);
  },
);

indexer.onEvent(
  { contract: "JobEscrow", event: "JobReleased", fields: { transaction: ["hash", "from", "input"], block: ["timestamp"] } },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const { jobId, releasedBy } = event.params;
    const [job, protocol] = await Promise.all([
      context.Job.get(jobId.toString()),
      loadProtocol(context, event.block.number, ts),
    ]);
    if (!job) {
      context.log.warn(`JobReleased for unknown job ${jobId}`);
      return;
    }
    let releasePath: "Hirer" | "Verifier" | "Passkey" | "ReviewWindow";
    if (releasedBy === job.hirer_id) {
      // releaseWithPasskey reports the hirer as releaser whoever submits the transaction.
      releasePath = selectorOf(event.transaction.input) === SELECTOR.releaseWithPasskey ? "Passkey" : "Hirer";
    } else {
      const verifier = await context.effect(readJobVerifier, jobId.toString());
      releasePath = verifier === releasedBy ? "Verifier" : "ReviewWindow";
    }
    context.Job.set({ ...job, status: "Released", closedAt: toDate(ts), closeTx: event.transaction.hash, releasedBy, releasePath, stamp_id: job.jobRef });
    if (releasePath === "Passkey") {
      const hirer = await context.Hirer.get(job.hirer_id);
      if (hirer) context.Hirer.set({ ...hirer, passkeyReleases: hirer.passkeyReleases + 1 });
      protocol.passkeyReleases += 1;
    }
    protocol.jobsReleased += 1;
    context.Protocol.set(protocol);
  },
);

indexer.onEvent(
  { contract: "JobEscrow", event: "JobRefunded", fields: { transaction: ["hash"], block: ["timestamp"] } },
  async ({ event, context }) => {
    const job = await context.Job.get(event.params.jobId.toString());
    if (!job) return;
    context.Job.set({ ...job, status: "Refunded", closedAt: toDate(event.block.timestamp), closeTx: event.transaction.hash, stamp_id: job.jobRef });
  },
);

indexer.onEvent(
  { contract: "JobEscrow", event: "JobDisputed", fields: { transaction: ["hash"], block: ["timestamp"] } },
  async ({ event, context }) => {
    const job = await context.Job.get(event.params.jobId.toString());
    if (!job) return;
    context.Job.set({ ...job, status: "Disputed", closedAt: toDate(event.block.timestamp), closeTx: event.transaction.hash, stamp_id: job.jobRef });
  },
);

indexer.onEvent(
  { contract: "JobEscrow", event: "PasskeyRegistered", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const protocol = await loadProtocol(context, event.block.number, ts);
    const hirer = await loadHirer(context, event.params.hirer, ts, protocol);
    context.Hirer.set({ ...hirer, passkeyRegistered: true, lastSeenAt: toDate(ts) });
    context.Protocol.set(protocol);
  },
);
