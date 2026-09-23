import { encodeAbiParameters, keccak256 } from "viem";

/**
 * Both JobEscrow deployments attest into the same AgentPassport. v1 (jobs #1-#5, all closed) was
 * replaced after a security review by v2, which adds agent acceptance (`JobAccepted`) and does not
 * attest a refund of a job the agent never accepted. Job ids restart at 1 on each escrow, so every
 * job-keyed entity is scoped by escrow address (see `jobKey`).
 */
export const JOB_ESCROW_V1 = "0x5b197edd258572dee7c923a6d38d6db268a266bc";
export const JOB_ESCROW_V2 = "0x41cb9b1a7ebe2e1a420d8cd96d02a9009ac54355";
/** Escrows without agent acceptance: every refund there was attested against the agent. */
const ESCROWS_WITHOUT_ACCEPTANCE = new Set([JOB_ESCROW_V1]);
export const AGENT_PASSPORT = "0xd01ec5fd5a9a4335d64600ada4e010aa6faf9d0a";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Function selectors of JobEscrow entry points (from the Foundry build; identical on v1 and v2). */
export const SELECTOR = {
  open: "25c566ab",
  openWithAuthorization: "b8e8fa51",
  release: "37bdc99b",
  releaseWithPasskey: "ab9550db",
} as const;

/** The escrow's job reference: keccak256(abi.encode(escrow, jobId)). Same value as the stamp id and ERC-8004 feedbackHash. */
export function jobRefOf(jobId: bigint, escrow: string): string {
  return keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [escrow as `0x${string}`, jobId]),
  ).toLowerCase();
}

/** Job entity id: `${escrow}-${jobId}` (lowercase escrow address), unique across escrows. */
export const jobKey = (escrow: string, jobId: bigint | string): string => `${escrow.toLowerCase()}-${jobId}`;

/** Splits a `jobKey` back into escrow address and job id. */
export function parseJobKey(key: string): { escrow: `0x${string}`; jobId: bigint } {
  const [escrow, jobId] = key.split("-");
  return { escrow: escrow as `0x${string}`, jobId: BigInt(jobId ?? "0") };
}

/**
 * True when a refund on this escrow says nothing about the agent: v2+ escrows attest a refund only
 * for a job the agent accepted, so an unaccepted refund is the hirer cancelling.
 */
export const hasAcceptance = (escrow: string): boolean => !ESCROWS_WITHOUT_ACCEPTANCE.has(escrow.toLowerCase());

/** First 4 bytes of calldata as 8 lowercase hex chars ("" for empty input). */
export function selectorOf(input: string | undefined): string {
  if (!input || input.length < 10) return "";
  return input.slice(2, 10).toLowerCase();
}

export const dayOf = (ts: number): number => Math.floor(ts / 86400);
export const isoDate = (day: number): string => new Date(day * 86400 * 1000).toISOString().slice(0, 10);
export const toDate = (ts: number): Date => new Date(ts * 1000);

/** ERC-8004 stores agentWallet as abi.encodePacked(address) (20 bytes) or "" when cleared. */
export function decodeAgentWallet(value: string): string | undefined {
  const hex = value.toLowerCase().replace(/^0x/, "");
  if (hex.length === 40) return "0x" + hex;
  if (hex.length === 64) return "0x" + hex.slice(24); // tolerate a 32-byte abi.encode
  return undefined;
}

export const bps = (part: bigint, whole: bigint): number => (whole === 0n ? 0 : Number((part * 10000n) / whole));
