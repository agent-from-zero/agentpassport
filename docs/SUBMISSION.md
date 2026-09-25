# Submission: Monad Metropolis (hackathon.monad.xyz)

Everything the submission form asks for, in one place, followed by a check of every requirement
and judging criterion against what exists. All facts below were checked on 2026-09-23 against the
chain (cast / RPC), the live sites and this repository.

## Form fields

| Field | Value |
|---|---|
| **Project name** | AgentPassport |
| **One-liner** | Escrow-backed reputation for AI agents on Monad: ERC-8004 feedback that only exists once an agent was hired, delivered and paid in USDC. |
| **Track** | Track 04: Trust, Identity & AI Infrastructure |
| **Bounties** | Best Use of Envio · Best use of Nansen · Best Use of Dynamic (evidence: [`BOUNTIES.md`](BOUNTIES.md)) |
| **Repository** | https://github.com/agent-from-zero/agentpassport (MIT) |
| **Live product** | https://agentpassport-monad.netlify.app (dashboard: look up any agent, live jobs, hire with any injected wallet on Monad testnet; needs no login) |
| **Paid API** | `POST https://agentfromzero.netlify.app/v1/agent/verify` (x402, 0.001 USDC on Monad testnet). Free: `GET /v1/agent/1908`, `GET /v1/agents`. Page: https://agentfromzero.netlify.app/agentpassport/ |
| **SDK** | https://www.npmjs.com/package/@agentfromzero/agentpassport-sdk (0.3.0) |
| **Demo video** (≤ 3 min) | https://vimeo.com/1229505127 (2:47): the live product, job #5 hired and released from the dashboard, explorer pages |
| **Pitch video** (≤ 2 min) | https://vimeo.com/1229506111 (1:56): team, problem, why Monad, what works, traction stated honestly |
| **Logo / graphic** | [`brand/logo.png`](brand/logo.png) (1024×1024, 24 KB), [`brand/banner.png`](brand/banner.png) (1600×900, 54 KB) |
| **Product ad** (optional) | not made |
| **Team** | Solo: **agentfromzero**, an autonomous AI agent (Anthropic Claude via Claude Code), disclosed as an AI in the README, the videos, the npm package and the agent card. It is also ERC-8004 agent 1908, the protocol's first registered, hired and paid user. A human operator set the rules but did not write the code. |
| **Judge access** | Nothing to log in to. To hire from the dashboard, a judge needs any EIP-1193 wallet with testnet MON (https://faucet.monad.xyz) and testnet USDC (https://faucet.circle.com). Reading needs no wallet. |

### Description (≤ 300 words)

ERC-8004 gives AI agents an on-chain identity and a reputation registry, but anyone can write
feedback, so a score is only as trustworthy as whoever wrote it. AgentPassport makes reputation
cost money to earn.

A hirer locks USDC in `JobEscrow` against an agent's ERC-8004 id. The agent accepts the job and
delivers a content-addressed artifact. The hirer checks its keccak256 hash and releases the escrow:
from a wallet, with a passkey verified by Monad's P256 precompile, through a delegated verifier (a
Dynamic MPC server wallet), or automatically once the review window has passed. Only then does
`AgentPassport` stamp the agent's record and mirror a feedback entry into the canonical ERC-8004
ReputationRegistry. The entry's `feedbackHash` points at that exact job.

Any router, marketplace or agent can ask one question on-chain, `meets(agentId, policy)`, or call
the paid x402 API. The API adds an Envio HyperIndex trust index (distinct and repeat hirers, hirer
concentration, escrow-backed vs unbacked feedback) and Nansen counterparty intelligence, which
flags self-dealing and linked or flagged hirers. Hirers without MON can fund a job with the same
EIP-3009 signature x402 uses.

Everything runs on Monad testnet today: 7 jobs (5 settled, 1 refunded, 1 cancelled), paid API
calls, a Dynamic-signed release, a dashboard, an npm SDK and an autonomous worker. The builder is
agentfromzero, a disclosed AI agent, which completed its jobs with no human steps. A security
review found that anyone could smear an agent with unsolicited jobs. JobEscrow v2 fixed that the
same day: refunds only count once the agent has accepted a job.

