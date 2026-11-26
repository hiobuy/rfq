// "Your backend": the integrator's server between the buyer-facing UI and the HIOBuy Gateway.
// Fetch-API handler (Request -> Response) shared by the local Node host and the Worker.
//
// Responsibilities an integrator keeps in production:
//  - hold the HIOBuy API key (server secret) and call https://api.hiobuy.com/v1/ask/* with it;
//  - map its own signed-in user to an opaque external_user_id (here: an anonymous demo visitor);
//  - authorize every RFQ, conversation and image against that user (the App boundary alone does not);
//  - receive signed webhooks, deduplicate them, then re-read the RFQ.
import { GatewayClient, GatewayError, IMAGE_TYPES, PDF_TYPE, assertUuid, assertVersion } from "./gateway.mjs";
import { parseEvent, verifySignature } from "./webhook.mjs";

const enc = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDEMPOTENCY = /^[!-~]{8,128}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const REQUIREMENT_KEYS = ["title", "quantity", "unit", "destination", "target_price", "target_currency", "target_price_unit",
  "reference_url", "needed_by", "sample", "accept_similar", "specs", "branding", "packaging", "monthly_volume"];
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_PDF = 20 * 1024 * 1024;

export class HttpError extends Error {
  constructor(status, code, message, headers = {}) { super(message); this.status = status; this.code = code; this.headers = headers; }
}
const bad = (message, code = "INVALID_REQUEST") => new HttpError(400, code, message);
const notFound = () => new HttpError(404, "NOT_FOUND", "Not found.");

const SECURITY_HEADERS = {
  "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY", "Cross-Origin-Resource-Policy": "same-origin",
};
export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", ...headers } });
}
const errorResponse = (status, code, message, headers = {}) => json({ error: { code, message } }, status, headers);

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (bytes) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256 = async (text) => hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readBody(request, max) {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body too large.");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body too large."); }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}
async function readJson(request, max = 256 * 1024) {
  if ((request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() !== "application/json")
    throw new HttpError(415, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBody(request, max)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw bad("Invalid JSON body.");
  }
}
const text = (v, max, name, required = false) => {
  if (v === undefined || v === null || v === "") { if (required) throw bad(`${name} is required.`); return undefined; }
  if (typeof v !== "string" || v.length > max) throw bad(`Invalid ${name}.`);
  return v;
};
function requirementInput(value, partial) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad("requirement must be an object.");
  const out = {};
  for (const key of REQUIREMENT_KEYS) if (value[key] !== undefined) out[key] = value[key];
  if (!partial && (typeof out.title !== "string" || !out.title.trim())) throw bad("requirement.title is required.");
  return out;
}

/** Strip anything the browser does not need from a conversation message. */
export function publicMessage(m) {
  if (!m || typeof m !== "object" || typeof m.id !== "string") return null;
  if (m.sender_type !== "customer" && m.sender_type !== "staff") return null;
  const recalled = m.recalled_at !== undefined && m.recalled_at !== null;
  return {
    id: m.id, sender_type: m.sender_type, recalled,
    content: recalled ? "" : typeof m.content === "string" ? m.content.slice(0, 10000) : "",
    created_at: typeof m.created_at === "string" ? m.created_at.slice(0, 40) : null,
    attachments: recalled || !Array.isArray(m.attachments) ? [] : m.attachments.slice(0, 8)
      .filter((a) => a && typeof a.id === "string" && UUID.test(a.id) && IMAGE_TYPES.has(a.content_type))
      .map((a) => ({ id: a.id, content_type: a.content_type, filename: typeof a.filename === "string" ? a.filename.slice(0, 120) : "image" })),
  };
}

/**
 * config: { apiKey, gatewayOrigin, webhookSecret, publicOrigin, allowedOrigins?, secureCookies, refPrefix, demoMode, fetchImpl, now }
 * demoMode (default true): the public demo accepts image uploads only; PDFs need demoMode=false.
 * store: SqlStore
 */
