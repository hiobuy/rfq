import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHandler } from "../server/handler.mjs";
import { SqlStore } from "../server/store.mjs";
import { signPayload } from "../server/webhook.mjs";
import { API_KEY, createFakeGateway } from "./fake-gateway.mjs";

const ORIGIN = "http://127.0.0.1:18891";
const SECRET = "whsec_demo_test_secret_0123456789abcdef";
const REQ = { title: "Silicone phone case", quantity: 500, unit: "pcs", destination: "Germany", specs: "Matte black, iPhone 15" };

function setup({ webhookSecret = SECRET, apiKey = API_KEY, demoMode } = {}) {
  const gw = createFakeGateway();
  const store = new SqlStore(new DatabaseSync(":memory:"));
  const handle = createHandler({ config: { apiKey, gatewayOrigin: "https://api.hiobuy.test", webhookSecret, publicOrigin: ORIGIN,
    secureCookies: false, refPrefix: "demo-", demoMode, fetchImpl: gw.fetchImpl }, store });
  return { gw, store, handle };
}

/** A browser-like visitor: keeps its cookie and CSRF token. */
async function visitor(handle, ip = "10.0.0.1") {
  const res = await handle(new Request(ORIGIN + "/api/session"), { clientIp: ip });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie").split(";")[0], session = await res.json();
  const req = async (method, path, body, headers = {}) => {
    const init = { method, headers: { cookie, origin: ORIGIN, "x-csrf-token": session.csrf_token, ...headers } };
    if (body instanceof Uint8Array) init.body = body;
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json"; }
    const r = await handle(new Request(ORIGIN + path, init), { clientIp: ip });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, headers: r.headers, body: type.startsWith("application/json") ? await r.json() : new Uint8Array(await r.arrayBuffer()) };
  };
  return { session, cookie, req };
}

test("session bootstrap returns identity and CSRF, never the key", async () => {
  const { handle } = setup();
  const res = await handle(new Request(ORIGIN + "/api/session"));
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie"), /^rfq_sid=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax/);
  const body = JSON.parse(text);
  assert.equal(body.app.ok, true);
  assert.deepEqual(body.app.rfq, { enabled: true, read: true, write: true, webhook_configured: true });
  assert.ok(!text.includes(API_KEY));
});

test("create, read, list: external_user_id and prefixed reference are set server-side", async () => {
  const { gw, handle } = setup();
  const a = await visitor(handle);
  const created = await a.req("POST", "/api/rfqs", { requirement: REQ, your_ref: "PO-1001", external_user_id: "spoofed" });
  assert.equal(created.status, 201);
  const sent = gw.calls.find((c) => c.method === "POST" && c.path === "/v1/ask/rfqs");
  assert.ok(sent.headers["idempotency-key"]);
  const stored = gw.rfqs.get(created.body.data.id);
  assert.match(stored.external_user_id, /^demo_[0-9a-f]{20}$/);
  assert.match(stored.external_ref, /^demo-[0-9a-f]{6}-PO-1001$/);
  assert.equal(created.body.data.your_ref, "PO-1001");
  assert.equal(created.body.data.external_user_id, undefined);
  const list = await a.req("GET", "/api/rfqs");
  assert.deepEqual(list.body.data.map((r) => r.id), [created.body.data.id]);
  const detail = await a.req("GET", `/api/rfqs/${created.body.data.id}`);
  assert.equal(detail.body.data.number, stored.number);
});

