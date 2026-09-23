// Delegated release: the hirer names a Dynamic MPC server wallet as the job's `verifier` when it
// opens the job. JobEscrow then lets exactly two parties release that job early: the hirer and
// this wallet. The delegate releases only when every check below passes; anything else is left
// for the hirer (who can still release, dispute or, after the deadline, refund).
//
//   delegation scope (enforced on chain) : this job only, release only; it can never refund,
//                                           dispute or move funds anywhere but to the agent
//   delegation scope (enforced here)     : amount cap, delivered bytes == on-chain hash, the
//                                           deliverable names this chain / escrow / job / spec
//
// Signing goes through whatever viem WalletClient the AgentPassportClient holds: a Dynamic server
// wallet in production (src/dynamic.ts), a local key in tests.
import { AgentPassportClient, JobStatus, formatUsdc, jobStatusName, type Job } from "@agentfromzero/agentpassport-sdk";
import type { Address, Hex } from "viem";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Decision {
  jobId: string;
  release: boolean;
  checks: Check[];
  tx?: Hex;
  block?: string;
}

export interface DelegateOptions {
  /** SDK client whose walletClient signs as the delegate (the Dynamic server wallet). */
  client: AgentPassportClient;
  /** Largest job (USDC base units) this delegate may release; above it the hirer must act. */
  maxAmount: bigint;
  /** Only release for these agents (empty = any agent). */
  agentIds?: bigint[];
  fetchImpl?: typeof fetch;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export class ReleaseDelegate {
  readonly address: Address;
  private readonly opts: DelegateOptions;
  constructor(opts: DelegateOptions) {
    this.opts = opts;
    const account = opts.client.walletClient?.account;
    if (!account) throw new Error("the AgentPassportClient needs a walletClient with an account (the delegate wallet)");
    this.address = account.address;
  }

  /** Runs every check without sending anything. */
  async evaluate(jobId: bigint): Promise<Decision> {
    const checks: Check[] = [];
    const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
    const job = await this.opts.client.getJob(jobId);
    const d = this.opts.client.deployment;

    add("delegated", job.verifier.toLowerCase() === this.address.toLowerCase(), `job verifier ${job.verifier}; delegate ${this.address}`);
    add("delivered", job.status === JobStatus.Delivered, `status ${jobStatusName(job.status)}`);
    add("amount cap", job.amount <= this.opts.maxAmount, `${formatUsdc(job.amount)} USDC <= cap ${formatUsdc(this.opts.maxAmount)} USDC`);
    if (this.opts.agentIds?.length) {
      add("agent allowed", this.opts.agentIds.includes(job.agentId), `agent ${job.agentId} in [${this.opts.agentIds.join(", ")}]`);
    }
    if (checks.some((c) => !c.ok)) return { jobId: jobId.toString(), release: false, checks };

    let bytes: Uint8Array | undefined;
    try {
      const v = await this.opts.client.verifyDelivery(jobId, this.opts.fetchImpl);
      bytes = v.bytes;
      add("deliverable hash", v.ok, v.ok ? `keccak256(bytes) == ${v.delivery.deliverableHash}` : `on chain ${v.delivery.deliverableHash}, served ${v.actualHash}`);
    } catch (e) {
      add("deliverable hash", false, `could not fetch the deliverable: ${(e as Error).message}`);
    }
    if (bytes && checks.every((c) => c.ok)) add("bound to this job", ...bindsToJob(bytes, jobId, job, d.chainId, d.jobEscrow));
    return { jobId: jobId.toString(), release: checks.every((c) => c.ok), checks };
  }

  /** evaluate(), then release through the delegate wallet if every check passed. */
  async process(jobId: bigint): Promise<Decision> {
    const decision = await this.evaluate(jobId);
    if (!decision.release) {
      this.opts.log?.("not released", { jobId: decision.jobId, failed: decision.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`) });
      return decision;
    }
    const tx = await this.opts.client.release(jobId);
    this.opts.log?.("released", { jobId: decision.jobId, tx: tx.hash, block: tx.receipt.blockNumber.toString() });
    return { ...decision, tx: tx.hash, block: tx.receipt.blockNumber.toString() };
  }

  /** Jobs in [fromJobId, jobCount] that name this delegate and are waiting for a release. */
  async pending(fromJobId = 1n): Promise<bigint[]> {
    const count = await this.opts.client.jobCount();
    const out: bigint[] = [];
    for (let id = fromJobId; id <= count; id++) {
      const job = await this.opts.client.getJob(id);
      if (job.verifier.toLowerCase() === this.address.toLowerCase() && job.status === JobStatus.Delivered) out.push(id);
    }
    return out;
  }

  /** One pass: process every pending delegated job. */
  async sweep(fromJobId = 1n): Promise<Decision[]> {
    const out: Decision[] = [];
    for (const id of await this.pending(fromJobId)) out.push(await this.process(id));
    return out;
  }
}

/**
 * The deliverable must say which job it answers (the worker writes chainId / escrow / jobId /
 * specHash into every deliverable). Stops an agent from delivering bytes it produced for another
 * job or another deployment, which would pass the hash check on its own.
 */
export function bindsToJob(bytes: Uint8Array, jobId: bigint, job: Job, chainId: number, escrow: Address): [boolean, string] {
  let doc: { job?: { chainId?: unknown; escrow?: unknown; jobId?: unknown; specHash?: unknown } };
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return [false, "deliverable is not JSON"];
  }
  const j = doc?.job ?? {};
  const want = { chainId, escrow: escrow.toLowerCase(), jobId: jobId.toString(), specHash: job.specHash.toLowerCase() };
  const got = {
    chainId: Number(j.chainId),
    escrow: String(j.escrow ?? "").toLowerCase(),
    jobId: String(j.jobId ?? ""),
    specHash: String(j.specHash ?? "").toLowerCase(),
  };
  const bad = (Object.keys(want) as Array<keyof typeof want>).filter((k) => want[k] !== got[k]);
  return bad.length === 0
    ? [true, `deliverable names chain ${chainId}, escrow ${escrow}, job ${jobId}, spec ${job.specHash}`]
    : [false, `deliverable ${bad.map((k) => `${k}=${got[k]} (want ${want[k]})`).join(", ")}`];
}
