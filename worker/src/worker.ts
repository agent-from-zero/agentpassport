// The hire-flow worker: the loop that makes an ERC-8004 agent hireable through JobEscrow.
//
//   JobOpened(agentId = ours) ─▶ re-read job on chain ─▶ fetch spec by specHash (hash-checked)
//     ─▶ run skill ─▶ accept(jobId) ─▶ publish deliverable bytes (served-bytes check)
//     ─▶ deliver(jobId, keccak, uri)
//   The worker accepts only once the spec checks pass and the skill has produced its output: a job it skips stays unaccepted, so the
//   hirer can cancel it at once and nothing lands on the passport (JobEscrow v2).
//   JobReleased(ours) ─▶ log "paid"
//
// Discovery is two-layered because public Monad RPCs cap eth_getLogs at 100 blocks: on start (and
// with --once) the worker scans escrow *state* (`jobCount` + `getJob`) for open jobs, then tails
// events block range by block range. On-chain status is the source of truth, so re-handling a job
// is harmless: anything not `Open` for our agent is skipped.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AgentPassportClient, JobStatus, formatUsdc, hashContent, jobStatusName, type Job, type JobEvent } from "@agentfromzero/agentpassport-sdk";
import type { Hex } from "viem";
import { resolveSpec, type Publisher } from "./io.ts";
import { SpecError, type Skill } from "./skills.ts";

export type Logger = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

export interface WorkerOptions {
  client: AgentPassportClient;
  agentId: bigint;
  skills: Skill[];
  /** Where specs live, as `<base>/<specHash>.json` (https URLs or local directories). */
  specBases: string[];
  publisher: Publisher;
  log: Logger;
  /** Jobs paying less than this (USDC base units) are ignored. */
  minAmount?: bigint;
  stateFile?: string;
  fetch?: typeof fetch;
  /** Public name written into every deliverable. */
  agentName?: string;
}

interface JobRecord {
  status: "delivered" | "skipped" | "failed" | "paid";
  acceptTx?: Hex;
  reason?: string;
  deliverTx?: Hex;
  deliverableURI?: string;
  deliverableHash?: Hex;
  releaseTx?: Hex;
  at: string;
}

interface State {
  lastBlock?: string;
  jobs: Record<string, JobRecord>;
}

export class Worker {
  readonly opts: WorkerOptions;
  private state: State;
  private readonly inFlight = new Set<string>();
  private stopWatch?: () => void;

  constructor(opts: WorkerOptions) {
    this.opts = opts;
    this.state = opts.stateFile && existsSync(opts.stateFile) ? (JSON.parse(readFileSync(opts.stateFile, "utf8")) as State) : { jobs: {} };
  }

  get jobs(): Readonly<Record<string, JobRecord>> {
    return this.state.jobs;
  }

  /** State-based sweep: handles every job that is still `Open` for our agent. Returns the job ids handled. */
  async catchUp(): Promise<bigint[]> {
    const open = await this.opts.client.listJobs({ agentId: this.opts.agentId, status: JobStatus.Open });
    this.opts.log("info", "catch-up", { openJobs: open.map((j) => j.jobId.toString()) });
    for (const j of open) await this.handle(j.jobId);
    return open.map((j) => j.jobId);
  }

