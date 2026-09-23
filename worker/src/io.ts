// Spec retrieval and deliverable publication. Both are content-addressed: a spec is accepted only
// if keccak256(bytes) equals the specHash the hirer locked into the escrow, and a deliverable is
// committed on chain only after the public URL is confirmed to serve the exact bytes that were hashed.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashContent } from "@agentfromzero/agentpassport-sdk";
import type { Hex } from "viem";

export interface ResolvedSpec {
  source: string;
  bytes: Uint8Array;
  json: Record<string, unknown>;
}

/**
 * Looks for `<base>/<specHash>.json` in each base (an https URL or a local directory) and returns
 * the first copy whose keccak256 matches. Mismatching copies are reported through `onReject`.
 */
export async function resolveSpec(
  specHash: Hex,
  bases: string[],
  opts: { fetch?: typeof fetch; onReject?: (source: string, reason: string) => void } = {},
): Promise<ResolvedSpec | null> {
  const doFetch = opts.fetch ?? fetch;
  for (const base of bases) {
    const source = `${base.replace(/\/+$/, "")}/${specHash}.json`;
    let bytes: Uint8Array;
    try {
      if (/^https?:\/\//.test(base)) {
        const res = await doFetch(source, { headers: { accept: "application/json" } });
        if (!res.ok) {
          opts.onReject?.(source, `HTTP ${res.status}`);
          continue;
        }
        bytes = new Uint8Array(await res.arrayBuffer());
      } else {
        bytes = readFileSync(source);
      }
    } catch (e) {
      opts.onReject?.(source, (e as Error).message);
      continue;
    }
    const got = hashContent(bytes);
    if (got !== specHash) {
      opts.onReject?.(source, `hash mismatch: ${got}`);
      continue;
    }
    try {
      const json = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("spec is not a JSON object");
      return { source, bytes, json };
    } catch (e) {
      opts.onReject?.(source, `invalid JSON: ${(e as Error).message}`);
    }
  }
  return null;
}

export interface Publisher {
  /** Makes `bytes` publicly retrievable and returns the URL that serves exactly these bytes. */
  publish(jobId: bigint, bytes: Uint8Array): Promise<string>;
}

export interface DirPublisherOptions {
  dir: string;
  baseUrl: string;
  deployCmd?: string;
  fetch?: typeof fetch;
  verifyTimeoutMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Writes `<dir>/jobs/<jobId>/deliverable.json`, optionally runs a deploy command (e.g. a static-site
 * deploy), then polls `<baseUrl>/jobs/<jobId>/deliverable.json` until it serves identical bytes.
 */
export class DirPublisher implements Publisher {
  private readonly opts: DirPublisherOptions;

  constructor(opts: DirPublisherOptions) {
    this.opts = opts;
  }

  async publish(jobId: bigint, bytes: Uint8Array): Promise<string> {
    const rel = `jobs/${jobId}/deliverable.json`;
    mkdirSync(join(this.opts.dir, "jobs", String(jobId)), { recursive: true });
    writeFileSync(join(this.opts.dir, rel), bytes);
    if (this.opts.deployCmd) {
      this.opts.log?.("deploy", { cmd: this.opts.deployCmd.replace(/\s.*/, " …") });
      execSync(this.opts.deployCmd, { stdio: "ignore", timeout: 10 * 60_000 });
    }
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/${rel}`;
    const want = hashContent(bytes);
    const doFetch = this.opts.fetch ?? fetch;
    const deadline = Date.now() + (this.opts.verifyTimeoutMs ?? 120_000);
    let last = "";
    while (Date.now() < deadline) {
      try {
        const res = await doFetch(url, { cache: "no-store" });
        if (res.ok) {
          const got = hashContent(new Uint8Array(await res.arrayBuffer()));
          if (got === want) return url;
          last = `served hash ${got}`;
        } else last = `HTTP ${res.status}`;
      } catch (e) {
        last = (e as Error).message;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`published deliverable not served at ${url} (${last})`);
  }
}
