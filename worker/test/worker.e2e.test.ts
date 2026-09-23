// The worker against a local anvil chain (real AgentPassport + JobEscrow bytecode) and a local
// static HTTP server standing in for the agent's website.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStatus, hashContent, parseUsdc } from "@agentfromzero/agentpassport-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevChain, type DevChain } from "../../sdk/test/harness.ts";
import { DirPublisher } from "../src/io.ts";
import { DEFAULT_SKILLS } from "../src/skills.ts";
import { Worker } from "../src/worker.ts";

let dev: DevChain;
let dir: string;
let server: Server;
let baseUrl: string;
const logs: Array<{ level: string; msg: string; extra?: Record<string, unknown> }> = [];

function makeWorker(extra: Partial<ConstructorParameters<typeof Worker>[0]> = {}) {
  return new Worker({
    client: dev.sdk.agent as never,
    agentId: dev.agentId,
    skills: DEFAULT_SKILLS,
    specBases: [join(dir, "decoy"), `${baseUrl}/specs`],
    publisher: new DirPublisher({ dir: join(dir, "site"), baseUrl, verifyTimeoutMs: 5000 }),
    log: (level, msg, extra) => void logs.push({ level, msg, extra }),
    minAmount: parseUsdc("0.01"),
    agentName: "test-agent",
    ...extra,
  });
}

/** The hirer publishes a spec (content-addressed) and opens a job for it. */
async function postJob(spec: unknown, amount = parseUsdc("1")) {
  const bytes = JSON.stringify(spec);
  const specHash = hashContent(bytes);
  writeFileSync(join(dir, "site", "specs", `${specHash}.json`), bytes);
  const { jobId } = await dev.sdk.hirer.hire({ agentId: dev.agentId, amount, specHash, endpoint: "scorecard" });
  return { jobId, specHash };
}

