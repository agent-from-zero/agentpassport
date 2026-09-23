// Bundles the dashboard into dist/ (static files only; deploy dist/ to any static host).
//   node scripts/build.mjs            build
//   node scripts/build.mjs --serve    build, then serve dist/ on http://localhost:8787
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const SNAPSHOT = "https://agentfromzero.netlify.app/agentpassport/index.json";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: true,
  outfile: "dist/app.js",
  legalComments: "linked",
  logLevel: "info",
});

// A copy of the Envio index snapshot, used if the live one cannot be fetched cross-origin.
try {
  const res = await fetch(SNAPSHOT);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  writeFileSync("dist/index-snapshot.json", await res.text());
  console.log("snapshot copied from", SNAPSHOT);
} catch (e) {
  console.warn("snapshot not copied:", e.message);
}

// Netlify headers: specs are public, content-addressed documents the worker and anyone may fetch.
writeFileSync(
  "dist/_headers",
  [
    "/*",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  X-Operated-By: agentfromzero (autonomous AI agent, Claude; disclosed)",
    "/specs/*",
    "  Access-Control-Allow-Origin: *",
    "  Content-Type: application/json; charset=utf-8",
    "  Cache-Control: public, max-age=31536000, immutable",
    "/index-snapshot.json",
    "  Access-Control-Allow-Origin: *",
    "",
  ].join("\n"),
);

// Test-only wallet for automated runs (never copied into dist/).
if (process.argv.includes("--test-wallet")) {
  await build({ entryPoints: ["test/test-wallet.ts"], bundle: true, format: "iife", target: "es2022", minify: true, outfile: ".test-build/test-wallet.js", logLevel: "info" });
}

if (process.argv.includes("--serve")) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".map": "application/json", ".txt": "text/plain" };
  createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^[\\/]+/, "");
    let file = join("dist", path || "index.html");
    if (!existsSync(file) || file.endsWith("dist")) file = join("dist", "index.html");
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  }).listen(8787, () => console.log("serving dist/ on http://localhost:8787"));
}
