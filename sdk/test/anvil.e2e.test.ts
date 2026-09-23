// End-to-end against a local anvil node running the real AgentPassport + JobEscrow bytecode (from
// `forge build`) wired to mock ERC-8004 registries and a mock EIP-3009 USDC. Exercises every SDK
// write path the way an integrator would: hire, gasless hire, deliver, verify, release, refund, dispute.
import { createTestClient, http, type PublicClient, type WalletClient } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentPassportClient, JobStatus, POLICIES, hashContent, jobEscrowAbi, parseUsdc, toPolicy, type Deployment, type JobEvent } from "../src/index.js";
import { artifact, startDevChain, type DevChain, type Role } from "./harness.js";

let dev: DevChain;
let pub: PublicClient;
let chain: DevChain["chain"];
let deployment: Deployment;
let wallets: Record<Role, WalletClient>;
let sdk: Record<Role, AgentPassportClient>;
let agentId: bigint;
let rpc: string;
let send: DevChain["send"];
let usdcBalance: DevChain["usdcBalance"];

beforeAll(async () => {
  dev = await startDevChain();
  ({ pub, chain, deployment, wallets, sdk, agentId, rpc, send, usdcBalance } = dev);
});

afterAll(() => dev?.stop());

describe("AgentPassport SDK on anvil", () => {
  it("fresh agent: empty passport, fails `proven`, passes the empty policy", async () => {
    const p = await sdk.hirer.getPassport(agentId);
    expect(p.jobsSettled).toBe(0n);
    expect(await sdk.hirer.meets(agentId, POLICIES.proven)).toBe(false);
    expect(await sdk.hirer.meets(agentId, {})).toBe(true);
  });

  it("hire -> deliver -> verifyDelivery -> release stamps the passport and pays the agent", async () => {
    const spec = "summarise https://example.com";
    const hired = await sdk.hirer.hire({ agentId, amount: parseUsdc("5"), specHash: hashContent(spec), endpoint: "summarise" });
    expect(hired.jobId).toBe(1n);
    expect(hired.approveHash).toMatch(/^0x/);
    const job = await sdk.agent.getJob(1n);
    expect(job).toMatchObject({ status: JobStatus.Open, amount: 5_000_000n, hirer: wallets.hirer.account!.address, specHash: hashContent(spec) });

    // A stranger cannot deliver: simulation surfaces the decoded custom error, nothing is sent.
    await expect(sdk.stranger.deliver(1n, { uri: "https://x", content: "x" })).rejects.toThrow(/NotAgent/);

    const deliverable = JSON.stringify({ summary: "ok" });
    const uri = "https://agent.example/jobs/1/deliverable.json";
    const d = await sdk.agent.deliver(1n, { uri, content: deliverable });
    expect(d.deliverableHash).toBe(hashContent(deliverable));

    const delivery = await sdk.hirer.getDelivery(1n);
    expect(delivery).toMatchObject({ jobId: 1n, deliverableURI: uri, deliverableHash: d.deliverableHash, transactionHash: d.hash });

    const fakeFetch = (async (u: string) => {
      expect(u).toBe(uri);
      return new Response(deliverable);
    }) as typeof fetch;
    const v = await sdk.hirer.verifyDelivery(1n, fakeFetch);
    expect(v.ok).toBe(true);
    const tampered = (async () => new Response(deliverable + " ")) as typeof fetch;
    expect((await sdk.hirer.verifyDelivery(1n, tampered)).ok).toBe(false);

    const before = await usdcBalance(wallets.agent.account!.address);
    await sdk.hirer.release(1n);
    expect((await usdcBalance(wallets.agent.account!.address)) - before).toBe(5_000_000n);

    const p = await sdk.hirer.getPassport(agentId);
    expect(p).toMatchObject({ jobsSettled: 1n, volumeSettled: 5_000_000n, jobsDisputed: 0n, token: deployment.usdc });
    expect(await sdk.hirer.meets(agentId, POLICIES.proven)).toBe(true);
    expect(await sdk.hirer.settledBetween(wallets.hirer.account!.address, agentId)).toBe(1n);
  });

  it("gasless hire: hirer signs EIP-3009 only, the agent relays; nonce matches the contract", async () => {
    const stranger = sdk.stranger;
    const hirerMonBefore = await pub.getBalance({ address: wallets.hirer.account!.address });
    const { params, authorization } = await sdk.hirer.signHire({ agentId, amount: parseUsdc("2"), specHash: hashContent("gasless"), endpoint: "gasless" });
    const onChain = await pub.readContract({
      address: deployment.jobEscrow,
      abi: jobEscrowAbi,
      functionName: "openNonce",
      args: [params, authorization.validAfter, authorization.validBefore],
    });
    expect(authorization.nonce).toBe(onChain);

    // A relayer that rewrites the job (here: a bigger reviewWindow) is rejected.
    await expect(stranger.openWithAuthorization({ ...params, reviewWindow: params.reviewWindow + 1n }, authorization)).rejects.toThrow(/AuthorizationMismatch/);

    const opened = await sdk.agent.openWithAuthorization(params, authorization);
    expect(opened.jobId).toBe(2n);
    expect((await sdk.agent.getJob(2n)).hirer).toBe(wallets.hirer.account!.address);
    expect(await pub.getBalance({ address: wallets.hirer.account!.address })).toBe(hirerMonBefore); // hirer spent no gas

    // Replay of the same authorization fails (EIP-3009 nonce already used).
    await expect(sdk.agent.openWithAuthorization(params, authorization)).rejects.toThrow();
  });

  it("refund after deadline and dispute inside the review window update the passport", async () => {
    const test = createTestClient({ chain, mode: "anvil", transport: http(rpc) });
    const now = (await pub.getBlock()).timestamp;
    // job 3: short deadline, never delivered -> refund
    await sdk.hirer.hire({ agentId, amount: parseUsdc("1"), specHash: hashContent("r"), deadline: now + 60n });
    await expect(sdk.hirer.refund(3n)).rejects.toThrow(/DeadlineNotPassed/);
    await test.increaseTime({ seconds: 120 });
    await test.mine({ blocks: 1 });
    await sdk.hirer.refund(3n);
    expect((await sdk.hirer.getJob(3n)).status).toBe(JobStatus.Refunded);

    // job 2 (gasless) delivered then disputed
    await sdk.agent.deliver(2n, { uri: "https://agent.example/2", content: "bad" });
    await sdk.hirer.dispute(2n);
    expect((await sdk.hirer.getJob(2n)).status).toBe(JobStatus.Disputed);

    const p = await sdk.hirer.getPassport(agentId);
    expect(p).toMatchObject({ jobsSettled: 1n, jobsRefunded: 1n, jobsDisputed: 1n });
    expect(await sdk.hirer.meets(agentId, POLICIES.proven)).toBe(false); // one dispute, tolerance 0
    expect(await sdk.hirer.meets(agentId, toPolicy({ minJobsSettled: 1, maxJobsDisputed: 1 }))).toBe(true);

    const card = await sdk.hirer.scorecard(agentId, POLICIES.proven);
    expect(card.meets).toBe(false);
    expect(card.checks.find((c) => !c.ok)?.rule).toBe("maxJobsDisputed");
    expect(card.passport).toMatchObject({ jobsSettled: "1", jobsRefunded: "1", jobsDisputed: "1", volumeSettledUsdc: "5" });
  });

  it("listJobs filters by agent and status (state-based, no logs)", async () => {
    const all = await sdk.hirer.listJobs({ agentId });
    expect(all.map((j) => j.jobId)).toEqual([1n, 2n, 3n]);
    expect((await sdk.hirer.listJobs({ status: JobStatus.Released })).map((j) => j.jobId)).toEqual([1n]);
    expect(await sdk.hirer.listJobs({ agentId: 99n })).toEqual([]);
  });

  it("getJobEvents pages through small log ranges and decodes every event in order", async () => {
    const events = await sdk.hirer.getJobEvents({ fromBlock: 0n });
    const names = events.map((e) => `${e.eventName}:${"jobId" in e.args ? e.args.jobId : ""}`);
    expect(names).toEqual([
      "JobOpened:1",
      "JobDelivered:1",
      "JobReleased:1",
      "JobOpened:2",
      "JobOpened:3",
      "JobRefunded:3",
      "JobDelivered:2",
      "JobDisputed:2",
    ]);
  });

  it("watchJobEvents tails new events live", async () => {
    const seen: JobEvent[] = [];
    const head = await pub.getBlockNumber();
    const stop = sdk.agent.watchJobEvents({ fromBlock: head + 1n, pollMs: 100, onEvent: (e) => void seen.push(e) });
    try {
      await sdk.hirer.hire({ agentId, amount: parseUsdc("1"), specHash: hashContent("watch"), endpoint: "watch" });
      for (let i = 0; i < 50 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    } finally {
      stop();
    }
    expect(seen.map((e) => e.eventName)).toEqual(["JobOpened"]);
    const e = seen[0]!;
    expect(e.eventName === "JobOpened" && e.args.jobId).toBe(4n);
  });

  it("identity lookups: owner, agentWallet, payout address", async () => {
    const agentAddr = wallets.agent.account!.address;
    expect(await sdk.hirer.getAgent(agentId)).toEqual({ owner: agentAddr, agentWallet: null, agentURI: "" });
    expect(await sdk.hirer.getPayoutAddress(agentId)).toBe(agentAddr);
    const stranger = wallets.stranger.account!.address;
    await send(wallets.agent, deployment.identityRegistry, artifact("Mocks.sol", "MockIdentityRegistry").abi, "setAgentWalletUnsafe", [agentId, stranger]);
    expect(await sdk.hirer.getPayoutAddress(agentId)).toBe(stranger);
    await expect(sdk.hirer.getAgent(42n)).rejects.toThrow();
    // Mock registry has no getSummary: reported as "no escrow-backed feedback", not an exception.
    expect(await sdk.hirer.getEscrowReputation(agentId)).toEqual({ count: 0n, summary: "0" });
  });
});