test("visitors are isolated: another visitor gets 404 for RFQs, images and messages", async () => {
  const { gw, handle } = setup();
  const a = await visitor(handle, "10.0.0.1"), b = await visitor(handle, "10.0.0.2");
  const { body } = await a.req("POST", "/api/rfqs", { requirement: REQ });
  const id = body.data.id;
  const img = await a.req("POST", `/api/rfqs/${id}/attachments`, new Uint8Array([1, 2, 3]), { "content-type": "image/png", "x-rfq-version": "1", "x-image-filename": "a.png" });
  assert.equal(img.status, 201);
  const staffImage = gw.staff.staffImage(id);
  await a.req("GET", `/api/rfqs/${id}/messages`);
  for (const path of [`/api/rfqs/${id}`, `/api/rfqs/${id}/messages`, `/api/rfqs/${id}/quotations`,
    `/api/rfqs/${id}/attachments/${img.body.data.id}/content`, `/api/attachments/${staffImage}/content`])
    assert.equal((await b.req("GET", path)).status, 404, path);
  assert.equal((await b.req("POST", `/api/rfqs/${id}/cancel`, { version: 2 })).status, 404);
  assert.deepEqual((await b.req("GET", "/api/rfqs")).body.data, []);
  assert.equal((await a.req("GET", `/api/attachments/${staffImage}/content`)).status, 200);
});

test("CSRF and origin are required for writes; sessions are required for the API", async () => {
  const { handle } = setup();
  const a = await visitor(handle);
  const noToken = await a.req("POST", "/api/rfqs", { requirement: REQ }, { "x-csrf-token": "wrong" });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.body.error.code, "INVALID_CSRF");
  const foreign = await a.req("POST", "/api/rfqs", { requirement: REQ }, { origin: "https://evil.example" });
  assert.equal(foreign.body.error.code, "INVALID_ORIGIN");
  const anon = await handle(new Request(ORIGIN + "/api/rfqs"));
  assert.equal(anon.status, 401);
});

