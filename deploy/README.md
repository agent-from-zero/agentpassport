# deploy/

- `monad-testnet.json` — network constants (chain id, RPCs, canonical ERC-8004 registries, Circle USDC, x402 facilitator). Verified against primary sources on 2026-09-21; see `../FAUCET.md` in the parent folder for the evidence trail.
- `addresses.json` — our deployed contract addresses, filled after the first broadcast.

Deploy:

```sh
cp ../.env.example ../.env   # then set DEPLOYER_PRIVATE_KEY (fresh key from `cast wallet new`)
forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast
```

The key is only ever read from the environment. `.env` is git-ignored.
