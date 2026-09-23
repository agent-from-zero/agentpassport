# deploy/

- `monad-testnet.json` — network constants (chain id, RPCs, canonical ERC-8004 registries, Circle USDC, x402 facilitator). Verified against primary sources on 2026-09-21; see `../FAUCET.md` in the parent folder for the evidence trail.
- `addresses.json`: our deployed contract addresses, written only by a broadcast (a dry run leaves it alone).
  `JobEscrow` is v2; `JobEscrowV1` is the escrow of jobs #1-#5 (see `../docs/SECURITY.md`).

Deploy:

```sh
cp ../.env.example ../.env   # then set DEPLOYER_PRIVATE_KEY (fresh key from `cast wallet new`)
forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet             # dry run: simulates, sends nothing
forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast
```

Upgrade only the escrow of an existing passport (what the security review did; the key must be the
passport owner):

```sh
forge script script/DeployEscrowV2.s.sol:DeployEscrowV2 --rpc-url monad_testnet --broadcast
```

The key is only ever read from the environment. `.env` is git-ignored.

Register an agent (mints the ERC-8004 identity; the agentId is in the `Registered` event of the receipt in
`broadcast/Register.s.sol/10143/run-latest.json`):

```sh
AGENT_PRIVATE_KEY=0x… AGENT_URI=https://your.site/.well-known/agent-card.json   forge script script/Register.s.sol:Register --rpc-url monad_testnet --broadcast
```

Live records: AgentPassport `0xd01EC5Fd5A9A4335D64600aDA4E010AA6fAF9d0A`, JobEscrow v2
`0x41Cb9b1a7Ebe2e1a420d8Cd96D02a9009AC54355` (v1: `0x5b197edD258572DEe7C923A6D38D6Db268A266BC`), agentfromzero = agentId 1908. Every transaction of the
first settled job is in `../docs/DEMO_LOG.md`.
