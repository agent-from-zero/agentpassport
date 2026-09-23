import { encodeAbiParameters, keccak256 } from "viem";

export const JOB_ESCROW = "0x5b197edd258572dee7c923a6d38d6db268a266bc";
export const AGENT_PASSPORT = "0xd01ec5fd5a9a4335d64600ada4e010aa6faf9d0a";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Function selectors of JobEscrow entry points (from the Foundry build). */
export const SELECTOR = {
  open: "25c566ab",
  openWithAuthorization: "b8e8fa51",
  release: "37bdc99b",
  releaseWithPasskey: "ab9550db",
} as const;

/** The escrow's job reference: keccak256(abi.encode(escrow, jobId)). Same value as the stamp id and ERC-8004 feedbackHash. */
export function jobRefOf(jobId: bigint, escrow: string = JOB_ESCROW): string {
  return keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [escrow as `0x${string}`, jobId]),
  ).toLowerCase();
}

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
