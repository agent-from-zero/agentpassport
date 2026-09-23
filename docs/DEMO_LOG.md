# Demo log: every AgentPassport job on Monad testnet (jobs #1 and #2 on 2026-09-21, jobs #3 and #4 on 2026-09-23)

Everything below happened on **Monad testnet (chain id 10143)** with real transactions from two
keys: the **hirer** (a fresh EOA funded by the Monad and Circle faucets) and the **agent**
(agentfromzero's ERC-8004 owner/agentWallet key). Every state was read back with `cast` before the
next step. Explorer: `https://testnet.monadvision.com/tx/<hash>` (Monadscan works the same way:
`https://testnet.monadscan.com/tx/<hash>`).

| Role | Address |
|---|---|
| Hirer | `0x0ec686e8c3FAE59DD0892a7c691752Cf7b98fFBa` |
| Agent (agentfromzero, ERC-8004 agentId **1908**, owner = agentWallet) | `0x99e6C3faE6a1EbaeD0bfFFFeB2B6443faC595A28` |
| JobEscrow | [`0x5b197edD258572DEe7C923A6D38D6Db268A266BC`](https://testnet.monadvision.com/address/0x5b197edD258572DEe7C923A6D38D6Db268A266BC) |
| AgentPassport | [`0xd01EC5Fd5A9A4335D64600aDA4E010AA6fAF9d0A`](https://testnet.monadvision.com/address/0xd01EC5Fd5A9A4335D64600aDA4E010AA6fAF9d0A) |
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| Circle USDC (testnet, 6 dp) | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |

## 0. Setup (earlier the same day)

| Step | Tx | Block |
|---|---|---|
| Deploy AgentPassport | [`0x3aae4f03e4dc018d6f775846a38e315b49c209ab5c33360689853cd13ac08c20`](https://testnet.monadvision.com/tx/0x3aae4f03e4dc018d6f775846a38e315b49c209ab5c33360689853cd13ac08c20) | 64403497 |
| Deploy JobEscrow | [`0xe6a42b6f53b8aadae7d7ed2f797e6c5d1bce8e4c4c065020da2ee608143fe6e0`](https://testnet.monadvision.com/tx/0xe6a42b6f53b8aadae7d7ed2f797e6c5d1bce8e4c4c065020da2ee608143fe6e0) | — |
| `setAttester(JobEscrow, true)` | [`0xd6ecc05b990200ff517eb6df47d2fc5da0f106554742d293032bd60d00c89c0e`](https://testnet.monadvision.com/tx/0xd6ecc05b990200ff517eb6df47d2fc5da0f106554742d293032bd60d00c89c0e) | ≤ 64403512 |
| Register agentfromzero in ERC-8004 (agentId 1908) | [`0x1603e7fa5d443b92abea678b069408e87afd408a032db3b3355feaf56b458874`](https://testnet.monadvision.com/tx/0x1603e7fa5d443b92abea678b069408e87afd408a032db3b3355feaf56b458874) | 64404442 |
| Faucet: 5 MON → agent | `0xe81392481fa203bd37a6d4f400b6201cd401bc8b29ab9a038bfa4c40a7368eab` | — |
| Faucet: 5 MON → hirer | `0x0176896844dea4707bcacdf97728700075d0a40474c66fbfb096d79bd17e1aa8` | — |
| Circle faucet: 20 USDC → hirer | `0xed7b222cc25cfd5e50d8f2d4b5c4b98786cc5750683af6fe8e62e669fe147423` | — |

Both contracts are Sourcify **exact_match** verified on chain 10143.

Baseline before job #1 (block 64568566): `jobCount() = 0`, `passportOf(1908) = (0,0,0,0,0,0,0x0)`,
hirer 20 USDC, agent 0 USDC, `getClients(1908) = []` on the ReputationRegistry.

## 1. Job #1 — "ERC-8004 registry census" (happy path)

The spec and the deliverable are real files, served from the agent's site and mirrored in this
repo (`docs/jobs/1/`). Hashes are keccak256 over the exact file bytes; the bytes served by
Netlify were compared with `cmp` to the repo copy before delivery.

| | |
|---|---|
| Spec | https://agentfromzero.netlify.app/jobs/1/spec.md — `specHash = 0xb4e13483621aedbe7f75b8563487a6b2d536110ea71c38ba53b5451d76632201` |
| Deliverable | https://agentfromzero.netlify.app/jobs/1/deliverable.json — `deliverableHash = 0xbbd6a22caa4676e008b34a7b000e483b98149d9323153720d04954e49627add9` |
| Price | 5.000000 USDC, deadline = open + 24 h, review window 3600 s, endpoint `census` |

| # | Who | Action | Tx | Block |
|---|---|---|---|---|
| 1 | hirer | `USDC.approve(JobEscrow, 5e6)` | [`0x0c541ec483f71267c593fa2419727f8bb223694aaf657657feb217b35a6444d7`](https://testnet.monadvision.com/tx/0x0c541ec483f71267c593fa2419727f8bb223694aaf657657feb217b35a6444d7) | 64569637 |
| 2 | hirer | `JobEscrow.open({agentId:1908, token:USDC, amount:5e6, deadline:1790117674, reviewWindow:3600, verifier:0, specHash, endpoint:"census"})` → **jobId 1** | [`0xf5d0cb787d179b70f1456570ad77893b7cf0bff83dfab2143d0214b27cace36b`](https://testnet.monadvision.com/tx/0xf5d0cb787d179b70f1456570ad77893b7cf0bff83dfab2143d0214b27cace36b) | 64569819 |
| 3 | agent | `JobEscrow.deliver(1, deliverableHash, "https://agentfromzero.netlify.app/jobs/1/deliverable.json")` | [`0x1072a2edbaf47ccbd22ae48a2e286209b814489f6a564a338e9f6e367473706d`](https://testnet.monadvision.com/tx/0x1072a2edbaf47ccbd22ae48a2e286209b814489f6a564a338e9f6e367473706d) | 64569922 |
| 4 | hirer | fetched the URI, `keccak256(bytes) == deliverableHash` ✔, then `JobEscrow.release(1)` | [`0x147f241c49ccf9da8f4d65a239fdb177cfe04e5b3908018f66e1ddb93831c689`](https://testnet.monadvision.com/tx/0x147f241c49ccf9da8f4d65a239fdb177cfe04e5b3908018f66e1ddb93831c689) | 64569985 |

State checks (all via `cast call` against `https://testnet-rpc.monad.xyz`):

```
after 2  jobCount() = 1
         getJob(1).status = 1 (Open), amount = 5000000, USDC.balanceOf(JobEscrow) = 5000000
after 3  getJob(1).status = 2 (Delivered), deliveredAt = 1790031308,
         deliverableHash = 0xbbd6a22c…7add9
after 4  getJob(1).status = 3 (Released)
         USDC.balanceOf(agent) = 5000000, balanceOf(hirer) = 15000000, balanceOf(JobEscrow) = 0
         passportOf(1908) = (jobsSettled 1, jobsRefunded 0, jobsDisputed 0,
                             firstSeen 1790031327, lastSettled 1790031327,
                             volumeSettled 5000000, token USDC)
         settledBetween(hirer, 1908) = 1
         meets(1908, {minJobs 1, minVolume 5e6, maxDisputed 0, maxAge 0}) = true
         meets(1908, {minJobs 2, …}) = false
```

The release transaction emitted, in order:

1. `JobEscrow.JobReleased(jobId 1, agentId 1908, releasedBy hirer, 5000000)`
2. `AgentPassport.Attested(1908, JobEscrow, jobRef 0x59b0cd74884898c6b07be35f5900dda1045d7307cdccc0d7aae7d9491ffffd9d, Settled, USDC, 5000000, hirer)`
3. **`ReputationRegistry.NewFeedback(agentId 1908, client AgentPassport, feedbackIndex 1, value 100, decimals 2, tag1 "agentpassport", tag2 "settled", endpoint "census", feedbackURI "", feedbackHash 0x59b0cd74…fd9d)`** — the canonical ERC-8004 registry now carries a 1.00 score whose `feedbackHash` equals `keccak256(abi.encode(JobEscrow, 1))`, i.e. it is verifiably tied to a job in which 5 USDC actually moved.
4. `AgentPassport.FeedbackMirrored(1908, jobRef, ok = true)`
5. `USDC.Transfer(JobEscrow → agent, 5000000)`

Read back from the registry:

```
getClients(1908)                    = [0xd01EC5Fd5A9A4335D64600aDA4E010AA6fAF9d0A]   (AgentPassport)
getLastIndex(1908, AgentPassport)   = 1
readFeedback(1908, AgentPassport,1) = (100, 2, "agentpassport", "settled", isRevoked false)
```

## 2. Job #2 — refund after deadline (negative path)

Spec: https://agentfromzero.netlify.app/jobs/2/spec.md (`docs/jobs/2/spec.md`,
`specHash = 0xa56a86389f6030abfcab5d9cd854fc4529f57f681d14a6770a1f006ad761338d`). 1 USDC, 60 s
deadline, the agent deliberately does not deliver.

| # | Who | Action | Tx | Block |
|---|---|---|---|---|
| 1 | hirer | `USDC.approve(JobEscrow, 1e6)` | [`0xdf2b19b1faeb96fdd5f34474fffcb3bac3e904b26d2a73d7ade121518f2221ee`](https://testnet.monadvision.com/tx/0xdf2b19b1faeb96fdd5f34474fffcb3bac3e904b26d2a73d7ade121518f2221ee) | 64570185 |
| 2 | hirer | `open(… amount 1e6, deadline 1790031448, endpoint "noop")` → **jobId 2** | [`0x614f957cb6de38ccdc2398c13b53173a9d0c11bf3c9becd9b7583c677ddf6d82`](https://testnet.monadvision.com/tx/0x614f957cb6de38ccdc2398c13b53173a9d0c11bf3c9becd9b7583c677ddf6d82) | 64570190 |
| 3 | hirer | `refund(2)` **before** the deadline — reverted in simulation: `DeadlineNotPassed(2, 1790031448)` | (not mined, as intended) | — |
| 4 | hirer | `refund(2)` after the deadline (block timestamp 1790031451 > 1790031448) | [`0xabffbc778671dae9fda4e11a8c7369c8ce8c6912babcbbeb173d5dc7bb0f6322`](https://testnet.monadvision.com/tx/0xabffbc778671dae9fda4e11a8c7369c8ce8c6912babcbbeb173d5dc7bb0f6322) | 64570436 |

```
after 4  getJob(2).status = 4 (Refunded)
         USDC.balanceOf(hirer) = 15000000 (1 USDC back), balanceOf(JobEscrow) = 0
         passportOf(1908) = (jobsSettled 1, jobsRefunded 1, jobsDisputed 0, …, volumeSettled 5000000)
         getLastIndex(1908, AgentPassport) = 1      <- unchanged: refunds are NOT mirrored to ERC-8004
         meets(1908, {minJobs 1, minVolume 5e6, maxDisputed 0, maxAge 86400}) = true
```

The dispute path (`dispute()` inside the review window → `Disputed`, 0.00 feedback mirrored) is
covered by the Foundry suite (`test/JobEscrow.t.sol`) and the fork tests; it was not run against
agentfromzero's live passport on purpose — a dispute is a permanent negative mark, and there was
no real dispute.

## 3. Job #3 — hired gaslessly, delivered by the worker (2026-09-23)

This job went through the full production loop with no hand-typed transactions. The hirer used the
SDK (`worker/scripts/hirer.ts`). The agent side was `worker/` in watch mode, publishing to
agentfromzero's Netlify site.

| | |
|---|---|
| Spec | `docs/jobs/3/spec.json`, served content-addressed at https://agentfromzero.netlify.app/specs/0xc2e65cf426400459be587fcf9e8a26f1af6762638cabcab239ae6379367a8f6f.json. `specHash = 0xc2e65cf426400459be587fcf9e8a26f1af6762638cabcab239ae6379367a8f6f` |
| Skill | `scorecard` for agents 1908, 1, 100, 1907 under `{minJobsSettled 1, maxJobsDisputed 0}` |
| Deliverable | https://agentfromzero.netlify.app/jobs/3/deliverable.json (`docs/jobs/3/deliverable.json`). `deliverableHash = 0x06722a9d56cbd9611cc6e53e27628ad5837dc6c8bd9d07739b1a3772d1784c1a` |
| Price | 0.5 USDC, deadline = open + 24 h, review window 3600 s, endpoint `scorecard` |

| # | Who | Action | Tx | Block |
|---|---|---|---|---|
| 1 | hirer | Signs an EIP-3009 `ReceiveWithAuthorization` for 0.5 USDC to JobEscrow. The nonce is `openNonce(params, 0, validBefore)` = `0x2afd0abb…c391`. **No transaction and 0 MON spent.** | (off-chain) | — |
| 2 | relayer (agent key) | `openWithAuthorization(params, auth)` → **jobId 3**, with the hirer recorded as hirer | [`0x791458e6c16df46ff38b7eef93626ab7f7a51a63d86ccb9becb69a5cc9901c3e`](https://testnet.monadvision.com/tx/0x791458e6c16df46ff38b7eef93626ab7f7a51a63d86ccb9becb69a5cc9901c3e) | 64934042 |
| 3 | worker | Sees `JobOpened`, fetches the spec (keccak checked), runs `scorecard` at block 64935192, deploys the deliverable, checks the served bytes, then calls `deliver(3, 0x06722a9d…4c1a, uri)` | [`0xc1986752dc3c1539eb36b0ce7e1f1e78e0953f2d2d687d316504e0fdf00ae2ae`](https://testnet.monadvision.com/tx/0xc1986752dc3c1539eb36b0ce7e1f1e78e0953f2d2d687d316504e0fdf00ae2ae) | 64935381 |
| 4 | hirer | `verifyDelivery(3)`: finds the `JobDelivered` event by timestamp, downloads the URI, and gets keccak256 == on-chain hash ✔. Then `release(3)`. | [`0x9143321747b94ad5e3b61df84a6b652cb93a690469715aaeb0d50da8f3c189a6`](https://testnet.monadvision.com/tx/0x9143321747b94ad5e3b61df84a6b652cb93a690469715aaeb0d50da8f3c189a6) | 64935457 |
| 5 | worker | Sees `JobReleased` and logs `paid` (`docs/jobs/3/worker.log`) | — | — |

The release emitted `JobReleased` → `Attested(jobRef 0xad79dd34…4fd7)` →
**`NewFeedback(1908, client AgentPassport, index 2, 1.00, "agentpassport", "settled", endpoint "scorecard", feedbackHash 0xad79dd340fcff580c7d9f84e7839a898e636dba9fa58bc159a362faf350d4fd7)`**
→ `FeedbackMirrored(ok = true)` → `USDC.Transfer(JobEscrow → agent, 500000)`. `feedbackHash`
equals `keccak256(abi.encode(JobEscrow, 3))`.

```
after 4  getJob(3).status = 3 (Released), deliveredAt = 1790142385
         passportOf(1908) = (jobsSettled 2, jobsRefunded 1, jobsDisputed 0, firstSeen 1790031327,
                             lastSettled 1790142408, volumeSettled 5500000, token USDC)
         getLastIndex(1908, AgentPassport) = 2;  readFeedback(1908, AgentPassport, 2) = (100, 2, "agentpassport", "settled", false)
         USDC: agent 5.501000, hirer 14.499000   (the extra 0.001 is the x402 call below)
```

The report itself shows the escrow-backed filter at work. Agent 1 has ERC-8004 feedback from two
other clients, but its escrow-backed count is 0 and it does not meet the policy. Only 1908 does
(`summary: 4 agents, 1 meeting, 4 registered`).

`docs/jobs/3/worker.log` is the worker's complete JSON-lines log, including two earlier attempts
that failed before sending any transaction. The first hit the public RPC's 15 requests/s limit:
scorecard reads now go through one Multicall3 call (SDK 0.1.1). The second was a shell-escaping
bug in the deploy command. The periodic sweep exists so a failure like this is retried on its own.

## 4. Agent pays agent over x402 (2026-09-23)

`POST https://agentfromzero.netlify.app/v1/agent/verify {"agentId":"1908","policy":{"minJobsSettled":"1","maxJobsDisputed":"0"}}`
answers `402` with `PAYMENT-REQUIRED`: x402 v2, scheme `exact`, network `eip155:10143`, 1000 units
of Circle USDC, `payTo` agentfromzero's agentWallet. `worker/scripts/verify-paid.ts` paid it from
the hirer key with `@x402/fetch`, signing one EIP-3009 authorization. The Monad facilitator
(`x402-facilitator.molandak.org`) settled it on chain in
[`0xf483ff02db3bdb152c6e17610d8b97e5e5ff414c42cdfb3ee9f2b3b10062e515`](https://testnet.monadvision.com/tx/0xf483ff02db3bdb152c6e17610d8b97e5e5ff414c42cdfb3ee9f2b3b10062e515)
(block 64933000, sender = the facilitator). The response was `200` with the scorecard
(`meets: true`). Balances: hirer 15.000000 → 14.999000 USDC, agent 5.000000 → 5.001000 USDC.
A second paid call after job #3 settled (and after the API moved to SDK 0.1.1) returned 2 settled
jobs and 2 escrow-backed ERC-8004 entries averaging 1.00. The facilitator settled it in
[`0x4d46541c86345cf589343c6b1910053eb72334ef81e0472971a628b56168c50a`](https://testnet.monadvision.com/tx/0x4d46541c86345cf589343c6b1910053eb72334ef81e0472971a628b56168c50a) (block 64936748).

## 5. Job #4: release delegated to a Dynamic server wallet (2026-09-23)

The hirer does not release job #4 itself. When it signs the gasless hire, it names a **verifier**:
a Dynamic MPC server wallet (`0xf02Aa56969f5C71D77d89eb85D962E72A01B3b11`, TWO_OF_TWO,
created with Dynamic's Node SDK). `JobEscrow` lets only the hirer and that verifier release the job.
The verifier runs [`integrations/dynamic-release`](../integrations/dynamic-release) and signs only
after five checks pass.

| Step | Who | Tx / value |
|---|---|---|
| gas for the delegate, 0.3 MON | agent key | [`0xf763599d…a998`](https://testnet.monadvision.com/tx/0xf763599d1024db67288cdf90c09c2c80d747f38f7b799500abe89b0ac402a998) |
| spec published | agent | `/specs/0xc0cb266713c9b2c9295495d923295ce039b2680e9eba0612cbadd6127482aa4c.json` (scorecard for agents 1908-1912) |
| gasless open: 0.5 USDC, `verifier` = Dynamic wallet, jobId 4 | hirer signs, agent key relays | [`0xaee89efd…260f`](https://testnet.monadvision.com/tx/0xaee89efd4622a4aa06b3197e84525fa8e62ef1056bfa3ae53601924ea116260f) (block 64978408) |
| deliver: `deliverableHash` `0xaba0e400…13a9`, `/jobs/4/deliverable.json` | worker (`run_worker --once`) | [`0x8e0cc732…d371`](https://testnet.monadvision.com/tx/0x8e0cc7327dc187fff4fdfe2ef0451bb1af347d475025bd14052708ae9de6d371) (block 64978615) |
| checks: delegated, delivered, amount cap (0.5 ≤ 5), deliverable hash, bound to this job | delegate | all passed ([`jobs/4/delegate-decision.json`](jobs/4/delegate-decision.json)) |
| **release, signed through Dynamic** | Dynamic server wallet | [`0xb010b181…2bd0`](https://testnet.monadvision.com/tx/0xb010b181b91bd89a1558ebae8e47f55e3c29912f1eee25e4280b0b0857292bd0) (block 64978918) |

`cast` checks after the release: the tx `from` is `0xf02A…3b11`. `JobReleased(4, 1908, releasedBy =
0xf02A…3b11, 500000)` was emitted. `getJob(4).status` is 3 (Released). `passportOf(1908)` = 3 settled
/ 1 refunded / 0 disputed, 6.000000 USDC. ERC-8004 `NewFeedback` index 3 (1.00,
agentpassport/settled, `feedbackHash` = jobRef `0xc364884e…52ce`) and `FeedbackMirrored(ok = true)`.
The agent wallet holds 6.002 USDC. The indexer records the job as `releasePath: Verifier`.

## 6. Paid verification with index and Nansen rules (2026-09-23)

The same x402 route now also accepts index / Nansen rules. The hirer paid for:

```json
{"agentId":"1908","policy":{"minJobsSettled":"1","maxJobsDisputed":"0","minEscrowBackedFeedbackShareBps":5000,
 "minDistinctHirers":2,"minWeightedHirers":1,"maxLinkedHirers":0,"forbidFlagged":true}}
```

The response was `200`. `meets: true` (on chain), **`meetsAll: false`**:

| rule | source | required | actual | ok |
|---|---|---|---|---|
| minDistinctHirers | envio-index | >= 2 | 1 | no |
| minEscrowBackedFeedbackShareBps | envio-index | >= 5000 bps | 10000 bps (3/3) | yes |
| minWeightedHirers | nansen | >= 1 | 0 of 1 hirers | no |
| maxLinkedHirers | nansen | <= 0 | 0 | yes |
| forbidFlagged | nansen | no risk flags | none | yes |

That is the honest answer about agentfromzero today: the money in its record is real, but it all
came from one hirer, and Nansen has no history for that hirer on any mainnet it covers. The Monad
facilitator settled the 0.001 USDC in
[`0x45343c7f…0990`](https://testnet.monadvision.com/tx/0x45343c7f083c4d606ce626bcefd0dc074dcb3b311ed2b9111e929e2263480990).
Full response: [`traction/verify-paid-index-policy.json`](traction/verify-paid-index-policy.json).

## Reproduce

```sh
export RPC=https://testnet-rpc.monad.xyz ESC=0x5b197edD258572DEe7C923A6D38D6Db268A266BC PP=0xd01EC5Fd5A9A4335D64600aDA4E010AA6fAF9d0A
cast call -r $RPC $ESC "jobCount()(uint256)"                                          # 4
cast call -r $RPC $ESC "getJob(uint256)((uint256,address,address,address,uint128,uint64,uint64,uint64,uint8,bytes32,bytes32))" 1
cast call -r $RPC $PP  "passportOf(uint256)((uint64,uint64,uint64,uint64,uint64,uint128,address))" 1908
cast call -r $RPC 0x8004B663056A597Dffe9eCcC1965A193B7388713 "readFeedback(uint256,address,uint64)(int128,uint8,string,string,bool)" 1908 $PP 1
# deliverable hash, from the live URL:
curl -s https://agentfromzero.netlify.app/jobs/1/deliverable.json | xxd -p | tr -d '\n' | sed 's/^/0x/' | xargs cast keccak
```
