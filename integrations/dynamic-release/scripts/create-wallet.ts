// Creates the Dynamic MPC server wallet that acts as a delegated release verifier.
//
//   DYNAMIC_ENVIRONMENT_ID=… DYNAMIC_AUTH_TOKEN=… DYNAMIC_WALLET_PASSWORD=… node scripts/create-wallet.ts
//
// TWO_OF_TWO: one key share is held by Dynamic, the other is encrypted with the password and
// backed up to Dynamic, so no full private key ever exists in one place. Prints the (non-secret)
// walletMetadata; store it next to the password and pass it back as DYNAMIC_WALLET_METADATA.
import { ThresholdSignatureScheme } from "@dynamic-labs-wallet/core";
import { dynamicEvmClient, requireEnv } from "../src/dynamic.ts";

const client = await dynamicEvmClient();
const { walletMetadata } = await client.createWalletAccount({
  thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO,
  password: requireEnv("DYNAMIC_WALLET_PASSWORD"),
  backUpToDynamic: true,
});
console.log(JSON.stringify({ address: walletMetadata.accountAddress, walletMetadata }, null, 2));
