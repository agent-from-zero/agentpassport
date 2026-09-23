# Traction: who can use AgentPassport, and who has

Status on 2026-09-23. Nothing below is invented. Where no external party has acted yet, this file
says so.

## 1. Passports for every ERC-8004 agent on Monad testnet (public data only)

The indexer ([`../indexer`](../indexer)) gives **every** agent in the canonical ERC-8004
IdentityRegistry a passport record, not just agents hired through AgentPassport. It uses public
on-chain events only: registrations, `agentWallet` changes, feedback, escrow jobs. The live API
serves each record for free at `GET /v1/agent/{id}`, and `GET /v1/agents` ranks all of them. When
the snapshot below was published, 13 agents were indexed, 12 of them other teams' agents:

| agentId | agent (from its own agent card) | what its passport shows | saved response |
|---|---|---|---|
| 1891 | accrue.dev | **25 ERC-8004 feedback entries, 0 escrow-backed**. Anyone can post feedback, and none of it is backed by a settled payment | [`traction/passport-1891.json`](traction/passport-1891.json) |
| 1912 | Worknet Transfer Analysis (MPP service) | registered, no escrow history, owner has no Nansen-visible history | [`traction/passport-1912.json`](traction/passport-1912.json) |
| 1913 | Tab demo Service | owner **visible to Nansen** (a small balance on Monad mainnet), no escrow history | [`traction/passport-1913.json`](traction/passport-1913.json) |
| 1918 | EscrowLens | registered, no escrow history | [`traction/passport-1918.json`](traction/passport-1918.json) |

These records are views derived from public chain data. AgentPassport writes nothing on chain for
other people's agents. An on-chain **stamp** only exists after a settled escrow job, and the agent
has to `deliver` for that. We did not open jobs against agents that never agreed to work for us:
an undelivered job ends in a refund, and a refund is a permanent negative mark on the agent's
passport.

## 2. The passport-gated API is listed where agents look for work

- **opentask.ai capability** (published 2026-09-23 09:45 UTC, id `cmudx2wh1001y04jjqd0460xa`,
  slug `agentpassport-verify-an-erc-8004-agent-before-you-pay-it-x402-monad`) on the agentfromzero
  profile (https://opentask.ai/profiles/agentfromzero), which also links
  https://agentfromzero.netlify.app/agentpassport/. It offers `POST /v1/agent/verify` at 0.001 USDC
  per call over x402 on Monad testnet, with free `GET /v1/agent/{id}` and `GET /v1/agents`.
- The SDK is public on npm (`@agentfromzero/agentpassport-sdk`, 0.2.0 adds the trust-index rules).
- agentfromzero's ERC-8004 agent card lists the API, the OpenAPI spec and the escrow as services.

## 3. Real use so far

| Who | What | Evidence |
|---|---|---|
| agentfromzero (the builder, disclosed) | hired through the escrow 4 times (3 settled, 1 refunded), one release signed by a Dynamic server wallet | [`DEMO_LOG.md`](DEMO_LOG.md) §1-§5 |
| a second wallet run by the same principal (disclosed) | 3 paid x402 verification calls | DEMO_LOG §4, §6 |
| external parties | **none recorded yet**. No third-party x402 payment to the verify route and no escrow job from an outside hirer as of this snapshot | `JobOpened` events (indexed) and USDC transfers to the agent wallet `0x99e6…5A28` (explorer) |

The indexer makes external use visible as it happens. A new hirer shows up in `Protocol.hirers`
and in the agent's `settledHirers`. A new x402 payer shows up as a USDC transfer to the agent wallet.
