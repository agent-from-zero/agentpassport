// Local dev chain for tests: anvil running the real AgentPassport + JobEscrow bytecode from
// `forge build`, wired to mock ERC-8004 registries and a mock EIP-3009 USDC. Shared by the SDK and
// the worker test suites.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AgentPassportClient, parseUsdc, type Deployment } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const artifact = (file: string, name: string) => {
  const j = JSON.parse(readFileSync(join(root, "out", file, `${name}.json`), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
};
const anvilBin = [join(root, "..", "tools", "foundry", "anvil.exe"), join(root, "..", "tools", "foundry", "anvil")].find(existsSync) ?? "anvil";

// anvil's well-known dev keys (public, test-only).
export const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  hirer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  agent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3faa6868f95b5b0e",
  stranger: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;
export type Role = keyof typeof KEYS;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

export interface DevChain {
  rpc: string;
  chain: ReturnType<typeof defineChain>;
  pub: PublicClient;
  wallets: Record<Role, WalletClient>;
  sdk: Record<Role, AgentPassportClient>;
  deployment: Deployment;
  agentId: bigint;
  send(w: WalletClient, address: Address, abi: Abi, functionName: string, args: unknown[]): Promise<void>;
  usdcBalance(who: Address): Promise<bigint>;
  stop(): void;
}

export async function startDevChain(opts: { maxLogRange?: bigint } = {}): Promise<DevChain> {
  const port = await freePort();
  const rpc = `http://127.0.0.1:${port}`;
  const anvil = spawn(anvilBin, ["--port", String(port), "--silent"], { stdio: "ignore" });
  const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 50 }) as PublicClient;
  for (let i = 0; ; i++) {
    try {
      await pub.getChainId();
      break;
    } catch (e) {
      if (i > 100) {
        anvil.kill();
        throw e;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const wallets = Object.fromEntries(
    Object.entries(KEYS).map(([k, key]) => [k, createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(rpc) })]),
  ) as unknown as Record<Role, WalletClient>;
  const test = createTestClient({ chain, mode: "anvil", transport: http(rpc) });
  for (const w of Object.values(wallets)) await test.setBalance({ address: w.account!.address, value: 10n ** 21n });

  const deploy = async (w: WalletClient, a: { abi: Abi; bytecode: Hex }, args: unknown[] = []): Promise<Address> => {
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: w.account!, chain });
    const r = await pub.waitForTransactionReceipt({ hash });
    return getAddress(r.contractAddress!);
  };
  const send = async (w: WalletClient, address: Address, abi: Abi, functionName: string, args: unknown[]) => {
    const hash = await w.writeContract({ address, abi, functionName, args, account: w.account!, chain });
    await pub.waitForTransactionReceipt({ hash });
  };

  const identity = artifact("Mocks.sol", "MockIdentityRegistry");
  const usdc = artifact("Mocks.sol", "MockUSDC");
  const d = wallets.deployer;
  const identityAddr = await deploy(d, identity);
  const reputationAddr = await deploy(d, artifact("Mocks.sol", "MockReputationRegistry"), [identityAddr]);
  const usdcAddr = await deploy(d, usdc);
  const passportAddr = await deploy(d, artifact("AgentPassport.sol", "AgentPassport"), [identityAddr, reputationAddr]);
  const escrowAddr = await deploy(d, artifact("JobEscrow.sol", "JobEscrow"), [identityAddr, passportAddr, usdcAddr]);
  await send(d, passportAddr, artifact("AgentPassport.sol", "AgentPassport").abi, "setAttester", [escrowAddr, true]);
  await send(wallets.agent, identityAddr, identity.abi, "register", ["data:application/json;base64," + btoa(JSON.stringify({ name: "test-agent" }))]);
  await send(d, usdcAddr, usdc.abi, "mint", [wallets.hirer.account!.address, parseUsdc("100")]);
  await send(d, usdcAddr, usdc.abi, "mint", [wallets.stranger.account!.address, parseUsdc("1")]);

  const deployment: Deployment = {
    chainId: 31337,
    agentPassport: passportAddr,
    jobEscrow: escrowAddr,
    identityRegistry: identityAddr,
    reputationRegistry: reputationAddr,
    usdc: usdcAddr,
    usdcDomain: { name: "USDC", version: "2" },
    fromBlock: 0n,
  };
  const sdk = Object.fromEntries(
    Object.entries(wallets).map(([k, w]) => [k, new AgentPassportClient({ publicClient: pub, walletClient: w, deployment, maxLogRange: opts.maxLogRange ?? 3n })]),
  ) as Record<Role, AgentPassportClient>;

  return {
    rpc,
    chain,
    pub,
    wallets,
    sdk,
    deployment,
    agentId: 1n,
    send,
    usdcBalance: (who) => pub.readContract({ address: usdcAddr, abi: usdc.abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>,
    stop: () => void anvil.kill(),
  };
}
