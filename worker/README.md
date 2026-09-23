# AgentPassport worker

The loop that makes an ERC-8004 agent hireable through `JobEscrow`. agentfromzero (agentId 1908)
runs it. Job #3 on Monad testnet was opened, delivered by this worker and paid:
[`../docs/DEMO_LOG.md`](../docs/DEMO_LOG.md#3-job-3--hired-gaslessly-delivered-by-the-worker-2026-09-23).

```
JobOpened(agentId = ours) ─▶ re-read the job on chain (Open? our agent? deadline? USDC? min price?)
  ─▶ fetch <SPEC_BASE>/<specHash>.json, accept only if keccak256(bytes) == specHash
  ─▶ run the skill named in the spec
  ─▶ write deliverable.json, deploy, poll the public URL until it serves the exact bytes
  ─▶ JobEscrow.deliver(jobId, keccak256(bytes), url)
JobReleased(ours) ─▶ log "paid"
```

- **Discovery on rate-limited RPCs.** Public Monad testnet RPCs cap `eth_getLogs` at 100 blocks.
  The worker first sweeps escrow *state* (`jobCount` + `getJob`, batched through Multicall3) for
  open jobs. It then tails events page by page and repeats the sweep every 60 s. The sweep retries
  jobs that failed on a transient error and finds specs published after their job was opened.
- **Idempotent.** On-chain status is the source of truth: a job that is no longer `Open` is left
  alone, so restarts, duplicate events and overlapping sweeps are harmless. Progress is kept in
  `STATE_FILE`, and every step is a JSON line in `LOG_FILE`.
- **Honest by construction.** A job whose spec cannot be found, whose hash does not match, whose
  skill is unknown or whose price is below the minimum is *skipped* and never delivered. The hirer
  can refund it after the deadline. A deliverable is committed on chain only once the public URL
  serves the exact bytes that were hashed.
- **Deterministic deliverables.** The deliverable has no wall-clock fields. Every number is read at
  one pinned block, so anyone can recompute it from the chain.

## Skills

| Skill | Spec | Deliverable |
|---|---|---|
| `scorecard` | `{"skill":"scorecard","agentIds":["1908","1"],"policy":{"minJobsSettled":"1"}}` (≤ 25 agents; policy optional) | For each agent at one block: `meets(policy)` from the chain, rule-by-rule checks, passport, ERC-8004 identity and escrow-backed ERC-8004 reputation. Also a summary (`agents`, `meeting`, `registered`). |

Add a skill by implementing `Skill` in `src/skills.ts` (`run(ctx) → JSON`) and adding it to `DEFAULT_SKILLS`.

## Run

Node ≥ 22.18 runs the TypeScript sources directly, so there is no build step. The SDK is linked from `../sdk`:

```sh
(cd ../sdk && npm install && npm run build)
npm install
AGENT_PRIVATE_KEY=0x… PUBLISH_DIR=./site PUBLIC_BASE_URL=https://you.example npm start   # watch
AGENT_PRIVATE_KEY=0x… … node src/main.ts --once        # sweep open jobs once, exit (cron)
AGENT_PRIVATE_KEY=0x… … node src/main.ts --job 3       # one job
```

| Env | Default | |
|---|---|---|
| `AGENT_PRIVATE_KEY` | required | ERC-8004 owner, approved operator or `agentWallet` of the agent |
| `AGENT_ID` | `1908` | agent to work for |
| `AGENT_NAME` | `ERC-8004 agent <id>` | written into deliverables |
| `MONAD_TESTNET_RPC` | `https://testnet-rpc.monad.xyz` | |
| `SPEC_BASES` | `https://agentfromzero.netlify.app/specs` | comma-separated URLs or directories holding `<specHash>.json` |
| `PUBLISH_DIR` / `PUBLIC_BASE_URL` | `./published` / `https://agentfromzero.netlify.app` | deliverables go to `<dir>/jobs/<id>/deliverable.json`, served at `<url>/jobs/<id>/deliverable.json` |
| `DEPLOY_CMD` | none | shell command run after writing, e.g. a static-site deploy |
| `MIN_AMOUNT_USDC` | `0.01` | ignore cheaper jobs |
| `STATE_FILE` / `LOG_FILE` | `worker-state.json` / `worker.log` | |

agentfromzero runs it with its Netlify site as `PUBLISH_DIR` and `netlify deploy --prod` as
`DEPLOY_CMD`. The operator's launcher lives outside this repo because it reads the key store.

## Hirer and payer scripts

```sh
# gasless hire: the hirer only signs EIP-3009 (0 MON); the relayer submits openWithAuthorization
HIRER_PRIVATE_KEY=0x… RELAYER_PRIVATE_KEY=0x… node scripts/hirer.ts open-gasless ../docs/jobs/3/spec.json 0.5
# check the delivered bytes against the on-chain hash, then release
HIRER_PRIVATE_KEY=0x… node scripts/hirer.ts release 3
# agent pays agent: x402 v2 call to the paid verification API (0.001 USDC on Monad testnet)
PAYER_PRIVATE_KEY=0x… node scripts/verify-paid.ts 1908
```

## Test

```sh
(cd .. && forge build)   # the e2e suite deploys the real contract bytecode on anvil
npm test                 # catch-up delivery with a decoy spec copy, skip rules, watch mode → paid
```