### What Monad enables

- **Sub-second finality and cheap writes.** One on-chain reputation entry per micro-job is
  affordable: release, attest, mirror and transfer cost ~554k gas, and it is final before an HTTP
  response returns. So an agent can treat "released" as "paid" within the same request.
- **Native `secp256r1` precompile (`0x0100`).** Hirers approve releases with a passkey tap, and the
  contract verifies a real WebAuthn assertion (tested with Safari and Chrome vectors).
- **Canonical ERC-8004 registries on testnet.** The passport composes with every other agent app on
  Monad instead of keeping a private reputation store (13 agents indexed).
- **Circle USDC with EIP-3009, plus the Monad x402 facilitator.** Hirers can fund a job gaslessly,
  and verification is paid per call in USDC.

## Contracts and transactions (Monad testnet, chain 10143)

| Contract | Address | Deploy tx |
|---|---|---|
| AgentPassport | [`0xd01EC5Fd5A9A4335D64600aDA4E010AA6fAF9d0A`](https://testnet.monadvision.com/address/0xd01EC5Fd5A9A4335D64600aDA4E010AA6fAF9d0A) (Sourcify exact match) | [`0x3aae4f03…8c20`](https://testnet.monadvision.com/tx/0x3aae4f03e4dc018d6f775846a38e315b49c209ab5c33360689853cd13ac08c20) |
| JobEscrow v2 (current) | [`0x41Cb9b1a7Ebe2e1a420d8Cd96D02a9009AC54355`](https://testnet.monadvision.com/address/0x41Cb9b1a7Ebe2e1a420d8Cd96D02a9009AC54355) (Sourcify exact match) | [`0x2f027443…2b20`](https://testnet.monadvision.com/tx/0x2f0274435c38c61ea6953a3539a2a5ad7198cfbfb2ba72da105f3622287d2b20) |
| JobEscrow v1 (jobs #1-#5) | [`0x5b197edD258572DEe7C923A6D38D6Db268A266BC`](https://testnet.monadvision.com/address/0x5b197edD258572DEe7C923A6D38D6Db268A266BC) (Sourcify exact match) | [`0xe6a42b6f…e6e0`](https://testnet.monadvision.com/tx/0xe6a42b6f53b8aadae7d7ed2f797e6c5d1bce8e4c4c065020da2ee608143fe6e0) |
| agentfromzero | ERC-8004 agentId 1908 on IdentityRegistry `0x8004A818BFB912233c491871b3d84c89A494BD9e` | register [`0x1603e7fa…8874`](https://testnet.monadvision.com/tx/0x1603e7fa5d443b92abea678b069408e87afd408a032db3b3355feaf56b458874) |

Key transactions (all of them are in [`DEMO_LOG.md`](DEMO_LOG.md)):

| What | Tx |
|---|---|
| Job #1 released (first settled job, feedback mirrored to ERC-8004) | [`0x147f241c…c689`](https://testnet.monadvision.com/tx/0x147f241c49ccf9da8f4d65a239fdb177cfe04e5b3908018f66e1ddb93831c689) |
| Job #3 released (hired gaslessly with EIP-3009, delivered by the worker) | [`0x91433217…89a6`](https://testnet.monadvision.com/tx/0x9143321747b94ad5e3b61df84a6b652cb93a690469715aaeb0d50da8f3c189a6) |
| Job #4 released by the Dynamic MPC server wallet (delegated verifier) | [`0xb010b181…2bd0`](https://testnet.monadvision.com/tx/0xb010b181b91bd89a1558ebae8e47f55e3c29912f1eee25e4280b0b0857292bd0) |
| Job #5 released from the dashboard (the demo video) | [`0x4ff516c0…6adb`](https://testnet.monadvision.com/tx/0x4ff516c07140f682fe729767e7d31c3a09b87b0e606ccd80b9996500676d6adb) |
| Paid x402 verify with index + Nansen rules | [`0x45343c7f…0990`](https://testnet.monadvision.com/tx/0x45343c7f083c4d606ce626bcefd0dc074dcb3b311ed2b9111e929e2263480990) |
| v2 job #1: agent `accept` → `deliver` → `release` | [`0x713c6a07…2348`](https://testnet.monadvision.com/tx/0x713c6a07875e0f4b78a5b3b4e0ebf377b380b3862ffa3bbdff0b8e5612682348) → [`0xef8e15e0…ba31`](https://testnet.monadvision.com/tx/0xef8e15e095806070440ca79af71e34e13abfb65a280e5ba033fb3794e8daba31) → [`0x413fb905…d5eb`](https://testnet.monadvision.com/tx/0x413fb905565e43c6c758d500d32124f71ce3b8e3e26e69c35a4a3db4415bd5eb) |
| v2 job #2: cancelled before acceptance, no passport write | [`0x8d270c6c…9fd4`](https://testnet.monadvision.com/tx/0x8d270c6c2e8a7018870921d3a8b3e4d35ce287955c484f1c1074b1760a2d9fd4) |

State at the time of writing: `passportOf(1908)` = 5 settled / 1 refunded / 0 disputed, 6.55 USDC.

## Mandatory requirements (rules §4.1, §7.2, §9) → where they are met

| Requirement | Status |
|---|---|
| Public GitHub repo with complete source | [github.com/agent-from-zero/agentpassport](https://github.com/agent-from-zero/agentpassport), public, full history from 2026-09-21 (pushed 2026-09-25) |
| README with setup instructions | [`README.md`](../README.md): Setup, Tests, Deploy (including a dry run), Register, hire by hand, SDK / API / worker, dashboard |
| OSI license | MIT ([`LICENSE`](../LICENSE)) |
| Attribution of external code | README "Attribution / external code" (forge-std, viem, esbuild, Playwright, edge-tts, ffmpeg, ERC-8004 interfaces re-declared) |
| Commit history covering the build window | All commits are dated 2026-09-21 onward, authored by agentfromzero |
| AI coding tools disclosed in README | README "AI disclosure": 100% AI-written, and the videos use a synthetic voice |
| Demo video ≤ 3 min, public, product in operation, shows Monad | Vimeo, 2:47, public, a live hire on testnet with explorer pages |
| Pitch video ≤ 2 min: team, problem, why | Vimeo, 1:56 |
| Monad integration explained, addresses, deployed to testnet | README "Why Monad", address table, Sourcify-verified contracts, [`deploy/addresses.json`](../deploy/addresses.json) |
| Documentation: description, architecture, tech stack, setup | README (problem, mermaid architecture, layout, setup); tech stack = Solidity/Foundry, TypeScript/viem, Envio, Netlify functions, x402 |
| Functioning prototype that a third party can run from the README | Fresh-clone test 2026-09-23, repeated from GitHub on 2026-09-25 (below) |
| Problem statement and intended user | README "The problem" (users: agent marketplaces, routers, and agents hiring agents) |
| Live product link with access instructions | Dashboard (no login); hiring needs testnet MON + USDC from the public faucets |
| No keys or credentials in the submission | Keys are env-only; a secret scan against the operator's secret store found 0 hits in tracked files |

## Judging criteria (20% each) → evidence

| Criterion | Evidence |
|---|---|
| Product quality & completeness | A live dashboard (lookup, jobs, trust index, hire flow), paid API, npm SDK, autonomous worker, indexer, 7 real jobs covering every path (settle, refund, cancel, gasless, delegated, dashboard), and videos |
| Technical excellence | 76 Foundry tests (unit, fuzz, fork against live USDC and ERC-8004, real WebAuthn vectors), 35 SDK, 4 worker, 12 indexer and 6 Dynamic tests. A security review with a fork proof of concept, fixed and redeployed ([`SECURITY.md`](SECURITY.md)). Slither: 0 high / 0 medium. Sourcify exact matches |
| Monad integration | Canonical ERC-8004 registries, the P256 precompile, Circle USDC EIP-3009, the Monad x402 facilitator, `network = "monad"` gas model, testnet deployment |
| Track fit (Trust, Identity & AI infra) | Identity (ERC-8004) + trust (reputation backed by settled money) + AI infra (an SDK, API and worker that agents use themselves) |
| Innovation & impact | Reputation that is expensive to fake; one on-chain `meets()` call; a disclosed AI agent that builds the protocol, is hired through it, and pays for its own verification over x402 |

## Bounties → requirement check

| Bounty | Published requirement | Met by |
|---|---|---|
| Envio ($1k) | "Meaningfully use HyperIndex/HyperSync/HyperRPC to power real on-chain data driving a core feature" | `indexer/` HyperIndex 3.12.1 over both escrows, the passport and both ERC-8004 registries; powers `/v1/agents`, the index part of `/v1/agent/{id}`, the index rules on the paid verify route, and the dashboard table |
| Nansen ($5k pool) | "Product experience powered by Nansen data that goes beyond exposing raw data" | Profiling of first funders, balances and related wallets becomes linked / weighted / flagged hirers, enforced as policy rules (`minWeightedHirers`, `maxLinkedHirers`, `forbidFlagged`); a live paid call returned `meetsAll = false` for Nansen reasons |
| Dynamic ($5k) | "Integrate the Dynamic SDK for authentication, embedded/agent wallets, and/or signing into a deployed, demoable app" | `integrations/dynamic-release`: a Dynamic MPC server wallet is a job's delegated verifier; job #4 was released by a Dynamic-signed tx |

## Fresh-clone test (2026-09-23)

The repo was cloned into an empty directory and the README followed literally, on Windows 11 with
Foundry 1.8.3, Node 24 and Docker:

| Step | Result |
|---|---|
| `forge install && forge build` | ok; the JobEscrow bytecode is identical to the deployed build |
| `SKIP_FORK_TESTS=1 forge test` / `forge test` | 69 passed / 76 passed |
| `forge fmt --check` | ok (after fix 1) |
| `forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet` (dry run, new unfunded key) | simulated against live testnet; `deploy/addresses.json` untouched |
| `cd sdk && npm install && npm test` | 35 passed |
| `cd worker && npm install && npm test` | 4 passed (after fix 2) |
| `cd integrations/dynamic-release && npm ci && npm test` | 6 passed |
| `cd app/dashboard && npm ci && npm run typecheck && npm run build` | ok |
| indexer codegen + tests (Docker, as in `indexer/README.md`) | 12 passed, 1 skipped (opt-in live test); `tsc` ok |

Gaps found and fixed:
1. A Windows checkout with `core.autocrlf=true` produced CRLF, which broke `forge fmt --check` and
   the byte-exact sources. Fixed with `.gitattributes` (LF everywhere, hashed specs and deliverables
   kept `-text`).
2. The worker and dynamic-release link `file:../sdk`, but `sdk/dist` is not committed. Fixed: the
   SDK builds itself on `npm install` (`prepare`), and the README says to install it first.
3. Before this review, a deploy dry run overwrote the committed `deploy/addresses.json`. Fixed: only
   a broadcast writes it.

Repeated on 2026-09-25 from the public repo (`git clone https://github.com/agent-from-zero/agentpassport`,
commit 8ca0089): `forge install && forge build` ok, 69 offline / 76 total tests passed, `forge fmt --check` ok,
the deploy dry run with a new unfunded key simulated against live testnet and left the tree clean, and
`cd sdk && npm install && LIVE=0 npm test` passed 28 (7 live-only tests skipped). No new gaps.

## Open items before the form can be submitted

1. ~~**GitHub.**~~ Done 2026-09-25: the repo is public at
   https://github.com/agent-from-zero/agentpassport, so `metropolis@hackathon.monad.xyz` can read it
   without an invite.
2. The demo video shows the v1 flow, which has no accept step. Everything else in it is unchanged,
   and the change is stated in this document and in the README.
3. External usage: no third-party hirer or x402 payer is recorded yet ([`TRACTION.md`](TRACTION.md)).
4. **Netlify credits.** The free Netlify account behind both sites ran out of monthly plan credits
   on 2026-09-23 (grace top-up at 12:29 UTC), and production deploys now return 403 until the
   period resets on 2026-10-21. The sites keep serving. Two things wait on it: the published index
   snapshot (`/agentpassport/index.json` is from block 64,984,982; the fresh one covering v2 is built
   locally), and the worker's deliverable publishing for new jobs. Hosting the deliverables
   elsewhere (e.g. GitHub Pages on the repo's account) would unblock the worker before the
   deadline.
