import type { Address, Hex } from "viem";

/** On-chain passport (mirrors `IAgentPassport.Passport`). Volumes are in settlement-token units. */
export interface Passport {
  jobsSettled: bigint;
  jobsRefunded: bigint;
  jobsDisputed: bigint;
  /** Unix seconds of the first attested job (0 = never hired). */
  firstSeen: bigint;
  /** Unix seconds of the last settlement (0 = never settled). */
  lastSettled: bigint;
  volumeSettled: bigint;
  /** Settlement token; zero address until the first attestation. */
  token: Address;
}

/** Hiring policy evaluated on-chain by `AgentPassport.meets` (mirrors `IAgentPassport.Policy`). */
export interface Policy {
  minJobsSettled: bigint;
  minVolumeSettled: bigint;
  maxJobsDisputed: bigint;
  /** Seconds; 0 disables the recency check. */
  maxAgeOfLastSettlement: bigint;
}

/** Loose policy input: every field optional, numbers or bigints or decimal strings. */
export type PolicyInput = Partial<Record<keyof Policy, bigint | number | string>>;

/** Escrow job status (mirrors `IJobEscrow.Status`). */
export const JobStatus = {
  None: 0,
  Open: 1,
  Delivered: 2,
  Released: 3,
  Refunded: 4,
  Disputed: 5,
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

/** 2 -> "Delivered". */
export const jobStatusName = (s: JobStatus): keyof typeof JobStatus =>
  (Object.keys(JobStatus) as Array<keyof typeof JobStatus>).find((k) => JobStatus[k] === s) ?? "None";

/** A job as stored by `JobEscrow.getJob`. */
export interface Job {
  agentId: bigint;
  hirer: Address;
  verifier: Address;
  token: Address;
  amount: bigint;
  deadline: bigint;
  reviewWindow: bigint;
  deliveredAt: bigint;
  status: JobStatus;
  specHash: Hex;
  deliverableHash: Hex;
}

/** Parameters for opening a job (mirrors `IJobEscrow.OpenParams`). */
export interface OpenParams {
  agentId: bigint;
  token: Address;
  amount: bigint;
  deadline: bigint;
  reviewWindow: bigint;
  verifier: Address;
  specHash: Hex;
  endpoint: string;
}

/** Friendlier input for opening a job; the SDK fills in the token and sane defaults. */
export interface HireInput {
  agentId: bigint | number;
  /** Amount in USDC base units (6 decimals). Use `parseUsdc("5")` for 5 USDC. */
  amount: bigint;
  /** keccak256 of the spec bytes (see `hashContent`). */
  specHash: Hex;
  /** Skill / endpoint label, forwarded to the ERC-8004 feedback entry. */
  endpoint?: string;
  /** Unix seconds; default now + 24 h. */
  deadline?: bigint | number;
  /** Seconds after delivery in which the hirer may dispute; default 3600. */
  reviewWindow?: bigint | number;
  /** Optional third party allowed to release. */
  verifier?: Address;
}

/** EIP-3009 authorization that funds `openWithAuthorization` (mirrors `IJobEscrow.Authorization`). */
export interface OpenAuthorization {
  from: Address;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
}

/** One line of a policy scorecard. */
export interface PolicyCheck {
  rule: keyof Policy;
  required: string;
  actual: string;
  ok: boolean;
}

/** Human- and machine-readable verdict for "should I trust / hire this agent?". */
export interface Scorecard {
  agentId: string;
  chainId: number;
  blockNumber: string;
  /** `AgentPassport.meets(agentId, policy)` as returned by the chain. */
  meets: boolean;
  checks: PolicyCheck[];
  passport: {
    jobsSettled: string;
    jobsRefunded: string;
    jobsDisputed: string;
    volumeSettled: string;
    volumeSettledUsdc: string;
    firstSeen: string | null;
    lastSettled: string | null;
    token: Address | null;
  };
  identity: { owner: Address; agentWallet: Address | null; agentURI: string } | null;
  /** Escrow-backed ERC-8004 feedback: entries written by the AgentPassport contract only. */
  reputation: { count: string; summaryValue: string | null; client: Address };
  policy: Record<keyof Policy, string>;
}
