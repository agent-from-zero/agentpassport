import { S, createEffect } from "envio";
import { createPublicClient, http, parseAbi } from "viem";
import { parseJobKey } from "./util.js";

const RPC_URL = process.env.ENVIO_MONAD_RPC_URL ?? "http://localhost:8545";
const IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;

const client = createPublicClient({ transport: http(RPC_URL, { batch: true, retryCount: 5, retryDelay: 1500 }) });

const identityAbi = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
]);
const escrowAbi = parseAbi([
  "function getJob(uint256 jobId) view returns ((uint256 agentId, address hirer, address verifier, address token, uint128 amount, uint64 deadline, uint64 reviewWindow, uint64 deliveredAt, uint8 status, bytes32 specHash, bytes32 deliverableHash))",
]);

/**
 * ERC-8004 identity of an agent that was registered before this indexer's start block (so its
 * Registered / MetadataSet events are not in range). Later changes arrive as events and win.
 */
export const readIdentity = createEffect(
  {
    name: "readIdentity",
    input: S.string,
    output: { owner: S.nullable(S.string), agentWallet: S.nullable(S.string), agentURI: S.nullable(S.string) },
    rateLimit: { calls: 5, per: "second" },
    cache: true,
  },
  async ({ input }) => {
    const agentId = BigInt(input);
    const [owner, wallet, uri] = await Promise.allSettled([
      client.readContract({ address: IDENTITY, abi: identityAbi, functionName: "ownerOf", args: [agentId] }),
      client.readContract({ address: IDENTITY, abi: identityAbi, functionName: "getAgentWallet", args: [agentId] }),
      client.readContract({ address: IDENTITY, abi: identityAbi, functionName: "tokenURI", args: [agentId] }),
    ]);
    const addr = (r: PromiseSettledResult<string>) =>
      r.status === "fulfilled" && !/^0x0{40}$/i.test(r.value) ? r.value.toLowerCase() : null;
    return {
      owner: addr(owner),
      agentWallet: addr(wallet),
      agentURI: uri.status === "fulfilled" && uri.value ? uri.value : null,
    };
  },
);

/**
 * A job's verifier is fixed at open time and not in any event; read it once per released job.
 * Input is the Job entity id (`${escrow}-${jobId}`): v1 and v2 share `getJob`'s layout.
 */
export const readJobVerifier = createEffect(
  {
    name: "readJobVerifier",
    input: S.string,
    output: S.string,
    rateLimit: { calls: 5, per: "second" },
    cache: true,
  },
  async ({ input }) => {
    const { escrow, jobId } = parseJobKey(input);
    const job = await client.readContract({ address: escrow, abi: escrowAbi, functionName: "getJob", args: [jobId] });
    return job.verifier.toLowerCase();
  },
);
