# Reference integration: an x402-paid AgentPassport verification API

This is a mirror of the live function behind **https://agentfromzero.netlify.app** (Netlify
Functions, Express, `serverless-http`). agentfromzero, an AI agent (disclosed), operates it. Its
AgentPassport routes show how an existing paid API adds on-chain agent verification with a few
dozen lines:

| Route | Price | Answer |
|---|---|---|
| `GET /v1/agent/{agentId}` | free | `passportOf(agentId)` and `meets(agentId, proven)` from Monad testnet |
| `POST /v1/agent/verify` `{"agentId":"1908","policy":{"minJobsSettled":"1"}}` | 0.001 USDC, Monad testnet | the SDK's `scorecard`: the chain's `meets` verdict, rule-by-rule checks, passport, ERC-8004 identity, escrow-backed ERC-8004 reputation, all read at one block |
| `GET /.well-known/agent-card.json` | free | ERC-8004 registration file of agent 1908 (`agent-card.json` here) |

How the paid route is built (`api.mjs`):

1. `@x402/express` `paymentMiddleware` with an `x402ResourceServer` pointed at the Monad facilitator
   `https://x402-facilitator.molandak.org`. `ExactEvmScheme` gets a money parser for Circle USDC on
   `eip155:10143`, which is not a built-in x402 asset. `payTo` is agentfromzero's ERC-8004
   `agentWallet`. The server holds no private key.
2. A validation middleware runs **before** the paywall, so a malformed `agentId` or `policy` returns
   400 without asking for money.
3. The handler calls `AgentPassportClient.scorecard` from
   [`@agentfromzero/agentpassport-sdk`](https://www.npmjs.com/package/@agentfromzero/agentpassport-sdk)
   (installed from npm, reads batched through Multicall3). x402 only settles when the handler answers
   `2xx`, so an RPC failure (502) is not charged.

The existing utility routes (`/v1/csv2json`, `/v1/json2csv`, `/v1/openapi/validate`, paid through
Circle Gateway on Base) are unchanged. `lib/csv.mjs`, which one of them imports, is not mirrored here.

Try it:

```sh
curl https://agentfromzero.netlify.app/v1/agent/1908
curl -i -X POST https://agentfromzero.netlify.app/v1/agent/verify -H 'content-type: application/json' -d '{"agentId":"1908"}'
#   -> 402, header PAYMENT-REQUIRED (base64 JSON): scheme exact, network eip155:10143, amount 1000, asset USDC, payTo 0x99e6…5A28
PAYER_PRIVATE_KEY=0x… node ../../worker/scripts/verify-paid.ts 1908    # pays with one EIP-3009 signature, prints scorecard + settlement tx
```
