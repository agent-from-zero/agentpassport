import { describe, expect, it } from "vitest";
import {
  MONAD_TESTNET, MONAD_TESTNET_V1,
  POLICIES,
  evaluatePolicy,
  formatFixed,
  formatUsdc,
  hashContent,
  jobRef,
  parseUsdc,
  toAgentId,
  toPolicy,
  type Passport,
} from "../src/index.js";

const passport = (p: Partial<Passport> = {}): Passport => ({
  jobsSettled: 0n,
  jobsRefunded: 0n,
  jobsDisputed: 0n,
  firstSeen: 0n,
  lastSettled: 0n,
  volumeSettled: 0n,
  token: "0x0000000000000000000000000000000000000000",
  ...p,
});

describe("policy", () => {
  it("fills unset fields with Solidity defaults (0 = no disputes tolerated)", () => {
    expect(toPolicy({ minJobsSettled: 2, minVolumeSettled: "5000000" })).toEqual({
      minJobsSettled: 2n,
      minVolumeSettled: 5_000_000n,
      maxJobsDisputed: 0n,
      maxAgeOfLastSettlement: 0n,
    });
  });

  it("empty passport passes the empty policy and fails `proven`", () => {
    expect(evaluatePolicy(passport(), toPolicy(), 1000n).ok).toBe(true);
    const r = evaluatePolicy(passport(), POLICIES.proven, 1000n);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.rule === "minJobsSettled")).toMatchObject({ ok: false, actual: "0", required: ">= 1" });
  });

  it("mirrors meets(): disputes, volume and recency", () => {
    const p = passport({ jobsSettled: 5n, volumeSettled: 25_000_000n, lastSettled: 1_000n, jobsDisputed: 1n });
    expect(evaluatePolicy(p, toPolicy({ minJobsSettled: 5 }), 2_000n).ok).toBe(false); // 1 dispute > 0
    expect(evaluatePolicy(p, toPolicy({ minJobsSettled: 5, maxJobsDisputed: 1 }), 2_000n).ok).toBe(true);
    expect(evaluatePolicy(p, toPolicy({ maxJobsDisputed: 1, minVolumeSettled: 25_000_001n }), 2_000n).ok).toBe(false);
    // recency: age exactly equal to the limit passes, one second more fails (contract uses `>`).
    expect(evaluatePolicy(p, toPolicy({ maxJobsDisputed: 1, maxAgeOfLastSettlement: 1000 }), 2_000n).ok).toBe(true);
    expect(evaluatePolicy(p, toPolicy({ maxJobsDisputed: 1, maxAgeOfLastSettlement: 1000 }), 2_001n).ok).toBe(false);
    const never = evaluatePolicy(passport(), toPolicy({ maxAgeOfLastSettlement: 60 }), 10n);
    expect(never.ok).toBe(false);
    expect(never.checks.at(-1)?.actual).toBe("never settled");
  });
});

describe("encoding helpers", () => {
  it("jobRef matches the feedbackHash AgentPassport wrote for live job #1", () => {
    // From the ERC-8004 NewFeedback event of job #1 on Monad testnet (docs/DEMO_LOG.md).
    expect(jobRef(MONAD_TESTNET_V1.jobEscrow, 1n)).toBe("0x59b0cd74884898c6b07be35f5900dda1045d7307cdccc0d7aae7d9491ffffd9d");
  });

  it("hashContent is keccak256 over UTF-8 bytes, same for string and bytes", () => {
    expect(hashContent("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(hashContent("héllo")).toBe(hashContent(new TextEncoder().encode("héllo")));
  });

  it("USDC and fixed-point formatting", () => {
    expect(parseUsdc("5")).toBe(5_000_000n);
    expect(parseUsdc(0.001)).toBe(1_000n);
    expect(formatUsdc(1_500_000n)).toBe("1.5");
    expect(formatFixed(100n, 2)).toBe("1");
    expect(formatFixed(150n, 2)).toBe("1.5");
    expect(formatFixed(-5n, 1)).toBe("-0.5");
    expect(formatFixed(7n, 0)).toBe("7");
  });

  it("toAgentId accepts decimal/hex/bigint and rejects junk", () => {
    expect(toAgentId("1908")).toBe(1908n);
    expect(toAgentId("0x774")).toBe(1908n);
    expect(toAgentId(1908)).toBe(1908n);
    expect(() => toAgentId("1.5")).toThrow();
    expect(() => toAgentId(-1)).toThrow();
    expect(() => toAgentId("abc")).toThrow();
  });
});
