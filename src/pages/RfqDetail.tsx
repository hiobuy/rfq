import { useRef, useState } from "react";
import type { DecisionAction, Quotation, Requirement, RequirementChange, Rfq } from "../api/types";
import { api, errorText, rfqImageUrl, useApi, useSession } from "../api/client";
import { demoConfig } from "../demo.config";
import { CLOSED, Failed, fmtDate, fmtMoney, fmtQty, fmtTime, fileAccept, ImageGrid, KV, Link, Loading, Modal, SAMPLE_LABEL, StatusChip, toast } from "../ui";
import { QuoteCard } from "../components/QuoteCard";
import { Composer, Thread } from "../components/Thread";
import { RequirementFields } from "./NewRfq";
import { type Draft, toRequirement } from "../requirement";

const STEPS = ["Submitted", "Review", "Sourcing", "Quoted", "Decision"];
const stepOf = (r: Rfq) => ({ new: 0, reviewing: 1, awaiting_clarification: 1, sourcing: 2, quoted: 3, revision_requested: 2, accepted: 4, unable_to_source: 4, closed: 4, cancelled: 4 } as const)[r.status];
const FIELD_LABEL: Partial<Record<keyof Requirement, string>> = { title: "Product", quantity: "Quantity", unit: "Unit", destination: "Destination",
  target_price: "Target price", target_currency: "Currency", target_price_unit: "Price unit", reference_url: "Reference link", needed_by: "Needed by",
  sample: "Samples", accept_similar: "Similar products", specs: "Specifications", branding: "Branding", packaging: "Packaging", monthly_volume: "Monthly volume" };
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v).length > 60 ? String(v).slice(0, 60) + "…" : String(v));

