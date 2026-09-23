// CLI entry point.  node src/main.ts [--once] [--job <id>]
//
//   --once      sweep open jobs for the agent, handle them, exit (cron-friendly)
//   --job <id>  handle one job and exit
//   (default)   sweep, then tail JobEscrow events until Ctrl-C
//
// Configuration is environment-only so no key ever lands in a file of this repo:
//   AGENT_PRIVATE_KEY  (required) key of the agent's ERC-8004 owner / operator / agentWallet
//   AGENT_ID           ERC-8004 agentId to work for (default 1908 = agentfromzero)
//   AGENT_NAME         name written into deliverables (default "ERC-8004 agent <id>")
//   MONAD_TESTNET_RPC  RPC URL (default https://testnet-rpc.monad.xyz)
//   SPEC_BASES         comma-separated URLs/dirs holding <specHash>.json (default https://agentfromzero.netlify.app/specs)
//   PUBLISH_DIR        directory the deliverable is written to (default ./published)
//   PUBLIC_BASE_URL    URL that serves PUBLISH_DIR (default https://agentfromzero.netlify.app)
//   PUBLISH_PREFIX     path of the job folders (default jobs/<escrow address>: job ids restart per escrow)
//   DEPLOY_CMD         optional shell command run after writing (e.g. a static-site deploy)
//   MIN_AMOUNT_USDC    ignore jobs paying less (default 0.01)
//   STATE_FILE / LOG_FILE  (default ./worker-state.json / ./worker.log, JSON lines)
import { appendFileSync } from "node:fs";
import { AGENTFROMZERO_AGENT_ID, AgentPassportClient, monadTestnet, parseUsdc, toAgentId } from "@agentfromzero/agentpassport-sdk";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DirPublisher } from "./io.ts";
import { DEFAULT_SKILLS } from "./skills.ts";
import { Worker, type Logger } from "./worker.ts";

const env = process.env;
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const key = env.AGENT_PRIVATE_KEY as Hex | undefined;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("AGENT_PRIVATE_KEY (0x + 64 hex) is required");
  process.exit(2);
}
const logFile = env.LOG_FILE ?? "worker.log";
const log: Logger = (level, msg, extra = {}) => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  console.log(line);
  appendFileSync(logFile, line + "\n");
};

const transport = http(env.MONAD_TESTNET_RPC || monadTestnet.rpcUrls.default.http[0], { retryCount: 5 });
const account = privateKeyToAccount(key);
const client = new AgentPassportClient({
  publicClient: createPublicClient({ chain: monadTestnet, transport, pollingInterval: 400, batch: { multicall: true } }),
  walletClient: createWalletClient({ chain: monadTestnet, transport, account }),
});
const agentId = env.AGENT_ID ? toAgentId(env.AGENT_ID) : AGENTFROMZERO_AGENT_ID;

// Fail fast if this key cannot deliver for the agent (same rule as JobEscrow._isAgent, minus operators).
const agent = await client.getAgent(agentId);
if (agent.owner !== account.address && agent.agentWallet !== account.address) {
  log("warn", "key is neither owner nor agentWallet of the agent; deliver() will revert unless it is an approved operator", {
    agentId: agentId.toString(),
    key: account.address,
    owner: agent.owner,
    agentWallet: agent.agentWallet,
  });
}

const worker = new Worker({
  client,
  agentId,
  skills: DEFAULT_SKILLS,
  specBases: (env.SPEC_BASES ?? "https://agentfromzero.netlify.app/specs").split(",").map((s) => s.trim()).filter(Boolean),
  publisher: new DirPublisher({
    dir: env.PUBLISH_DIR ?? "published",
    baseUrl: env.PUBLIC_BASE_URL ?? "https://agentfromzero.netlify.app",
    pathPrefix: env.PUBLISH_PREFIX ?? `jobs/${client.deployment.jobEscrow.toLowerCase()}`,
    deployCmd: env.DEPLOY_CMD || undefined,
    log: (msg, extra) => log("info", msg, extra),
  }),
  log,
  minAmount: parseUsdc(env.MIN_AMOUNT_USDC ?? "0.01"),
  stateFile: env.STATE_FILE ?? "worker-state.json",
  agentName: env.AGENT_NAME,
});

log("info", "worker up", { agentId: agentId.toString(), key: account.address, escrow: client.deployment.jobEscrow, skills: DEFAULT_SKILLS.map((s) => s.name) });

const one = opt("--job");
if (one !== undefined) {
  const rec = await worker.handle(BigInt(one));
  log("info", "done", { jobId: one, result: rec?.status ?? "nothing to do" });
} else if (flag("--once")) {
  await worker.catchUp();
  log("info", "done", { jobs: worker.jobs });
} else {
  await worker.start();
  const shutdown = () => {
    worker.stop();
    log("info", "stopped");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
