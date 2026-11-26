// For developers reading the demo: how it is wired, what the backend called, and which webhooks arrived.
import { api, useApi, useEvents, useOnline, useSession } from "../api/client";
import { fmtTime, Link } from "../ui";

export function Integration() {
  const session = useSession(), events = useEvents(), online = useOnline();
  const calls = useApi(() => api.calls());
  const app = session?.app;
  return <>
    <div className="page-header rq-page-head"><div><h1>Integration</h1><p className="rq-muted">For developers: where each call goes, what the demo backend sent to the HIOBuy Gateway, and the signed webhook events it received.</p></div></div>
    <section className="card rq-card">
      <h3>Architecture</h3>
      <div className="rq-arch">
        <div className="rq-arch-box"><b>Buyer's browser</b><span>This UI</span><small>No API key. Talks only to your backend, with a session cookie and CSRF token.</small></div>
        <div className="rq-arch-arrow">→<small>/api/*</small></div>
        <div className="rq-arch-box rq-arch-you"><b>Your backend</b><span><code>server/handler.mjs</code></span><small>Holds <code>HIOBUY_API_KEY</code>, maps the buyer to an opaque <code>external_user_id</code>, checks ownership of every RFQ, message and image, verifies webhooks.</small></div>
        <div className="rq-arch-arrow">→<small>HTTPS · Bearer key</small></div>
        <div className="rq-arch-box"><b>HIOBuy Gateway</b><span><code>api.hiobuy.com/v1/ask/*</code></span><small>Key → App. Scopes <code>rfq:read</code> / <code>rfq:write</code>.</small></div>
        <div className="rq-arch-arrow">→</div>
        <div className="rq-arch-box"><b>HIOAsk</b><span>Sourcing team console</span><small>Questions, quotations and status changes.</small></div>
      </div>
      <div className="rq-kvs">
        <div className="rq-kv"><span>App</span><div>{app?.ok ? <>{app.app_name || "—"} <span className="rq-muted">({app.environment ?? "unknown"} key)</span></> : <span className="rq-warn">Gateway identity unavailable{app && !app.ok ? ` — ${app.code}` : ""}</span>}</div></div>
        <div className="rq-kv"><span>RFQ access</span><div>{app?.ok && app.rfq ? <>{app.rfq.enabled ? "ready at the Gateway" : <span className="rq-warn">not ready at the Gateway</span>} · read {app.rfq.read ? "✓" : "✗"} · write {app.rfq.write ? "✓" : "✗"}</> : "—"}
          <div className="rq-muted">HIOAsk's own per-App RFQ switch is reported by the RFQ calls themselves (<code>RFQ_DISABLED</code>).</div></div></div>
        <div className="rq-kv"><span>Conversation access</span><div>{app?.ok && app.inquiry ? <>read {app.inquiry.read ? "✓" : "✗"} · write {app.inquiry.write ? "✓" : "✗"} <span className="rq-muted">(supplier_inquiry scopes, used for the RFQ's linked conversation)</span></> : "—"}</div></div>
        <div className="rq-kv"><span>Webhooks</span><div>{session?.webhook_configured ? <>Receiver at <code>/hooks/hiobuy</code> with a signing secret{app?.ok && app.rfq?.webhook_configured === false ? <span className="rq-warn"> · no ask.rfq.* subscription found for this App</span> : null}</> : <span className="rq-warn">No signing secret configured — events are not received; the UI still refreshes on focus.</span>}</div></div>
        <div className="rq-kv"><span>Demo mode</span><div>{session?.demo_mode ? <><b>On</b> — image uploads only; PDF uploads are refused by the demo backend (<code>DEMO_PDF_DISABLED</code>). Existing PDFs can still be downloaded.</> : <><b>Off</b> — PDFs up to 20 MiB can be uploaded. They are stored as uploaded, not scanned, and are always served as downloads.</>}</div></div>
        <div className="rq-kv"><span>Your references</span><div>Sent as <code>{session?.ref_prefix ?? "demo-…-"}&lt;your ref&gt;</code> so the sourcing team can recognise demo requests.</div></div>
      </div>
    </section>
    <div className="rq-two">
      <section className="card rq-card"><div className="rq-section-head"><h3>Calls your backend made</h3><span className="rq-muted">newest first · method, path and status only</span></div>
        {calls.data?.length ? <ul className="rq-calls">{calls.data.map(c => <li key={c.seq}><div className="rq-call"><code className={`rq-method rq-method-${c.method}`}>{c.method}</code><code>{c.path}</code><span className={c.status < 400 ? "rq-ok" : "rq-warn"}>{c.status}{c.code ? ` ${c.code}` : ""}</span><span className="rq-muted">{c.ms} ms · {fmtTime(c.at)}</span></div></li>)}</ul>
          : <p className="rq-muted">Use the app; each Gateway call appears here.</p>}</section>
      <section className="card rq-card"><div className="rq-section-head"><h3>Webhook events received</h3><span className={online ? "rq-muted" : "rq-warn"}>{online ? `${events.length}` : "backend unreachable"}</span></div>
        <p className="rq-muted">Verified (<code>HioBuy-Signature</code>), deduplicated by event id, then the UI re-reads the RFQ. Events are notices, not the source of truth.</p>
        {events.length ? <ul className="rq-events">{events.map(e => <li key={e.seq}><code>{e.type}</code>
          <span>{e.rfq_id ? <Link to={`/rfqs/${e.rfq_id}`}>RFQ</Link> : "conversation"}{e.summary.status ? ` → ${e.summary.status}` : ""}{e.summary.quotation_version ? ` · quote v${e.summary.quotation_version}` : ""}{e.deliveries > 1 ? ` · delivered ${e.deliveries}×` : ""}</span>
          <span className="rq-muted">{fmtTime(e.received_at)}</span></li>)}</ul> : <p className="rq-muted">No events yet.</p>}</section>
    </div>
  </>;
}