export function RfqDetail({ id }: { id: string }) {
  const { data, error, loading } = useApi(() => api.getRfq(id), [id]);
  const msgs = useApi(() => api.messages(id), [id]);
  const [modal, setModal] = useState<null | "edit" | "cancel" | { q: Quotation; action: DecisionAction }>(null);
  const [showHistory, setShowHistory] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  const demoMode = useSession()?.demo_mode !== false;
  const [uploading, setUploading] = useState(false);
  if (loading && !data) return <Loading />;
  if (!data) return error?.status === 404 ? <p>Request not found. <Link to="/rfqs">Back to RFQs</Link></p> : <Failed error={error} />;
  const r = data.data, history = data.history, req = r.requirement, q = r.latest_quotation;
  const open = !CLOSED.includes(r.status), step = stepOf(r);
  const provider = q?.provider_name || demoConfig.providerName;
  const upload = async (files: File[]) => {
    setUploading(true);
    let version = r.version;
    for (const file of files) {
      try { version = (await api.uploadImage(r.id, version, file)).rfq.version; }
      catch (e) { toast(`"${file.name}": ${errorText(e)}`); break; }
    }
    setUploading(false);
  };
  return <>
    <div className="page-header rq-page-head"><div>
      <p className="rq-crumb"><Link to="/rfqs">RFQs</Link> / {r.your_ref ?? r.number}</p>
      <h1>{req.title}</h1>
      <p className="rq-muted">{r.your_ref ? <>Your reference <b>{r.your_ref}</b> · </> : null}{r.number} · submitted {fmtTime(r.created_at)}{r.source === "staff" ? " · entered by the sourcing team" : ""}</p></div>
      <div className="rq-inline"><StatusChip status={r.status} />
        {open && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setModal("edit")}>Edit requirement</button>}
        {open && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModal("cancel")}>Cancel request</button>}</div></div>
    <ol className="rq-progress-steps">{STEPS.map((s, i) => <li key={s} className={i < step ? "done" : i === step ? "on" : ""}>{i === 4 && step === 4 ? ({ accepted: "Accepted", unable_to_source: "Unable to source", closed: "Closed", cancelled: "Cancelled" } as Record<string, string>)[r.status] ?? s : s}</li>)}</ol>
    {r.open_questions.length > 0 && <Questions r={r} />}
    {r.status === "unable_to_source" && <p className="rq-banner-red rq-inline-banner">The sourcing team cannot source this request{r.public_reason ? ` — ${r.public_reason}` : "."}</p>}
    {r.status === "cancelled" && <p className="rq-banner-gray rq-inline-banner">You cancelled this request{r.public_reason ? ` — ${r.public_reason}` : "."}</p>}
    {r.status === "accepted" && <p className="rq-banner-green rq-inline-banner"><b>You accepted a quotation — this is not a payment or a purchase order.</b> Place the order in your own fulfillment flow using your reference.</p>}
    {q?.is_stale && q.status === "sent" && <p className="rq-banner-orange rq-inline-banner">Your requirement changed after quotation v{q.version} was sent (priced against v{q.based_on_req_version}, now v{r.req_version}). The quotation stays as sent: wait for a revised version or decide on it as is.</p>}
    <div className="rq-dev-grid">
      <div>
        {q && <QuoteCard rfqId={r.id} q={q} currentReqVersion={r.req_version} actions={q.status === "sent" && r.status === "quoted" ? <>
          <span className="rq-muted">Valid until {fmtDate(q.valid_until)}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModal({ q, action: "rejected" })}>Decline</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setModal({ q, action: "revision_requested" })}>Request revision</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setModal({ q, action: "accepted" })}>Accept{q.options.length > 1 ? "…" : ""}</button></> : undefined} />}
        {q && q.version > 1 && <section className="rq-history"><button type="button" className="rq-text-button" onClick={() => setShowHistory(x => !x)}>{showHistory ? "Hide" : "Show"} earlier quotation versions</button>{showHistory && <QuoteHistory r={r} />}</section>}
        <section className="card rq-card">
          <div className="rq-section-head"><h3>Requirement <span className="tag">v{r.req_version}</span></h3>{open && <button type="button" className="rq-text-button" onClick={() => setModal("edit")}>Edit</button>}</div>
          <div className="rq-kvs">
            <KV k="Quantity">{fmtQty(req.quantity, req.unit)}</KV>
            <KV k="Target price">{req.target_price != null ? `${fmtMoney(req.target_price, req.target_currency)}${req.target_price_unit ? ` / ${req.target_price_unit}` : ""}` : "Not specified"}</KV>
            <KV k="Destination">{req.destination || "—"}</KV><KV k="Needed by">{req.needed_by || "—"}</KV>
            {req.monthly_volume ? <KV k="Monthly volume">{req.monthly_volume.toLocaleString("en-US")} {req.unit}/month</KV> : null}
            <KV k="Samples">{SAMPLE_LABEL[req.sample] ?? req.sample}</KV><KV k="Similar products">{req.accept_similar ? "Acceptable" : "Must match"}</KV>
            <KV k="Branding">{req.branding || "—"}</KV><KV k="Packaging">{req.packaging || "—"}</KV>
            {req.reference_url && <KV k="Reference link"><a href={req.reference_url} target="_blank" rel="noreferrer noopener">{req.reference_url}</a></KV>}
          </div>
          <h4>Specifications</h4>{req.specs ? <pre className="rq-specs">{req.specs}</pre> : <p className="rq-muted">No written specs — the sourcing team works from the link and images.</p>}
          <div className="rq-section-head"><h4>{demoMode ? "Images" : "Images and PDFs"}</h4>{open && <><button type="button" className="rq-text-button" disabled={uploading || r.attachments.length >= 8} onClick={() => pick.current?.click()}>{uploading ? "Uploading…" : demoMode ? "+ Add images" : "+ Add images or PDFs"}</button>
            <input ref={pick} type="file" multiple hidden accept={fileAccept(demoMode)} onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ""; if (files.length) void upload(files); }} /></>}</div>
          <ImageGrid items={r.attachments.map(a => ({ id: a.id, url: rfqImageUrl(r.id, a.id), name: a.filename, pdf: a.content_type === "application/pdf" }))} />
          <ChangeLog history={history} created={r.created_at} />
        </section>
      </div>
      <aside className="card rq-card rq-dev-thread"><h3>Conversation with {provider}</h3><p className="rq-muted">Messages are translated for the team; replies come back translated.</p>
        <div className="rq-side-body">{msgs.data ? <Thread messages={msgs.data.data} providerName={provider} /> : msgs.loading ? <Loading /> : <Failed error={msgs.error} />}</div>
        {msgs.data?.conversation && !["closed", "cancelled"].includes(r.status) && <Composer placeholder="Ask a question or add details…"
          onSend={text => api.sendMessage(r.id, text).catch(e => { toast(errorText(e)); throw e; })} />}
      </aside>
    </div>
    {modal === "edit" && <EditRequirement r={r} onClose={() => setModal(null)} />}
    {modal === "cancel" && <CancelModal r={r} onClose={() => setModal(null)} />}
    {modal && typeof modal === "object" && <DecisionModal r={r} q={modal.q} action={modal.action} onClose={() => setModal(null)} />}
  </>;
}

