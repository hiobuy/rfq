// Local Node host: serves the built UI (dist/) and the shared handler on one origin.
//   npm run build && npm start        -> http://127.0.0.1:18891
//   npm run dev  (Vite on :18890 proxies /api and /hooks to this host)
// Configuration: environment variables or a git-ignored .dev.vars file (KEY=VALUE lines).
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createHandler } from "./handler.mjs";
import { SqlStore } from "./store.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadDevVars(file = path.join(ROOT, ".dev.vars")) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

/** DEMO_MODE defaults to on; only "false", "0" or "off" turn it off. */
export const demoModeOf = (value) => !["false", "0", "off"].includes(String(value ?? "true").trim().toLowerCase());

export function nodeStore(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "rfq-demo.sqlite");
  if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
  chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;");
  return new SqlStore(db);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json" };
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function serveStatic(dist, pathname, res) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.resolve(dist, rel);
  if (!file.startsWith(dist + path.sep) || !existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Content-Security-Policy": CSP,
    "Cache-Control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store",
  });
  res.end(readFileSync(file));
  return true;
}

export function createNodeServer({ env = { ...loadDevVars(), ...process.env }, fetchImpl, store } = {}) {
  const port = Number(env.PORT ?? 18891);
  // Local default: the Vite dev UI (18890) and this host (18891) are both allowed origins.
  const publicOrigin = env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
  const allowedOrigins = env.PUBLIC_ORIGIN ? [env.PUBLIC_ORIGIN] : [publicOrigin, "http://127.0.0.1:18890"];
  const handle = createHandler({
    config: {
      apiKey: env.HIOBUY_API_KEY, gatewayOrigin: env.HIOBUY_GATEWAY_ORIGIN ?? "https://api.hiobuy.com",
      webhookSecret: env.HIOBUY_WEBHOOK_SECRET, publicOrigin, allowedOrigins, secureCookies: publicOrigin.startsWith("https://"),
      refPrefix: env.DEMO_REF_PREFIX ?? "demo-", demoMode: demoModeOf(env.DEMO_MODE), fetchImpl,
    },
    store: store ?? nodeStore(path.join(ROOT, ".local", "state")),
  });
  const dist = path.join(ROOT, "dist");
  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 180_000 }, async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");
      const isApi = url.pathname.startsWith("/api/") || url.pathname === "/hooks/hiobuy" || url.pathname === "/health";
      if (!isApi) {
        if (["GET", "HEAD"].includes(req.method ?? "") && (serveStatic(dist, url.pathname, res) || serveStatic(dist, "/", res))) return;
        res.writeHead(404).end();
        return;
      }
      const request = new Request(new URL(url.pathname + url.search, publicOrigin), {
        method: req.method, headers: req.headers,
        ...(["GET", "HEAD"].includes(req.method ?? "") ? {} : { body: Readable.toWeb(req), duplex: "half" }),
      });
      const response = await handle(request, { clientIp: req.socket.remoteAddress ?? "local" });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
    } catch {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":{"code":"INTERNAL_ERROR","message":"Request failed."}}');
    }
  });
  return {
    server,
    listen: () => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createNodeServer();
  const port = await app.listen();
  process.stdout.write(`RFQ demo backend on http://127.0.0.1:${port}\n`);
}
