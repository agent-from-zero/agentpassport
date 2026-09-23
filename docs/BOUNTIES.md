# Sponsor bounties: each requirement and where it is met

Requirements are quoted from https://hackathon.monad.xyz/tracks (checked 2026-09-23). Sponsor
bounties are judged on adherence to the published requirements (40%), technical implementation
(30%), Monad integration (20%) and innovation (10%).

## Envio: "Best Use of Envio" ($1,000, all tracks)

> "Meaningfully use Envio's HyperIndex, HyperSync, or HyperRPC to power real on-chain data driving a core feature in your app."

| Requirement | Where it is met |
|---|---|
| Uses HyperIndex | [`indexer/`](../indexer): HyperIndex v3 (`envio` 3.12.1). `config.yaml`, `schema.graphql` (Agent, Job, Stamp, Hirer, AgentHirer, Feedback, Protocol, daily aggregates), handlers in `src/handlers/`, effects for cached RPC reads |
| Real on-chain data | Monad testnet (10143) from the AgentPassport deployment block: JobEscrow, AgentPassport and both canonical ERC-8004 registries. 13 agents, 4 jobs and 36 feedback entries indexed live. The live test indexed ~530k blocks and matched `passportOf(1908)` at the same block |
| Drives a core feature | The trust index behind the scorecard. `GET /v1/agent/{id}` and `GET /v1/agents` return index data. `POST /v1/agent/verify` enforces index rules (`minDistinctHirers`, `maxTopHirerShareBps`, `minEscrowBackedFeedbackShareBps`, `minIndexScore`, `maxIndexAgeSeconds`) inside the paid x402 verdict (`meetsAll`). SDK 0.2.0 exposes `queryIndexedAgent` (live GraphQL) and `fetchIndexSnapshot`. The `/agentpassport/` page shows the table |
| Meaningful, not cosmetic | It answers questions the contract cannot: distinct and repeat hirers, hirer concentration, and escrow-backed vs unbacked ERC-8004 feedback. Example: agent 1891 has 25 feedback entries and 0 backed by money. It also records the release path, e.g. job #4 released by a delegated verifier |
| Runs from the README | `docker compose up -d --build` → GraphQL on `:8088`. `node scripts/snapshot.ts` publishes the snapshot. Tests: 7 handler tests + 3 Nansen-derivation tests + the live comparison test |
| Hosting | Envio's hosted service and HyperSync tokens need a GitHub login, which the operator does not have. The indexer is **self-hosted** on the RPC source, with `rpc-proxy/` so free public RPCs can sustain HyperIndex's concurrency (documented in `indexer/README.md`). The public site serves the published snapshot (`/agentpassport/index.json`) |

## Nansen: "Best use of Nansen" ($5,000 pool, all tracks)

> "Build a product experience powered by Nansen data/API/MCP/CLI that goes beyond exposing raw data."

| Requirement | Where it is met |
|---|---|
| Uses Nansen data / API | Nansen API, free plan (email sign-up, no card). [`indexer/scripts/nansen.ts`](../indexer/scripts/nansen.ts) calls `profiler/address/first-funder`, `profiler/address/current-balance` (all chains) and `profiler/address/related-wallets` (Monad) for every hirer and agent owner. Cached, with a credit budget |
| Beyond raw data | The raw answers become **trust decisions**. A hirer is *linked* if its first funder or a related wallet is the agent's own owner/wallet (self-dealing). It is *weighted* only if Nansen sees real history and it is neither linked nor flagged. Mixer / exploit / scam labels on funders or related wallets become *flags*. Per agent these become `weightedHirers`, `linkedHirers`, `flagged`, `coverage` |
| Product experience | Policies can require them: `minWeightedHirers`, `maxLinkedHirers`, `forbidFlagged` on the live paid route `POST /v1/agent/verify`, and in the SDK (`evaluateIndexPolicy`). Nansen rules fail closed. Live result: agentfromzero passes `proven` on chain but fails `minWeightedHirers: 1` because its only hirer has no Nansen-visible history ([DEMO_LOG §6](DEMO_LOG.md#6-paid-verification-with-index-and-nansen-rules-2026-09-23), paid tx `0x45343c7f…0990`) |
| Real data | 12 counterparty wallets profiled (snapshot `nansen` block). One agent owner (agents 1913/1914) is visible on Monad mainnet. The others are testnet-only, which the product reports as "no Nansen history" instead of hiding it |
| Tests | `indexer/test/nansen.test.ts` (derivation, flags), `sdk/test/trust-index.test.ts` (join, linked/weighted/flagged, policy evaluation, fail-closed) |
| Limits, stated | Nansen covers mainnets (incl. Monad mainnet), not Monad testnet. The free plan's credits (100 once, then 10 a day) are why intel is cached in the snapshot rather than fetched per request. Nansen's x402 pay-per-call was not used ($0 budget; no mainnet USDC) |

## Dynamic: "Best Use of Dynamic" ($5,000, all tracks)

> "Integrate the Dynamic SDK for authentication, embedded/agent wallets, and/or signing into a deployed, demoable app."

Free-plan check (task requirement): the Dynamic developer account (email OTP sign-up, no card) is
on the free **Standard** plan. Its sandbox environment gives API tokens and **server wallets**
through the Node SDK. **Delegated access** for end-user embedded wallets can be tested in sandbox,
but Dynamic's docs say production needs an Enterprise plan. So the integration uses a server wallet
with delegation expressed on chain.

| Requirement | Where it is met |
|---|---|
| Integrates the Dynamic SDK | [`integrations/dynamic-release/`](../integrations/dynamic-release): `@dynamic-labs-wallet/node-evm`. `authenticateApiToken`, `createWalletAccount` (TWO_OF_TWO MPC, key share backed up to Dynamic), `getWalletClient` → a viem WalletClient that signs through Dynamic |
| Agent wallets / signing | The Dynamic server wallet `0xf02Aa56969f5C71D77d89eb85D962E72A01B3b11` is the **delegated release verifier** of AgentPassport jobs. It checks the delivery (delegated, delivered, amount cap, bytes hash, job binding) and then signs `JobEscrow.release` via Dynamic MPC |
| Deployed, demoable | Live on Monad testnet: job #4 opened gaslessly with `verifier` = the Dynamic wallet, delivered by the worker, **released by a Dynamic-signed tx** [`0xb010b181…2bd0`](https://testnet.monadvision.com/tx/0xb010b181b91bd89a1558ebae8e47f55e3c29912f1eee25e4280b0b0857292bd0). The page https://agentfromzero.netlify.app/agentpassport/ explains it. The indexer shows `releasePath: Verifier` |
| Tests | 6 anvil e2e tests (`npm test`): release path, tampered bytes, mis-bound deliverable, over-cap, not delegated, escrow rejects non-verifier |
| Checked and not used | Dynamic policy rules: the rule editor offered no Monad Testnet network, so scope is enforced by the escrow's per-job verifier and the delegate's checks. End-user delegated access: sandbox-only on the free plan |
