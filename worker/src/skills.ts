// What the agent can be hired for. A skill turns a verified spec into a JSON deliverable.
// Deterministic by design: every number in a deliverable is read at one pinned block, so anyone
// can recompute it from the chain and compare with the bytes the agent committed to.
import { type AgentPassportClient, type Job, type PolicyInput, toAgentId } from "@agentfromzero/agentpassport-sdk";

export interface SkillContext {
  jobId: bigint;
  job: Job;
  spec: Record<string, unknown>;
  client: AgentPassportClient;
}

export interface Skill {
  name: string;
  description: string;
  /** Throws `SpecError` when the spec is not acceptable for this skill. */
  run(ctx: SkillContext): Promise<Record<string, unknown>>;
}

export class SpecError extends Error {}

const POLICY_KEYS = ["minJobsSettled", "minVolumeSettled", "maxJobsDisputed", "maxAgeOfLastSettlement"] as const;

function parsePolicy(raw: unknown): PolicyInput {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new SpecError("policy must be an object");
  const out: PolicyInput = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(POLICY_KEYS as readonly string[]).includes(k)) throw new SpecError(`unknown policy field: ${k}`);
    if (!(typeof v === "number" || typeof v === "string") || !/^\d+$/.test(String(v))) throw new SpecError(`policy.${k} must be a non-negative integer`);
    out[k as (typeof POLICY_KEYS)[number]] = String(v);
  }
  return out;
}

/**
 * `scorecard`: due diligence on a list of ERC-8004 agents. For each agent: the on-chain
 * `meets(policy)` verdict, a rule-by-rule explanation, its passport, ERC-8004 identity and the
 * escrow-backed slice of its ERC-8004 reputation — all read at the same block.
 *
 * Spec: `{ "skill": "scorecard", "agentIds": ["1908", 1], "policy": { "minJobsSettled": 1 } }`
 */
export const scorecardSkill: Skill = {
  name: "scorecard",
  description: "AgentPassport due-diligence report for up to 25 ERC-8004 agents under one hiring policy",
  async run({ spec, client }) {
    const ids = spec.agentIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 25) throw new SpecError("agentIds must be a non-empty array of at most 25 ids");
    let agentIds: bigint[];
    try {
      agentIds = ids.map((v) => toAgentId(v as string | number));
    } catch (e) {
      throw new SpecError((e as Error).message);
    }
    const policy = parsePolicy(spec.policy);
    const blockNumber = await client.publicClient.getBlockNumber({ cacheTime: 0 });
    const results = [];
    for (const id of agentIds) results.push(await client.scorecard(id, policy, { blockNumber }));
    return {
      chainId: client.deployment.chainId,
      blockNumber: blockNumber.toString(),
      policy: results[0]?.policy,
      summary: {
        agents: results.length,
        meeting: results.filter((r) => r.meets).length,
        registered: results.filter((r) => r.identity !== null).length,
      },
      results,
    };
  },
};

export const DEFAULT_SKILLS: Skill[] = [scorecardSkill];
