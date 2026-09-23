// The hirer's side of a job, for demos and manual testing.
//
//   HIRER_PRIVATE_KEY=0x… RELAYER_PRIVATE_KEY=0x… node scripts/hirer.ts open-gasless <spec.json> <amountUsdc> [agentId] [endpoint]
//       The hirer only signs an EIP-3009 authorization (no MON spent); the relayer submits
//       JobEscrow.openWithAuthorization. Prints the jobId.
//   HIRER_PRIVATE_KEY=0x… node scripts/hirer.ts release <jobId>
//       Fetches the deliverable from the URI in the JobDelivered event, checks keccak256(bytes)
//       against the on-chain deliverableHash, and releases only if they match.
import { readFileSync } from "node:fs";
import { AGENTFROMZERO_AGENT_ID, AgentPassportClient, hashContent, monadTestnet, parseUsdc } from "@agentfromzero/agentpassport-sdk";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const transport = http(process.env.MONAD_TESTNET_RPC || undefined, { retryCount: 5 });
const publicClient = createPublicClient({ chain: monadTestnet, transport, pollingInterval: 400, batch: { multicall: true } });
const clientFor = (envName: string) => {
  const key = process.env[envName] as Hex | undefined;
  if (!key) throw new Error(`${envName} is required`);
  return new AgentPassportClient({ publicClient, walletClient: createWalletClient({ chain: monadTestnet, transport, account: privateKeyToAccount(key) }) });
};
const out = (o: unknown) => console.log(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "open-gasless") {
  const [specFile, amount, agentId, endpoint] = rest;
  if (!specFile || !amount) throw new Error("usage: open-gasless <spec.json> <amountUsdc> [agentId] [endpoint]");
  const specHash = hashContent(readFileSync(specFile));
  const hirer = clientFor("HIRER_PRIVATE_KEY");
  const relayer = clientFor("RELAYER_PRIVATE_KEY");
  const hirerAddr = hirer.walletClient!.account!.address;
  const monBefore = await publicClient.getBalance({ address: hirerAddr });
  const { params, authorization } = await hirer.signHire({
    agentId: agentId ?? AGENTFROMZERO_AGENT_ID,
    amount: parseUsdc(amount),
    specHash,
    endpoint: endpoint ?? "scorecard",
  });
  const opened = await relayer.openWithAuthorization(params, authorization);
  const monAfter = await publicClient.getBalance({ address: hirerAddr });
  out({ jobId: opened.jobId, tx: opened.hash, block: opened.receipt.blockNumber, specHash, nonce: authorization.nonce, hirer: hirerAddr, relayer: relayer.walletClient!.account!.address, hirerMonSpent: monBefore - monAfter });
} else if (cmd === "release") {
  const jobId = BigInt(rest[0] ?? NaN);
  const hirer = clientFor("HIRER_PRIVATE_KEY");
  const v = await hirer.verifyDelivery(jobId);
  if (!v.ok) {
    out({ jobId, released: false, reason: "deliverable bytes do not match the on-chain hash", expected: v.delivery.deliverableHash, actual: v.actualHash });
    process.exit(1);
  }
  const tx = await hirer.release(jobId);
  out({ jobId, released: true, tx: tx.hash, block: tx.receipt.blockNumber, deliverableURI: v.delivery.deliverableURI, deliverableHash: v.actualHash, deliverTx: v.delivery.transactionHash });
} else {
  console.error("commands: open-gasless <spec.json> <amountUsdc> [agentId] [endpoint] | release <jobId>");
  process.exit(2);
}
