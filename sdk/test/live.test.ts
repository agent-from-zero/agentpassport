// Read-only checks against the live Monad testnet deployment. No keys, no transactions.
// Skipped with LIVE=0 (e.g. offline CI). RPC override: MONAD_TESTNET_RPC.
import { createPublicClient, http } from "viem";
import { describe, expect, it } from "vitest";
import {
  AGENTFROMZERO_AGENT_ID,
  AgentPassportClient,
  MONAD_TESTNET,
  POLICIES,
  hashContent,
  jobEscrowAbi,
  monadTestnet,
  parseUsdc,
  reputationRegistryAbi,
  toPolicy,
  type OpenParams,
} from "../src/index.js";

const live = process.env.LIVE !== "0";
const publicClient = createPublicClient({ chain: monadTestnet, transport: http(process.env.MONAD_TESTNET_RPC) });
const ap = new AgentPassportClient({ publicClient });

describe.runIf(live)("live Monad testnet (read-only)", () => {
  it("agentfromzero (agentId 1908) has an escrow-backed passport and meets `proven`", async () => {
    const p = await ap.getPassport(AGENTFROMZERO_AGENT_ID);
    expect(p.jobsSettled).toBeGreaterThanOrEqual(1n);
    expect(p.volumeSettled).toBeGreaterThanOrEqual(parseUsdc("5"));
    expect(p.token).toBe(MONAD_TESTNET.usdc);
    expect(await ap.meets(AGENTFROMZERO_AGENT_ID, POLICIES.proven)).toBe(true);
    expect(await ap.meets(AGENTFROMZERO_AGENT_ID, toPolicy({ minJobsSettled: 1_000_000 }))).toBe(false);
  });

  it("scorecard agrees with the chain and carries identity + escrow-backed ERC-8004 reputation", async () => {
    const card = await ap.scorecard(AGENTFROMZERO_AGENT_ID, POLICIES.proven);
    expect(card.meets).toBe(true);
    expect(card.checks.every((c) => c.ok)).toBe(true);
    expect(card.identity?.agentURI).toBe("https://agentfromzero.netlify.app/.well-known/agent-card.json");
    expect(Number(card.reputation.count)).toBeGreaterThanOrEqual(1);
    const fb = await ap.getEscrowFeedback(AGENTFROMZERO_AGENT_ID);
    expect(fb[0]).toMatchObject({ client: MONAD_TESTNET.agentPassport, tag1: "agentpassport", tag2: "settled", value: "1", revoked: false });
  });

  it("escrow-backed reputation ignores ERC-8004 feedback from other clients (agent 1 has some, none escrow-backed)", async () => {
    const block = await publicClient.getBlockNumber();
    const [a, b] = await Promise.all([ap.scorecard(1n, POLICIES.proven, { blockNumber: block }), ap.scorecard(AGENTFROMZERO_AGENT_ID, POLICIES.proven, { blockNumber: block })]);
    expect(a.blockNumber).toBe(b.blockNumber);
    expect(a.identity).not.toBeNull();
    expect(a.meets).toBe(false);
    expect(a.reputation.count).toBe("0");
    expect(await publicClient.readContract({ address: MONAD_TESTNET.reputationRegistry, abi: reputationRegistryAbi, functionName: "getClients", args: [1n] })).not.toHaveLength(0);
  });

  it("local openNonce is byte-identical to JobEscrow.openNonce on chain", async () => {
    const params: OpenParams = {
      agentId: AGENTFROMZERO_AGENT_ID,
      token: MONAD_TESTNET.usdc,
      amount: parseUsdc("1.25"),
      deadline: 1_900_000_000n,
      reviewWindow: 3600n,
      verifier: "0x000000000000000000000000000000000000dEaD",
      specHash: hashContent("nonce parity"),
      endpoint: "scorecard",
    };
    const onChain = await publicClient.readContract({ address: MONAD_TESTNET.jobEscrow, abi: jobEscrowAbi, functionName: "openNonce", args: [params, 5n, 1_900_000_000n] });
    expect(ap.openNonce(params, 5n, 1_900_000_000n)).toBe(onChain);
  });

  it("finds job #1's delivery without an archive log scan, and the served bytes match the on-chain hash", async () => {
    const d = await ap.getDelivery(1n);
    expect(d).toMatchObject({
      deliverableURI: "https://agentfromzero.netlify.app/jobs/1/deliverable.json",
      deliverableHash: "0xbbd6a22caa4676e008b34a7b000e483b98149d9323153720d04954e49627add9",
      transactionHash: "0x1072a2edbaf47ccbd22ae48a2e286209b814489f6a564a338e9f6e367473706d",
    });
    expect((await ap.verifyDelivery(1n)).ok).toBe(true);
  });

  it("agent card resolves from the ERC-8004 tokenURI", async () => {
    const card = await ap.fetchAgentCard(AGENTFROMZERO_AGENT_ID);
    expect(card.name).toBe("agentfromzero");
  });
});
