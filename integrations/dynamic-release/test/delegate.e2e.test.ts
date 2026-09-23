// The release delegate against a local anvil chain (real AgentPassport + JobEscrow bytecode).
// A local key stands in for the Dynamic server wallet: the delegate only sees a viem WalletClient,
// so the on-chain behaviour is identical (the live run in docs/DEMO_LOG.md signs through Dynamic).
import { createServer, type Server } from "node:http";
import { JobStatus, parseUsdc } from "@agentfromzero/agentpassport-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevChain, type DevChain } from "../../../sdk/test/harness.ts";
import { ReleaseDelegate } from "../src/delegate.ts";

let dev: DevChain;
let server: Server;
let baseUrl: string;
const served = new Map<string, string>();
let delegate: ReleaseDelegate;

const deliverable = (jobId: bigint, specHash: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "agentpassport/scorecard@1",
    job: { chainId: dev.deployment.chainId, escrow: dev.deployment.jobEscrow, jobId: jobId.toString(), specHash, ...over },
    producedBy: "test-agent",
    output: { ok: true },
  }) + "\n";

/** Hirer opens a job (verifier = the delegate unless overridden); the agent serves bytes and delivers. */
async function deliveredJob(opts: { amount?: string; verifier?: `0x${string}`; body?: (jobId: bigint, specHash: string) => string; serveOther?: string } = {}) {
  const specHash = ("0x" + Math.floor(Math.random() * 1e15).toString(16).padStart(64, "0")) as `0x${string}`;
  const { jobId } = await dev.sdk.hirer.hire({
    agentId: dev.agentId,
    amount: parseUsdc(opts.amount ?? "1"),
    specHash,
    endpoint: "scorecard",
    verifier: opts.verifier ?? delegate.address,
  });
  const bytes = (opts.body ?? ((id, s) => deliverable(id, s)))(jobId, specHash);
  const path = `/jobs/${jobId}/deliverable.json`;
  served.set(path, opts.serveOther ?? bytes);
  await dev.sdk.agent.deliver(jobId, { uri: baseUrl + path, content: bytes });
  return jobId;
}

beforeAll(async () => {
  dev = await startDevChain({ maxLogRange: 5n });
  server = createServer((req, res) => {
    const body = served.get(req.url!.split("?")[0]!);
    res.statusCode = body === undefined ? 404 : 200;
    res.end(body ?? "not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  delegate = new ReleaseDelegate({ client: dev.sdk.stranger as never, maxAmount: parseUsdc("5") });
});

afterAll(() => {
  dev?.stop();
  server?.close();
});

describe("ReleaseDelegate", () => {
  it("releases a delegated, delivered, hash-matching job and stamps the passport", async () => {
    const jobId = await deliveredJob();
    const agentAddr = dev.wallets.agent.account!.address;
    const before = await dev.usdcBalance(agentAddr);
    const d = await delegate.process(jobId);
    expect(d.checks.map((c) => [c.name, c.ok])).toEqual([
      ["delegated", true],
      ["delivered", true],
      ["amount cap", true],
      ["deliverable hash", true],
      ["bound to this job", true],
    ]);
    expect(d.release).toBe(true);
    expect(d.tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await dev.sdk.hirer.getJob(jobId)).status).toBe(JobStatus.Released);
    expect((await dev.usdcBalance(agentAddr)) - before).toBe(parseUsdc("1"));
    expect((await dev.sdk.hirer.getPassport(dev.agentId)).jobsSettled).toBeGreaterThanOrEqual(1n);
  });

  it("refuses when the served bytes differ from the on-chain hash", async () => {
    const jobId = await deliveredJob({ serveOther: "tampered\n" });
    const d = await delegate.process(jobId);
    expect(d.release).toBe(false);
    expect(d.checks.find((c) => c.name === "deliverable hash")?.ok).toBe(false);
    expect((await dev.sdk.hirer.getJob(jobId)).status).toBe(JobStatus.Delivered);
  });

  it("refuses a deliverable produced for another job (hash matches, binding does not)", async () => {
    const jobId = await deliveredJob({ body: (id, s) => deliverable(id, s, { jobId: (id + 100n).toString() }) });
    const d = await delegate.process(jobId);
    expect(d.release).toBe(false);
    expect(d.checks.find((c) => c.name === "deliverable hash")?.ok).toBe(true);
    const bound = d.checks.find((c) => c.name === "bound to this job");
    expect(bound?.ok).toBe(false);
    expect(bound?.detail).toContain("jobId=");
  });

  it("refuses above the delegation's amount cap, and jobs that did not delegate to it", async () => {
    const big = await deliveredJob({ amount: "6" });
    const d1 = await delegate.evaluate(big);
    expect(d1.release).toBe(false);
    expect(d1.checks.find((c) => c.name === "amount cap")?.ok).toBe(false);

    const notMine = await deliveredJob({ verifier: "0x0000000000000000000000000000000000000000" });
    const d2 = await delegate.evaluate(notMine);
    expect(d2.release).toBe(false);
    expect(d2.checks[0]).toMatchObject({ name: "delegated", ok: false });
  });

  it("sweep releases only what it may: pending() lists delegated delivered jobs", async () => {
    const ok = await deliveredJob();
    const pending = await delegate.pending();
    expect(pending).toContain(ok);
    const results = await delegate.sweep();
    expect(results.find((r) => r.jobId === ok.toString())?.release).toBe(true);
    // The tampered / mis-bound / over-cap jobs above are still waiting for their hirer.
    expect((await delegate.pending()).length).toBe(3);
  });

  it("the escrow itself rejects a non-verifier release (delegation is enforced on chain)", async () => {
    const jobId = await deliveredJob({ verifier: "0x0000000000000000000000000000000000000000" });
    await expect(dev.sdk.stranger.release(jobId)).rejects.toThrow();
  });
});
