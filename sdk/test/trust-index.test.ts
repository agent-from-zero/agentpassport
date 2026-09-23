// Index / Nansen trust rules: pure functions over indexer rows and Nansen profiles (no network).
import { describe, expect, it } from "vitest";
import { evaluateIndexPolicy, fetchIndexSnapshot, fromRawAgent, queryIndexedAgent, toIndexPolicy, type CounterpartyIntel, type RawAgent } from "../src/index.js";

const OWNER = "0x99e6c3fae6a1ebaed0bffffeb2b6443fac595a28";
const HIRER_A = "0x0ec686e8c3fae59dd0892a7c691752cf7b98ffba";
const HIRER_B = "0x00000000000000000000000000000000000000b2";
const HIRER_C = "0x00000000000000000000000000000000000000c3";

const raw = (over: Partial<RawAgent> = {}): RawAgent => ({
  id: "1908",
  owner: OWNER,
  agentWallet: OWNER,
  agentURI: "https://agentfromzero.netlify.app/.well-known/agent-card.json",
  jobsOpened: 4,
  jobsDelivered: 3,
  jobsSettled: 3,
  jobsRefunded: 1,
  jobsDisputed: 0,
  volumeSettled: "6000000",
  settledHirers: 1,
  repeatHirers: 1,
  topHirerShareBps: 10000,
  feedbackCount: 3,
  feedbackEscrowBacked: 3,
  feedbackRevoked: 0,
  escrowBackedShareBps: 10000,
  avgDeliverySeconds: 167,
  onTimeDeliveries: 3,
  score: 50,
  firstJobAt: "2026-09-21T10:00:00Z",
  lastSettledAt: "2026-09-23T09:25:42Z",
  hirers: [{ hirer_id: HIRER_A, jobsSettled: 3, volumeSettled: "6000000" }],
  ...over,
});

const profile = (address: string, over: Partial<CounterpartyIntel> = {}): CounterpartyIntel => ({
  address,
  firstFunder: null,
  footprintUsd: 0,
  chains: [],
  related: [],
  flags: [],
  visible: false,
  fetchedAt: "2026-09-23T10:00:00Z",
  ...over,
});

describe("fromRawAgent + Nansen join", () => {
  it("no Nansen data: coverage none, nothing weighted", () => {
    const a = fromRawAgent(raw());
    expect(a.intel).toMatchObject({ coverage: "none", weightedHirers: 0, linkedHirers: 0, flagged: [] });
    expect(a.hirers[0]).toMatchObject({ address: HIRER_A, linkedToAgent: false, weighted: false, intel: null });
  });

  it("a hirer Nansen cannot see is profiled but not weighted", () => {
    const a = fromRawAgent(raw(), { [HIRER_A]: profile(HIRER_A), [OWNER]: profile(OWNER) });
    expect(a.intel.coverage).toBe("nansen");
    expect(a.intel.weightedHirers).toBe(0);
  });

  it("weights visible, independent hirers; flags self-funded and risky ones", () => {
    const a = fromRawAgent(
      raw({
        settledHirers: 3,
        hirers: [
          { hirer_id: HIRER_A, jobsSettled: 2, volumeSettled: "4000000" },
          { hirer_id: HIRER_B, jobsSettled: 1, volumeSettled: "1000000" },
          { hirer_id: HIRER_C, jobsSettled: 1, volumeSettled: "1000000" },
        ],
      }),
      {
        // funded by the agent's own owner: self-dealing
        [HIRER_A]: profile(HIRER_A, { visible: true, firstFunder: { address: OWNER, name: null, chain: "monad", tx: null, at: null } }),
        // independent, with mainnet history
        [HIRER_B]: profile(HIRER_B, { visible: true, footprintUsd: 1200, chains: ["ethereum"], firstFunder: { address: "0xcex", name: "Binance: Hot Wallet", chain: "ethereum", tx: null, at: null } }),
        // funded through a mixer
        [HIRER_C]: profile(HIRER_C, { visible: true, flags: ["mixer"], firstFunder: { address: "0xmix", name: "Tornado Cash", chain: "ethereum", tx: null, at: null } }),
      },
    );
    expect(a.hirers.map((h) => [h.address, h.linkedToAgent, h.weighted])).toEqual([
      [HIRER_A, true, false],
      [HIRER_B, false, true],
      [HIRER_C, false, false],
    ]);
    expect(a.intel).toMatchObject({ weightedHirers: 1, linkedHirers: 1, coverage: "partial" });
    expect(a.intel.flagged).toEqual([`hirer ${HIRER_C}: mixer`]);
  });

  it("a related wallet equal to the agent's wallet also links the hirer", () => {
    const a = fromRawAgent(raw(), { [HIRER_A]: profile(HIRER_A, { visible: true, related: [{ address: OWNER.toUpperCase().replace("0X", "0x"), label: null, relation: "funded", chain: "monad" }] }) });
    expect(a.hirers[0]!.linkedToAgent).toBe(true);
  });

  it("ignores hirers that never settled", () => {
    const a = fromRawAgent(raw({ hirers: [{ hirer_id: HIRER_A, jobsSettled: 3, volumeSettled: "6000000" }, { hirer_id: HIRER_B, jobsSettled: 0, volumeSettled: "0" }] }));
    expect(a.hirers.map((h) => h.address)).toEqual([HIRER_A]);
  });
});

