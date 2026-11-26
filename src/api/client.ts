// Browser side of the demo. It talks ONLY to the demo backend (/api/*) on the same origin, never to
// HIOBuy or HIOAsk directly, and holds no API key. The backend authenticates the visitor by cookie
// and checks a CSRF token on every write.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ApiCall, DecisionAction, DemoEvent, Message, NewRequirement, Requirement, RequirementChange, Rfq, Session, Quotation, Attachment } from "./types";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message?: string) { super(message ?? code); }
}

let session: Session | null = null;
let sessionPromise: Promise<Session> | null = null;
export function loadSession(): Promise<Session> {
  sessionPromise ??= fetch("/api/session", { credentials: "same-origin" }).then(async (r) => {
    if (!r.ok) throw await toError(r);
    session = (await r.json()) as Session;
    notify();
    return session;
  }).catch((e) => { sessionPromise = null; throw e; });
  return sessionPromise;
}

async function toError(r: Response) {
  try { const b = await r.json(); return new ApiError(r.status, b?.error?.code ?? `HTTP_${r.status}`, b?.error?.message); }
  catch { return new ApiError(r.status, `HTTP_${r.status}`, r.statusText || "Request failed"); }
}

/** One write = one idempotency key. A retry of the same user action should reuse it. */
export const newIdempotencyKey = () => crypto.randomUUID();

async function request<T>(method: string, path: string, body?: unknown, extra: { headers?: Record<string, string>; raw?: Blob } = {}): Promise<T> {
  const s = session ?? await loadSession();
  const headers: Record<string, string> = { ...extra.headers };
  if (method !== "GET") { headers["X-CSRF-Token"] = s.csrf_token; headers["Idempotency-Key"] ??= newIdempotencyKey(); }
  let payload: BodyInit | undefined;
  if (extra.raw) payload = extra.raw;
  else if (body !== undefined) { payload = JSON.stringify(body); headers["Content-Type"] = "application/json"; }
  const r = await fetch(path, { method, headers, body: payload, credentials: "same-origin" });
  if (r.status === 401) { session = null; sessionPromise = null; }
  if (!r.ok) throw await toError(r);
  return (await r.json()) as T;
}

