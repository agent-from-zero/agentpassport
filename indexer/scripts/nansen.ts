// Nansen wallet intelligence for AgentPassport counterparties (hirers, agent owners).
//
// Three Nansen API calls per address, 1 credit each on the free plan:
//   POST /api/v1/profiler/address/first-funder      who first sent this wallet gas, with Nansen's label
//   POST /api/v1/profiler/address/current-balance   balances on every Nansen chain (economic footprint)
//   POST /api/v1/profiler/address/related-wallets   wallets Nansen relates to it on Monad (hirers only)
// Results are cached on disk (the free plan tops up to 10 credits a day), empty answers included:
// "Nansen has never seen this wallet" is itself the signal for a fresh testnet-only hirer.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CounterpartyIntel } from "../../sdk/src/trust-index.ts";

const BASE = "https://api.nansen.ai/api/v1";
/** Label words that make a counterparty a risk flag (checked on the funder and related-wallet labels). */
const RISK = /tornado|mixer|exploit|hack|scam|phish|drainer|sanction|ofac|rug/i;

export interface NansenOptions {
  apiKey: string;
  cacheFile: string;
  /** Upper bound on credits this run may spend. */
  maxCredits: number;
  /** Re-query a cached address after this many days. */
  ttlDays: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

type Cache = Record<string, CounterpartyIntel>;

export class NansenIntel {
  private cache: Cache;
  private readonly o: NansenOptions;
  spent = 0;
  creditsRemaining: number | null = null;
  constructor(o: NansenOptions) {
    this.o = o;
    this.cache = existsSync(o.cacheFile) ? (JSON.parse(readFileSync(o.cacheFile, "utf8")) as Cache) : {};
  }

  get profiled(): Cache {
    return this.cache;
  }

  save(): void {
    writeFileSync(this.o.cacheFile, JSON.stringify(this.cache, null, 2) + "\n");
  }

  /** Cached profile, refreshed when stale and the credit budget allows. `withRelated` costs one more credit. */
  async profile(address: string, withRelated: boolean): Promise<CounterpartyIntel | null> {
    const key = address.toLowerCase();
    const hit = this.cache[key];
    const fresh = hit && Date.now() - Date.parse(hit.fetchedAt) < this.o.ttlDays * 86_400_000;
    const need = withRelated ? 3 : 2;
    if (fresh) return hit;
    if (this.spent + need > this.o.maxCredits) {
      this.o.log?.(`nansen: budget reached, keeping ${hit ? "stale" : "no"} profile for ${key}`);
      return hit ?? null;
    }
    const [funder, balances, related] = await Promise.all([
      this.call<FirstFunderRow>("profiler/address/first-funder", { address: key }),
      this.call<BalanceRow>("profiler/address/current-balance", { address: key, chain: "all", hide_spam_token: true, pagination: { page: 1, per_page: 50 } }),
      withRelated ? this.call<RelatedRow>("profiler/address/related-wallets", { address: key, chain: "monad", pagination: { page: 1, per_page: 25 } }) : Promise.resolve([]),
    ]);
    const intel = toIntel(key, funder, balances, related, new Date().toISOString());
    this.cache[key] = intel;
    return intel;
  }

  private async call<T>(path: string, body: unknown): Promise<T[]> {
    const f = this.o.fetchImpl ?? fetch;
    for (let attempt = 0; ; attempt++) {
      const res = await f(`${BASE}/${path}`, {
        method: "POST",
        headers: { apikey: this.o.apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const cost = Number(res.headers.get("x-nansen-credits-cost") ?? 0);
      const left = res.headers.get("x-nansen-credits-remaining");
      this.spent += cost;
      if (left !== null) this.creditsRemaining = Number(left);
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`nansen ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { data?: T[] };
      return json.data ?? [];
    }
  }
}

interface FirstFunderRow {
  first_funder_address?: string;
  first_funder_name?: string | null;
  transaction_hash?: string | null;
  block_timestamp?: string | null;
  chain?: string;
}
interface BalanceRow {
  chain?: string;
  value_usd?: number | null;
}
interface RelatedRow {
  address?: string;
  address_label?: string | null;
  relation?: string;
  chain?: string;
}

/** Raw Nansen rows -> the profile the trust index consumes. Pure; unit-tested. */
export function toIntel(address: string, funder: FirstFunderRow[], balances: BalanceRow[], related: RelatedRow[], fetchedAt: string): CounterpartyIntel {
  const f = funder.find((r) => r.first_funder_address);
  const firstFunder = f
    ? { address: f.first_funder_address!.toLowerCase(), name: f.first_funder_name ?? null, chain: f.chain ?? "unknown", tx: f.transaction_hash ?? null, at: f.block_timestamp ?? null }
    : null;
  const footprintUsd = Math.round(balances.reduce((s, b) => s + (Number(b.value_usd) || 0), 0) * 100) / 100;
  const chains = [...new Set(balances.filter((b) => (Number(b.value_usd) || 0) > 0 && b.chain).map((b) => b.chain!))].sort();
  const rel = related
    .filter((r) => r.address)
    .map((r) => ({ address: r.address!.toLowerCase(), label: r.address_label ?? null, relation: r.relation ?? "related", chain: r.chain ?? "monad" }));
  const labels = [firstFunder?.name, ...rel.map((r) => r.label)].filter((x): x is string => !!x);
  const flags = [...new Set(labels.flatMap((l) => (RISK.test(l) ? [l.match(RISK)![0].toLowerCase()] : [])))];
  return {
    address,
    firstFunder,
    footprintUsd,
    chains,
    related: rel,
    flags,
    visible: !!firstFunder || footprintUsd > 0 || rel.length > 0,
    fetchedAt,
  };
}