beforeAll(async () => {
  dev = await startDevChain({ maxLogRange: 5n });
  dir = mkdtempSync(join(tmpdir(), "ap-worker-"));
  mkdirSync(join(dir, "site", "specs"), { recursive: true });
  mkdirSync(join(dir, "decoy"), { recursive: true });
  server = createServer((req, res) => {
    try {
      res.end(readFileSync(join(dir, "site", decodeURIComponent(req.url!.split("?")[0]!))));
    } catch {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  dev?.stop();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("worker", () => {
  it("catch-up: fetches the hash-checked spec, runs `scorecard`, publishes, delivers on chain", async () => {
    const spec = { skill: "scorecard", agentIds: [String(dev.agentId), 99], policy: { minJobsSettled: 0 } };
    const { jobId, specHash } = await postJob(spec);
    // A decoy copy with the right name but wrong bytes sits in the first spec base: it must be rejected.
    writeFileSync(join(dir, "decoy", `${specHash}.json`), JSON.stringify({ ...spec, agentIds: ["7"] }));

    const w = makeWorker();
    expect(await w.catchUp()).toEqual([jobId]);
    expect(w.jobs[jobId.toString()]?.status).toBe("delivered");
    expect(w.jobs[jobId.toString()]?.acceptTx).toMatch(/^0x/);
    expect(await dev.sdk.hirer.acceptedAt(jobId)).toBeGreaterThan(0n);
    expect(logs.findIndex((l) => l.msg === "accepted")).toBeLessThan(logs.findIndex((l) => l.msg === "delivered"));
    expect(logs.some((l) => l.msg === "spec copy rejected" && String(l.extra?.reason).startsWith("hash mismatch"))).toBe(true);

    const job = await dev.sdk.hirer.getJob(jobId);
    expect(job.status).toBe(JobStatus.Delivered);
    const v = await dev.sdk.hirer.verifyDelivery(jobId);
    expect(v.ok).toBe(true);
    expect(v.delivery.deliverableURI).toBe(`${baseUrl}/jobs/${jobId}/deliverable.json`);

    const doc = JSON.parse(new TextDecoder().decode(v.bytes));
    expect(doc.type).toBe("agentpassport/scorecard@1");
    expect(doc.job).toMatchObject({ jobId: jobId.toString(), specHash, amountUsdc: "1", escrow: dev.deployment.jobEscrow });
    expect(doc.producedBy).toBe("test-agent");
    expect(doc.output.summary).toEqual({ agents: 2, meeting: 2, registered: 1 });
    expect(doc.output.results[1]).toMatchObject({ agentId: "99", identity: null });

    // Idempotent: a second sweep finds nothing open.
    expect(await makeWorker().catchUp()).toEqual([]);
  });

  it("skips (and never delivers) jobs it cannot do honestly", async () => {
    const unknownSpec = await dev.sdk.hirer.hire({ agentId: dev.agentId, amount: parseUsdc("1"), specHash: hashContent("never published") });
    const badSkill = await postJob({ skill: "write-poetry" });
    const badSpec = await postJob({ skill: "scorecard", agentIds: [] });
    const tooCheap = await postJob({ skill: "scorecard", agentIds: [1] }, 1n);

    const w = makeWorker();
    await w.catchUp();
    const reason = (id: bigint) => w.jobs[id.toString()];
    expect(reason(unknownSpec.jobId)).toMatchObject({ status: "skipped", reason: expect.stringContaining("no spec matching") });
    expect(reason(badSkill.jobId)).toMatchObject({ status: "skipped", reason: 'unsupported skill "write-poetry"' });
    expect(reason(badSpec.jobId)).toMatchObject({ status: "skipped", reason: expect.stringContaining("bad spec") });
    expect(reason(tooCheap.jobId)).toMatchObject({ status: "skipped", reason: expect.stringContaining("below minimum") });
    for (const id of [unknownSpec.jobId, badSkill.jobId, badSpec.jobId, tooCheap.jobId]) {
      expect((await dev.sdk.hirer.getJob(id)).status).toBe(JobStatus.Open);
      expect(await dev.sdk.hirer.acceptedAt(id)).toBe(0n); // skipped jobs stay unaccepted: the hirer can cancel at once
    }
    await dev.sdk.hirer.refund(unknownSpec.jobId);
    expect((await dev.sdk.hirer.getPassport(dev.agentId)).jobsRefunded).toBe(0n);
  });

  it("watch mode: picks up a new JobOpened event, delivers, then logs the release as paid", async () => {
    const stateFile = join(dir, "state.json");
    const w = makeWorker({ stateFile });
    // Leave only fresh jobs to the event path.
    await w.catchUp();
    await w.start({ pollMs: 100 });
    try {
      const { jobId } = await postJob({ skill: "scorecard", agentIds: [1] });
      const until = async (cond: () => boolean) => {
        for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 100));
        expect(cond()).toBe(true);
      };
      await until(() => w.jobs[jobId.toString()]?.status === "delivered");
      await dev.sdk.hirer.release(jobId);
      await until(() => w.jobs[jobId.toString()]?.status === "paid");
      expect(JSON.parse(readFileSync(stateFile, "utf8")).jobs[jobId.toString()]).toMatchObject({ status: "paid", deliverTx: expect.stringMatching(/^0x/) });
      expect(logs.some((l) => l.msg === "JobOpened" && l.extra?.jobId === jobId.toString())).toBe(true);
    } finally {
      w.stop();
    }
    expect((await dev.sdk.hirer.getPassport(dev.agentId)).jobsSettled).toBe(1n);
  });
});

describe("DirPublisher", () => {
  it("scopes job folders with pathPrefix (job ids restart at 1 in every escrow)", async () => {
    const d = mkdtempSync(join(tmpdir(), "pub-"));
    const bytes = new TextEncoder().encode('{"v":2}\n');
    const served = (async (url: string) => {
      const path = new URL(url).pathname.slice(1);
      return new Response(readFileSync(join(d, path)));
    }) as typeof fetch;
    const pub = new DirPublisher({ dir: d, baseUrl: "https://agent.example/", pathPrefix: "/jobs/0xescrow2/", fetch: served, verifyTimeoutMs: 1000 });
    expect(await pub.publish(1n, bytes)).toBe("https://agent.example/jobs/0xescrow2/1/deliverable.json");
    expect(hashContent(readFileSync(join(d, "jobs", "0xescrow2", "1", "deliverable.json")))).toBe(hashContent(bytes));
    rmSync(d, { recursive: true, force: true });
  });
});
