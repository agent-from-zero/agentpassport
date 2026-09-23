import { describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { scoreBreakdown } from "../src/lib/score.js";
import { AGENT_PASSPORT, JOB_ESCROW, SELECTOR, jobRefOf } from "../src/lib/util.js";

const CHAIN = 10143;
const USDC = "0x534b2f3a21130d7a60830c2df862319e593943a3";
const AGENT = 1908n;
const HIRER_A = "0x0ec686e8c3fae59dd0892a7c691752cf7b98ffba";
const HIRER_B = "0x00000000000000000000000000000000000000b2";
const RELAYER = "0x00000000000000000000000000000000000000c1";
const OWNER = "0x99e6c3fae6a1ebaed0bffffeb2b6443fac595a28";
const T0 = 1_790_000_000;
/** Simulated blocks must sit after config.yaml's start_block or the indexer skips them. */
const B = 64_500_000;
/** Handler-level `fields` selections are not reflected in simulate() typings; the runtime accepts them. */
const sim = (items: object[]) => items as never[];
const tx = (n: number) => "0x" + n.toString(16).padStart(64, "0");

/** Seeds the agent so handlers never need the identity RPC effect (tests stay offline). */
function seededIndexer() {
  const indexer = createTestIndexer();
  indexer.Agent.set({
    id: AGENT.toString(),
    agentId: AGENT,
    owner: OWNER,
    agentWallet: OWNER,
    agentURI: "https://agentfromzero.netlify.app/.well-known/agent-card.json",
    registeredAt: undefined,
    registrationIndexed: false,
    jobsOpened: 0,
    jobsDelivered: 0,
    jobsSettled: 0,
    jobsRefunded: 0,
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
    scoreVersion: 1,
    lastActivityAt: undefined,
  });
  return indexer;
}

type Opts = { jobId: bigint; hirer: string; amount: bigint; at: number; block: number; gasless?: boolean };

/** open -> deliver -> release (by hirer) -> Attested(Settled) -> NewFeedback -> FeedbackMirrored, as JobEscrow emits them. */
function settledJob(o: Opts, feedbackIndex: bigint) {
  const ref = jobRefOf(o.jobId);
  return [
    {
      contract: "JobEscrow" as const,
      event: "JobOpened" as const,
      srcAddress: JOB_ESCROW as `0x${string}`,
      block: { number: o.block, timestamp: o.at },
      transaction: {
        hash: tx(o.block),
        from: (o.gasless ? RELAYER : o.hirer) as `0x${string}`,
        input: "0x" + (o.gasless ? SELECTOR.openWithAuthorization : SELECTOR.open) + "00",
      },
      params: {
        jobId: o.jobId,
        agentId: AGENT,
        hirer: o.hirer as `0x${string}`,
        token: USDC as `0x${string}`,
        amount: o.amount,
        deadline: BigInt(o.at + 3600),
        specHash: tx(99),
        endpoint: "scorecard",
      },
    },
    {
      contract: "JobEscrow" as const,
      event: "JobDelivered" as const,
      block: { number: o.block + 1, timestamp: o.at + 120 },
      transaction: { hash: tx(o.block + 1), from: OWNER as `0x${string}` },
      params: { jobId: o.jobId, agentId: AGENT, deliverableHash: tx(7), deliverableURI: `https://example.test/jobs/${o.jobId}` },
    },
    {
      contract: "JobEscrow" as const,
      event: "JobReleased" as const,
      block: { number: o.block + 2, timestamp: o.at + 200 },
      transaction: { hash: tx(o.block + 2), from: o.hirer as `0x${string}`, input: "0x" + SELECTOR.release },
      params: { jobId: o.jobId, agentId: AGENT, releasedBy: o.hirer as `0x${string}`, amount: o.amount },
    },
    {
      contract: "AgentPassport" as const,
      event: "Attested" as const,
      block: { number: o.block + 2, timestamp: o.at + 200 },
      transaction: { hash: tx(o.block + 2) },
      params: { agentId: AGENT, attester: JOB_ESCROW as `0x${string}`, jobRef: ref, outcome: 0n, token: USDC as `0x${string}`, amount: o.amount, hirer: o.hirer as `0x${string}` },
    },
    {
      contract: "ReputationRegistry" as const,
      event: "NewFeedback" as const,
      block: { number: o.block + 2, timestamp: o.at + 200 },
      transaction: { hash: tx(o.block + 2) },
      params: {
        agentId: AGENT,
        clientAddress: AGENT_PASSPORT as `0x${string}`,
        feedbackIndex,
        value: 100n,
        valueDecimals: 2n,
        indexedTag1: tx(5),
        tag1: "agentpassport",
        tag2: "settled",
        endpoint: "scorecard",
        feedbackURI: "",
        feedbackHash: ref,
      },
    },
    {
      contract: "AgentPassport" as const,
      event: "FeedbackMirrored" as const,
      block: { number: o.block + 2, timestamp: o.at + 200 },
      params: { agentId: AGENT, jobRef: ref, ok: true },
    },
  ];
}

describe("AgentPassport indexer", () => {
  it("indexes a gasless job end to end: job, stamp, escrow-backed feedback, aggregates", async (t) => {
    const indexer = seededIndexer();
    await indexer.process({
      chains: { [CHAIN]: { simulate: sim(settledJob({ jobId: 3n, hirer: HIRER_A, amount: 500_000n, at: T0, block: 64934042, gasless: true }, 2n)) } },
    });

    const job = await indexer.Job.getOrThrow("3");
    t.expect(job.status).toBe("Released");
    t.expect(job.gasless).toBe(true);
    t.expect(job.openedBy).toBe(RELAYER);
    t.expect(job.deliverySeconds).toBe(120);
    t.expect(job.onTime).toBe(true);
    t.expect(job.releasePath).toBe("Hirer");
    t.expect(job.jobRef).toBe(jobRefOf(3n));
    t.expect(job.stamp_id).toBe(jobRefOf(3n));

    const stamp = await indexer.Stamp.getOrThrow(jobRefOf(3n));
    t.expect(stamp.outcome).toBe("Settled");
    t.expect(stamp.job_id).toBe("3");
    t.expect(stamp.mirrored).toBe(true);

    const fb = await indexer.Feedback.getOrThrow(`1908-${AGENT_PASSPORT}-2`);
    t.expect(fb.escrowBacked).toBe(true);
    t.expect(fb.stamp_id).toBe(jobRefOf(3n));

    const agent = await indexer.Agent.getOrThrow("1908");
    t.expect(agent.jobsOpened).toBe(1);
    t.expect(agent.jobsSettled).toBe(1);
    t.expect(agent.volumeSettled).toBe(500_000n);
    t.expect(agent.settledHirers).toBe(1);
    t.expect(agent.repeatHirers).toBe(0);
    t.expect(agent.topHirerShareBps).toBe(10000);
    t.expect(agent.escrowBackedShareBps).toBe(10000);
    t.expect(agent.avgDeliverySeconds).toBe(120);
    // 1 settled job: activity 6, volume floor(log10(1)*5)=0, diversity 5, repeat 0, reliability 25
    t.expect(agent.score).toBe(36);

    const hirer = await indexer.Hirer.getOrThrow(HIRER_A);
    t.expect(hirer.gaslessOpens).toBe(1);
    t.expect(hirer.jobsSettled).toBe(1);

    const protocol = await indexer.Protocol.getOrThrow("10143");
    t.expect(protocol.jobsOpened).toBe(1);
    t.expect(protocol.jobsReleased).toBe(1);
    t.expect(protocol.gaslessOpens).toBe(1);
    t.expect(protocol.feedbackEscrowBacked).toBe(1);
    t.expect(protocol.hirers).toBe(1);
    t.expect(protocol.agentsWithStamps).toBe(1);
  });

  it("derives repeat hirers, hirer concentration and the score from several hirers", async (t) => {
    const indexer = seededIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: sim([
            ...settledJob({ jobId: 10n, hirer: HIRER_A, amount: 40_000_000n, at: T0, block: B + 100 }, 1n),
            ...settledJob({ jobId: 11n, hirer: HIRER_A, amount: 40_000_000n, at: T0 + 1000, block: B + 110 }, 2n),
            ...settledJob({ jobId: 12n, hirer: HIRER_B, amount: 20_000_000n, at: T0 + 2000, block: B + 120 }, 3n),
          ]),
        },
      },
    });
    const agent = await indexer.Agent.getOrThrow("1908");
    t.expect(agent.jobsSettled).toBe(3);
    t.expect(agent.settledHirers).toBe(2);
    t.expect(agent.repeatHirers).toBe(1);
    t.expect(agent.topHirerVolume).toBe(80_000_000n);
    t.expect(agent.topHirerShareBps).toBe(8000);
    const expected = scoreBreakdown({
      jobsSettled: 3, jobsRefunded: 0, jobsDisputed: 0, volumeSettled: 100_000_000n,
      settledHirers: 2, repeatHirers: 1, topHirerShareBps: 8000,
    });
    // 18 + floor(log10(101)*5)=10 + 10 + 5 + 25 = 68
    t.expect(expected.score).toBe(68);
    t.expect(agent.score).toBe(expected.score);

    const pairA = await indexer.AgentHirer.getOrThrow(`1908-${HIRER_A}`);
    t.expect(pairA.jobsSettled).toBe(2);
    const day = await indexer.ProtocolDay.getOrThrow(String(Math.floor(T0 / 86400)));
    t.expect(day.jobsSettled).toBe(3);
    t.expect(day.activeAgents).toBe(1);
  });

  it("counts refunds against reliability and never lets unbacked feedback raise the score", async (t) => {
    const indexer = seededIndexer();
    const ref = jobRefOf(2n);
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: sim([
            ...settledJob({ jobId: 1n, hirer: HIRER_A, amount: 5_000_000n, at: T0, block: B + 200 }, 1n),
            {
              contract: "JobEscrow",
              event: "JobOpened",
              block: { number: B + 210, timestamp: T0 + 100 },
              transaction: { hash: tx(B + 210), from: HIRER_A as `0x${string}`, input: "0x" + SELECTOR.open },
              params: { jobId: 2n, agentId: AGENT, hirer: HIRER_A as `0x${string}`, token: USDC as `0x${string}`, amount: 1_000_000n, deadline: BigInt(T0 + 160), specHash: tx(98), endpoint: "census" },
            },
            {
              contract: "JobEscrow",
              event: "JobRefunded",
              block: { number: B + 220, timestamp: T0 + 400 },
              transaction: { hash: tx(B + 220) },
              params: { jobId: 2n, agentId: AGENT, amount: 1_000_000n },
            },
            {
              contract: "AgentPassport",
              event: "Attested",
              block: { number: B + 220, timestamp: T0 + 400 },
              transaction: { hash: tx(B + 220) },
              params: { agentId: AGENT, attester: JOB_ESCROW as `0x${string}`, jobRef: ref, outcome: 1n, token: USDC as `0x${string}`, amount: 0n, hirer: HIRER_A as `0x${string}` },
            },
            {
              contract: "ReputationRegistry",
              event: "NewFeedback",
              block: { number: B + 230, timestamp: T0 + 500 },
              transaction: { hash: tx(B + 230) },
              params: {
                agentId: AGENT, clientAddress: HIRER_B as `0x${string}`, feedbackIndex: 1n, value: 100n, valueDecimals: 2n,
                indexedTag1: tx(6), tag1: "starred", tag2: "", endpoint: "", feedbackURI: "", feedbackHash: tx(0),
              },
            },
          ]),
        },
      },
    });
    const job = await indexer.Job.getOrThrow("2");
    t.expect(job.status).toBe("Refunded");
    t.expect(job.gasless).toBe(false);
    const agent = await indexer.Agent.getOrThrow("1908");
    t.expect(agent.jobsSettled).toBe(1);
    t.expect(agent.jobsRefunded).toBe(1);
    t.expect(agent.feedbackCount).toBe(2);
    t.expect(agent.feedbackEscrowBacked).toBe(1);
    t.expect(agent.escrowBackedShareBps).toBe(5000);
    // activity 6 + volume floor(log10(6)*5)=3 + diversity 5 + repeat 0 + reliability floor(25/2)=12 = 26
    t.expect(agent.score).toBe(26);
    const unbacked = await indexer.Feedback.getOrThrow(`1908-${HIRER_B}-1`);
    t.expect(unbacked.escrowBacked).toBe(false);
  });

  it("recognises a passkey release relayed by a third party", async (t) => {
    const indexer = seededIndexer();
    const items = settledJob({ jobId: 20n, hirer: HIRER_A, amount: 2_000_000n, at: T0, block: B + 300 }, 1n);
    const release = items[2] as { transaction: { from: `0x${string}`; input: string } };
    release.transaction = { ...release.transaction, from: RELAYER as `0x${string}`, input: "0x" + SELECTOR.releaseWithPasskey + "00" };
    await indexer.process({ chains: { [CHAIN]: { simulate: sim([
      {
        contract: "JobEscrow",
        event: "PasskeyRegistered",
        block: { number: B + 299, timestamp: T0 - 10 },
        params: { hirer: HIRER_A as `0x${string}`, x: 1n, y: 2n },
      },
      ...items,
    ]) } } });
    const job = await indexer.Job.getOrThrow("20");
    t.expect(job.releasePath).toBe("Passkey");
    const hirer = await indexer.Hirer.getOrThrow(HIRER_A);
    t.expect(hirer.passkeyRegistered).toBe(true);
    t.expect(hirer.passkeyReleases).toBe(1);
    const protocol = await indexer.Protocol.getOrThrow("10143");
    t.expect(protocol.passkeyReleases).toBe(1);
  });

  it("tracks ERC-8004 registration, agentWallet and the wallet reset on transfer", async (t) => {
    const indexer = createTestIndexer();
    const owner = "0x00000000000000000000000000000000000000a1";
    const buyer = "0x00000000000000000000000000000000000000a2";
    await indexer.process({ chains: { [CHAIN]: { simulate: sim([
      { contract: "IdentityRegistry", event: "Transfer", block: { number: B + 400, timestamp: T0 }, params: { from: "0x0000000000000000000000000000000000000000", to: owner as `0x${string}`, tokenId: 4242n } },
      { contract: "IdentityRegistry", event: "Registered", block: { number: B + 400, timestamp: T0 }, params: { agentId: 4242n, agentURI: "ipfs://card", owner: owner as `0x${string}` } },
      { contract: "IdentityRegistry", event: "MetadataSet", block: { number: B + 400, timestamp: T0 }, params: { agentId: 4242n, indexedMetadataKey: tx(1), metadataKey: "agentWallet", metadataValue: owner } },
      { contract: "IdentityRegistry", event: "URIUpdated", block: { number: B + 401, timestamp: T0 + 5 }, params: { agentId: 4242n, newURI: "https://card.example/v2", updatedBy: owner as `0x${string}` } },
    ]) } } });
    let agent = await indexer.Agent.getOrThrow("4242");
    t.expect(agent.registrationIndexed).toBe(true);
    t.expect(agent.owner).toBe(owner);
    t.expect(agent.agentWallet).toBe(owner);
    t.expect(agent.agentURI).toBe("https://card.example/v2");
    t.expect(agent.score).toBe(0);

    await indexer.process({ chains: { [CHAIN]: { simulate: sim([
      { contract: "IdentityRegistry", event: "Transfer", block: { number: B + 500, timestamp: T0 + 100 }, params: { from: owner as `0x${string}`, to: buyer as `0x${string}`, tokenId: 4242n } },
    ]) } } });
    agent = await indexer.Agent.getOrThrow("4242");
    t.expect(agent.owner).toBe(buyer);
    t.expect(agent.agentWallet).toBeUndefined();
    const protocol = await indexer.Protocol.getOrThrow("10143");
    t.expect(protocol.agentsSeen).toBe(1);
  });
});

