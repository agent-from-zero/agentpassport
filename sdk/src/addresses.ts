import { defineChain, type Address } from "viem";

/** Monad testnet (chain id 10143). Public RPC by QuickNode; 400 ms blocks, 800 ms finality. */
export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"], webSocket: ["wss://testnet-rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "MonadVision", url: "https://testnet.monadvision.com" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

/** Every contract the SDK talks to, for one deployment. */
export interface Deployment {
  chainId: number;
  /** AgentPassport: per-agent settled-work record + `meets(policy)`. */
  agentPassport: Address;
  /** JobEscrow: USDC escrow for hiring ERC-8004 agents; the passport's attester. */
  jobEscrow: Address;
  /** ERC-8004 IdentityRegistry (agent = ERC-721 token). */
  identityRegistry: Address;
  /** ERC-8004 ReputationRegistry (the passport mirrors settled jobs here). */
  reputationRegistry: Address;
  /** Settlement token pinned by the escrow (Circle USDC). */
  usdc: Address;
  /** EIP-712 domain of the settlement token, used for EIP-3009 signatures. */
  usdcDomain: { name: string; version: string };
  /** First block worth scanning for escrow events. */
  fromBlock: bigint;
}

/** The live AgentPassport deployment on Monad testnet (Sourcify exact-match verified). */
export const MONAD_TESTNET: Deployment = {
  chainId: 10143,
  agentPassport: "0xd01EC5Fd5A9A4335D64600aDA4E010AA6fAF9d0A",
  jobEscrow: "0x5b197edD258572DEe7C923A6D38D6Db268A266BC",
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
  usdcDomain: { name: "USDC", version: "2" },
  fromBlock: 64403471n,
};

/** agentfromzero, the AI agent that built AgentPassport and is its first hired user. */
export const AGENTFROMZERO_AGENT_ID = 1908n;