/** Open clarification questions from the sourcing team. Answering also posts a message in the conversation. */
function Questions({ r }: { r: Rfq }) {
  const [text, setText] = useState<Record<string, string>>({}), [busy, setBusy] = useState("");
  const send = async (questionId: string) => {
    setBusy(questionId);
    try { await api.answer(r.id, r.version, text[questionId]!.trim(), questionId); setText(t => ({ ...t, [questionId]: "" })); toast("Answer sent"); }
    catch (e) { toast(errorText(e)); } finally { setBusy(""); }
  };
  return <section className="card rq-card rq-questions"><h3>The sourcing team needs more information</h3>
    {r.open_questions.map(q => <div key={q.id} className="rq-question"><p><b>{q.text}</b> <span className="rq-muted">{fmtTime(q.created_at)}</span></p>
      <div className="rq-compose-row"><textarea rows={2} maxLength={4000} value={text[q.id] ?? ""} onChange={e => setText(t => ({ ...t, [q.id]: e.target.value }))} placeholder="Your answer" />
        <button type="button" className="btn btn-primary" disabled={!text[q.id]?.trim() || busy === q.id} onClick={() => void send(q.id)}>{busy === q.id ? "Sending…" : "Answer"}</button></div></div>)}
    <p className="rq-muted">You can also change fields with “Edit requirement”.</p>
  </section>;
}

function QuoteHistory({ r }: { r: Rfq }) {
  const { data, error } = useApi(() => api.quotations(r.id), [r.id]);
  if (!data) return error ? <Failed error={error} /> : <Loading />;
  const older = data.filter(x => x.version !== r.latest_quotation?.version);
  return <>{older.map(x => <details key={x.id}><summary>v{x.version} · {x.status.replace("_", " ")} · sent {fmtTime(x.sent_at)} · requirement v{x.based_on_req_version}</summary><QuoteCard rfqId={r.id} q={x} /></details>)}</>;
}

/** The public API returns the current requirement only; your backend keeps its own change log. */
function ChangeLog({ history, created }: { history: RequirementChange[]; created: string }) {
  if (!history.length) return null;
  return <details className="rq-reqhist"><summary>Change history · {history.length} change{history.length > 1 ? "s" : ""} (recorded by your backend)</summary>
    <ol>{[...history].reverse().map(h => <li key={h.version}><b>v{h.version}</b> <span className="rq-muted">{fmtTime(h.at)}</span>
      <ul>{h.changed.map((c, i) => <li key={i}>{FIELD_LABEL[c.field] ?? c.field}: {show(c.from)} → {show(c.to)}</li>)}</ul>{h.note && <p className="rq-muted">“{h.note}”</p>}</li>)}
      <li><b>v1</b> <span className="rq-muted">{fmtTime(created)} · original submission</span></li></ol></details>;
}

