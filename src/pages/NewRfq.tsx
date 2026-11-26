import { useRef, useState } from "react";
import type { SampleRequirement } from "../api/types";
import { type Draft, draftValid, emptyDraft as baseDraft, toRequirement } from "../requirement";
import { api, errorText, useSession } from "../api/client";
import { EXAMPLES, demoConfig } from "../demo.config";
import { fileAccept, go, Link, toast } from "../ui";

type Set = <K extends keyof Draft>(k: K, v: Draft[K]) => void;
const UNITS = ["pcs", "set", "pair", "carton", "kg", "m"];
const num = (v: string) => (v === "" ? null : Number(v));
const emptyDraft = () => baseDraft(demoConfig.defaultDestination);

export function SampleSelect({ value, onChange }: { value: SampleRequirement; onChange: (v: SampleRequirement) => void }) {
  return <select value={value} onChange={e => onChange(e.target.value as SampleRequirement)}><option value="not_specified">Not specified</option><option value="none">No sample needed</option><option value="preferred">Sample preferred</option><option value="required">Sample required</option></select>;
}

/** Structured fields shared by "New RFQ" and "Edit requirement". */
export function RequirementFields({ f, set }: { f: Draft; set: Set }) {
  return <div className="rq-form">
    <label className="field"><span>Product name *</span><input value={f.title} maxLength={200} onChange={e => set("title", e.target.value)} placeholder="e.g. Stainless steel water bottle" /></label>
    <label className="field"><span>Quantity (first order) *</span><div className="rq-input-group"><input type="number" min="0" value={f.quantity ?? ""} onChange={e => set("quantity", num(e.target.value))} /><select value={f.unit} onChange={e => set("unit", e.target.value)} style={{ maxWidth: 110 }}>{[...new Set([f.unit, ...UNITS])].map(u => <option key={u}>{u}</option>)}</select></div></label>
    <label className="field"><span>Destination country / region *</span><input value={f.destination} onChange={e => set("destination", e.target.value)} /></label>
    <label className="field"><span>Target price <small>(optional)</small></span><div className="rq-input-group"><select value={f.target_currency || "USD"} onChange={e => set("target_currency", e.target.value)} style={{ maxWidth: 80 }}><option>USD</option><option>EUR</option><option>GBP</option><option>CNY</option></select><input type="number" step="0.01" min="0" value={f.target_price ?? ""} onChange={e => set("target_price", num(e.target.value))} placeholder="0.00" /><input value={f.target_price_unit} onChange={e => set("target_price_unit", e.target.value)} placeholder="per" style={{ maxWidth: 80 }} /></div><small className="field-hint">Product cost target only. Shipping is quoted separately.</small></label>
    <label className="field"><span>Product URL / reference link</span><input value={f.reference_url} maxLength={512} onChange={e => set("reference_url", e.target.value)} placeholder="https://" /></label>
    <label className="field"><span>Needed by</span><input type="date" value={f.needed_by} onChange={e => set("needed_by", e.target.value)} /></label>
    <label className="field"><span>Samples</span><SampleSelect value={f.sample} onChange={v => set("sample", v)} /></label>
    <label className="field"><span>Expected monthly volume <small>(optional)</small></span><input type="number" min="0" value={f.monthly_volume ?? ""} onChange={e => set("monthly_volume", num(e.target.value))} /></label>
    <label className="field"><span>Packaging</span><input value={f.packaging} onChange={e => set("packaging", e.target.value)} placeholder="e.g. Retail box, neutral poly bag" /></label>
    <label className="field"><span>Branding / logo</span><input value={f.branding} onChange={e => set("branding", e.target.value)} placeholder="e.g. Laser-engraved logo, private label" /></label>
    <label className="rq-check rq-span2"><input type="checkbox" checked={f.accept_similar} onChange={e => set("accept_similar", e.target.checked)} /> Accept similar products if the exact model is unavailable</label>
    <label className="field rq-span2"><span>Specifications and details {f.reference_url.trim() ? <small>(optional — link provided)</small> : "*"}</span><textarea rows={5} maxLength={5000} value={f.specs} onChange={e => set("specs", e.target.value)} placeholder="Material, size, colours, certifications, questions for the factory…" /></label>
  </div>;
}

