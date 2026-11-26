// LOCAL UI PREVIEW ONLY — not part of the demo's runtime. Starts the real demo backend (port 18891) wired to the
// in-memory fake Gateway, plus a control server on 127.0.0.1:18892 that plays the sourcing team and sends signed
// webhooks, so the UI can be exercised without a HIOBuy key.  Usage: npm run build && node test/preview-server.mjs
//   curl -X POST 'http://127.0.0.1:18892/ask?rfq=<id>&text=Which%20colour%3F'
//   curl -X POST 'http://127.0.0.1:18892/quote?rfq=<id>&options=2'
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createNodeServer } from "../server/node-host.mjs";
import { SqlStore } from "../server/store.mjs";
import { signPayload } from "../server/webhook.mjs";
import { API_KEY, createFakeGateway } from "./fake-gateway.mjs";

const SECRET = "whsec_local_preview_only_0123456789abcdef";
const gw = createFakeGateway();
const app = createNodeServer({
  env: { HIOBUY_API_KEY: API_KEY, HIOBUY_GATEWAY_ORIGIN: "https://api.hiobuy.test", HIOBUY_WEBHOOK_SECRET: SECRET, PORT: "18891" },
  fetchImpl: gw.fetchImpl, store: new SqlStore(new DatabaseSync(":memory:")),
});
const port = await app.listen();

async function deliver(type, rfq, extra = {}) {
  const body = new TextEncoder().encode(JSON.stringify({ id: "evt_" + crypto.randomUUID(), type, created_at: new Date().toISOString(), livemode: false,
    app_id: "app_demo", data: { type, rfq: { id: rfq.id, status: rfq.status, version: rfq.version }, ...extra } }));
  await fetch(`http://127.0.0.1:${port}/hooks/hiobuy`, { method: "POST", body,
    headers: { "HioBuy-Signature": await signPayload(SECRET, Math.floor(Date.now() / 1000), body) } });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://local"), rfq = gw.rfqs.get(url.searchParams.get("rfq") ?? "");
  if (req.method !== "POST" || !rfq) { res.writeHead(404).end("unknown rfq\n"); return; }
  if (url.pathname === "/ask") { gw.staff.ask(rfq.id, url.searchParams.get("text") ?? "Could you confirm the colour?"); await deliver("ask.rfq.updated", rfq); }
  else if (url.pathname === "/quote") { const q = gw.staff.quote(rfq.id, { options: Number(url.searchParams.get("options") ?? 1) }); await deliver("ask.rfq.quotation.sent", rfq, { quotation: { version: q.version } }); }
  else { res.writeHead(404).end(); return; }
  res.writeHead(200).end("ok\n");
}).listen(18892, "127.0.0.1");
process.stdout.write(`Preview backend (fake Gateway) on http://127.0.0.1:${port} · staff control on http://127.0.0.1:18892\n`);
