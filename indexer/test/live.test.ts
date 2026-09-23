/**
 * Live check against Monad testnet (opt-in: LIVE=1 npm test). Indexes the real range from the
 * AgentPassport deployment through job #3's release over RPC and compares the indexed passport of
 * agentfromzero (ERC-8004 agentId 1908) with the contract's own `passportOf` and `getJob`.
 */
import { describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { createPublicClient, http, parseAbi } from "viem";
import { JOB_ESCROW_V1, jobKey, jobRefOf } from "../src/lib/util.js";

const LIVE = process.env.LIVE === "1";
const START = 64403471;
const END = 64935500; // after job #3 (escrow v1) was released (block 64935457); before escrow v2 exists
const rpc = createPublicClient({ transport: http(process.env.ENVIO_MONAD_RPC_URL ?? "https://10143.rpc.thirdweb.com") });
const passportAbi = parseAbi([
  "function passportOf(uint256) view returns ((uint64 jobsSettled, uint64 jobsRefunded, uint64 jobsDisputed, uint64 firstSeen, uint64 lastSettled, uint128 volumeSettled, address token))",
]);

describe.skipIf(!LIVE)("live Monad testnet", () => {
  it("indexed passport of agent 1908 equals passportOf() at the same block", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 10143: { startBlock: START, endBlock: END } } });

    const onchain = await rpc.readContract({
      address: "0xd01EC5Fd5A9A4335D64600aDA4E010AA6fAF9d0A",
      abi: passportAbi,
      functionName: "passportOf",
      args: [1908n],
      blockNumber: BigInt(END),
    });
    const agent = await indexer.Agent.getOrThrow("1908");
    t.expect(agent.jobsSettled).toBe(Number(onchain.jobsSettled));
    t.expect(agent.jobsRefunded).toBe(Number(onchain.jobsRefunded));
    t.expect(agent.jobsDisputed).toBe(Number(onchain.jobsDisputed));
    t.expect(agent.volumeSettled).toBe(onchain.volumeSettled);
    t.expect(Math.floor(agent.lastSettledAt!.getTime() / 1000)).toBe(Number(onchain.lastSettled));
    t.expect(agent.owner).toBe("0x99e6c3fae6a1ebaed0bffffeb2b6443fac595a28");

    const job3 = await indexer.Job.getOrThrow(jobKey(JOB_ESCROW_V1, 3n));
    t.expect(job3.status).toBe("Released");
    t.expect(job3.gasless).toBe(true);
    t.expect(job3.releasePath).toBe("Hirer");
    t.expect(job3.jobRef).toBe(jobRefOf(3n, JOB_ESCROW_V1));
    const job2 = await indexer.Job.getOrThrow(jobKey(JOB_ESCROW_V1, 2n));
    t.expect(job2.status).toBe("Refunded");

    const stamp = await indexer.Stamp.getOrThrow(jobRefOf(3n, JOB_ESCROW_V1));
    t.expect(stamp.mirrored).toBe(true);
    t.expect(agent.feedbackEscrowBacked).toBe(2);
    console.log("agent 1908 as indexed:", JSON.stringify(agent, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  }, 1_800_000);
});
