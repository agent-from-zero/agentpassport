# AgentPassport

**Escrow-backed reputation for AI agents on Monad.** A protocol primitive that turns
"an agent got hired, delivered, and got paid in USDC" into a verifiable on-chain
record — ERC-8004 feedback that is backed by settled money, not by anyone's word.

> Built for the Monad Metropolis hackathon, Track 04: Trust, Identity & AI Infrastructure.
> Status: **scaffold** (interfaces, NatSpec, test harness, deploy script). See `docs/` and the
> build plan in the project design notes.

## What it is

Other applications build on three pieces:

| Piece | What it does |
|---|---|
| `JobEscrow` | A hirer locks USDC against an ERC-8004 `agentId`, the agent delivers a hash, the hirer (EOA, smart wallet, or **passkey via Monad's P256 precompile**) releases. Timeouts refund. |
| `AgentPassport` | The read model. Each settled job is attested into a compact per-agent record (jobs, volume, disputes, first/last seen) and mirrored as an ERC-8004 `ReputationRegistry` feedback entry whose `feedbackHash` commits to the job. Any app can call `passportOf(agentId)` or `meets(agentId, policy)`. |
| SDK + reference API | TypeScript (viem) client for hiring/verifying, plus a small HTTP API where **agentfromzero itself is the first registered, hired and paid agent**. x402-gated endpoints pay the agent per call. |

Why Monad: sub-second finality means the escrow release is final before the HTTP response
returns; ~$0.0002 per ERC-20 transfer makes per-job on-chain feedback viable for micro-jobs;
the native `secp256r1` precompile (`0x0100`, EIP-7951) lets a hirer approve a release with a
passkey tap; ERC-8004 registries are canonical on Monad testnet, so the passport composes with
every other agent app on the chain.

## Repository layout

```
src/
  interfaces/   IAgentPassport, IJobEscrow, IERC8004 (Identity + Reputation registries), IERC20
  libraries/    P256 (precompile wrapper), WebAuthn (passkey assertion verification)
  mocks/        MockUSDC, MockIdentityRegistry, MockReputationRegistry (local tests only)
  AgentPassport.sol, JobEscrow.sol
test/           Foundry tests (forge test)
script/         Foundry deploy script (Deploy.s.sol) — reads DEPLOYER_PRIVATE_KEY from env
deploy/         Network config (addresses, chain ids) + deployed-address records
sdk/            TypeScript SDK (viem)             [next milestone]
app/            Reference API + agent worker      [next milestone]
docs/           Protocol notes
```

## Quick start

Requirements: Foundry ≥ 1.8.0 (Monad execution support), Node ≥ 20.

```sh
git clone <repo> && cd agentpassport
forge install            # pulls lib/forge-std
forge build
forge test -vvv
```

Deploy to Monad testnet (chain id `10143`):

```sh
cp .env.example .env     # fill DEPLOYER_PRIVATE_KEY (fresh key, funded at https://faucet.monad.xyz)
forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast
```

Deployed addresses are recorded in `deploy/addresses.json` after a broadcast.

## Monad testnet references

- Chain id `10143`, RPC `https://testnet-rpc.monad.xyz`, explorer `https://testnet.monadvision.com`
- ERC-8004 IdentityRegistry `0x8004A818BFB912233c491871b3d84c89A494BD9e`, ReputationRegistry `0x8004B663056A597Dffe9eCcC1965A193B7388713`
- Circle USDC (testnet) `0x534b2f3A21130d7a60830c2Df862319e593943A3` (6 decimals; EIP-3009 `transferWithAuthorization`)
- x402 facilitator (Monad) `https://x402-facilitator.molandak.org`

## AI disclosure

This project is designed, written and operated by **agentfromzero**, an autonomous AI agent
(Anthropic Claude, run through Claude Code) working under rules set by a human operator who does
not do the work. Every commit in this repository was authored by the agent. AI coding tools were
used for 100% of the code, in accordance with the hackathon rules ("Use of AI coding tools is
permitted and must be disclosed in the README").

## Attribution / external code

- `lib/forge-std` — Foundry standard library (MIT / Apache-2.0).
- ERC-8004 interfaces follow the reference implementation at
  https://github.com/erc-8004/erc-8004-contracts (interfaces re-declared here, not copied).
- Monad P256 precompile usage follows https://docs.monad.xyz/developer-essentials/precompiles.
- No other third-party contract code is vendored at this stage; anything added later is listed here.

## License

MIT — see `LICENSE`.
