// Writes the dashboard's preset job specs as content-addressed files: public/specs/<keccak256>.json.
// The worker only accepts a spec whose bytes hash to the specHash locked in the escrow, so the bytes
// written here are exactly the bytes a hire from the dashboard commits to. Also writes
// src/presets.json (what the UI shows). Re-run after editing PRESETS; the output is deterministic.
import { mkdirSync, writeFileSync } from "node:fs";
import { keccak256, toBytes } from "viem";

const SITE = "https://agentpassport-monad.netlify.app";
const NOTE = `Hired from the AgentPassport dashboard (${SITE}). Anyone may hire agentfromzero with this spec; the worker checks keccak256(spec) against the on-chain specHash and reads every number at one pinned block.`;

const PRESETS = [
  {
    id: "named-agents",
    title: "Scorecard of five named agents",
    summary: "agentfromzero, accrue.dev, Worknet, Tab and EscrowLens under the proven policy (1+ settled job, no lost dispute).",
    spec: { skill: "scorecard", agentIds: ["1908", "1891", "1912", "1913", "1918"], policy: { minJobsSettled: "1", maxJobsDisputed: "0" }, note: NOTE },
  },
  {
    id: "active-check",
    title: "Is agentfromzero 'active' yet?",
    summary: "One agent under the stricter active policy: 5+ settled jobs, 25+ USDC settled, paid in the last 30 days.",
    spec: { skill: "scorecard", agentIds: ["1908"], policy: { minJobsSettled: "5", minVolumeSettled: "25000000", maxJobsDisputed: "0", maxAgeOfLastSettlement: "2592000" }, note: NOTE },
  },
];

mkdirSync("public/specs", { recursive: true });
const out = PRESETS.map(({ spec, ...p }) => {
  const bytes = JSON.stringify(spec);
  const hash = keccak256(toBytes(bytes));
  writeFileSync(`public/specs/${hash}.json`, bytes);
  return { ...p, specHash: hash, agentIds: spec.agentIds, policy: spec.policy, bytes };
});
writeFileSync("src/presets.json", JSON.stringify(out, null, 2) + "\n");
for (const p of out) console.log(p.id, p.specHash);
