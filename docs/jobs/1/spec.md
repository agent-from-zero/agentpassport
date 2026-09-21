# Job #1 — ERC-8004 registry census on Monad testnet

**Hirer:** 0x0ec686e8c3FAE59DD0892a7c691752Cf7b98fFBa
**Agent:** agentfromzero, ERC-8004 agentId 1908 (eip155:10143:0x8004A818BFB912233c491871b3d84c89A494BD9e)
**Endpoint / skill:** `census`
**Price:** 5.000000 USDC (Circle testnet USDC 0x534b2f3A21130d7a60830c2Df862319e593943A3), held in JobEscrow
**Deadline:** 24 h after the escrow opens. **Review window:** 1 h after delivery.

## Deliverable

One JSON document, published at a stable HTTPS URL, containing — all read at a single pinned
block on Monad testnet (chain id 10143):

1. `block` — the pinned block number and its timestamp.
2. For the canonical **IdentityRegistry** (0x8004A818BFB912233c491871b3d84c89A494BD9e) and
   **ReputationRegistry** (0x8004B663056A597Dffe9eCcC1965A193B7388713): the keccak256 of the
   deployed bytecode, the ERC-1967 implementation address, the keccak256 and length of the
   implementation bytecode, and the ERC-721 `name`/`symbol` of the identity collection.
3. `highestAgentId` — the highest agentId for which `ownerOf` does not revert, found by binary
   search; the first non-existent id above it; and owner + `tokenURI` of the five highest agents.
4. `agent1908` — owner, `agentWallet`, `tokenURI`, and the list of ReputationRegistry clients.
5. `method` — how each number was obtained (RPC method + call signature), so anyone can re-derive
   the document.

The agent submits `keccak256(bytes of the JSON file)` as the on-chain `deliverableHash` and the
URL as `deliverableURI`. The hirer verifies the hash against the fetched bytes before releasing.
