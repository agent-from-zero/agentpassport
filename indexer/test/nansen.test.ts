// Nansen rows -> counterparty profile (pure; no API calls).
import { describe, expect, it } from "vitest";
import { toIntel } from "../scripts/nansen.ts";

const AT = "2026-09-23T10:00:00Z";

describe("toIntel", () => {
  it("a testnet-only wallet: nothing visible, nothing flagged", () => {
    expect(toIntel("0xabc", [], [], [], AT)).toEqual({ address: "0xabc", firstFunder: null, footprintUsd: 0, chains: [], related: [], flags: [], visible: false, fetchedAt: AT });
  });

  it("sums balances across chains and keeps the funder label", () => {
    const i = toIntel(
      "0xabc",
      [{ first_funder_address: "0xF00D", first_funder_name: "Binance: Hot Wallet 20", chain: "ethereum", transaction_hash: "0x1", block_timestamp: "2024-01-01T00:00:00" }],
      [{ chain: "monad", value_usd: 1.2 }, { chain: "ethereum", value_usd: 100.005 }, { chain: "base", value_usd: 0 }],
      [],
      AT,
    );
    expect(i.firstFunder).toEqual({ address: "0xf00d", name: "Binance: Hot Wallet 20", chain: "ethereum", tx: "0x1", at: "2024-01-01T00:00:00" });
    expect(i.footprintUsd).toBe(101.21);
    expect(i.chains).toEqual(["ethereum", "monad"]);
    expect(i.visible).toBe(true);
    expect(i.flags).toEqual([]);
  });

  it("flags mixer / exploit labels on the funder or a related wallet", () => {
    const i = toIntel(
      "0xabc",
      [{ first_funder_address: "0x1", first_funder_name: "Tornado Cash: Router" }],
      [],
      [{ address: "0xBAD", address_label: "Exploiter: Some Bridge Hack", relation: "First Funder", chain: "monad" }],
      AT,
    );
    expect(i.flags).toEqual(["tornado", "exploit"]);
    expect(i.related).toEqual([{ address: "0xbad", label: "Exploiter: Some Bridge Hack", relation: "First Funder", chain: "monad" }]);
  });
});
