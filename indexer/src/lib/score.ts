/**
 * AgentPassport index score, v1: a deterministic 0-100 summary of an agent's escrow-backed record.
 *
 * Only facts that cost money to create count: settled / refunded / disputed escrow jobs and who
 * paid for them. ERC-8004 feedback that is not escrow-backed is reported next to the score but
 * never raises it, so a wallet farm that posts feedback cannot move it.
 *
 *   activity     up to 30   6 per settled job
 *   volume       up to 15   5 per order of magnitude of settled USDC (log10(usd + 1) * 5)
 *   diversity    up to 20   5 per distinct paying hirer
 *   repeat       up to 10   5 per hirer that came back and paid again
 *   reliability  up to 25   25 * settled / closed jobs
 *   disputes     -15 each
 *   concentration: one paying hirer caps the score at 50; a top hirer above 80% of volume costs 10
 *
 * The on-chain `AgentPassport.meets(agentId, policy)` stays authoritative for hard policy checks;
 * this score is an index-side ranking signal and is recomputed from the aggregates on every change.
 */
export const SCORE_VERSION = 1;

export interface ScoreInput {
  jobsSettled: number;
  jobsRefunded: number;
  jobsDisputed: number;
  /** Settled volume in the token's smallest unit. */
  volumeSettled: bigint;
  /** Token decimals (Circle USDC = 6). */
  decimals?: number;
  settledHirers: number;
  repeatHirers: number;
  /** Largest single hirer's share of settled volume, basis points. */
  topHirerShareBps: number;
}

export interface ScoreBreakdown {
  score: number;
  activity: number;
  volume: number;
  diversity: number;
  repeat: number;
  reliability: number;
  disputePenalty: number;
  concentrationPenalty: number;
  cappedAt: number | null;
}

export function scoreBreakdown(i: ScoreInput): ScoreBreakdown {
  const closed = i.jobsSettled + i.jobsRefunded + i.jobsDisputed;
  const zero: ScoreBreakdown = {
    score: 0, activity: 0, volume: 0, diversity: 0, repeat: 0, reliability: 0,
    disputePenalty: 0, concentrationPenalty: 0, cappedAt: null,
  };
  if (closed === 0) return zero;
  const decimals = i.decimals ?? 6;
  // Whole units are enough precision for a log scale and keep the math in safe integers.
  const units = Number(i.volumeSettled / 10n ** BigInt(decimals));
  const activity = Math.min(30, i.jobsSettled * 6);
  const volume = Math.min(15, Math.floor(Math.log10(units + 1) * 5));
  const diversity = Math.min(20, i.settledHirers * 5);
  const repeat = Math.min(10, i.repeatHirers * 5);
  const reliability = Math.floor((25 * i.jobsSettled) / closed);
  const disputePenalty = 15 * i.jobsDisputed;
  const concentrationPenalty = i.settledHirers > 1 && i.topHirerShareBps > 8000 ? 10 : 0;
  let score = activity + volume + diversity + repeat + reliability - disputePenalty - concentrationPenalty;
  let cappedAt: number | null = null;
  if (i.settledHirers <= 1 && score > 50) {
    score = 50;
    cappedAt = 50;
  }
  score = Math.max(0, Math.min(100, score));
  return { score, activity, volume, diversity, repeat, reliability, disputePenalty, concentrationPenalty, cappedAt };
}

export function computeScore(i: ScoreInput): number {
  return scoreBreakdown(i).score;
}