test("requirement edit records history and passes version conflicts through", async () => {
  const { handle } = setup();
  const a = await visitor(handle);
  const id = (await a.req("POST", "/api/rfqs", { requirement: REQ })).body.data.id;
  const ok = await a.req("PATCH", `/api/rfqs/${id}/requirement`, { version: 1, requirement: { quantity: 800 }, note: "More units" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.req_version, 2);
  assert.deepEqual(ok.body.history, [{ version: 2, changed: [{ field: "quantity", from: 500, to: 800 }], note: "More units", at: ok.body.data.updated_at }]);
  const stale = await a.req("PATCH", `/api/rfqs/${id}/requirement`, { version: 1, requirement: { quantity: 900 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");
  const none = await a.req("PATCH", `/api/rfqs/${id}/requirement`, { version: 2, requirement: { quantity: 800 } });
  assert.equal(none.body.error.code, "NO_CHANGES");
});

test("answer a clarification, then decide on quotations (revision, expiry, multi-option acceptance)", async () => {
  const { gw, handle } = setup();
  const a = await visitor(handle);
  const id = (await a.req("POST", "/api/rfqs", { requirement: REQ })).body.data.id;
  const q = gw.staff.ask(id, "Which colour?");
  let rfq = (await a.req("GET", `/api/rfqs/${id}`)).body.data;
  assert.equal(rfq.status, "awaiting_clarification");
  rfq = (await a.req("POST", `/api/rfqs/${id}/answers`, { version: rfq.version, question_id: q.id, text: "Black" })).body.data;
  assert.equal(rfq.status, "reviewing");
  gw.staff.quote(id, { options: 2 });
  rfq = (await a.req("GET", `/api/rfqs/${id}`)).body.data;
  const missing = await a.req("POST", `/api/rfqs/${id}/quotations/1/decision`, { version: rfq.version, action: "accepted" });
  assert.equal(missing.body.error.code, "OPTION_REQUIRED");
  rfq = (await a.req("POST", `/api/rfqs/${id}/quotations/1/decision`, { version: rfq.version, action: "revision_requested", reason: "Lower price" })).body.data;
  assert.equal(rfq.status, "revision_requested");
  gw.staff.quote(id, { validUntil: "2020-01-01T00:00:00.000Z" });
  rfq = (await a.req("GET", `/api/rfqs/${id}`)).body.data;
  const expired = await a.req("POST", `/api/rfqs/${id}/quotations/2/decision`, { version: rfq.version, action: "accepted" });
  assert.equal(expired.status, 409);
  assert.equal(expired.body.error.code, "QUOTATION_EXPIRED");
  const bad = await a.req("POST", `/api/rfqs/${id}/quotations/x/decision`, { version: rfq.version, action: "accepted" });
  assert.equal(bad.status, 400);
  const quotes = await a.req("GET", `/api/rfqs/${id}/quotations`);
  assert.deepEqual(quotes.body.data.map((x) => x.version), [2, 1]);
});

test("messages: list, send and image proxy with content-type allowlist", async () => {
  const { gw, handle } = setup();
  const a = await visitor(handle);
  const id = (await a.req("POST", "/api/rfqs", { requirement: REQ })).body.data.id;
  const sent = await a.req("POST", `/api/rfqs/${id}/messages`, { text: "Hello" });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.data.content, "Hello");
  const imageId = gw.staff.staffImage(id);
  const list = await a.req("GET", `/api/rfqs/${id}/messages`);
  assert.deepEqual(list.body.data.map((m) => m.sender_type), ["customer", "staff"]);
  const img = await a.req("GET", `/api/attachments/${imageId}/content`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal(img.headers.get("x-content-type-options"), "nosniff");
  const upload = await a.req("POST", `/api/rfqs/${id}/attachments`, new Uint8Array([1]), { "content-type": "image/gif", "x-rfq-version": "1" });
  assert.equal(upload.status, 415);
});

test("webhooks: signature, deduplication, unknown types and visitor-scoped event feed", async () => {
  const { handle } = setup();
  const a = await visitor(handle, "10.0.0.1"), b = await visitor(handle, "10.0.0.2");
  const rfq = (await a.req("POST", "/api/rfqs", { requirement: REQ })).body.data;
  const envelope = { id: "evt_1", type: "ask.rfq.quotation.sent", created_at: "2026-11-25T12:00:00.000Z", livemode: true, app_id: "app_demo",
    data: { event_id: "e1", type: "ask.rfq.quotation.sent", rfq: { id: rfq.id, status: "quoted", version: 3 }, quotation: { version: 1 } } };
  const raw = new TextEncoder().encode(JSON.stringify(envelope));
  const t = Math.floor(Date.now() / 1000);
  const post = async (bytes, signature) => handle(new Request(ORIGIN + "/hooks/hiobuy", { method: "POST", body: bytes, headers: { "hiobuy-signature": signature } }));
  assert.equal((await post(raw, await signPayload(SECRET, t, raw))).status, 200);
  const dup = await post(raw, await signPayload(SECRET, t, raw));
  assert.deepEqual(await dup.json(), { received: true, duplicate: true });
  const tampered = new TextEncoder().encode(JSON.stringify({ ...envelope, id: "evt_2" }));
  assert.equal((await post(tampered, await signPayload(SECRET, t, raw))).status, 401);
  assert.equal((await post(raw, await signPayload(SECRET, t - 3600, raw))).status, 401);
  const other = new TextEncoder().encode(JSON.stringify({ id: "evt_3", type: "procurement.failed", data: {} }));
  assert.equal((await post(other, await signPayload(SECRET, t, other))).status, 202);
  const feedA = (await a.req("GET", "/api/events")).body.data;
  assert.equal(feedA.length, 1);
  assert.equal(feedA[0].deliveries, 2);
  assert.equal(feedA[0].summary.quotation_version, 1);
  assert.deepEqual((await b.req("GET", "/api/events")).body.data, []);
});

test("webhook without a configured secret is rejected", async () => {
  const { handle } = setup({ webhookSecret: null });
  const res = await handle(new Request(ORIGIN + "/hooks/hiobuy", { method: "POST", body: "{}", headers: { "hiobuy-signature": "t=1,v1=" + "0".repeat(64) } }));
  assert.equal(res.status, 503);
});

test("upstream errors are passed through sanitized; the key never appears in logs or responses", async () => {
  const { handle, store } = setup({ apiKey: "hb_wrong_key_0000000000" });
  const res = await handle(new Request(ORIGIN + "/api/session"));
  const body = await res.json();
  assert.equal(body.app.ok, false);
  assert.equal(body.app.code, "UNAUTHORIZED");
  const cookie = res.headers.get("set-cookie").split(";")[0];
  const list = await handle(new Request(ORIGIN + "/api/rfqs", { headers: { cookie } }));
  assert.equal(list.status, 401);
  const dump = JSON.stringify(store.db.prepare("SELECT * FROM calls").all()) + JSON.stringify(store.db.prepare("SELECT * FROM sessions").all());
  assert.ok(!dump.includes("hb_wrong_key"));
});

test("rate limits return 429 with Retry-After", async () => {
  const { handle } = setup();
  const a = await visitor(handle);
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await a.req("POST", "/api/rfqs", { requirement: { ...REQ, title: `Item ${i}` } })).status);
  assert.deepEqual(codes, [201, 201, 201, 429]); // 3 RFQs per hour per client IP
  const last = await a.req("POST", "/api/rfqs", { requirement: REQ });
  assert.ok(Number(last.headers.get("retry-after")) > 0);
});

test("invalid ids and unknown routes are rejected before any upstream call", async () => {
  const { gw, handle } = setup();
  const a = await visitor(handle);
  const before = gw.calls.length;
  assert.equal((await a.req("GET", "/api/rfqs/not-a-uuid")).status, 404);
  assert.equal((await a.req("GET", "/api/rfqs/00000000-0000-4000-8000-000000000000")).status, 404);
  assert.equal((await a.req("DELETE", "/api/rfqs")).status, 404);
  assert.equal(gw.calls.length, before);
});

test("batch endpoints are not exposed by the demo backend", async () => {
  const { gw, handle } = setup();
  const a = await visitor(handle);
  const before = gw.calls.length;
  assert.equal((await a.req("POST", "/api/batches", { items: [{ requirement: REQ }] })).status, 404);
  assert.equal((await a.req("GET", "/api/batches")).status, 404);
  assert.equal(gw.calls.length, before);
});

const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

test("demo mode (the default) refuses PDF uploads before calling the Gateway", async () => {
  const { gw, handle } = setup();
  const a = await visitor(handle);
  assert.equal((await handle(new Request(ORIGIN + "/api/session", { headers: { cookie: a.cookie } }))).headers.get("set-cookie"), null);
  assert.equal(a.session.demo_mode, true);
  const id = (await a.req("POST", "/api/rfqs", { requirement: REQ })).body.data.id;
  const before = gw.calls.length;
  const res = await a.req("POST", `/api/rfqs/${id}/attachments`, PDF, { "content-type": "application/pdf", "x-rfq-version": "1", "x-image-filename": "spec.pdf" });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, "DEMO_PDF_DISABLED");
  assert.equal(gw.calls.length, before);
});

test("with demo mode off a PDF is forwarded and always relayed as a download", async () => {
  const { gw, handle } = setup({ demoMode: false });
  const a = await visitor(handle);
  assert.equal(a.session.demo_mode, false);
  const id = (await a.req("POST", "/api/rfqs", { requirement: REQ })).body.data.id;
  const up = await a.req("POST", `/api/rfqs/${id}/attachments`, PDF, { "content-type": "application/pdf", "x-rfq-version": "1", "x-image-filename": "spec.pdf" });
  assert.equal(up.status, 201);
  assert.equal(gw.calls.at(-2).headers["content-type"], "application/pdf");
  const file = await a.req("GET", `/api/rfqs/${id}/attachments/${up.body.data.id}/content`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "application/pdf");
  assert.equal(file.headers.get("content-disposition"), `attachment; filename="document-${up.body.data.id}.pdf"`);
  assert.equal(file.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(file.headers.get("x-content-type-options"), "nosniff");
  const gif = await a.req("POST", `/api/rfqs/${id}/attachments`, new Uint8Array([71, 73, 70]), { "content-type": "image/gif", "x-rfq-version": "2" });
  assert.equal(gif.status, 415);
});