export function NewRfq() {
  const session = useSession();
  const [ref, setRef] = useState(""), [f, setF] = useState<Draft>(emptyDraft()), [files, setFiles] = useState<File[]>([]), [busy, setBusy] = useState("");
  const pick = useRef<HTMLInputElement>(null);
  const set: Set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const valid = draftValid(f);
  const example = (i: number) => { const e = EXAMPLES[i % EXAMPLES.length]!; setRef(e.ref); setF({ ...emptyDraft(), ...e.requirement }); };
  const submit = async () => {
    if (!valid) return toast("Fill in product name, quantity, destination, and specs or a reference link.");
    setBusy("Submitting…");
    try {
      let rfq = await api.createRfq({ requirement: toRequirement(f), your_ref: ref.trim() || undefined });
      // Images are uploaded after creation, one at a time; each upload needs the RFQ's current version.
      for (const [i, file] of files.entries()) {
        setBusy(`Uploading image ${i + 1} of ${files.length}…`);
        try { rfq = (await api.uploadImage(rfq.id, rfq.version, file)).rfq; }
        catch (e) { toast(`Image "${file.name}" was not added: ${errorText(e)}`); }
      }
      toast("RFQ submitted");
      go(`/rfqs/${rfq.id}`);
    } catch (e) { toast(errorText(e)); } finally { setBusy(""); }
  };
  return <>
    <div className="page-header rq-page-head"><div><p className="rq-crumb"><Link to="/rfqs">RFQs</Link> / New</p><h1>New request for quotation</h1><p className="rq-muted">One product per request. Specifications or a reference link are required; photos help the sourcing team.</p></div>
      <button type="button" className="btn btn-ghost" onClick={() => example(Math.floor(Math.random() * EXAMPLES.length))}>Fill with an example</button></div>
    <div className="rq-newgrid">
      <div className="rq-newmain">
        <section className="card rq-card"><h3 className="rq-sec-title"><i />Your reference</h3>
          <div className="rq-form">
            <label className="field rq-span2"><span>Your order / request number <small>(optional)</small></span><input value={ref} maxLength={40} onChange={e => setRef(e.target.value)} placeholder="e.g. PO-1042" />
              <small className="field-hint">Sent as <code>external_ref</code>{session ? <> = <code>{session.ref_prefix}{ref.trim() || "…"}</code></> : null}. The demo prefix keeps demo requests recognizable for the sourcing team; your own backend would send your real number.</small></label>
          </div>
        </section>
        <section className="card rq-card"><h3 className="rq-sec-title"><i />Requirement</h3><RequirementFields f={f} set={set} /></section>
      </div>
      <aside className="rq-newside">
        <section className="card rq-card"><h3 className="rq-sec-title"><i />{session?.demo_mode === false ? "Reference images and PDFs" : "Reference images"}</h3>
          <div className="rq-dropzone rq-dropzone-sm"><div className="rq-drop-icon">⇪</div><b>{session?.demo_mode === false ? "Add photos or PDFs" : "Add product photos"}</b><span className="rq-muted">{session?.demo_mode === false ? "PNG, JPEG, WebP (10 MiB) or PDF (20 MiB) · max 8" : "PNG, JPEG or WebP · up to 10 MiB each · max 8 · PDFs are off in demo mode"}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => pick.current?.click()}>Choose files</button>
            <input ref={pick} type="file" multiple hidden accept={fileAccept(session?.demo_mode !== false)} onChange={e => { const list = Array.from(e.target.files ?? []); e.target.value = ""; setFiles(x => [...x, ...list].slice(0, 8)); }} /></div>
          {files.length > 0 && <ul className="rq-filelist">{files.map((file, i) => <li key={i}><span>{file.name}</span><button type="button" className="rq-text-button" aria-label="Remove" onClick={() => setFiles(x => x.filter((_, j) => j !== i))}>×</button></li>)}</ul>}
          <p className="rq-muted rq-mt">Files are uploaded right after the request is created.</p>
        </section>
        <section className="card rq-card rq-submit-card"><h3>Ready to submit?</h3>
          <p className="rq-muted">{demoConfig.responseTimePromise}</p>
          <button type="button" className="btn btn-primary rq-block" disabled={!valid || Boolean(busy)} onClick={() => void submit()}>{busy || "Submit RFQ"}</button>
          {!valid && <p className="rq-muted rq-center">Fill in product name, quantity and destination, and describe the product with specs or a link.</p>}
          <Link to="/rfqs" className="btn btn-ghost rq-block">Cancel</Link>
        </section>
      </aside>
    </div>
  </>;
}
