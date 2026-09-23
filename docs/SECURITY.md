# Security review — AgentPassport + JobEscrow

**Date:** 2026-09-23. **Reviewer:** agentfromzero, the AI agent that also wrote the code. This is a
self-review, not an independent audit. Keep that in mind when you weigh it.
**Scope:** `src/AgentPassport.sol`, `src/JobEscrow.sol`, `src/libraries/{P256,WebAuthn}.sol` and
their interfaces, at the v1 deployment (`JobEscrow` `0x5b197edD…66BC`, `AgentPassport`
`0xd01EC5Fd…9d0A`). **Method:** a manual threat model along the axes below, Slither 0.11.6
(report in [`security/slither.txt`](security/slither.txt)), Foundry unit, fuzz and fork tests, and a
proof of concept of the main finding against the deployed bytecode on a Monad testnet fork.

## Outcome

| # | Finding | Severity | Status |
|---|---|---|---|
| F-1 | Anyone can put a refund mark on any agent's passport by opening a job the agent never saw | Medium | **Fixed in JobEscrow v2**, deployed |
| F-2 | The agent can deliver after the deadline and front-run the hirer's refund | Low | **Fixed in v2** |
| F-3 | Review window unbounded: `dispute` overflows (panics) for windows close to `2^64` | Low | **Fixed in v2** (≤ 30 days) |
| F-4 | `open` accepts an agent if the identity registry's `ownerOf` returns `0` instead of reverting | Info | **Fixed in v2** |
| F-5 | Hirer-controlled `endpoint` string unbounded: stored and re-sent on every settlement | Low | **Fixed in v2** (≤ 256 bytes) |
| F-6 | A hirer can dispute any delivery and keep the (public) deliverable at no cost | Design (v0) | Accepted and documented; see below |
| F-7 | Passport `owner` is an EOA that can add attesters | Centralisation | Accepted for testnet; see below |

Each fix has its own test in [`test/JobEscrow.v2.t.sol`](../test/JobEscrow.v2.t.sol). F-1 is also
reproduced against the live contracts in [`test/ForkFindings.t.sol`](../test/ForkFindings.t.sol):
with v1 a stranger's 0.000001 USDC job adds a refund to agent 1908, and with v2 attached to the same
live passport it adds nothing.

**Deployment.** Only `JobEscrow` changed. v2 was deployed next to the unchanged passport by
[`script/DeployEscrowV2.s.sol`](../script/DeployEscrowV2.s.sol), and the passport owner allowed it
as an attester:

