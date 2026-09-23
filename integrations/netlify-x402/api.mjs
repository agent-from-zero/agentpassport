// agentfromzero pay-per-call service on Netlify Functions.
//   - utility routes: x402 via Circle Gateway, USDC on Base
//   - AgentPassport routes: x402 v2 via the Monad facilitator, Circle USDC on Monad testnet
// Holds NO private key: sellers are public wallet addresses; payments are settled by facilitators.
import express from "express";
import serverless from "serverless-http";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import SwaggerParser from "@apidevtools/swagger-parser";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createPublicClient, http } from "viem";
import { AGENTFROMZERO_AGENT_ID, AgentPassportClient, MONAD_TESTNET, POLICIES, monadTestnet, toAgentId, toPolicy } from "@agentfromzero/agentpassport-sdk";
import { parse as parseCsv } from "../lib/csv.mjs";
import openapiDoc from "./openapi.json" with { type: "json" };

const SELLER = process.env.SELLER_ADDRESS || "0x6E6192B3c32215def00C62DEd4F6493dA4B8bF57";
const HOST = process.env.PUBLIC_HOST || "agentfromzero.netlify.app";
const gateway = createGatewayMiddleware({ sellerAddress: SELLER, networks: ["eip155:8453"], description: "agentfromzero utility API (AI-operated; disclosed)" });
const openapi = structuredClone(openapiDoc); openapi.servers = [{ url: `https://${HOST}` }];

// ── AgentPassport on Monad testnet ──
const MONAD = "eip155:10143";
const AGENT_WALLET = process.env.AGENT_WALLET || "0x99e6C3faE6a1EbaeD0bfFFFeB2B6443faC595A28"; // agentWallet of ERC-8004 agent 1908
const VERIFY_PRICE = "$0.001";
const monadExact = new ExactEvmScheme();
// Monad testnet USDC is not in @x402/evm's built-in asset table (docs.monad.xyz/guides/x402).
monadExact.registerMoneyParser(async (amount, network) =>
  network === MONAD ? { amount: String(Math.round(amount * 1e6)), asset: MONAD_TESTNET.usdc, extra: { name: "USDC", version: "2" } } : null);
const monadX402 = new x402ResourceServer(new HTTPFacilitatorClient({ url: "https://x402-facilitator.molandak.org" })).register(MONAD, monadExact);
const passport = new AgentPassportClient({ publicClient: createPublicClient({ chain: monadTestnet, transport: http(process.env.MONAD_TESTNET_RPC, { retryCount: 2 }), batch: { multicall: true } }) });
const verifyPaywall = paymentMiddleware({
  "POST /v1/agent/verify": {
    accepts: { scheme: "exact", price: VERIFY_PRICE, network: MONAD, payTo: AGENT_WALLET, maxTimeoutSeconds: 120 },
    description: "AgentPassport verification: meets(agentId, policy) on Monad testnet plus a rule-by-rule scorecard",
    mimeType: "application/json",
  },
}, monadX402);

/** Validates {agentId, policy} before any payment is requested: a caller never pays for a malformed query. */
function parseVerifyRequest(body) {
  const b = body && typeof body === "object" ? body : {};
  if (b.agentId === undefined) throw new Error("agentId is required");
  const agentId = toAgentId(b.agentId);
  let policy = b.policy ?? "proven";
  if (typeof policy === "string") {
    if (!(policy in POLICIES)) throw new Error(`unknown policy preset "${policy}" (use ${Object.keys(POLICIES).join(" | ")} or an object)`);
    policy = POLICIES[policy];
  } else {
    const allowed = ["minJobsSettled", "minVolumeSettled", "maxJobsDisputed", "maxAgeOfLastSettlement"];
    if (typeof policy !== "object" || Array.isArray(policy)) throw new Error("policy must be a preset name or an object");
    for (const [k, v] of Object.entries(policy)) {
      if (!allowed.includes(k)) throw new Error(`unknown policy field ${k}`);
      if (!/^\d+$/.test(String(v))) throw new Error(`policy.${k} must be a non-negative integer`);
    }
    policy = toPolicy(policy);
  }
  return { agentId, policy };
}
const jsonSafe = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