// ---- tiny observable: pages re-fetch after writes and when a webhook event arrives ----
let version = 0, events: DemoEvent[] = [], online = true;
const listeners = new Set<() => void>();
function notify() { listeners.forEach((l) => l()); }
const bump = () => { version++; notify(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useVersion = () => useSyncExternalStore(subscribe, () => version);
export const useEvents = () => useSyncExternalStore(subscribe, () => events);
export const useOnline = () => useSyncExternalStore(subscribe, () => online);
export const useSession = () => useSyncExternalStore(subscribe, () => session);

const write = async <T,>(p: Promise<T>) => {
  try { const out = await p; bump(); return out; }
  catch (e) { if (e instanceof ApiError && e.status === 409) bump(); throw e; } // reload the current state after a conflict
};

export const api = {
  listRfqs: () => request<{ data: Rfq[] }>("GET", "/api/rfqs").then((r) => r.data),
  getRfq: (id: string) => request<{ data: Rfq; history: RequirementChange[] }>("GET", `/api/rfqs/${id}`),
  quotations: (id: string) => request<{ data: Quotation[] }>("GET", `/api/rfqs/${id}/quotations`).then((r) => r.data),
  createRfq: (input: { requirement: NewRequirement; your_ref?: string }) =>
    write(request<{ data: Rfq }>("POST", "/api/rfqs", input).then((r) => r.data)),
  updateRequirement: (id: string, version: number, requirement: Partial<Requirement>, note?: string) =>
    write(request<{ data: Rfq; history: RequirementChange[] }>("PATCH", `/api/rfqs/${id}/requirement`, { version, requirement, note })),
  cancel: (id: string, version: number, reason?: string) =>
    write(request<{ data: Rfq }>("POST", `/api/rfqs/${id}/cancel`, { version, reason }).then((r) => r.data)),
  answer: (id: string, version: number, text: string, question_id?: string) =>
    write(request<{ data: Rfq }>("POST", `/api/rfqs/${id}/answers`, { version, text, question_id }).then((r) => r.data)),
  decide: (id: string, quoteVersion: number, version: number, action: DecisionAction, option_id?: string, reason?: string) =>
    write(request<{ data: Rfq }>("POST", `/api/rfqs/${id}/quotations/${quoteVersion}/decision`, { version, action, option_id, reason }).then((r) => r.data)),
  uploadImage: (id: string, version: number, file: File) =>
    write(request<{ data: Attachment; rfq: Rfq }>("POST", `/api/rfqs/${id}/attachments`, undefined, {
      raw: file, headers: { "Content-Type": file.type, "X-RFQ-Version": String(version), "X-Image-Filename": encodeURIComponent(file.name.slice(0, 120)) },
    })),
  messages: (id: string) => request<{ data: Message[]; conversation: boolean }>("GET", `/api/rfqs/${id}/messages`),
  sendMessage: (id: string, text: string) => write(request<{ data: Message }>("POST", `/api/rfqs/${id}/messages`, { text }).then((r) => r.data)),
  calls: () => request<{ data: ApiCall[] }>("GET", "/api/calls").then((r) => r.data),
};

/** Image URL served by the demo backend (which proxies the Gateway with the server-side key). */
export const rfqImageUrl = (rfqId: string, attachmentId: string) => `/api/rfqs/${rfqId}/attachments/${attachmentId}/content`;
export const messageImageUrl = (attachmentId: string) => `/api/attachments/${attachmentId}/content`;

// ---- webhook relay: the backend stores verified events; the UI polls its own backend for them ----
let lastSeq = 0, polling = false;
async function pollEvents() {
  if (polling || !session) return;
  polling = true;
  try {
    const { data } = await request<{ data: DemoEvent[] }>("GET", `/api/events?after=${lastSeq}`);
    if (!online) { online = true; notify(); }
    if (data.length) {
      lastSeq = Math.max(lastSeq, ...data.map((e) => e.seq));
      events = [...data, ...events].slice(0, 100);
      bump();
    }
  } catch { if (online) { online = false; notify(); } }
  finally { polling = false; }
}
if (typeof window !== "undefined") {
  window.setInterval(() => { void pollEvents(); }, 3000);
  window.addEventListener("focus", () => bump());
}

/** Fetch helper for pages: re-runs after any write, incoming event or window focus. */
export function useApi<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const v = useVersion();
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: true });
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => alive && setState({ data, loading: false }),
      (error: unknown) => alive && setState((s) => ({ data: s.data, loading: false,
        error: error instanceof ApiError ? error : new ApiError(0, "NETWORK", String(error)) })),
    );
    return () => { alive = false; };
  }, [v, ...deps]);
  return state;
}

export const errorText = (e: unknown) => {
  if (e instanceof ApiError) return HINT[e.code] ?? e.message;
  return e instanceof Error ? e.message : String(e);
};
const HINT: Record<string, string> = {
  VERSION_CONFLICT: "This request changed in the meantime (for example the sourcing team replied). The page has reloaded — check and try again.",
  QUOTATION_EXPIRED: "This quotation has expired. Ask the sourcing team for a new version.",
  QUOTATION_NOT_CURRENT: "This is no longer the current quotation. A newer version may have been sent.",
  RFQ_DISABLED: "RFQ is not enabled for this App yet. The HIOBuy administrator must turn it on.",
  INSUFFICIENT_SCOPE: "The demo's API key does not have the rfq:read / rfq:write scopes.",
  RFQ_DAILY_LIMIT: "This App has reached its daily RFQ limit. Try again tomorrow (UTC).",
  REQUIREMENT_TOO_VAGUE: "Describe the product with specifications or a reference link.",
  RFQ_EXTERNAL_REF_CONFLICT: "You already used this reference for a different request.",
  DEMO_RATE_LIMITED: "Too many requests from this demo session. Please wait a moment.",
  DEMO_NOT_CONFIGURED: "The demo backend has no HIOBuy API key configured.",
  RFQ_NOT_OPEN: "This request is no longer open.",
  RFQ_ATTACHMENT_LIMIT: "A request can have up to eight attachments.",
  DEMO_PDF_DISABLED: "PDF uploads are turned off in demo mode. Use images instead.",
  FILE_TOO_LARGE: "PDF files can be up to 20 MiB.",
  UNSUPPORTED_FILE_TYPE: "Use PNG, JPEG or WebP images (or a valid PDF when demo mode is off).",
};
