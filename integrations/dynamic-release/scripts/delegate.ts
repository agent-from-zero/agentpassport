// The delegated-release verifier, signing with the Dynamic server wallet.
//
//   env: DYNAMIC_ENVIRONMENT_ID, DYNAMIC_AUTH_TOKEN, DYNAMIC_WALLET_PASSWORD, DYNAMIC_WALLET_METADATA
//        (JSON printed by create-wallet.ts), optional MONAD_TESTNET_RPC, MAX_RELEASE_USDC (default 5),
//        AGENT_IDS (comma list; default any), STATE_FILE (JSON log of decisions)
//
//   node scripts/delegate.ts address          the delegate's address (fund it with a little MON)
//   node scripts/delegate.ts check <jobId>    run the checks, send nothing
//   node scripts/delegate.ts release <jobId>  run the checks and release if they all pass
//   node scripts/delegate.ts sweep [fromJob]  process every delivered job that names this delegate
//   node scripts/delegate.ts watch [fromJob]  sweep every 30 s until stopped
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AgentPassportClient, monadTestnet, parseUsdc } from "@agentfromzero/agentpassport-sdk";
import { createPublicClient, http } from "viem";
import { ReleaseDelegate, type Decision } from "../src/delegate.ts";
import { dynamicEvmClient, dynamicWalletClient, requireEnv } from "../src/dynamic.ts";

const rpcUrl = process.env.MONAD_TESTNET_RPC || monadTestnet.rpcUrls.default.http[0];
const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl, { retryCount: 5 }), pollingInterval: 400, batch: { multicall: true } });
const walletClient = await dynamicWalletClient({
  client: await dynamicEvmClient(),
  walletMetadata: JSON.parse(requireEnv("DYNAMIC_WALLET_METADATA")),
  password: requireEnv("DYNAMIC_WALLET_PASSWORD"),
  chain: monadTestnet,
  rpcUrl,
});
const delegate = new ReleaseDelegate({
  client: new AgentPassportClient({ publicClient, walletClient }),
  maxAmount: parseUsdc(process.env.MAX_RELEASE_USDC ?? "5"),
  agentIds: (process.env.AGENT_IDS ?? "").split(",").filter(Boolean).map(BigInt),
  log: (msg, extra) => console.error(new Date().toISOString(), msg, JSON.stringify(extra ?? {})),
});
const out = (o: unknown) => console.log(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
const record = (d: Decision) => {
  const f = process.env.STATE_FILE;
  if (!f) return;
  const state = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { delegate: delegate.address, decisions: [] };
  state.decisions.push({ at: new Date().toISOString(), ...d });
  writeFileSync(f, JSON.stringify(state, null, 2));
};

const [cmd, arg] = process.argv.slice(2);
if (cmd === "address") {
  out({ delegate: delegate.address, balanceWei: await publicClient.getBalance({ address: delegate.address }) });
} else if (cmd === "check") {
  out(await delegate.evaluate(BigInt(arg ?? NaN)));
} else if (cmd === "release") {
  const d = await delegate.process(BigInt(arg ?? NaN));
  record(d);
  out(d);
  if (!d.release) process.exitCode = 1;
} else if (cmd === "sweep" || cmd === "watch") {
  const from = BigInt(arg ?? 1);
  for (;;) {
    for (const d of await delegate.sweep(from)) {
      record(d);
      out(d);
    }
    if (cmd === "sweep") break;
    await new Promise((r) => setTimeout(r, 30_000));
  }
} else {
  console.error("commands: address | check <jobId> | release <jobId> | sweep [fromJob] | watch [fromJob]");
  process.exitCode = 2;
}
process.exit();
