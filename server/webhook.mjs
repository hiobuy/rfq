// Developer webhook verification for HIOBuy Gateway deliveries.
// HioBuy-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>." + exact raw body)>
// Runtime-neutral: Web Crypto only.

export const TOLERANCE_SEC = 300;
const HEADER = /^t=([0-9]{1,12}),v1=([0-9a-f]{64})$/;
const enc = new TextEncoder();

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

async function hmacKey(secret, usage) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}
function signedBytes(timestamp, raw) {
  const prefix = enc.encode(`${timestamp}.`);
  const out = new Uint8Array(prefix.length + raw.length);
  out.set(prefix);
  out.set(raw, prefix.length);
  return out;
}

export async function signPayload(secret, timestampSec, raw) {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), signedBytes(timestampSec, raw));
  return `t=${timestampSec},v1=${hex(mac)}`;
}

/** Constant-time verification via crypto.subtle.verify. `raw` is the exact received body (Uint8Array). */
export async function verifySignature(header, raw, secret, nowSec) {
  if (!secret) return { ok: false, reason: "WEBHOOK_NOT_CONFIGURED" };
  if (typeof header !== "string") return { ok: false, reason: "SIGNATURE_MISSING" };
  const m = HEADER.exec(header.trim());
  if (!m) return { ok: false, reason: "SIGNATURE_MALFORMED" };
  const t = Number(m[1]);
  if (!Number.isSafeInteger(t) || Math.abs(nowSec - t) > TOLERANCE_SEC) return { ok: false, reason: "SIGNATURE_EXPIRED" };
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), fromHex(m[2]), signedBytes(m[1], raw));
  return ok ? { ok: true, timestamp: t } : { ok: false, reason: "SIGNATURE_INVALID" };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TYPES = new Set([
  "ask.rfq.updated", "ask.rfq.quotation.sent", "ask.rfq.quotation.withdrawn", "ask.rfq.closed",
  "ask.message.created", "ask.message.recalled", "ask.conversation.updated", "ask.conversation.closed",
]);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);

/**
 * Extract the allowlisted fields of a Gateway envelope:
 * { id, type, created_at, app_id, data: { rfq?: {id,...}, quotation?, conversation?: {id}, message? } }.
 * Events are invalidation notices: the demo re-reads the RFQ instead of trusting the payload.
 */
export function parseEvent(parsed) {
  const root = obj(parsed);
  if (!root) return null;
  const data = obj(root.data) ?? {};
  const eventId = root.id ?? data.event_id;
  const type = root.type ?? data.type;
  if (typeof eventId !== "string" || !EVENT_ID.test(eventId) || !TYPES.has(type)) return null;
  const rfq = obj(data.rfq), conversation = obj(data.conversation), quotation = obj(data.quotation);
  const rfqId = typeof rfq?.id === "string" && UUID.test(rfq.id) ? rfq.id : null;
  const conversationId = typeof conversation?.id === "string" && UUID.test(conversation.id) ? conversation.id : null;
  if (type.startsWith("ask.rfq.") && !rfqId) return null;
  if (!type.startsWith("ask.rfq.") && !conversationId) return null;
  return {
    eventId, type, rfqId, conversationId,
    createdAt: typeof root.created_at === "string" ? root.created_at.slice(0, 40) : null,
    summary: {
      status: typeof rfq?.status === "string" ? rfq.status.slice(0, 40) : null,
      version: Number.isSafeInteger(rfq?.version) ? rfq.version : null,
      quotation_version: Number.isSafeInteger(quotation?.version) ? quotation.version : null,
    },
  };
}