describe("score", () => {
  it("is zero without closed jobs and capped at 50 for a single paying hirer", (t) => {
    t.expect(scoreBreakdown({ jobsSettled: 0, jobsRefunded: 0, jobsDisputed: 0, volumeSettled: 0n, settledHirers: 0, repeatHirers: 0, topHirerShareBps: 0 }).score).toBe(0);
    const solo = scoreBreakdown({ jobsSettled: 10, jobsRefunded: 0, jobsDisputed: 0, volumeSettled: 10_000_000_000n, settledHirers: 1, repeatHirers: 1, topHirerShareBps: 10000 });
    t.expect(solo.cappedAt).toBe(50);
    t.expect(solo.score).toBe(50);
  });
  it("penalises disputes and concentration", (t) => {
    const diverse = scoreBreakdown({ jobsSettled: 5, jobsRefunded: 0, jobsDisputed: 0, volumeSettled: 1_000_000_000n, settledHirers: 4, repeatHirers: 2, topHirerShareBps: 4000 });
    t.expect(diverse.score).toBe(30 + 15 + 20 + 10 + 25);
    const disputed = scoreBreakdown({ jobsSettled: 5, jobsRefunded: 0, jobsDisputed: 1, volumeSettled: 1_000_000_000n, settledHirers: 4, repeatHirers: 2, topHirerShareBps: 9000 });
    t.expect(disputed.disputePenalty).toBe(15);
    t.expect(disputed.concentrationPenalty).toBe(10);
    t.expect(disputed.score).toBe(30 + 15 + 20 + 10 + Math.floor(125 / 6) - 15 - 10);
  });
});
