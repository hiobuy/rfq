// Server-only client for the HIOBuy Gateway RFQ API (https://api.hiobuy.com/v1/ask/*).
// The API key is passed per call and never logged or returned. Errors are sanitized.
// Runtime-neutral (Node 24 and Cloudflare Workers): only fetch/Request/Response/Headers.

export const USER_AGENT = "RFQ-Demo/0.2";
const JSON_LIMIT = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PASS_STATUS = new Set([400, 401, 403, 404, 409, 410, 413, 415, 422, 429]);
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const PDF_TYPE = "application/pdf";

export class GatewayError extends Error {
  constructor(status, code, message, retryAfter = null) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function assertUuid(id) {
  if (typeof id !== "string" || !UUID.test(id)) throw new GatewayError(400, "INVALID_ID", "Invalid identifier.");
  return id;
}
export function assertVersion(v) {
  const n = typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 1) throw new GatewayError(400, "INVALID_VERSION", "Invalid version.");
  return n;
}

export function sanitizeText(message, secrets = []) {
  if (typeof message !== "string") return null;
  let m = message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
  for (const s of secrets) if (s && s.length >= 8) m = m.split(s).join("[redacted]");
  m = m.replace(/\b(sk|hb|hio|key)[-_][A-Za-z0-9_-]{12,}\b/gi, "[redacted]");
  return m.trim() || null;
}

async function readLimited(res, limit) {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > limit) throw new GatewayError(502, "GATEWAY_RESPONSE_TOO_LARGE", "Gateway response too large.");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new GatewayError(502, "GATEWAY_RESPONSE_TOO_LARGE", "Gateway response too large.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(out);
}

const RFQ_LIST_QUERY = ["status", "external_ref", "external_user_id", "batch_id", "updated_after", "limit", "cursor"];

