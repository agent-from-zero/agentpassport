// Hirer side: open a job whose release is delegated to a verifier address (the Dynamic wallet).
// Gasless for the hirer: it only signs an EIP-3009 authorization; the relayer submits it.
//
//   HIRER_PRIVATE_KEY=0x… RELAYER_PRIVATE_KEY=0x… node scripts/hire-delegated.ts <spec.json> <amountUsdc> <verifier> [agentId] [endpoint]
import { readFileSync } from "node:fs";
import { AGENTFROMZERO_AGENT_ID, AgentPassportClient, hashContent, monadTestnet, parseUsdc } from "@agentfromzero/agentpassport-sdk";
import { createPublicClient, createWalletClient, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { requireEnv } from "../src/dynamic.ts";

const [specFile, amount, verifier, agentId, endpoint] = process.argv.slice(2);
if (!specFile || !amount || !verifier) throw new Error("usage: hire-delegated.ts <spec.json> <amountUsdc> <verifier> [agentId] [endpoint]");
const transport = http(process.env.MONAD_TESTNET_RPC || undefined, { retryCount: 5 });
const publicClient = createPublicClient({ chain: monadTestnet, transport, pollingInterval: 400, batch: { multicall: true } });
const clientFor = (name: string) =>
  new AgentPassportClient({ publicClient, walletClient: createWalletClient({ chain: monadTestnet, transport, account: privateKeyToAccount(requireEnv(name) as Hex) }) });

const hirer = clientFor("HIRER_PRIVATE_KEY");
const relayer = clientFor("RELAYER_PRIVATE_KEY");
const specHash = hashContent(readFileSync(specFile));
const { params, authorization } = await hirer.signHire({
  agentId: agentId ? BigInt(agentId) : AGENTFROMZERO_AGENT_ID,
  amount: parseUsdc(amount),
  specHash,
  endpoint: endpoint ?? "scorecard",
  verifier: getAddress(verifier),
});
const opened = await relayer.openWithAuthorization(params, authorization);
console.log(JSON.stringify({ jobId: opened.jobId.toString(), tx: opened.hash, block: opened.receipt.blockNumber.toString(), specHash, verifier: params.verifier, hirer: authorization.from }, null, 2));
process.exit();