const app = express();
app.use(express.text({ type: ["text/*", "application/csv"], limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => { res.setHeader("X-Operated-By", "agentfromzero (autonomous AI agent, Claude; disclosed)"); next(); });
app.get("/", (req, res) => res.json({
  service: "agentfromzero utility API", operator: "autonomous AI agent (Claude), disclosed", openapi: "/openapi.json",
  payment: { "utilities": "x402 via Circle Gateway, USDC on Base", "agentpassport": "x402 v2 via the Monad facilitator (x402-facilitator.molandak.org), USDC on Monad testnet" },
  seller: SELLER, agentPassportPayTo: AGENT_WALLET,
  endpoints: { "/v1/csv2json": "$0.005", "/v1/json2csv": "$0.005", "/v1/openapi/validate": "$0.01", "POST /v1/agent/verify": `${VERIFY_PRICE} (Monad testnet USDC)`, "GET /v1/agent/{agentId}": "free" },
  agentCard: "/.well-known/agent-card.json", agentPassport: "/agentpassport/",
}));
app.get("/health", (req, res) => res.json({ ok: true, t: Date.now(), host: HOST }));
app.get("/openapi.json", (req, res) => res.json(openapi));
app.post("/v1/csv2json", gateway.require("$0.005"), (req, res) => {
  const text = typeof req.body === "string" ? req.body : (req.body?.csv ?? "");
  if (!text.trim()) return res.status(400).json({ error: "send CSV as text/csv body or {\"csv\": \"...\"}" });
  try { res.json(parseCsv(text, { header: req.query.header !== "0", infer: req.query.infer === "1" })); }
  catch (e) { res.status(422).json({ error: String(e.message || e) }); }
});
app.post("/v1/json2csv", gateway.require("$0.005"), (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : req.body?.rows;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: "send a JSON array of objects (or {\"rows\": [...]})" });
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const esc = v => { const s = v == null ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  res.type("text/csv").send([cols.join(","), ...rows.map(r => cols.map(c => esc(r[c])).join(","))].join("\r\n"));
});
app.post("/v1/openapi/validate", gateway.require("$0.01"), async (req, res) => {
  const doc = req.body;
  try {
    const api = await SwaggerParser.validate(typeof doc === "string" ? JSON.parse(doc) : structuredClone(doc));
    const paths = Object.keys(api.paths || {});
    const ops = paths.flatMap(p => Object.keys(api.paths[p]).filter(m => ["get","post","put","patch","delete","head","options"].includes(m)).map(m => `${m.toUpperCase()} ${p}`));
    res.json({ valid: true, version: api.openapi || api.swagger, title: api.info?.title, paths: paths.length, operations: ops.length, operationList: ops.slice(0, 500) });
  } catch (e) { res.status(200).json({ valid: false, error: String(e.message || e).slice(0, 4000) }); }
});

// Free: raw passport + the `proven` verdict. Enough to decide "has this agent ever been paid through escrow?"
app.get("/v1/agent/:agentId", async (req, res) => {
  let agentId;
  try { agentId = toAgentId(req.params.agentId); } catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    const [p, proven] = await Promise.all([passport.getPassport(agentId), passport.meets(agentId, POLICIES.proven)]);
    res.json(jsonSafe({ agentId, chainId: MONAD_TESTNET.chainId, agentPassport: MONAD_TESTNET.agentPassport, passport: p, meetsProven: proven, fullScorecard: "POST /v1/agent/verify (x402, $0.001 USDC on Monad testnet)" }));
  } catch (e) { res.status(502).json({ error: "Monad RPC error", detail: String(e.shortMessage || e.message || e).slice(0, 300) }); }
});

// Paid: the full scorecard for any policy. Validation runs before the paywall; the RPC read runs
// after payment verification, and settlement only happens if we answer 200 (errors are not charged).
app.post("/v1/agent/verify", (req, res, next) => {
  try { req.verify = parseVerifyRequest(req.body); next(); }
  catch (e) { res.status(400).json({ error: e.message, example: { agentId: String(AGENTFROMZERO_AGENT_ID), policy: { minJobsSettled: 1, maxJobsDisputed: 0 } } }); }
}, verifyPaywall, async (req, res) => {
  try {
    const card = await passport.scorecard(req.verify.agentId, req.verify.policy);
    res.json({ ...card, verifiedBy: "agentfromzero (ERC-8004 agent 1908, AI; disclosed)", contracts: { agentPassport: MONAD_TESTNET.agentPassport, jobEscrow: MONAD_TESTNET.jobEscrow, reputationRegistry: MONAD_TESTNET.reputationRegistry } });
  } catch (e) { res.status(502).json({ error: "Monad RPC error (not charged)", detail: String(e.shortMessage || e.message || e).slice(0, 300) }); }
});

export { app };
export const handler = serverless(app);
