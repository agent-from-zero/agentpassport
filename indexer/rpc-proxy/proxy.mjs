// Rate-limited, caching JSON-RPC proxy for indexing Monad testnet from free public RPCs.
//
// Why: HyperIndex's RPC source runs up to 100 queries in parallel. Free public endpoints answer
// that with HTTP 429 and HyperIndex backs off per query, so a sync that needs ~1,200 requests
// crawls for hours. This proxy queues every call behind a per-upstream token bucket, retries
// 429/5xx itself (HyperIndex never sees them), routes wide eth_getLogs ranges only to upstreams
// that accept them, and caches responses that can never change (blocks / transactions / receipts
// by number or hash, and logs of ranges well behind the head).
//
//   UPSTREAMS="https://10143.rpc.thirdweb.com|4|1000,https://testnet-rpc.monad.xyz|12|100"
//             (url|requests per second|max eth_getLogs block range), tried in order of fit
//   PORT=8545  CACHE_MAX=50000  FINALITY=64 (blocks behind head before a getLogs range is cached)
//
// No dependencies: node >= 20.
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8545);
const CACHE_MAX = Number(process.env.CACHE_MAX ?? 50_000);
const FINALITY = BigInt(process.env.FINALITY ?? 64);
const UPSTREAMS = (process.env.UPSTREAMS ?? "https://10143.rpc.thirdweb.com|4|1000,https://testnet-rpc.monad.xyz|12|100")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [url, rps = "5", maxRange = "100"] = s.split("|");
    return { url, rps: Number(rps), maxRange: BigInt(maxRange), next: 0, inFlight: 0, ok: 0, errors: 0 };
  });

const stats = { requests: 0, cacheHits: 0, upstreamCalls: 0, retries: 0 };
const cache = new Map();
let head = 0n;
let headAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexToBig = (h) => (typeof h === "string" && /^0x[0-9a-f]+$/i.test(h) ? BigInt(h) : null);

function cacheGet(key) {
  const v = cache.get(key);
  if (v === undefined) return undefined;
  cache.delete(key); // LRU: re-insert as most recent
  cache.set(key, v);
  return v;
}
function cachePut(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/** Token bucket: returns once this upstream may be called again. */
async function takeSlot(u) {
  const gap = 1000 / u.rps;
  const now = Date.now();
  const at = Math.max(now, u.next);
  u.next = at + gap;
  if (at > now) await sleep(at - now);
}

/** getLogs range width (null when the call is not a bounded eth_getLogs). */
function logsRange(call) {
  if (call.method !== "eth_getLogs") return null;
  const f = call.params?.[0] ?? {};
  if (f.blockHash) return 0n;
  const from = hexToBig(f.fromBlock);
  const to = hexToBig(f.toBlock);
  return from !== null && to !== null ? to - from + 1n : null;
}

/** A cache key for results that can never change, or null. */
function immutableKey(call) {
  const p = call.params ?? [];
  switch (call.method) {
    case "eth_chainId":
      return "chainId";
    case "eth_getBlockByNumber": {
      // Only blocks safely behind the head: a block at the tip could still be replaced.
      const n = hexToBig(p[0]);
      return n !== null && head > 0n && n + FINALITY < head ? `b:${p[0]}:${!!p[1]}` : null;
    }
    case "eth_getBlockByHash":
      return `bh:${p[0]}:${!!p[1]}`;
    case "eth_getTransactionByHash":
    case "eth_getTransactionReceipt":
      return `${call.method}:${p[0]}`;
    case "eth_getLogs": {
      const to = hexToBig(p[0]?.toBlock);
      if (p[0]?.blockHash) return `l:${JSON.stringify(p[0])}`;
      return to !== null && head > 0n && to + FINALITY < head ? `l:${JSON.stringify(p[0])}` : null;
    }
    default:
      return null;
  }
}

async function upstreamCall(u, call) {
  u.inFlight++;
  stats.upstreamCalls++;
  try {
    const res = await fetch(u.url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "agentpassport-rpc-proxy/0.1" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: call.method, params: call.params ?? [] }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) return { retry: true, why: `HTTP ${res.status}` };
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { retry: true, why: `non-JSON (${res.status}): ${text.slice(0, 80)}` };
    }
    // Rate-limit / capacity errors come back as JSON-RPC errors on some providers.
    if (body.error && /rate|limit exceeded|too many|capacity|timeout/i.test(body.error.message ?? "") && !/range|block/i.test(body.error.message ?? "")) {
      return { retry: true, why: body.error.message };
    }
    return { body };
  } catch (e) {
    return { retry: true, why: String(e?.message ?? e) };
  } finally {
    u.inFlight--;
  }
}

async function forward(call) {
  const range = logsRange(call);
  const fit = UPSTREAMS.filter((u) => range === null || range <= u.maxRange);
  if (fit.length === 0) {
    const max = UPSTREAMS.reduce((m, u) => (u.maxRange > m ? u.maxRange : m), 0n);
    return { jsonrpc: "2.0", id: call.id, error: { code: -32602, message: `eth_getLogs is limited to a ${max} range` } };
  }
  for (let attempt = 0; ; attempt++) {
    // Least-loaded upstream by next free slot.
    const u = fit.reduce((a, b) => (b.next < a.next ? b : a));
    await takeSlot(u);
    const r = await upstreamCall(u, call);
    if (!r.retry) {
      u.ok++;
      return { ...r.body, id: call.id };
    }
    u.errors++;
    stats.retries++;
    u.next = Math.max(u.next, Date.now() + Math.min(500 * 2 ** attempt, 8000));
    if (attempt >= 12) return { jsonrpc: "2.0", id: call.id, error: { code: -32603, message: `upstreams failing: ${r.why}` } };
  }
}

async function handle(call) {
  stats.requests++;
  if (call.method === "eth_blockNumber" && Date.now() - headAt < 400 && head > 0n) {
    return { jsonrpc: "2.0", id: call.id, result: "0x" + head.toString(16) };
  }
  const key = immutableKey(call);
  if (key) {
    const hit = cacheGet(key);
    if (hit !== undefined) {
      stats.cacheHits++;
      return { jsonrpc: "2.0", id: call.id, result: hit };
    }
  }
  const out = await forward(call);
  if (call.method === "eth_blockNumber" && out.result) {
    const h = hexToBig(out.result);
    if (h !== null && h > head) head = h;
    headAt = Date.now();
  }
  // Never cache nulls (a block/tx the upstream has not seen yet).
  if (key && out.result !== undefined && out.result !== null && !out.error) cachePut(key, out.result);
  return out;
}

const server = http.createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, head: head.toString(), cacheSize: cache.size, ...stats, upstreams: UPSTREAMS.map(({ url, rps, maxRange, ok, errors, inFlight }) => ({ url, rps, maxRange: maxRange.toString(), ok, errors, inFlight })) }));
    return;
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      return;
    }
    const out = Array.isArray(payload) ? await Promise.all(payload.map(handle)) : await handle(payload);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
});
server.listen(PORT, () => console.log(`rpc-proxy on :${PORT} -> ${UPSTREAMS.map((u) => `${u.url} (${u.rps}/s, getLogs<=${u.maxRange})`).join(", ")}`));
