import {
  parseEventLogs,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type ContractEventName,
  type Hex,
  type ParseEventLogsReturnType,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { agentPassportAbi, identityRegistryAbi, jobEscrowAbi, reputationRegistryAbi, usdcAbi } from "./abis.js";
import { MONAD_TESTNET, type Deployment } from "./addresses.js";
import { openNonce, signOpenAuthorization } from "./gasless.js";
import {
  JobStatus,
  type HireInput,
  type Job,
  type OpenAuthorization,
  type OpenParams,
  type Passport,
  type PolicyInput,
  type Scorecard,
} from "./types.js";
import { ZERO_ADDRESS, evaluatePolicy, formatUsdc, hashContent, toAgentId, toPolicy } from "./utils.js";

type AnyPublicClient = PublicClient<Transport, Chain | undefined>;
type AgentIdLike = bigint | number | string;

/** Decoded JobEscrow event (JobOpened / JobDelivered / JobReleased / JobRefunded / JobDisputed / PasskeyRegistered). */
export type JobEvent = ParseEventLogsReturnType<typeof jobEscrowAbi, ContractEventName<typeof jobEscrowAbi>, true>[number];

export interface AgentPassportClientOptions {
  publicClient: AnyPublicClient;
  /** Needed for writes only. Must carry an account (local key or JSON-RPC account). */
  walletClient?: WalletClient;
  /** Defaults to the live Monad testnet deployment. */
  deployment?: Deployment;
  /**
   * Largest block span per `eth_getLogs`. Public Monad testnet RPCs cap it at 100 blocks
   * (QuickNode: "eth_getLogs is limited to a 100 range"), so the SDK pages through ranges.
   */
  maxLogRange?: bigint;
}

export interface TxResult {
  hash: Hex;
  receipt: TransactionReceipt;
}

export interface Delivery {
  jobId: bigint;
  deliverableHash: Hex;
  deliverableURI: string;
  blockNumber: bigint;
  transactionHash: Hex;
}

export class AgentPassportError extends Error {}

/**
 * One object for everything AgentPassport: passport reads and policy checks, the escrow lifecycle
 * (plain and gasless EIP-3009 opens), ERC-8004 identity/reputation lookups and event tailing.
 *
 * Writes are simulated first (so a revert surfaces as a decoded custom error and costs nothing:
 * Monad charges the gas *limit*, not gas used), then sent and awaited; every write returns the
 * receipt, which on Monad is final ~800 ms after submission.
 */
export class AgentPassportClient {
  readonly publicClient: AnyPublicClient;
  readonly walletClient?: WalletClient;
  readonly deployment: Deployment;
  readonly maxLogRange: bigint;

  constructor(opts: AgentPassportClientOptions) {
    this.publicClient = opts.publicClient;
    this.walletClient = opts.walletClient;
    this.deployment = opts.deployment ?? MONAD_TESTNET;
    this.maxLogRange = opts.maxLogRange ?? 100n;
  }

  // ───────────────────────────── passport ─────────────────────────────

  async getPassport(agentId: AgentIdLike, blockNumber?: bigint): Promise<Passport> {
    const p = await this.publicClient.readContract({
      address: this.deployment.agentPassport,
      abi: agentPassportAbi,
      functionName: "passportOf",
      args: [toAgentId(agentId)],
      blockNumber,
    });
    return { ...p, jobsSettled: BigInt(p.jobsSettled), jobsRefunded: BigInt(p.jobsRefunded), jobsDisputed: BigInt(p.jobsDisputed), firstSeen: BigInt(p.firstSeen), lastSettled: BigInt(p.lastSettled) };
  }

  /** The on-chain policy check integrators call before routing work or money to an agent. */
  async meets(agentId: AgentIdLike, policy: PolicyInput = {}, blockNumber?: bigint): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.deployment.agentPassport,
      abi: agentPassportAbi,
      functionName: "meets",
      args: [toAgentId(agentId), toPolicy(policy)],
      blockNumber,
    });
  }

  /** Settled jobs between one hirer and one agent (repeat-business signal). */
  async settledBetween(hirer: Address, agentId: AgentIdLike): Promise<bigint> {
    return BigInt(
      await this.publicClient.readContract({
        address: this.deployment.agentPassport,
        abi: agentPassportAbi,
        functionName: "settledBetween",
        args: [hirer, toAgentId(agentId)],
      }),
    );
  }

  /**
   * Everything a router needs to decide on one agent, read at a single block: the chain's `meets`
   * verdict, a rule-by-rule explanation, the passport, the ERC-8004 identity, and the escrow-backed
   * slice of ERC-8004 reputation (feedback whose client is the AgentPassport contract).
   */
  async scorecard(agentId: AgentIdLike, policyInput: PolicyInput = {}, opts: { blockNumber?: bigint } = {}): Promise<Scorecard> {
    const id = toAgentId(agentId);
    const policy = toPolicy(policyInput);
    const block = await this.publicClient.getBlock(opts.blockNumber ? { blockNumber: opts.blockNumber } : { blockTag: "latest" });
    const blockNumber = block.number;
    const d = this.deployment;
    // One round trip (Multicall3) when the chain has it: public Monad RPCs allow ~15 requests/s.
    const [rawPassport, rawMeets, owner, wallet, uri, summary] = await this.readMany(
      [
        { address: d.agentPassport, abi: agentPassportAbi, functionName: "passportOf", args: [id] },
        { address: d.agentPassport, abi: agentPassportAbi, functionName: "meets", args: [id, policy] },
        { address: d.identityRegistry, abi: identityRegistryAbi, functionName: "ownerOf", args: [id] },
        { address: d.identityRegistry, abi: identityRegistryAbi, functionName: "getAgentWallet", args: [id] },
        { address: d.identityRegistry, abi: identityRegistryAbi, functionName: "tokenURI", args: [id] },
        { address: d.reputationRegistry, abi: reputationRegistryAbi, functionName: "getSummary", args: [id, [d.agentPassport], "", ""] },
      ],
      blockNumber,
    );
    if (rawPassport?.status !== "success" || rawMeets?.status !== "success") {
      throw (rawPassport?.status === "failure" ? rawPassport.error : rawMeets?.status === "failure" ? rawMeets.error : new AgentPassportError("scorecard read failed"));
    }
    const p = rawPassport.result as { jobsSettled: bigint | number; jobsRefunded: bigint | number; jobsDisputed: bigint | number; firstSeen: bigint | number; lastSettled: bigint | number; volumeSettled: bigint; token: Address };
    const passport: Passport = { ...p, jobsSettled: BigInt(p.jobsSettled), jobsRefunded: BigInt(p.jobsRefunded), jobsDisputed: BigInt(p.jobsDisputed), firstSeen: BigInt(p.firstSeen), lastSettled: BigInt(p.lastSettled) };
    const meets = rawMeets.result as boolean;
    const identity =
      owner?.status === "success"
        ? {
            owner: owner.result as Address,
            agentWallet: wallet?.status === "success" && wallet.result !== ZERO_ADDRESS ? (wallet.result as Address) : null,
            agentURI: uri?.status === "success" ? (uri.result as string) : "",
          }
        : null;
    const [count, value, decimals] = summary?.status === "success" ? (summary.result as readonly [bigint, bigint, number]) : [0n, 0n, 0];
    const reputation = { count: BigInt(count), summary: formatFixed(value, decimals) };
    const explained = evaluatePolicy(passport, policy, block.timestamp);
    const iso = (t: bigint) => (t === 0n ? null : new Date(Number(t) * 1000).toISOString());
    return {
      agentId: id.toString(),
      chainId: this.deployment.chainId,
      blockNumber: blockNumber.toString(),
      meets,
      checks: explained.checks,
      passport: {
        jobsSettled: passport.jobsSettled.toString(),
        jobsRefunded: passport.jobsRefunded.toString(),
        jobsDisputed: passport.jobsDisputed.toString(),
        volumeSettled: passport.volumeSettled.toString(),
        volumeSettledUsdc: formatUsdc(passport.volumeSettled),
        firstSeen: iso(passport.firstSeen),
        lastSettled: iso(passport.lastSettled),
        token: passport.token === ZERO_ADDRESS ? null : passport.token,
      },
      identity,
      reputation: {
        count: reputation.count.toString(),
        summaryValue: reputation.count === 0n ? null : reputation.summary,
        client: this.deployment.agentPassport,
      },
      policy: {
        minJobsSettled: policy.minJobsSettled.toString(),
        minVolumeSettled: policy.minVolumeSettled.toString(),
        maxJobsDisputed: policy.maxJobsDisputed.toString(),
        maxAgeOfLastSettlement: policy.maxAgeOfLastSettlement.toString(),
      },
    };
  }

  // ───────────────────────────── ERC-8004 ─────────────────────────────

  /** ERC-8004 identity: owner, payment wallet (`agentWallet` metadata) and agent-card URI. Throws if the agent does not exist. */
  async getAgent(agentId: AgentIdLike, blockNumber?: bigint): Promise<{ owner: Address; agentWallet: Address | null; agentURI: string }> {
    const id = toAgentId(agentId);
    const c = { address: this.deployment.identityRegistry, abi: identityRegistryAbi, blockNumber } as const;
    const [owner, agentWallet, agentURI] = await Promise.all([
      this.publicClient.readContract({ ...c, functionName: "ownerOf", args: [id] }),
      this.publicClient.readContract({ ...c, functionName: "getAgentWallet", args: [id] }),
      // Registries without ERC-721 metadata simply have no card URI.
      this.publicClient.readContract({ ...c, functionName: "tokenURI", args: [id] }).catch(() => ""),
    ]);
    return { owner, agentWallet: agentWallet === ZERO_ADDRESS ? null : agentWallet, agentURI };
  }

  /** Where the escrow pays the agent: `agentWallet`, falling back to the ERC-721 owner (same rule as JobEscrow). */
  async getPayoutAddress(agentId: AgentIdLike): Promise<Address> {
    const a = await this.getAgent(agentId);
    return a.agentWallet ?? a.owner;
  }

  /** Fetches and parses the agent's registration file (ERC-8004 agent card). Supports https, ipfs:// and data: URIs. */
  async fetchAgentCard(agentId: AgentIdLike, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
    const { agentURI } = await this.getAgent(agentId);
    if (agentURI.startsWith("data:")) {
      const [meta, body = ""] = agentURI.slice(5).split(",", 2);
      const text = meta?.endsWith(";base64")
        ? new TextDecoder().decode(Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0)))
        : decodeURIComponent(body);
      return JSON.parse(text);
    }
    const url = agentURI.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${agentURI.slice(7)}` : agentURI;
    const res = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new AgentPassportError(`agent card ${url}: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * ERC-8004 `getSummary` restricted to feedback written by the AgentPassport contract, i.e. only
   * feedback that a settled (or disputed) escrow job paid for. Sybil feedback from other clients is excluded.
   */
  async getEscrowReputation(agentId: AgentIdLike, blockNumber?: bigint): Promise<{ count: bigint; summary: string }> {
    try {
      const [count, value, decimals] = await this.publicClient.readContract({
        address: this.deployment.reputationRegistry,
        abi: reputationRegistryAbi,
        functionName: "getSummary",
        args: [toAgentId(agentId), [this.deployment.agentPassport], "", ""],
        blockNumber,
      });
      return { count: BigInt(count), summary: formatFixed(value, decimals) };
    } catch {
      return { count: 0n, summary: "0" };
    }
  }

  /** Individual escrow-backed feedback entries (value 1.00 = settled, 0.00 = disputed). */
  async getEscrowFeedback(agentId: AgentIdLike) {
    const id = toAgentId(agentId);
    const [clients, indexes, values, decimals, tag1s, tag2s, revoked] = await this.publicClient.readContract({
      address: this.deployment.reputationRegistry,
      abi: reputationRegistryAbi,
      functionName: "readAllFeedback",
      args: [id, [this.deployment.agentPassport], "", "", true],
    });
    return clients.map((client, i) => ({
      client,
      index: BigInt(indexes[i]!),
      value: formatFixed(values[i]!, decimals[i]!),
      tag1: tag1s[i]!,
      tag2: tag2s[i]!,
      revoked: revoked[i]!,
    }));
  }

  // ───────────────────────────── escrow reads ─────────────────────────────

  async getJob(jobId: bigint | number): Promise<Job> {
    const j = await this.publicClient.readContract({
      address: this.deployment.jobEscrow,
      abi: jobEscrowAbi,
      functionName: "getJob",
      args: [BigInt(jobId)],
    });
    return { ...j, amount: BigInt(j.amount), deadline: BigInt(j.deadline), reviewWindow: BigInt(j.reviewWindow), deliveredAt: BigInt(j.deliveredAt), status: j.status as JobStatus };
  }

  /**
   * When the agent accepted `jobId` (unix seconds), 0n if it has not, or null on an escrow that
   * predates acceptance (v1). A refund of an unaccepted job leaves no mark on the passport.
   */
  async acceptedAt(jobId: bigint | number): Promise<bigint | null> {
    try {
      const t = await this.publicClient.readContract({ address: this.deployment.jobEscrow, abi: jobEscrowAbi, functionName: "acceptedAt", args: [BigInt(jobId)] });
      return BigInt(t);
    } catch {
      return null;
    }
  }

  async jobCount(): Promise<bigint> {
    return this.publicClient.readContract({ address: this.deployment.jobEscrow, abi: jobEscrowAbi, functionName: "jobCount" });
  }

  /**
   * Jobs from `fromId` up to the current `jobCount`, optionally for one agent / status.
   * State-based (one `getJob` per id), so it works on RPCs that cap `eth_getLogs` ranges.
   */
  async listJobs(filter: { agentId?: AgentIdLike; status?: JobStatus; fromId?: bigint } = {}): Promise<Array<Job & { jobId: bigint }>> {
    const count = await this.jobCount();
    const agentId = filter.agentId === undefined ? undefined : toAgentId(filter.agentId);
    const ids: bigint[] = [];
    for (let i = filter.fromId ?? 1n; i <= count; i++) ids.push(i);
    const jobs = await Promise.all(ids.map(async (jobId) => ({ jobId, ...(await this.getJob(jobId)) })));
    return jobs.filter((j) => (agentId === undefined || j.agentId === agentId) && (filter.status === undefined || j.status === filter.status));
  }

  /** Locates the `JobDelivered` event of a delivered job (URI + hash + tx) without scanning history. */
  async getDelivery(jobId: bigint | number): Promise<Delivery | null> {
    const id = BigInt(jobId);
    const job = await this.getJob(id);
    if (job.deliveredAt === 0n) return null;
    // The delivery block is among the blocks stamped with `deliveredAt`; walk them window by window.
    const head = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    for (let from = await this.firstBlockAtOrAfter(job.deliveredAt); from <= head; from += this.maxLogRange) {
      const to = from + this.maxLogRange - 1n < head ? from + this.maxLogRange - 1n : head;
      const ev = (await this.getJobEvents({ fromBlock: from, toBlock: to })).find((e) => e.eventName === "JobDelivered" && e.args.jobId === id);
      if (ev?.eventName === "JobDelivered") {
        return { jobId: id, deliverableHash: ev.args.deliverableHash, deliverableURI: ev.args.deliverableURI, blockNumber: ev.blockNumber, transactionHash: ev.transactionHash };
      }
      if ((await this.publicClient.getBlock({ blockNumber: to })).timestamp > job.deliveredAt) break;
    }
    return null;
  }

  /**
   * Downloads a delivered job's deliverable and checks keccak256(bytes) against the hash the agent
   * committed on chain — what a hirer (or verifier) does before `release`.
   */
  async verifyDelivery(jobId: bigint | number, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; delivery: Delivery; actualHash: Hex; bytes: Uint8Array }> {
    const delivery = await this.getDelivery(jobId);
    if (!delivery) throw new AgentPassportError(`job ${jobId} has not been delivered`);
    const res = await fetchImpl(delivery.deliverableURI);
    if (!res.ok) throw new AgentPassportError(`deliverable ${delivery.deliverableURI}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const actualHash = hashContent(bytes);
    return { ok: actualHash === delivery.deliverableHash, delivery, actualHash, bytes };
  }

  // ───────────────────────────── events ─────────────────────────────

  /** Decoded JobEscrow events in [fromBlock, toBlock], paged in `maxLogRange` chunks. */
  async getJobEvents(range: { fromBlock: bigint; toBlock?: bigint }): Promise<JobEvent[]> {
    const toBlock = range.toBlock ?? (await this.publicClient.getBlockNumber({ cacheTime: 0 }));
    const out: JobEvent[] = [];
    for (let from = range.fromBlock; from <= toBlock; from += this.maxLogRange) {
      const to = from + this.maxLogRange - 1n < toBlock ? from + this.maxLogRange - 1n : toBlock;
      const logs = await this.publicClient.getLogs({ address: this.deployment.jobEscrow, fromBlock: from, toBlock: to });
      out.push(...(parseEventLogs({ abi: jobEscrowAbi, logs, strict: true }) as JobEvent[]));
    }
    return out;
  }

  /**
   * Tails JobEscrow events from `fromBlock` (default: head) and calls `onEvent` in order. Pages
   * through the 100-block `eth_getLogs` cap, so it catches up after a pause instead of skipping.
   * Returns a stop function. `onError` gets RPC errors; the loop retries on the next tick.
   */
  watchJobEvents(opts: {
    onEvent: (e: JobEvent) => void | Promise<void>;
    onError?: (err: unknown) => void;
    onBlock?: (block: bigint) => void;
    fromBlock?: bigint;
    pollMs?: number;
  }): () => void {
    let stopped = false;
    let next = opts.fromBlock;
    const tick = async () => {
      try {
        const head = await this.publicClient.getBlockNumber({ cacheTime: 0 });
        let from: bigint = next ?? head;
        while (!stopped && from <= head) {
          const to: bigint = from + this.maxLogRange - 1n < head ? from + this.maxLogRange - 1n : head;
          for (const e of await this.getJobEvents({ fromBlock: from, toBlock: to })) await opts.onEvent(e);
          from = to + 1n;
          next = from;
          opts.onBlock?.(to);
        }
      } catch (err) {
        opts.onError?.(err);
      }
      if (!stopped) timer = setTimeout(tick, opts.pollMs ?? 1000);
    };
    let timer: ReturnType<typeof setTimeout> = setTimeout(tick, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }

  // ───────────────────────────── escrow writes ─────────────────────────────

  /** Turns a friendly `HireInput` into the exact `OpenParams` struct (token pinned to the deployment's USDC). */
  toOpenParams(input: HireInput): OpenParams {
    const now = BigInt(Math.floor(Date.now() / 1000));
    return {
      agentId: toAgentId(input.agentId),
      token: this.deployment.usdc,
      amount: input.amount,
      deadline: input.deadline === undefined ? now + 86400n : BigInt(input.deadline),
      reviewWindow: input.reviewWindow === undefined ? 3600n : BigInt(input.reviewWindow),
      verifier: input.verifier ?? ZERO_ADDRESS,
      specHash: input.specHash,
      endpoint: input.endpoint ?? "",
    };
  }

  /** Hire an agent: approves USDC if the allowance is short, then `open`. Returns the new job id. */
  async hire(input: HireInput): Promise<TxResult & { jobId: bigint; params: OpenParams; approveHash?: Hex }> {
    const params = this.toOpenParams(input);
    const { account } = this.wallet();
    const allowance = await this.publicClient.readContract({
      address: this.deployment.usdc,
      abi: usdcAbi,
      functionName: "allowance",
      args: [account.address, this.deployment.jobEscrow],
    });
    let approveHash: Hex | undefined;
    if (allowance < params.amount) {
      approveHash = (await this.write(this.deployment.usdc, usdcAbi, "approve", [this.deployment.jobEscrow, params.amount])).hash;
    }
    const tx = await this.write(this.deployment.jobEscrow, jobEscrowAbi, "open", [params]);
    return { ...tx, jobId: this.jobIdFrom(tx.receipt), params, approveHash };
  }

  /** The EIP-3009 nonce `openWithAuthorization` expects (computed locally; equals `JobEscrow.openNonce`). */
  openNonce(params: OpenParams, validAfter: bigint, validBefore: bigint): Hex {
    return openNonce(this.deployment.chainId, this.deployment.jobEscrow, params, validAfter, validBefore);
  }

  /** Hirer side of a gasless hire: sign only, no transaction, no MON needed. */
  async signHire(input: HireInput, window: { validAfter?: bigint; validBefore?: bigint } = {}): Promise<{ params: OpenParams; authorization: OpenAuthorization }> {
    const params = this.toOpenParams(input);
    const { wallet, account } = this.wallet();
    const authorization = await signOpenAuthorization({
      wallet,
      account,
      chainId: this.deployment.chainId,
      escrow: this.deployment.jobEscrow,
      token: this.deployment.usdc,
      tokenDomain: this.deployment.usdcDomain,
      params,
      ...window,
    });
    return { params, authorization };
  }

  /** Relayer side of a gasless hire: submits the hirer's signed authorization and opens the job. */
  async openWithAuthorization(params: OpenParams, authorization: OpenAuthorization): Promise<TxResult & { jobId: bigint }> {
    const tx = await this.write(this.deployment.jobEscrow, jobEscrowAbi, "openWithAuthorization", [params, authorization]);
    return { ...tx, jobId: this.jobIdFrom(tx.receipt) };
  }

  /**
   * Agent side: take the job before working on it. After this the hirer can no longer cancel it,
   * and a refund after the deadline counts against the agent. Optional: `deliver` implies it.
   */
  accept(jobId: bigint | number): Promise<TxResult> {
    return this.write(this.deployment.jobEscrow, jobEscrowAbi, "accept", [BigInt(jobId)]);
  }

  /**
   * Agent side: commit to a deliverable (before the job's deadline). Pass the exact bytes (hashed here) or a precomputed hash,
   * plus the URI where the hirer can fetch those bytes.
   */
  async deliver(jobId: bigint | number, deliverable: { uri: string; content?: string | Uint8Array; hash?: Hex }): Promise<TxResult & { deliverableHash: Hex }> {
    const deliverableHash = deliverable.hash ?? (deliverable.content !== undefined ? hashContent(deliverable.content) : undefined);
    if (!deliverableHash) throw new AgentPassportError("deliver: pass content or hash");
    const tx = await this.write(this.deployment.jobEscrow, jobEscrowAbi, "deliver", [BigInt(jobId), deliverableHash, deliverable.uri]);
    return { ...tx, deliverableHash };
  }

  /** Hirer / verifier (or anyone after the review window): pay the agent and stamp its passport. */
  release(jobId: bigint | number): Promise<TxResult> {
    return this.write(this.deployment.jobEscrow, jobEscrowAbi, "release", [BigInt(jobId)]);
  }

  /**
   * Hirer: reclaim an undelivered job. Before the agent accepts it this is a cancel (any time, no
   * passport entry); after acceptance, only once the deadline has passed (recorded as a refund).
   */
  refund(jobId: bigint | number): Promise<TxResult> {
    return this.write(this.deployment.jobEscrow, jobEscrowAbi, "refund", [BigInt(jobId)]);
  }

  /** Hirer: reject a delivery inside the review window (refund + negative stamp). */
  dispute(jobId: bigint | number): Promise<TxResult> {
    return this.write(this.deployment.jobEscrow, jobEscrowAbi, "dispute", [BigInt(jobId)]);
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** Reads several view calls at one block: one Multicall3 `eth_call` if the chain defines it, else in parallel. */
  private async readMany(
    calls: Array<{ address: Address; abi: Abi; functionName: string; args: readonly unknown[] }>,
    blockNumber: bigint,
  ): Promise<Array<{ status: "success"; result: unknown } | { status: "failure"; error: Error }>> {
    if (this.publicClient.chain?.contracts?.multicall3) {
      return (await this.publicClient.multicall({ contracts: calls as never, allowFailure: true, blockNumber })) as Array<
        { status: "success"; result: unknown } | { status: "failure"; error: Error }
      >;
    }
    return Promise.all(
      calls.map((c) =>
        this.publicClient.readContract({ ...c, blockNumber } as never).then(
          (result) => ({ status: "success" as const, result: result as unknown }),
          (error: Error) => ({ status: "failure" as const, error }),
        ),
      ),
    );
  }

  private wallet(): { wallet: WalletClient; account: Account } {
    const wallet = this.walletClient;
    if (!wallet?.account) throw new AgentPassportError("this call needs a walletClient with an account");
    return { wallet, account: wallet.account };
  }

  private async write(address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<TxResult> {
    const { wallet, account } = this.wallet();
    const { request } = await this.publicClient.simulateContract({ address, abi, functionName, args, account });
    const hash = await wallet.writeContract({ ...request, chain: wallet.chain ?? null, account } as Parameters<WalletClient["writeContract"]>[0]);
    // Monad produces a block every ~400 ms; poll at that pace rather than viem's 4 s default.
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, pollingInterval: Math.min(this.publicClient.pollingInterval, 400) });
    if (receipt.status !== "success") throw new AgentPassportError(`${functionName} reverted in tx ${hash}`);
    return { hash, receipt };
  }

  private jobIdFrom(receipt: TransactionReceipt): bigint {
    const [ev] = parseEventLogs({ abi: jobEscrowAbi, logs: receipt.logs, eventName: "JobOpened" });
    if (!ev) throw new AgentPassportError(`no JobOpened event in ${receipt.transactionHash}`);
    return ev.args.jobId;
  }

  /** Binary search for the first block with timestamp >= `ts` (Monad: 2-3 blocks share a second). */
  private async firstBlockAtOrAfter(ts: bigint): Promise<bigint> {
    let lo = this.deployment.fromBlock;
    let hi = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      const b = await this.publicClient.getBlock({ blockNumber: mid });
      if (b.timestamp < ts) lo = mid + 1n;
      else hi = mid;
    }
    return lo;
  }
}

/** Signed fixed-point to a decimal string: (150, 2) -> "1.5", (-5, 1) -> "-0.5". */
export function formatFixed(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / base}${frac ? `.${frac}` : ""}`;
}

/** Shorthand for `new AgentPassportClient(opts)`. */
export function createAgentPassport(opts: AgentPassportClientOptions): AgentPassportClient {
  return new AgentPassportClient(opts);
}
