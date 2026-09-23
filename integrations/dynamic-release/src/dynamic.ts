// Dynamic Node SDK glue: an authenticated MPC wallet client and a viem WalletClient whose
// account signs through Dynamic (TWO_OF_TWO threshold ECDSA; no full private key anywhere).
import { DynamicEvmWalletClient } from "@dynamic-labs-wallet/node-evm";
import type { WalletMetadata } from "@dynamic-labs-wallet/node";
import type { Account, Chain, Transport, WalletClient } from "viem";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export async function dynamicEvmClient(
  environmentId = requireEnv("DYNAMIC_ENVIRONMENT_ID"),
  authToken = requireEnv("DYNAMIC_AUTH_TOKEN"),
): Promise<DynamicEvmWalletClient> {
  // enableMPCAccelerator needs AWS Nitro attestation; off everywhere else.
  const client = new DynamicEvmWalletClient({ environmentId, enableMPCAccelerator: false });
  await client.authenticateApiToken(authToken);
  return client;
}

/** A viem WalletClient for the Dynamic server wallet described by `walletMetadata`. */
export async function dynamicWalletClient(opts: {
  client: DynamicEvmWalletClient;
  walletMetadata: WalletMetadata;
  password: string;
  chain: Chain;
  rpcUrl?: string;
}): Promise<WalletClient<Transport, Chain, Account>> {
  return opts.client.getWalletClient({
    walletMetadata: opts.walletMetadata,
    password: opts.password,
    chain: opts.chain,
    rpcUrl: opts.rpcUrl ?? opts.chain.rpcUrls.default.http[0],
  });
}