describe("evaluateIndexPolicy", () => {
  it("agentfromzero today: real escrow money, one hirer Nansen cannot vouch for", () => {
    const a = fromRawAgent(raw(), { [HIRER_A]: profile(HIRER_A), [OWNER]: profile(OWNER) });
    const r = evaluateIndexPolicy(a, { minIndexScore: 40, minEscrowBackedFeedbackShareBps: 5000, minDistinctHirers: 2, maxTopHirerShareBps: 8000, minWeightedHirers: 1, maxLinkedHirers: 0, forbidFlagged: true });
    expect(Object.fromEntries(r.checks.map((c) => [c.rule, c.ok]))).toEqual({
      minIndexScore: true,
      minEscrowBackedFeedbackShareBps: true,
      minDistinctHirers: false,
      maxTopHirerShareBps: false,
      minWeightedHirers: false,
      maxLinkedHirers: true,
      forbidFlagged: true,
    });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.rule === "minWeightedHirers")).toMatchObject({ source: "nansen", actual: "0 of 1 hirers" });
  });

  it("Nansen rules fail closed without Nansen data; unknown agents fail every rule", () => {
    const noIntel = evaluateIndexPolicy(fromRawAgent(raw()), { maxLinkedHirers: 5, forbidFlagged: true });
    expect(noIntel.checks.every((c) => !c.ok && c.actual === "no Nansen data")).toBe(true);
    const unknown = evaluateIndexPolicy(undefined, { minIndexScore: 0, minDistinctHirers: 0 });
    expect(unknown.ok).toBe(false);
    expect(unknown.checks.map((c) => c.actual)).toEqual(["not indexed", "not indexed"]);
  });

  it("feedback share needs at least one feedback entry; concentration needs a settled hirer", () => {
    const a = fromRawAgent(raw({ feedbackCount: 0, feedbackEscrowBacked: 0, escrowBackedShareBps: 0, settledHirers: 0, topHirerShareBps: 0, hirers: [] }));
    const r = evaluateIndexPolicy(a, { minEscrowBackedFeedbackShareBps: 0, maxTopHirerShareBps: 10000 });
    expect(r.checks.map((c) => c.ok)).toEqual([false, false]);
  });

  it("index freshness", () => {
    const a = fromRawAgent(raw());
    const now = new Date("2026-09-23T10:00:00Z");
    expect(evaluateIndexPolicy(a, { maxIndexAgeSeconds: 600 }, { blockTime: "2026-09-23T09:55:00Z", now }).ok).toBe(true);
    expect(evaluateIndexPolicy(a, { maxIndexAgeSeconds: 60 }, { blockTime: "2026-09-23T09:55:00Z", now }).checks[0]!.actual).toBe("300s");
    expect(evaluateIndexPolicy(a, { maxIndexAgeSeconds: 60 }, { blockTime: null, now }).ok).toBe(false);
  });

  it("toIndexPolicy validates and ignores on-chain fields", () => {
    expect(toIndexPolicy({ minJobsSettled: 1, minIndexScore: "40", forbidFlagged: true })).toEqual({ minIndexScore: 40, forbidFlagged: true });
    expect(() => toIndexPolicy({ minIndexScore: -1 })).toThrow(/non-negative integer/);
    expect(() => toIndexPolicy({ forbidFlagged: "yes" })).toThrow(/true or false/);
  });
});

describe("loaders", () => {
  it("fetchIndexSnapshot checks the schema", async () => {
    const ok = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    await expect(fetchIndexSnapshot("x", ok({ schema: "nope" }))).rejects.toThrow(/unexpected schema/);
    const snap = await fetchIndexSnapshot("x", ok({ schema: "agentpassport/index-snapshot@1", agents: {} }));
    expect(snap.agents).toEqual({});
  });

  it("queryIndexedAgent maps a GraphQL row", async () => {
    let sent: { query: string; variables: { id: string } } | undefined;
    const f = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: { Agent: [raw()], _meta: [{ progressBlock: 64981163, progressBlockTime: "2026-09-23T09:40:00Z" }] } }));
    }) as unknown as typeof fetch;
    const { agent, block } = await queryIndexedAgent("http://localhost:8088/v1/graphql", 1908n, f);
    expect(sent?.variables).toEqual({ id: "1908" });
    expect(block).toEqual({ number: 64981163, time: "2026-09-23T09:40:00Z" });
    expect(agent).toMatchObject({ agentId: "1908", score: 50, settledHirers: 1, jobs: { settled: 3, refunded: 1 } });
  });
});