export function createHandler({ config, store }) {
  const now = config.now ?? (() => Date.now());
  const gateway = new GatewayClient({ origin: config.gatewayOrigin, apiKey: config.apiKey, fetchImpl: config.fetchImpl });
  const cookieName = config.secureCookies ? "__Host-rfq_sid" : "rfq_sid";
  const refPrefix = config.refPrefix ?? "demo-";
  const demoMode = config.demoMode !== false;
  let identityCache = null;

  async function identity() {
    if (identityCache && identityCache.until > now()) return identityCache.value;
    let value;
    try {
      const { data } = await gateway.identity();
      value = { ok: true, app_name: data?.app?.name ?? "", environment: data?.api_key?.environment ?? null,
        rfq: data?.rfq ?? null, inquiry: data?.inquiry ? { read: !!data.inquiry.read, write: !!data.inquiry.write } : null };
    } catch (e) {
      value = { ok: false, code: e instanceof GatewayError ? e.code : "GATEWAY_UNAVAILABLE" };
    }
    identityCache = { value, until: now() + (value.ok ? 60_000 : 10_000) };
    return value;
  }

  // ---- session / visitor ----
  function readCookie(request) {
    for (const part of (request.headers.get("cookie") ?? "").split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === cookieName) return v.join("=");
    }
    return null;
  }
  async function currentSession(request) {
    const sid = readCookie(request);
    if (!sid || !/^[0-9a-f]{64}$/.test(sid)) return null;
    return store.session(await sha256(sid));
  }
  async function newSession() {
    const sid = randomHex(32), visitor = "demo_" + randomHex(10), csrf = randomHex(24);
    store.createSession(await sha256(sid), visitor, csrf);
    const cookie = `${cookieName}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}${config.secureCookies ? "; Secure" : ""}`;
    return { session: { visitor, csrf }, cookie };
  }
  const visitorTag = (visitor) => visitor.slice(5, 11);
  /** The integrator's own reference, prefixed so demo submissions are recognizable and unique per visitor. */
  function externalRef(visitor, ref) {
    const own = ref === undefined || ref === null || ref === "" ? randomHex(4) : ref;
    if (typeof own !== "string" || !REF.test(own)) throw bad("Your reference may use letters, digits, '.', '_' and '-' (max 40).");
    return `${refPrefix}${visitorTag(visitor)}-${own}`;
  }
  const displayRef = (visitor, ref) => {
    const prefix = `${refPrefix}${visitorTag(visitor)}-`;
    return typeof ref === "string" && ref.startsWith(prefix) ? ref.slice(prefix.length) : ref ?? null;
  };
  const presentRfq = (visitor, rfq) => ({ ...rfq, external_user_id: undefined, your_ref: displayRef(visitor, rfq.external_ref) });

  function requireOwned(kind, id, visitor) {
    if (typeof id !== "string" || !UUID.test(id) || !store.owns(kind, id, visitor)) throw notFound();
    return id;
  }
  function idempotencyKey(request) {
    const key = request.headers.get("idempotency-key");
    if (key === null) return crypto.randomUUID();
    if (!IDEMPOTENCY.test(key)) throw bad("Invalid Idempotency-Key.");
    return key;
  }

  // ---- gateway calls, logged per visitor for the Integration page ----
  async function call(visitor, label, fn) {
    const t0 = now();
    try {
      const out = await fn();
      store.logCall(visitor, label[0], label[1], out?.status ?? 200, now() - t0);
      return out;
    } catch (e) {
      store.logCall(visitor, label[0], label[1], e instanceof GatewayError ? e.status : 500, now() - t0, e instanceof GatewayError ? e.code : "ERROR");
      throw e;
    }
  }
  async function loadRfq(visitor, id) {
    const { data } = await call(visitor, ["GET", `/v1/ask/rfqs/${id}`], () => gateway.getRfq(id));
    if (data?.external_user_id !== visitor) throw notFound(); // defence in depth: never serve another user's RFQ
    if (typeof data.conversation_id === "string" && UUID.test(data.conversation_id)) store.own("conversation", data.conversation_id, visitor, id);
    return data;
  }
  function ownCreated(visitor, rfq) {
    store.own("rfq", rfq.id, visitor);
    if (typeof rfq.conversation_id === "string" && UUID.test(rfq.conversation_id)) store.own("conversation", rfq.conversation_id, visitor, rfq.id);
  }

  /** Images are shown inline; PDFs (unscanned, stored as uploaded) are always a download. */
  async function relayFile(upstream, id) {
    const type = (upstream.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type) && type !== PDF_TYPE) { await upstream.body?.cancel().catch(() => {}); throw new HttpError(502, "INVALID_FILE", "Invalid file response."); }
    const headers = { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": "private, max-age=300",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      ...(type === PDF_TYPE ? { "Content-Disposition": `attachment; filename="document-${id}.pdf"`, "Cache-Control": "no-store" } : {}) };
    const length = upstream.headers.get("content-length");
    if (length && /^\d+$/.test(length)) headers["Content-Length"] = length;
    return new Response(upstream.body, { status: 200, headers });
  }

  // ---- rate limits (fixed windows, per hashed client IP and per App) ----
  async function limited(request, url, ipHash, hasSession) {
    const m = request.method, p = url.pathname;
    const rules = [["req", 240, 60_000]];
    if (p === "/api/session" && !hasSession) rules.push(["session", 30, 3600_000]);
    // Every RFQ reaches a real sourcing team: keep demo submissions scarce.
    if (m === "POST" && p === "/api/rfqs") rules.push(["create", 3, 3600_000], ["create-app", 30, 86_400_000, true]);
    if (m === "POST" && /\/attachments$/.test(p)) rules.push(["upload", 30, 3600_000]);
    if (m === "POST" && /\/messages$/.test(p)) rules.push(["message", 40, 3600_000]);
    if ((m === "POST" || m === "PATCH") && /\/(requirement|cancel|answers|decision)$/.test(p)) rules.push(["action", 60, 3600_000]);
    for (const [name, max, period, global] of rules) {
      const wait = store.limit(global ? name : `${name}:${ipHash}`, max, period);
      if (wait) return wait;
    }
    return 0;
  }

  // ---- webhook receiver ----
  async function webhook(request) {
    const raw = await readBody(request, 64 * 1024);
    const verified = await verifySignature(request.headers.get("hiobuy-signature"), raw, config.webhookSecret, Math.floor(now() / 1000));
    if (!verified.ok) return errorResponse(verified.reason === "WEBHOOK_NOT_CONFIGURED" ? 503 : 401, verified.reason, "Webhook rejected.");
    let parsed;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { return errorResponse(400, "INVALID_EVENT", "Invalid event."); }
    const event = parseEvent(parsed);
    if (!event) return json({ received: true, ignored: true }, 202);
    const fresh = store.recordEvent(event);
    // Acknowledge fast. The UI re-reads the RFQ through the API when it sees the event.
    return json({ received: true, duplicate: !fresh });
  }

  // ---- routes ----
  async function api(request, url, session) {
    const { visitor } = session, m = request.method, p = url.pathname;
    let match;

    if (m === "GET" && p === "/api/rfqs") {
      const owned = new Set(store.ownedIds("rfq", visitor));
      const status = url.searchParams.get("status") ?? undefined;
      const { data } = await call(visitor, ["GET", "/v1/ask/rfqs?external_user_id=…"],
        () => gateway.listRfqs({ external_user_id: visitor, status, limit: 100 }));
      return json({ data: (Array.isArray(data) ? data : []).filter((r) => owned.has(r.id)).map((r) => presentRfq(visitor, r)) });
    }
    if (m === "POST" && p === "/api/rfqs") {
      const body = await readJson(request);
      const input = { requirement: requirementInput(body.requirement, false), external_ref: externalRef(visitor, body.your_ref),
        external_user_id: visitor, ...(body.language ? { language: text(body.language, 35, "language") } : {}) };
      const { status, data } = await call(visitor, ["POST", "/v1/ask/rfqs"], () => gateway.createRfq(input, idempotencyKey(request)));
      ownCreated(visitor, data);
      return json({ data: presentRfq(visitor, data) }, status);
    }
    if ((match = p.match(/^\/api\/rfqs\/([^/]+)$/)) && m === "GET") {
      const id = requireOwned("rfq", match[1], visitor);
      const rfq = await loadRfq(visitor, id);
      return json({ data: presentRfq(visitor, rfq), history: store.requirementHistory(id) });
    }
    if ((match = p.match(/^\/api\/rfqs\/([^/]+)\/quotations$/)) && m === "GET") {
      const id = requireOwned("rfq", match[1], visitor);
      const { data } = await call(visitor, ["GET", `/v1/ask/rfqs/${id}/quotations`], () => gateway.quotations(id));
      return json({ data: Array.isArray(data) ? data : [] });
    }
    if ((match = p.match(/^\/api\/rfqs\/([^/]+)\/requirement$/)) && m === "PATCH") {
      const id = requireOwned("rfq", match[1], visitor);
      const body = await readJson(request);
      const patch = requirementInput(body.requirement, true), note = text(body.note, 2000, "note") ?? "";
      const before = await loadRfq(visitor, id);
      const changed = Object.keys(patch).filter((k) => JSON.stringify(patch[k]) !== JSON.stringify(before.requirement?.[k]));
      if (!changed.length && !note) throw bad("Nothing changed.", "NO_CHANGES");
      const { data } = await call(visitor, ["PATCH", `/v1/ask/rfqs/${id}/requirement`], () =>
        gateway.updateRequirement(id, { version: assertVersion(body.version), requirement: patch, ...(note ? { note } : {}) }, idempotencyKey(request)));
      if (data.req_version > before.req_version)
        store.recordRequirementChange(id, data.req_version, changed.map((k) => ({ field: k, from: before.requirement?.[k] ?? null, to: patch[k] })), note, data.updated_at ?? new Date(now()).toISOString());
      return json({ data: presentRfq(visitor, data), history: store.requirementHistory(id) });
    }
    if ((match = p.match(/^\/api\/rfqs\/([^/]+)\/(cancel|answers)$/)) && m === "POST") {
      const id = requireOwned("rfq", match[1], visitor), action = match[2];
      const body = await readJson(request, 32 * 1024);
      const payload = action === "cancel"
        ? { version: assertVersion(body.version), ...(body.reason ? { reason: text(body.reason, 1200, "reason") } : {}) }
        : { version: assertVersion(body.version), text: text(body.text, 4000, "text", true),
            ...(body.question_id ? { question_id: assertUuid(body.question_id) } : {}) };
      const { data } = await call(visitor, ["POST", `/v1/ask/rfqs/${id}/${action}`], () =>
        (action === "cancel" ? gateway.cancel : gateway.answer).call(gateway, id, payload, idempotencyKey(request)));
      return json({ data: presentRfq(visitor, data) });
    }
    if ((match = p.match(/^\/api\/rfqs\/([^/]+)\/quotations\/([^/]+)\/decision$/)) && m === "POST") {
      const id = requireOwned("rfq", match[1], visitor), quoteVersion = assertVersion(match[2]);
      const body = await readJson(request, 32 * 1024);
      if (!["accepted", "rejected", "revision_requested"].includes(body.action)) throw bad("Invalid action.");
      const payload = { version: assertVersion(body.version), action: body.action,
        ...(body.option_id ? { option_id: text(body.option_id, 64, "option_id") } : {}),
        ...(body.reason ? { reason: text(body.reason, 2000, "reason") } : {}) };
      const { data } = await call(visitor, ["POST", `/v1/ask/rfqs/${id}/quotations/${quoteVersion}/decision`], () =>
        gateway.decide(id, quoteVersion, payload, idempotencyKey(request)));
      return json({ data: presentRfq(visitor, data) });
    }
    if ((match = p.match(/^\/api\/rfqs\/([^/]+)\/attachments$/)) && m === "POST") {
      const id = requireOwned("rfq", match[1], visitor);
      const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
      const pdf = contentType === PDF_TYPE;
      if (pdf && demoMode) throw new HttpError(403, "DEMO_PDF_DISABLED", "PDF uploads are disabled in demo mode.");
      if (!pdf && !IMAGE_TYPES.has(contentType)) throw new HttpError(415, "UNSUPPORTED_FILE_TYPE", demoMode ? "Only PNG, JPEG and WebP images are supported." : "Only PNG, JPEG, WebP and PDF are supported.");
      let filename = "image";
      try { filename = decodeURIComponent(request.headers.get("x-image-filename") ?? "image").slice(0, 120); } catch { /* keep default */ }
      const bytes = await readBody(request, pdf ? MAX_PDF : MAX_IMAGE);
      const { status, data } = await call(visitor, ["POST", `/v1/ask/rfqs/${id}/attachments`], () =>
        gateway.uploadImage(id, { bytes, contentType, filename, rfqVersion: request.headers.get("x-rfq-version"), idempotencyKey: idempotencyKey(request) }));
      return json({ data, rfq: presentRfq(visitor, await loadRfq(visitor, id)) }, status);
    }
    if ((match = p.match(/^\/api\/rfqs\/([^/]+)\/attachments\/([^/]+)\/content$/)) && m === "GET") {
      const id = requireOwned("rfq", match[1], visitor), attachmentId = assertUuid(match[2]);
      return relayFile(await gateway.rfqImage(id, attachmentId), attachmentId);
    }
    if ((match = p.match(/^\/api\/rfqs\/([^/]+)\/messages$/))) {
      const id = requireOwned("rfq", match[1], visitor);
      const rfq = await loadRfq(visitor, id);
      if (!rfq.conversation_id) return m === "GET" ? json({ data: [], conversation: false }) : errorResponse(409, "NO_CONVERSATION", "This RFQ has no conversation.");
      if (m === "GET") {
        const { data } = await call(visitor, ["GET", `/v1/ask/conversations/${rfq.conversation_id}/messages`], () => gateway.listMessages(rfq.conversation_id));
        // The API pages newest first; show the latest page in reading order (oldest at the top).
        const messages = (Array.isArray(data) ? data : []).map(publicMessage).filter(Boolean)
          .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id));
        for (const msg of messages) for (const a of msg.attachments) store.own("attachment", a.id, visitor, id);
        return json({ data: messages, conversation: true });
      }
      if (m === "POST") {
        const body = await readJson(request, 32 * 1024);
        const content = text(body.text, 4000, "text", true);
        const { status, data } = await call(visitor, ["POST", `/v1/ask/conversations/${rfq.conversation_id}/messages`], () =>
          gateway.sendMessage(rfq.conversation_id, { client_message_id: crypto.randomUUID(), type: "text", content }, idempotencyKey(request)));
        return json({ data: publicMessage(data) }, status);
      }
    }
    if ((match = p.match(/^\/api\/attachments\/([^/]+)\/content$/)) && m === "GET") {
      const attachmentId = requireOwned("attachment", match[1], visitor);
      return relayFile(await gateway.messageImage(attachmentId), attachmentId);
    }
    if (m === "GET" && p === "/api/events") {
      const after = Number(url.searchParams.get("after") ?? 0);
      return json({ data: store.eventsFor(visitor, Number.isSafeInteger(after) && after > 0 ? after : 0) });
    }
    if (m === "GET" && p === "/api/calls") return json({ data: store.callsFor(visitor) });
    throw notFound();
  }

  return async function handle(request, { clientIp = "local" } = {}) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health" && request.method === "GET") return json({ status: "ok", service: "rfq-demo" });
      if (url.pathname === "/hooks/hiobuy" && request.method === "POST") return await webhook(request);
      if (!url.pathname.startsWith("/api/")) return errorResponse(404, "NOT_FOUND", "Not found.");

      let session = await currentSession(request), cookie = null;
      const wait = await limited(request, url, await sha256(`${config.apiKey ?? ""}:ip:${clientIp}`), !!session);
      if (wait) return errorResponse(429, "DEMO_RATE_LIMITED", "Too many requests. Please try again later.", { "Retry-After": String(wait) });

      if (url.pathname === "/api/session" && request.method === "GET") {
        if (!session) ({ session, cookie } = await newSession());
        const id = await identity();
        return json({ visitor: { label: `Demo buyer ${visitorTag(session.visitor)}` }, csrf_token: session.csrf,
          app: id, demo_mode: demoMode, webhook_configured: !!config.webhookSecret, ref_prefix: `${refPrefix}${visitorTag(session.visitor)}-` },
        200, cookie ? { "Set-Cookie": cookie } : {});
      }
      if (!session) return errorResponse(401, "SESSION_REQUIRED", "Reload the page to start a demo session.");
      if (!["GET", "HEAD"].includes(request.method)) {
        const origin = request.headers.get("origin");
        if (origin !== null && !(config.allowedOrigins ?? [config.publicOrigin]).includes(origin)) return errorResponse(403, "INVALID_ORIGIN", "Cross-origin request rejected.");
        if (!safeEqual(request.headers.get("x-csrf-token") ?? "", session.csrf)) return errorResponse(403, "INVALID_CSRF", "CSRF validation failed.");
      }
      return await api(request, url, session);
    } catch (e) {
      if (e instanceof HttpError) return errorResponse(e.status, e.code, e.message, e.headers);
      if (e instanceof GatewayError) return errorResponse(e.status, e.code, e.message, e.retryAfter ? { "Retry-After": e.retryAfter } : {});
      return errorResponse(500, "INTERNAL_ERROR", "The demo backend failed to complete the request.");
    }
  };
}