  /**
   * Catch up, then tail JobEscrow events until `stop()`. Every `sweepMs` the state sweep runs again,
   * which retries jobs that failed on a transient error (RPC rate limit, slow deploy) and picks up
   * specs that were published after their job was opened.
   */
  async start(opts: { pollMs?: number; sweepMs?: number } = {}): Promise<void> {
    await this.catchUp();
    const head = await this.opts.client.publicClient.getBlockNumber({ cacheTime: 0 });
    const saved = this.state.lastBlock ? BigInt(this.state.lastBlock) + 1n : undefined;
    // Resume from the saved block only if it is recent; older gaps were covered by catchUp().
    const fromBlock = saved !== undefined && head - saved < 1000n ? saved : head;
    this.opts.log("info", "watching", { fromBlock: fromBlock.toString(), escrow: this.opts.client.deployment.jobEscrow });
    this.stopWatch = this.opts.client.watchJobEvents({
      fromBlock,
      pollMs: opts.pollMs ?? 1000,
      onEvent: (e) => this.onEvent(e),
      onBlock: (b) => {
        this.state.lastBlock = b.toString();
        this.save();
      },
      onError: (err) => this.opts.log("warn", "rpc error (will retry)", { error: describeError(err) }),
    });
    const sweep = setInterval(() => {
      this.catchUp().catch((err) => this.opts.log("warn", "sweep failed (will retry)", { error: describeError(err) }));
    }, opts.sweepMs ?? 60_000);
    const stopTail = this.stopWatch;
    this.stopWatch = () => {
      clearInterval(sweep);
      stopTail();
    };
  }

  stop(): void {
    this.stopWatch?.();
  }

  private async onEvent(e: JobEvent): Promise<void> {
    if (e.eventName === "JobOpened" && e.args.agentId === this.opts.agentId) {
      this.opts.log("info", "JobOpened", { jobId: e.args.jobId.toString(), hirer: e.args.hirer, amountUsdc: formatUsdc(e.args.amount), endpoint: e.args.endpoint, tx: e.transactionHash });
      await this.handle(e.args.jobId);
    } else if (e.eventName === "JobReleased" && e.args.agentId === this.opts.agentId) {
      this.opts.log("info", "paid", { jobId: e.args.jobId.toString(), amountUsdc: formatUsdc(e.args.amount), releasedBy: e.args.releasedBy, tx: e.transactionHash });
      const rec = this.state.jobs[e.args.jobId.toString()];
      this.record(e.args.jobId, { ...rec, status: "paid", releaseTx: e.transactionHash, at: new Date().toISOString() });
    } else if ((e.eventName === "JobRefunded" || e.eventName === "JobDisputed") && e.args.agentId === this.opts.agentId) {
      this.opts.log("warn", e.eventName, { jobId: e.args.jobId.toString(), tx: e.transactionHash });
    }
  }

  /** Does one job end to end. Safe to call repeatedly: only an `Open` job for our agent is worked on. */
  async handle(jobId: bigint): Promise<JobRecord | null> {
    const key = jobId.toString();
    if (this.inFlight.has(key)) return null;
    this.inFlight.add(key);
    try {
      const job = await this.opts.client.getJob(jobId);
      if (job.agentId !== this.opts.agentId) return null;
      if (job.status !== JobStatus.Open) {
        this.opts.log("info", "not open, nothing to do", { jobId: key, status: jobStatusName(job.status) });
        return null;
      }
      const skip = this.precheck(job);
      if (skip) return this.skip(jobId, skip);

      const spec = await resolveSpec(job.specHash, this.opts.specBases, {
        fetch: this.opts.fetch,
        onReject: (source, reason) => this.opts.log("warn", "spec copy rejected", { jobId: key, source, reason }),
      });
      if (!spec) return this.skip(jobId, `no spec matching specHash ${job.specHash} in ${this.opts.specBases.join(", ")}`);
      const skillName = typeof spec.json.skill === "string" ? spec.json.skill : "";
      const skill = this.opts.skills.find((s) => s.name === skillName);
      if (!skill) return this.skip(jobId, `unsupported skill "${skillName}"`);
      this.opts.log("info", "working", { jobId: key, skill: skill.name, spec: spec.source });

      let output: Record<string, unknown>;
      try {
        output = await skill.run({ jobId, job, spec: spec.json, client: this.opts.client });
      } catch (e) {
        if (e instanceof SpecError) return this.skip(jobId, `bad spec: ${e.message}`);
        throw e;
      }
      // The spec is valid and the output computed: commit before the slow publish step, so the
      // hirer cannot cancel mid-job. null = escrow without acceptance (v1).
      let acceptTx: Hex | undefined;
      if ((await this.opts.client.acceptedAt(jobId)) === 0n) {
        const tx = await this.opts.client.accept(jobId);
        acceptTx = tx.hash;
        this.opts.log("info", "accepted", { jobId: key, tx: tx.hash, block: tx.receipt.blockNumber.toString() });
      }
      const bytes = this.render(jobId, job, skill, output);
      const deliverableHash = hashContent(bytes);
      const uri = await this.opts.publisher.publish(jobId, bytes);
      this.opts.log("info", "published", { jobId: key, uri, deliverableHash, bytes: bytes.length });

      const tx = await this.opts.client.deliver(jobId, { uri, hash: deliverableHash });
      this.opts.log("info", "delivered", { jobId: key, tx: tx.hash, block: tx.receipt.blockNumber.toString(), gasUsed: tx.receipt.gasUsed.toString() });
      return this.record(jobId, { status: "delivered", acceptTx, deliverTx: tx.hash, deliverableURI: uri, deliverableHash, at: new Date().toISOString() });
    } catch (e) {
      const reason = describeError(e);
      this.opts.log("error", "job failed", { jobId: key, reason });
      return this.record(jobId, { status: "failed", reason, at: new Date().toISOString() });
    } finally {
      this.inFlight.delete(key);
    }
  }

