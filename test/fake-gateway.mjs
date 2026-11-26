// In-memory stand-in for https://api.hiobuy.com/v1/ask/* (RFQ subset), used as `fetchImpl`.
// It mirrors the documented response envelopes ({data}, {data, pagination}) and error shape.
export const API_KEY = "hb_test_key_for_demo_only_0001";

const uuid = () => crypto.randomUUID();
const err = (status, code, message = code, headers = {}) =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "Content-Type": "application/json", ...headers } });
const ok = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify({ data, ...extra }), { status, headers: { "Content-Type": "application/json" } });

export function createFakeGateway() {
  const rfqs = new Map(), messages = new Map(), images = new Map(), idem = new Map();
  const calls = [];
  let seq = 0;
  const now = () => new Date(Date.UTC(2026, 10, 25, 12, 0, seq++)).toISOString();

  function newRfq(body) {
    const id = uuid(), conversation_id = uuid();
    const rfq = { id, number: `RFQ-2611-${String(rfqs.size + 1).padStart(4, "0")}`, external_ref: body.external_ref ?? null,
      external_user_id: body.external_user_id ?? null, external_batch_ref: null, batch_id: null, status: "new", source: "api",
      req_version: 1, requirement: { ...body.requirement }, attachments: [], open_questions: [], latest_quotation: null,
      conversation_id, closed_reason: null, public_reason: null, created_at: now(), updated_at: now(), version: 1, quotations: [] };
    rfqs.set(id, rfq);
    messages.set(conversation_id, []);
    return rfq;
  }
  const view = ({ quotations, ...rfq }) => rfq;
  const bump = (r) => { r.version++; r.updated_at = now(); };

  async function fetchImpl(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method ?? "GET", headers = new Headers(init.headers);
    calls.push({ method, path: url.pathname + url.search, headers: Object.fromEntries(headers) });
    if (headers.get("authorization") !== `Bearer ${API_KEY}`) return err(401, "UNAUTHORIZED");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    const key = headers.get("idempotency-key");
    if (method !== "GET") {
      if (!key) return err(400, "IDEMPOTENCY_KEY_REQUIRED");
      const replay = idem.get(`${method} ${url.pathname} ${key}`);
      if (replay) return ok(replay.data, 200);
    }
    const remember = (data, status = 200) => { if (key) idem.set(`${method} ${url.pathname} ${key}`, { data }); return ok(data, status); };
    const p = url.pathname;
    let m;
    if (p === "/v1/ask/identity") return ok({ app: { id: "app_demo", name: "Demo App" }, api_key: { environment: "production" },
      inquiry: { enabled: true, read: true, write: true }, rfq: { enabled: true, read: true, write: true, webhook_configured: true } });
    if (p === "/v1/ask/rfqs" && method === "GET") {
      const user = url.searchParams.get("external_user_id");
      return ok([...rfqs.values()].filter((r) => !user || r.external_user_id === user).reverse().map(view), 200, { pagination: { next_cursor: null } });
    }
    if (p === "/v1/ask/rfqs" && method === "POST") {
      if (!body.requirement?.specs && !body.requirement?.reference_url) return err(400, "REQUIREMENT_TOO_VAGUE");
      return remember(view(newRfq(body)), 201);
    }
    if ((m = p.match(/^\/v1\/ask\/rfqs\/([^/]+)(?:\/(.*))?$/))) {
      const r = rfqs.get(m[1]), rest = m[2];
      if (!r) return err(404, "NOT_FOUND", "RFQ not found");
      if (!rest && method === "GET") return ok(view(r));
      if (rest === "quotations") return ok([...r.quotations].reverse());
      const check = (v) => v !== r.version ? err(409, "VERSION_CONFLICT", "RFQ changed; reload and retry") : null;
      if (rest === "requirement" && method === "PATCH") {
        const c = check(body.version); if (c) return c;
        r.requirement = { ...r.requirement, ...body.requirement }; r.req_version++; bump(r);
        return remember(view(r));
      }
      if (rest === "cancel") {
        const c = check(body.version); if (c) return c;
        r.status = "cancelled"; r.closed_reason = "cancelled"; bump(r); return remember(view(r));
      }
      if (rest === "answers") {
        const c = check(body.version); if (c) return c;
        r.open_questions = r.open_questions.filter((q) => body.question_id && q.id !== body.question_id);
        r.status = r.open_questions.length ? r.status : "reviewing"; bump(r);
        messages.get(r.conversation_id).push({ id: uuid(), sender_type: "customer", type: "text", content: body.text, created_at: now() });
        return remember(view(r));
      }
      if ((m = rest?.match(/^quotations\/(\d+)\/decision$/))) {
        const c = check(body.version); if (c) return c;
        const q = r.quotations.find((x) => x.version === Number(m[1]));
        if (!q || q.status !== "sent") return err(409, "QUOTATION_NOT_CURRENT");
        if (Date.parse(q.valid_until) <= Date.now()) return err(409, "QUOTATION_EXPIRED", "Quotation has expired");
        if (body.action === "accepted" && q.options.length > 1 && !body.option_id) return err(400, "OPTION_REQUIRED");
        q.status = body.action; q.decision = { action: body.action, option_id: body.option_id ?? null, reason: body.reason ?? "" };
        r.status = body.action === "accepted" ? "accepted" : body.action === "revision_requested" ? "revision_requested" : "closed";
        r.latest_quotation = q; bump(r);
        return remember(view(r));
      }
      if (rest === "attachments" && method === "POST") {
        if (Number(headers.get("x-rfq-version")) !== r.version) return err(409, "VERSION_CONFLICT");
        const a = { id: uuid(), filename: decodeURIComponent(headers.get("x-image-filename") ?? "image"), content_type: headers.get("content-type"),
          content_path: "" };
        a.content_path = `/v1/ask/rfqs/${r.id}/attachments/${a.id}/content`;
        images.set(a.id, { bytes: body, type: a.content_type, rfq: r.id });
        r.attachments.push(a); bump(r);
        return remember(a, 201);
      }
      if ((m = rest?.match(/^attachments\/([^/]+)\/content$/))) {
        const img = images.get(m[1]);
        if (!img || img.rfq !== r.id) return err(404, "NOT_FOUND");
        return new Response(img.bytes, { status: 200, headers: { "Content-Type": img.type, "Content-Length": String(img.bytes.byteLength) } });
      }
    }
    if ((m = p.match(/^\/v1\/ask\/conversations\/([^/]+)\/messages$/))) {
      const list = messages.get(m[1]);
      if (!list) return err(404, "CONVERSATION_NOT_FOUND");
      if (method === "GET") return ok([...list].reverse(), 200, { pagination: { next_cursor: null } }); // newest first, like the live API
      const msg = { id: uuid(), sender_type: "customer", type: "text", content: body.content, created_at: now(), client_message_id: body.client_message_id };
      list.push(msg);
      return remember(msg, 201);
    }
    if ((m = p.match(/^\/v1\/ask\/attachments\/([^/]+)\/content$/))) {
      const img = images.get(m[1]);
      return img ? new Response(img.bytes, { status: 200, headers: { "Content-Type": img.type } }) : err(404, "NOT_FOUND");
    }
    return err(404, "NOT_FOUND");
  }

  // Staff-side helpers (HIOAsk console actions the demo cannot perform through the public API).
  const staff = {
    ask(rfqId, text) {
      const r = rfqs.get(rfqId), q = { id: uuid(), text, created_at: now() };
      r.open_questions.push(q); r.status = "awaiting_clarification"; bump(r);
      messages.get(r.conversation_id).push({ id: q.id, sender_type: "staff", type: "text", content: text, created_at: now() });
      return q;
    },
    quote(rfqId, { options = 1, validUntil = "2099-01-01T00:00:00.000Z" } = {}) {
      const r = rfqs.get(rfqId), version = r.quotations.length + 1;
      for (const old of r.quotations) if (old.status === "sent") old.status = "superseded";
      const q = { id: uuid(), number: `${r.number}-Q${version}`, version, based_on_req_version: r.req_version, valid_until: validUntil,
        status: "sent", terms: "FOB Ningbo. Payment terms agreed at order.", provider_name: "Demo Sourcing Desk", response_time_promise: "",
        options: Array.from({ length: options }, (_, i) => ({ id: `opt-${i + 1}`, label: String.fromCharCode(65 + i), plan: `Plan ${i + 1}`,
          match_type: "exact", image_id: null, sku: "", specs: "", differences: "", quantity: 500, unit: "pcs", unit_price: 2.5 + i,
          currency: "USD", moq: 300, lead_time: "20 days", packaging: "", incoterm: "FOB", shipping: "", notes: "",
          fees: [{ kind: "sample", label: "", amount: 30, confirmed: true, note: "" }], confirmed_total: 1280 + i * 500, pending_fees: 0 })),
        attachments: [], is_stale: false, sent_at: now(), decided_at: null, decision: null };
      r.quotations.push(q); r.latest_quotation = q; r.status = "quoted"; bump(r);
      return q;
    },
    staffImage(rfqId) { // a staff message image in the RFQ conversation
      const r = rfqs.get(rfqId), id = uuid();
      images.set(id, { bytes: new Uint8Array([137, 80, 78, 71]), type: "image/png", rfq: null });
      messages.get(r.conversation_id).push({ id: uuid(), sender_type: "staff", type: "image", content: "", created_at: now(),
        attachments: [{ id, content_type: "image/png", filename: "photo.png" }] });
      return id;
    },
  };
  return { fetchImpl, calls, rfqs, staff };
}
