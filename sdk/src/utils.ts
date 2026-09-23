import { encodeAbiParameters, formatUnits, keccak256, parseUnits, toBytes, type Address, type Hex } from "viem";
import type { Passport, Policy, PolicyCheck, PolicyInput } from "./types.js";

export const USDC_DECIMALS = 6;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** "5" -> 5_000_000n. */
export const parseUsdc = (amount: string | number): bigint => parseUnits(String(amount), USDC_DECIMALS);
/** 5_000_000n -> "5". */
export const formatUsdc = (amount: bigint): string => formatUnits(amount, USDC_DECIMALS);

/**
 * keccak256 over the exact bytes of a spec or deliverable. Strings are hashed as UTF-8; pass the
 * raw bytes when hashing a downloaded file so line endings and encodings are not rewritten.
 */
export function hashContent(content: string | Uint8Array): Hex {
  return keccak256(typeof content === "string" ? toBytes(content) : content);
}

/**
 * The ERC-8004 `feedbackHash` AgentPassport writes for a job: keccak256(abi.encode(escrow, jobId)).
 * Anyone can recompute it to link a feedback entry to the escrow job that paid for it.
 */
export function jobRef(escrow: Address, jobId: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [escrow, jobId]));
}

const toBig = (v: bigint | number | string | undefined): bigint => (v === undefined ? 0n : BigInt(v));

/**
 * Fills a policy. Unset fields are 0, which matches Solidity defaults: in particular
 * `maxJobsDisputed` defaults to 0, i.e. "no disputes tolerated".
 */
export function toPolicy(input: PolicyInput = {}): Policy {
  return {
    minJobsSettled: toBig(input.minJobsSettled),
    minVolumeSettled: toBig(input.minVolumeSettled),
    maxJobsDisputed: toBig(input.maxJobsDisputed),
    maxAgeOfLastSettlement: toBig(input.maxAgeOfLastSettlement),
  };
}

/** Ready-made policies. Volumes are in USDC base units. */
export const POLICIES = {
  /** Has been paid through escrow at least once and never lost a dispute. */
  proven: toPolicy({ minJobsSettled: 1 }),
  /** 5+ settled jobs, 25+ USDC settled, no disputes, paid in the last 30 days. */
  active: toPolicy({ minJobsSettled: 5, minVolumeSettled: 25_000_000, maxAgeOfLastSettlement: 30 * 86400 }),
} as const;

/**
 * Explains a policy decision rule by rule. Mirrors `AgentPassport.meets` exactly; the chain's answer
 * stays authoritative (see `scorecard`, which returns both).
 */
export function evaluatePolicy(p: Passport, policy: Policy, now: bigint): { ok: boolean; checks: PolicyCheck[] } {
  const checks: PolicyCheck[] = [
    { rule: "minJobsSettled", required: `>= ${policy.minJobsSettled}`, actual: `${p.jobsSettled}`, ok: p.jobsSettled >= policy.minJobsSettled },
    {
      rule: "minVolumeSettled",
      required: `>= ${policy.minVolumeSettled}`,
      actual: `${p.volumeSettled}`,
      ok: p.volumeSettled >= policy.minVolumeSettled,
    },
    { rule: "maxJobsDisputed", required: `<= ${policy.maxJobsDisputed}`, actual: `${p.jobsDisputed}`, ok: p.jobsDisputed <= policy.maxJobsDisputed },
  ];
  if (policy.maxAgeOfLastSettlement !== 0n) {
    const age = p.lastSettled === 0n ? null : now - p.lastSettled;
    checks.push({
      rule: "maxAgeOfLastSettlement",
      required: `<= ${policy.maxAgeOfLastSettlement}s`,
      actual: age === null ? "never settled" : `${age}s`,
      ok: age !== null && age <= policy.maxAgeOfLastSettlement,
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

/** Parses a decimal/hex/bigint agent id; throws on anything that is not a non-negative integer. */
export function toAgentId(v: bigint | number | string): bigint {
  if (typeof v === "bigint") {
    if (v < 0n) throw new Error(`invalid agentId: ${v}`);
    return v;
  }
  const s = String(v).trim();
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(s)) throw new Error(`invalid agentId: ${s}`);
  return BigInt(s);
}