  private precheck(job: Job): string | null {
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (job.deadline <= now) return `deadline passed (${new Date(Number(job.deadline) * 1000).toISOString()}); hirer can refund`;
    if (job.amount < (this.opts.minAmount ?? 0n)) return `pays ${formatUsdc(job.amount)} USDC, below minimum ${formatUsdc(this.opts.minAmount ?? 0n)}`;
    if (job.token.toLowerCase() !== this.opts.client.deployment.usdc.toLowerCase()) return `unexpected token ${job.token}`;
    return null;
  }

  /** Canonical deliverable bytes: 2-space JSON + trailing newline, no wall-clock fields (reproducible from the chain). */
  private render(jobId: bigint, job: Job, skill: Skill, output: Record<string, unknown>): Uint8Array {
    const doc = {
      type: `agentpassport/${skill.name}@1`,
      job: {
        chainId: this.opts.client.deployment.chainId,
        escrow: this.opts.client.deployment.jobEscrow,
        jobId: jobId.toString(),
        agentId: job.agentId.toString(),
        hirer: job.hirer,
        amountUsdc: formatUsdc(job.amount),
        specHash: job.specHash,
      },
      producedBy: this.opts.agentName ?? `ERC-8004 agent ${job.agentId}`,
      output,
    };
    return new TextEncoder().encode(JSON.stringify(doc, null, 2) + "\n");
  }

  private skip(jobId: bigint, reason: string): JobRecord {
    const prev = this.state.jobs[jobId.toString()];
    if (prev?.status !== "skipped" || prev.reason !== reason) this.opts.log("warn", "skipped", { jobId: jobId.toString(), reason });
    return this.record(jobId, { status: "skipped", reason, at: new Date().toISOString() });
  }

  private record(jobId: bigint, rec: JobRecord): JobRecord {
    this.state.jobs[jobId.toString()] = rec;
    this.save();
    return rec;
  }

  private save(): void {
    if (this.opts.stateFile) writeFileSync(this.opts.stateFile, JSON.stringify(this.state, null, 2));
  }
}

/** One line with the useful part of a viem error ("RPC Request failed." alone says nothing). */
export function describeError(e: unknown): string {
  const err = e as { shortMessage?: string; details?: string; message?: string };
  const head = err.shortMessage ?? String(err.message ?? e).split("\n")[0]!;
  return (err.details && !head.includes(err.details) ? `${head} (${err.details})` : head).slice(0, 500);
}
