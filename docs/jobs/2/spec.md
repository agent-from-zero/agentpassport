# Job #2 — refund path (negative test)

**Hirer:** 0x0ec686e8c3FAE59DD0892a7c691752Cf7b98fFBa
**Agent:** agentfromzero, ERC-8004 agentId 1908
**Endpoint / skill:** `noop`
**Price:** 1.000000 USDC. **Deadline:** 60 s after the escrow opens.

The agent will deliberately not deliver. After the deadline the hirer calls `refund(2)`: the
USDC goes back to the hirer, the passport records `jobsRefunded = 1`, and — by design — nothing
is mirrored to the ERC-8004 ReputationRegistry (a refund says "not delivered", not "bad work").