function EditRequirement({ r, onClose }: { r: Rfq; onClose: () => void }) {
  const [f, setF] = useState<Draft>({ ...r.requirement }), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  const next = toRequirement(f) as Partial<Requirement>;
  const keys = Object.keys(FIELD_LABEL) as (keyof Requirement)[];
  const patch = Object.fromEntries(keys.filter(k => JSON.stringify(next[k] ?? emptyOf(k)) !== JSON.stringify(r.requirement[k] ?? emptyOf(k))).map(k => [k, next[k] ?? emptyOf(k)])) as Partial<Requirement>;
  const changed = Object.keys(patch);
  const save = async () => {
    setBusy(true);
    try { await api.updateRequirement(r.id, r.version, patch, note.trim() || undefined); toast(changed.length ? `Saved as requirement v${r.req_version + 1}` : "Note sent"); onClose(); }
    catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  };
  const live = r.latest_quotation?.status === "sent" ? r.latest_quotation : null;
  return <Modal title={`Edit requirement · ${r.your_ref ?? r.number}`} wide onClose={onClose} footer={<><span className="rq-muted">{changed.length ? `${changed.length} change${changed.length > 1 ? "s" : ""} → saves as v${r.req_version + 1}` : "No field changes"}</span><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || (!changed.length && !note.trim())} onClick={() => void save()}>Save</button></>}>
    {live && <p className="rq-banner-orange rq-inline-banner">Quotation v{live.version} was priced against requirement v{live.based_on_req_version}. Saving creates requirement v{r.req_version + 1}; the quotation is not changed — the team decides whether to send a new version.</p>}
    <RequirementFields f={f} set={(k, v) => setF(x => ({ ...x, [k]: v }))} />
    <label className="field rq-mt"><span>Note to the sourcing team <small>(optional)</small></span><textarea rows={2} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} placeholder="What changed and why" /></label>
  </Modal>;
}
const emptyOf = (k: keyof Requirement) => (k === "target_price" || k === "monthly_volume" ? null : k === "accept_similar" ? false : k === "sample" ? "not_specified" : "");

function CancelModal({ r, onClose }: { r: Rfq; onClose: () => void }) {
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const ok = async () => { setBusy(true); try { await api.cancel(r.id, r.version, reason.trim() || undefined); toast("Request cancelled"); onClose(); } catch (e) { toast(errorText(e)); } finally { setBusy(false); } };
  return <Modal title="Cancel this request?" onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Back</button><button className="btn btn-danger" disabled={busy} onClick={() => void ok()}>Cancel request</button></>}>
    <p className="rq-muted">A quotation that is awaiting your decision is withdrawn.</p>
    <label className="field"><span>Reason (optional, shown to the sourcing team)</span><textarea rows={3} maxLength={1200} value={reason} onChange={e => setReason(e.target.value)} /></label></Modal>;
}

function DecisionModal({ r, q, action, onClose }: { r: Rfq; q: Quotation; action: DecisionAction; onClose: () => void }) {
  const [reason, setReason] = useState(""), [opt, setOpt] = useState(q.options[0]!.id), [busy, setBusy] = useState(false);
  const title = { accepted: `Accept quotation v${q.version}`, rejected: `Decline quotation v${q.version}`, revision_requested: `Request a revision of v${q.version}` }[action];
  const needReason = action !== "accepted";
  const ok = async () => {
    setBusy(true);
    try {
      await api.decide(r.id, q.version, r.version, action, action === "accepted" ? opt : undefined, reason.trim() || undefined);
      toast({ accepted: "Quotation accepted", rejected: "Quotation declined", revision_requested: "Revision requested" }[action]); onClose();
    } catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  };
  return <Modal title={title} onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Back</button><button className={`btn ${action === "rejected" ? "btn-danger" : "btn-primary"}`} disabled={busy || (needReason && !reason.trim())} onClick={() => void ok()}>{{ accepted: "Accept quotation", rejected: "Decline", revision_requested: "Send request" }[action]}</button></>}>
    {action === "accepted" && <><div className="rq-notice"><b>Accepting is not a payment or a purchase order.</b> It tells the sourcing team which option you want. Place the order in your own fulfillment flow.</div>
      {q.options.length > 1 && <fieldset className="rq-options-pick">{q.options.map(o => <label key={o.id}><input type="radio" name="opt" checked={opt === o.id} onChange={() => setOpt(o.id)} /><span><b>Option {o.label}</b> · {fmtMoney(o.unit_price, o.currency)}/{o.unit} · {o.plan}</span></label>)}</fieldset>}</>}
    {action === "revision_requested" && <p className="rq-muted">Tell the team what to change (price, quantity, materials, lead time…). They send a new version; this one stays in the history.</p>}
    <label className="field"><span>{action === "accepted" ? "Note (optional)" : action === "revision_requested" ? "What should change? *" : "Reason *"}</span><textarea rows={3} maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} /></label>
  </Modal>;
}
