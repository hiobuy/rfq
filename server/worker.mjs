// Cloudflare Worker entry. Static UI from the ASSETS binding; API and webhook in one Durable Object with private
// SQLite, following the Supplier Inquiry demo. Secrets: HIOBUY_API_KEY, HIOBUY_WEBHOOK_SECRET.
// Optional service binding HIOBUY_GATEWAY: required when the demo runs on the same Cloudflare zone as the Gateway.
import { DurableObject } from "cloudflare:workers";
import { createHandler, json } from "./handler.mjs";
import { SqlStore } from "./store.mjs";

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function config(env) {
  const gateway = env.HIOBUY_GATEWAY;
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (origin.origin !== env.PUBLIC_ORIGIN || origin.protocol !== "https:") throw new Error("Invalid PUBLIC_ORIGIN");
  if (typeof env.HIOBUY_API_KEY !== "string" || env.HIOBUY_API_KEY.length < 16) throw new Error("Missing credential");
  return {
    apiKey: env.HIOBUY_API_KEY, gatewayOrigin: env.HIOBUY_GATEWAY_ORIGIN || "https://api.hiobuy.com",
    webhookSecret: env.HIOBUY_WEBHOOK_SECRET, publicOrigin: origin.origin, secureCookies: true,
    refPrefix: env.DEMO_REF_PREFIX || "demo-",
    demoMode: !["false", "0", "off"].includes(String(env.DEMO_MODE ?? "true").trim().toLowerCase()),
    ...(gateway ? { fetchImpl: (url, init) => gateway.fetch(new Request(url, init)) } : {}),
  };
}

function durableStore(storage) {
  const sql = storage.sql;
  const db = {
    exec(query) { sql.exec(query).toArray(); },
    prepare(query) {
      return {
        get: (...args) => sql.exec(query, ...args).toArray()[0],
        all: (...args) => sql.exec(query, ...args).toArray(),
        run: (...args) => { sql.exec(query, ...args).toArray(); return { changes: sql.exec("SELECT changes() AS c").one().c }; },
      };
    },
  };
  return new SqlStore(db, { transaction: (fn) => storage.transactionSync(fn) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const secure = (response) => {
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", CSP);
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("X-Frame-Options", "DENY");
      return new Response(response.body, { status: response.status, headers });
    };
    try {
      const cfg = config(env);
      if (url.origin !== cfg.publicOrigin) return json({ error: { code: "INVALID_HOST", message: "Invalid host." } }, 421);
      if (url.pathname.startsWith("/api/") || url.pathname === "/hooks/hiobuy" || url.pathname === "/health")
        return env.DEMO_STATE.getByName("rfq-demo").fetch(request);
      return secure(await env.ASSETS.fetch(request));
    } catch {
      return json({ error: { code: "DEMO_NOT_CONFIGURED", message: "The demo is temporarily unavailable." } }, 503);
    }
  },
};

export class DemoState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = durableStore(ctx.storage);
    this.handle = createHandler({ config: config(env), store: this.store });
    this.nextPurge = 0;
  }
  async fetch(request) {
    if (Date.now() >= this.nextPurge) { this.nextPurge = Date.now() + 60_000; this.store.purge(); }
    return this.handle(request, { clientIp: request.headers.get("cf-connecting-ip") ?? "unknown" });
  }
}