export class GatewayClient {
  constructor({ origin, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
    if (!/^https?:\/\/[^/]+$/.test(origin)) throw new Error("Invalid gateway origin");
    this.origin = origin;
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async #raw(method, path, { headers = {}, body, timeoutMs } = {}) {
    if (typeof this.apiKey !== "string" || this.apiKey.length < 8)
      throw new GatewayError(503, "DEMO_NOT_CONFIGURED", "The demo has no HIOBuy API key configured.");
    if (!path.startsWith("/v1/ask/")) throw new Error("bad path");
    try {
      return await this.fetch(this.origin + path, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, "User-Agent": USER_AGENT, ...headers },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
      });
    } catch {
      throw new GatewayError(503, "GATEWAY_UNAVAILABLE", "HIOBuy Gateway is unavailable.");
    }
  }

  async #error(res) {
    let parsed = null;
    try { parsed = JSON.parse(await readLimited(res, 64 * 1024)); } catch { /* non-JSON, e.g. an edge block page */ }
    const err = parsed && typeof parsed === "object" ? parsed.error ?? {} : {};
    const code = typeof err.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(err.code) ? err.code : null;
    const retryAfter = res.headers.get("retry-after");
    if (res.status >= 300 && res.status < 400) return new GatewayError(502, "GATEWAY_REDIRECT_REJECTED", "Unexpected redirect from Gateway.");
    if (PASS_STATUS.has(res.status))
      return new GatewayError(res.status, code ?? `HTTP_${res.status}`, sanitizeText(err.message, [this.apiKey]) ?? "Request rejected by Gateway.", retryAfter);
    if (res.status === 503) return new GatewayError(503, code ?? "SERVICE_UNAVAILABLE", "Service unavailable.", retryAfter);
    return new GatewayError(502, "GATEWAY_ERROR", "Gateway request failed.");
  }

  async #json(method, path, { body, idempotencyKey } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const res = await this.#raw(method, path, { headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status < 200 || res.status >= 300) throw await this.#error(res);
    let parsed;
    try { parsed = JSON.parse(await readLimited(res, JSON_LIMIT)); }
    catch { throw new GatewayError(502, "GATEWAY_BAD_RESPONSE", "Gateway returned invalid JSON."); }
    if (!parsed || typeof parsed !== "object" || !("data" in parsed))
      throw new GatewayError(502, "GATEWAY_BAD_RESPONSE", "Gateway returned an unexpected response.");
    return { status: res.status, data: parsed.data, nextCursor: parsed.pagination?.next_cursor ?? null };
  }

  identity() { return this.#json("GET", "/v1/ask/identity"); }

  listRfqs(query = {}) {
    const q = new URLSearchParams();
    for (const key of RFQ_LIST_QUERY) if (query[key] !== undefined && query[key] !== null && query[key] !== "") q.set(key, String(query[key]));
    return this.#json("GET", "/v1/ask/rfqs" + (q.size ? "?" + q : ""));
  }
  getRfq(id) { return this.#json("GET", `/v1/ask/rfqs/${assertUuid(id)}`); }
  createRfq(body, idempotencyKey) { return this.#json("POST", "/v1/ask/rfqs", { body, idempotencyKey }); }
  updateRequirement(id, body, idempotencyKey) { return this.#json("PATCH", `/v1/ask/rfqs/${assertUuid(id)}/requirement`, { body, idempotencyKey }); }
  cancel(id, body, idempotencyKey) { return this.#json("POST", `/v1/ask/rfqs/${assertUuid(id)}/cancel`, { body, idempotencyKey }); }
  answer(id, body, idempotencyKey) { return this.#json("POST", `/v1/ask/rfqs/${assertUuid(id)}/answers`, { body, idempotencyKey }); }
  quotations(id) { return this.#json("GET", `/v1/ask/rfqs/${assertUuid(id)}/quotations`); }
  decide(id, version, body, idempotencyKey) {
    return this.#json("POST", `/v1/ask/rfqs/${assertUuid(id)}/quotations/${assertVersion(version)}/decision`, { body, idempotencyKey });
  }
  listMessages(conversationId, cursor) {
    const q = new URLSearchParams({ limit: "50" });
    if (cursor) q.set("cursor", cursor);
    return this.#json("GET", `/v1/ask/conversations/${assertUuid(conversationId)}/messages?${q}`);
  }
  sendMessage(conversationId, body, idempotencyKey) {
    return this.#json("POST", `/v1/ask/conversations/${assertUuid(conversationId)}/messages`, { body, idempotencyKey });
  }

  async #upload(path, { bytes, contentType, filename, idempotencyKey, extraHeaders = {} }) {
    if (!IMAGE_TYPES.has(contentType) && contentType !== PDF_TYPE) throw new GatewayError(415, "UNSUPPORTED_FILE_TYPE", "Only PNG, JPEG, WebP and PDF are supported.");
    const headers = { Accept: "application/json", "Content-Type": contentType, "Idempotency-Key": idempotencyKey, ...extraHeaders };
    if (filename) headers["X-Image-Filename"] = encodeURIComponent(filename).slice(0, 1536);
    const res = await this.#raw("POST", path, { headers, body: bytes, timeoutMs: 120_000 });
    if (res.status < 200 || res.status >= 300) throw await this.#error(res);
    try { return { status: res.status, data: JSON.parse(await readLimited(res, 64 * 1024)).data }; }
    catch { throw new GatewayError(502, "GATEWAY_BAD_RESPONSE", "Gateway returned invalid JSON."); }
  }
  /** Requirement image on the RFQ (needs the RFQ's current version). */
  uploadImage(id, { rfqVersion, ...file }) {
    return this.#upload(`/v1/ask/rfqs/${assertUuid(id)}/attachments`, { ...file, extraHeaders: { "X-RFQ-Version": String(assertVersion(rfqVersion)) } });
  }
  /** Conversation image; bind it to a message with `attachment_ids` (up to 4 per message). */
  uploadConversationImage(conversationId, file) {
    return this.#upload(`/v1/ask/conversations/${assertUuid(conversationId)}/attachments`, file);
  }

  /** RFQ requirement or quotation image. Returns the raw Response; the caller relays allowlisted headers only. */
  async rfqImage(id, attachmentId) {
    const res = await this.#raw("GET", `/v1/ask/rfqs/${assertUuid(id)}/attachments/${assertUuid(attachmentId)}/content`, { timeoutMs: 60_000 });
    if (res.status !== 200) throw await this.#error(res);
    return res;
  }
  /** Conversation message image. */
  async messageImage(attachmentId) {
    const res = await this.#raw("GET", `/v1/ask/attachments/${assertUuid(attachmentId)}/content`, { timeoutMs: 60_000 });
    if (res.status !== 200) throw await this.#error(res);
    return res;
  }
}