| | |
|---|---|
| JobEscrow v2 | [`0x41Cb9b1a7Ebe2e1a420d8Cd96D02a9009AC54355`](https://testnet.monadvision.com/address/0x41Cb9b1a7Ebe2e1a420d8Cd96D02a9009AC54355) (Sourcify exact match) |
| deploy tx | [`0x2f027443…2b20`](https://testnet.monadvision.com/tx/0x2f0274435c38c61ea6953a3539a2a5ad7198cfbfb2ba72da105f3622287d2b20) (block 65,011,497) |
| `setAttester(v2, true)` | [`0x84e531ca…5e70`](https://testnet.monadvision.com/tx/0x84e531ca5e3ed29f716463e0c4c605e249c6cd9f8960d09c4b38bd1025565e70) |

The passport keeps its address and its history (jobs #1-#5 of v1). **v1 stays an attester on
purpose.** If it were removed, `release`/`refund`/`dispute` on v1 would revert, and USDC in any job
someone opened there later would be stuck for good. Stuck funds are worse than F-1, so the
remaining exposure is the refund counter (see the residual risks). The first v2 jobs ran live on
testnet (DEMO_LOG §8): job #1 was accepted, delivered and released; job #2 was opened and cancelled
before acceptance, with no passport write.

## Threat model

### Reentrancy
- Every function in `JobEscrow` that moves tokens (`open`, `openWithAuthorization`, `release`,
  `releaseWithPasskey`, `refund`, `dispute`) has a mutex. Status changes are written before any
  external call (checks-effects-interactions). `test_release_blocksReentrancy` uses a token that calls back
  into `release` from `transfer`. The mutex fires and the agent is paid exactly once.
- `accept` and `deliver` move no funds. Their only external calls are `view` calls into the identity
  registry.
- `AgentPassport.attest` is `onlyAttester`. The ERC-8004 call inside it cannot re-enter the escrow,
  because the mutex is held, and it cannot re-enter `attest`, because the registry is not an
  attester. Slither's `reentrancy-events` note (the event is emitted after the registry call) is
  intentional: the event reports the call's result.

### Token pinning
- The escrow accepts exactly one token, fixed in the constructor (Circle USDC). `open` with any
  other token reverts `UnsupportedToken`.
- The passport fixes each agent's token at its first attestation and reverts `TokenMismatch` after
  that. Without the escrow-level pin, a griefer could expire a junk-token job and bind an agent's
  passport to the junk token. Both pins are tested.
- USDC is pausable and has a blacklist. A paused USDC delays settlement. If USDC blacklists the
  agent's payout wallet, `release` reverts until the agent points `agentWallet` somewhere else. This
  is accepted: it is a property of the settlement asset.

### Replay: EIP-3009 and passkey signatures
- `openWithAuthorization`: the hirer signs `ReceiveWithAuthorization`, not `Transfer…`. USDC
  requires `msg.sender == to`, so only the escrow can consume the signature. A front-runner cannot
  move the funds anywhere else.
- The EIP-3009 nonce must equal `openNonce(p, validAfter, validBefore)`. That value is a hash of the
  domain tag, `chainid`, the escrow address, every `OpenParams` field and the validity window. A
  relayer that changes the agent, amount, deadline, window, verifier, spec or endpoint gets
  `AuthorizationMismatch`. USDC consumes each nonce only once, so a replay reverts.
  `test_openWithAuthorization_fork_rejectsRedirect` covers this against real Circle USDC.
- A front-runner who submits the hirer's signed authorization first creates the identical job. The
  hirer is recorded from `auth.from`, not `msg.sender`, so nothing is lost.
- `releaseWithPasskey`: the challenge is `releaseDigest(jobId)`, which hashes a domain tag, chainid,
  the escrow, jobId, agentId and the committed `deliverableHash`. It cannot be replayed on another
  job, another escrow or another chain. After a release the job is no longer `Delivered`, so the
  same assertion is useless. The signature must be low-s, which kills the malleable twin, and the
  check requires the UP and UV flags and `type = webauthn.get`. The precompile rejects keys that are
  not on the curve.
- Not checked on-chain: the WebAuthn `origin` and `rpIdHash`. Authenticators already scope a passkey
  to its RP, and the challenge binds the assertion to one job, which is all the escrow needs.

### Deadline math
- `open` requires `deadline > now`. v2 lets the agent accept or deliver while `now <= deadline`, and
  lets the hirer refund an accepted job only when `now > deadline`. The windows neither overlap nor
  leave a gap: `testFuzz_F2_deliverAndRefundWindowsPartitionTime` checks exactly one of the two is
  possible at every instant. In v1, `deliver` had no deadline check (F-2), so a late delivery could
  win the race against a refund.
- Review window: the hirer can dispute while `now <= deliveredAt + window`, and anyone can release
  once `now > deliveredAt + window`. In v1, `dispute` added in `uint64` and panicked for huge windows
  (F-3). v2 caps the window at 30 days.
- A window of 0 is allowed. The agent can then finalise from the next second, which only makes sense
  with a `verifier` or a hirer who releases in the same flow. This is documented in `IJobEscrow`.
- Timestamps are used only at second granularity with windows of minutes or more. Slither's
  `timestamp` notes are expected.

### Access control
| Action | Who |
|---|---|
| `accept`, `deliver` | the agent's ERC-8004 owner, an approved operator, or its `agentWallet` |
| `release` | the hirer or the per-job `verifier` at any time after delivery; anyone once the review window has passed |
| `releaseWithPasskey` | anyone relaying a valid assertion from the hirer's registered passkey |
| `refund`, `dispute` | the hirer only |
| `registerPasskey` | the caller, for their own address only (it can only affect their own jobs) |
| `attest` | allowed attesters only (the two escrows) |
| `setAttester`, `transferOwnership` | the passport owner |

`release` always pays the agent's current `agentWallet` (or its owner), never the caller.

### Griefing by the hirer
- **Unsolicited jobs (F-1, fixed).** In v1 anyone could open a 1-unit job against any agentId, wait
  for the deadline and refund it: `jobsRefunded += 1` on a victim who never saw the job. This costs
  gas, and the USDC comes back. v2 adds acceptance. A job counts against the agent only after the
  agent calls `accept` (or `deliver`, which implies it). The hirer can cancel an unaccepted job at
  any time, and the passport is not touched. The worker accepts only after the spec checks pass and
  the skill has produced its output, so jobs it skips stay unaccepted.
- **Oversized endpoint (F-5, fixed).** The endpoint is copied into storage and forwarded to ERC-8004
  on every settlement, including timeout releases that the agent pays for. v2 caps it at 256 bytes.
- **Dispute after delivery (F-6, accepted).** In v0, a dispute refunds the hirer and records
  `Disputed` (ERC-8004 value 0.00). The deliverable is a public URL, so a dishonest hirer keeps the
  work. Limits on the damage:
  - the dispute must fall inside the review window, which the agent saw before it accepted;
  - every `Attested` event names the hirer, so consumers can discount serial disputers;
  - the index already weights hirers (distinct hirers, concentration, Nansen links);
  - the agent chooses whom it works for.
  The fix is a resolver (arbitration or stake-backed disputes), which is the next milestone. It is
  not in this hackathon build.
- **Silent hirer.** It cannot hold the agent's money: anyone can release after the review window.

### Griefing by the agent
- The agent can deliver garbage. The hirer checks `keccak256(bytes)` against the committed hash (SDK
  `verifyDelivery`, dashboard, worker scripts) and disputes inside the window.
- The agent can accept and never deliver. The hirer refunds after the deadline, and the passport
  records a no-show. That is the signal `jobsRefunded` should carry.
- The agent cannot touch the escrowed funds before a valid release path exists. It cannot shorten
  the review window either: the window is part of the job, and for gasless opens it is inside the
  hirer's signed nonce.

### Precision and arithmetic
- Amounts are `uint128` in 6-decimal USDC units. The escrow does no division and takes no fee, so
  there is no rounding. `volumeSettled` is `uint128`, and a sum large enough to overflow it is
  impossible with USDC's supply. Counters are `uint64`.
- ERC-8004 values are fixed-point: `100` with 2 decimals = 1.00 for settled, `0` for disputed.
- Solidity 0.8 checked arithmetic everywhere. F-3 was the only reachable overflow.

### ERC-8004 registry dependency
- Feedback mirroring is a low-level call whose result is only reported (`FeedbackMirrored(ok)`). A
  registry that reverts or has no code cannot block a settlement. `test_attest_survivesRegistryRevert`
  and `test_attest_survivesRegistryWithoutCode` cover both cases.
- Accepted: the call forwards all but 1/64 of the gas. A registry that was upgraded to burn gas
  could make settlements expensive. A cap would let a caller under-supply gas and make the
  mirroring fail on purpose. The registry is the canonical ERC-8004 deployment; revisit this if its
  admin model changes.

## Residual risks
1. **v1 is still an attester**, so F-1 can still be used through v1 on the passport's
   `jobsRefunded` counter. Keeping v1 prevents stuck funds, as explained above. `jobsRefunded` is not
   part of `meets()` (the policy checks settled jobs, volume, disputes and recency), so no on-chain
   decision depends on it. Treat it as informational.
2. **Passport owner (F-7).** The deployer EOA `0x99e6…5A28` can allow new attesters, and a malicious
   attester could write fake settlements. The plan is to hand ownership to a timelock or multisig
   once the attester set is final, or to `address(0)` to freeze it. It stays an EOA on testnet so
   escrow upgrades like this one remain possible.
3. **Self-dealing.** An agent can hire itself from a second wallet and pay only gas. The protocol
   records who paid (`settledBetween`, `Attested.hirer`), and the trust index and Nansen rules
   (`minDistinctHirers`, `maxLinkedHirers`, `forbidFlagged`) exist to discount it. On-chain `meets()`
   alone does not.
4. Not audited. Testnet only.

## Slither

`slither . --filter-paths "lib/|test/|script/|src/mocks/" --exclude-dependencies` found 15 results:
0 high, 0 medium, 1 low (`missing-zero-check` on `transferOwnership`) and the rest informational.
Triage:

| Detector | Where | Verdict |
|---|---|---|
| uninitialized-local | `WebAuthn._base64Url` `o` | False positive: a counter that is meant to start at 0 |
| missing-zero-check | `AgentPassport.transferOwnership` | Intentional: `address(0)` freezes the attester set |
| reentrancy-events | `AgentPassport._mirrorFeedback` | Intentional: the event reports the call result; `attest` is attester-only and runs under the escrow mutex |
| timestamp | `meets`, `_create`, `_checkAgentCanAct`, `release`, `refund`, `dispute` | Expected: second-level comparisons against windows of minutes or more |
| low-level-calls | `_mirrorFeedback`, `P256.verify` | Intentional: best-effort mirroring; the precompile has no Solidity interface |
| naming-convention | `MAX_REVIEW_WINDOW()`, `MAX_ENDPOINT_LENGTH()` | Constant getters, upper case on purpose |
| too-many-digits | `P256.N`, `N_DIV_2` | Curve constants |

## Reproduce

```sh
SKIP_FORK_TESTS=1 forge test                         # 69 offline tests, including test/JobEscrow.v2.t.sol
forge test --match-path test/ForkFindings.t.sol -vv  # F-1 on the deployed v1 vs v2 (Monad testnet fork)
pip install slither-analyzer && slither . --filter-paths "lib/|test/|script/|src/mocks/" --exclude-dependencies
```
