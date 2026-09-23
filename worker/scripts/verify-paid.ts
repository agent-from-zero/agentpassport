// Agent pays agent: calls agentfromzero's x402-paid AgentPassport verification endpoint, paying
// 0.001 Circle USDC on Monad testnet with one EIP-3009 signature (no MON needed by the payer; the
// Monad x402 facilitator settles on chain).
//
//   PAYER_PRIVATE_KEY=0x… node scripts/verify-paid.ts [agentId] [url]
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET, monadTestnet } from "@agentfromzero/agentpassport-sdk";

const key = process.env.PAYER_PRIVATE_KEY as Hex | undefined;
if (!key) throw new Error("PAYER_PRIVATE_KEY is required");
const agentId = process.argv[2] ?? "1908";
const url = process.argv[3] ?? "https://agentfromzero.netlify.app/v1/agent/verify";

const account = privateKeyToAccount(key);
const signer = toClientEvmSigner(account, createPublicClient({ chain: monadTestnet, transport: http() }));
// Monad testnet USDC is not one of x402's default assets: allow it explicitly, capped at 0.01 USDC per call.
const client = new x402Client()
  .register("eip155:10143", new ExactEvmScheme(signer))
  .setSpendControls({ allowedAssets: [{ network: "eip155:10143", asset: MONAD_TESTNET.usdc, maxAmountPerPayment: "10000" }] });
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ agentId, policy: { minJobsSettled: "1", maxJobsDisputed: "0" } }),
});
const receipt = res.headers.get("payment-response");
console.log(JSON.stringify({
  status: res.status,
  payer: account.address,
  settlement: receipt ? JSON.parse(Buffer.from(receipt, "base64").toString("utf8")) : null,
  body: await res.json(),
}, null, 2));
