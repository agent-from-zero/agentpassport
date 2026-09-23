import { encodeAbiParameters, keccak256, toBytes, type Account, type Address, type Hex, type WalletClient } from "viem";
import type { OpenAuthorization, OpenParams } from "./types.js";

/** keccak256("AgentPassport.JobEscrow.openWithAuthorization") — the domain tag of `openNonce`. */
export const OPEN_AUTH_TYPEHASH = keccak256(toBytes("AgentPassport.JobEscrow.openWithAuthorization"));

/**
 * The EIP-3009 nonce that binds a hirer's USDC authorization to one exact job.
 * Byte-for-byte the same as `JobEscrow.openNonce` (checked against the live contract in the tests):
 * a relayer that changes the agent, amount, deadline, verifier, spec or endpoint invalidates it.
 */
export function openNonce(
  chainId: number | bigint,
  escrow: Address,
  p: OpenParams,
  validAfter: bigint,
  validBefore: bigint,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint128" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        OPEN_AUTH_TYPEHASH,
        BigInt(chainId),
        escrow,
        p.agentId,
        p.token,
        p.amount,
        p.deadline,
        p.reviewWindow,
        p.verifier,
        p.specHash,
        keccak256(toBytes(p.endpoint)),
        validAfter,
        validBefore,
      ],
    ),
  );
}

/** EIP-712 types of Circle USDC's `receiveWithAuthorization` (EIP-3009) — also what x402 "exact" signs. */
export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface SignOpenArgs {
  /** Wallet of the hirer; it signs only, it needs no MON. */
  wallet: WalletClient;
  account?: Account | Address;
  chainId: number;
  escrow: Address;
  token: Address;
  tokenDomain: { name: string; version: string };
  params: OpenParams;
  /** Unix seconds; default 0 (valid immediately). */
  validAfter?: bigint;
  /** Unix seconds; default now + 1 h. */
  validBefore?: bigint;
}

/**
 * Hirer side of a gasless hire: signs an EIP-3009 `ReceiveWithAuthorization` for exactly
 * `params.amount` USDC to the escrow, with the nonce bound to `params`. Anyone (the agent, a relayer,
 * an x402 facilitator) can then submit `JobEscrow.openWithAuthorization(params, authorization)`.
 */
export async function signOpenAuthorization(args: SignOpenArgs): Promise<OpenAuthorization> {
  const account = args.account ?? args.wallet.account;
  if (!account) throw new Error("signOpenAuthorization: wallet has no account");
  const from = typeof account === "string" ? account : account.address;
  const validAfter = args.validAfter ?? 0n;
  const validBefore = args.validBefore ?? BigInt(Math.floor(Date.now() / 1000) + 3600);
  const nonce = openNonce(args.chainId, args.escrow, args.params, validAfter, validBefore);
  const signature = await args.wallet.signTypedData({
    account,
    domain: { ...args.tokenDomain, chainId: args.chainId, verifyingContract: args.token },
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message: { from, to: args.escrow, value: args.params.amount, validAfter, validBefore, nonce },
  });
  return { from, validAfter, validBefore, nonce, signature };
}
