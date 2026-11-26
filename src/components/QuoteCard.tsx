import type { ReactNode } from "react";
import type { FeeKind, Quotation } from "../api/types";
import { rfqImageUrl } from "../api/client";
import { fmtDate, fmtMoney, fmtNum, QuoteChip } from "../ui";

const FEE_LABEL: Record<FeeKind, string> = { sample: "Sample fee", tooling: "Tooling / mould", service: "Service fee", shipping: "Shipping", other: "Other" };
const MATCH_LABEL = { exact: "Exact match", similar: "Similar product", custom: "Custom solution" } as const;
const DECISION_LABEL = { accepted: "You accepted", rejected: "You declined", revision_requested: "You requested a revision" } as const;

/** A formal quotation as the API returns it. HIOAsk never exposes supplier identity, contacts or cost. */
export function QuoteCard({ rfqId, q, actions, currentReqVersion }: { rfqId: string; q: Quotation; actions?: ReactNode; currentReqVersion?: number }) {
  const stale = q.is_stale || (currentReqVersion != null && q.based_on_req_version < currentReqVersion);
  // An option's image_id resolves inside this quotation version's attachments only.
  const image = (id: string | null) => (id ? q.attachments.find(a => a.id === id) : undefined);
  return <article className={`rq-quote rq-quote-${q.status}`}>
    <header>
      <div><strong>{q.number}</strong><span className="rq-muted"> · {q.provider_name ? `${q.provider_name} · ` : ""}valid until {fmtDate(q.valid_until)} · sent {fmtDate(q.sent_at)} · priced against requirement v{q.based_on_req_version}</span></div>
      <QuoteChip status={q.status} />
    </header>
    {stale && ["sent", "accepted"].includes(q.status) && <p className="rq-stale">⚠ Priced against requirement v{q.based_on_req_version}{currentReqVersion ? `; your requirement is now v${currentReqVersion}` : ""}. The quotation is not updated automatically — the sourcing team sends a new version if the price changes.</p>}
    <div className="rq-quote-options">{q.options.map(o => {
      const img = image(o.image_id), product = Math.round(o.unit_price * o.quantity * 100) / 100;
      return <div key={o.id} className={`rq-option${q.decision?.option_id === o.id ? " rq-option-picked" : ""}`}>
        <div className="rq-option-top">
          {img ? <img src={rfqImageUrl(rfqId, img.id)} alt="" className="rq-option-img" loading="lazy" /> : <span className="rq-option-img rq-option-noimg">No image</span>}
          <div className="rq-option-main">
            <div className="rq-option-head"><span className="rq-option-label">Option {o.label}</span><span className={`rq-match rq-match-${o.match_type}`}>{MATCH_LABEL[o.match_type]}</span><span className="rq-option-price">{fmtMoney(o.unit_price, o.currency)}<small> / {o.unit}</small></span></div>
            <p className="rq-option-plan">{o.plan}</p>
            {o.sku && <p className="rq-option-meta"><b>SKU</b> {o.sku}</p>}
            {o.specs && <p className="rq-option-meta"><b>Specs</b> {o.specs}</p>}
          </div>
        </div>
        {o.differences && <p className="rq-diff"><b>Differences from your request</b> {o.differences}</p>}
        <dl className="rq-option-grid">
          <div><dt>Quoted qty</dt><dd>{fmtNum(o.quantity)} {o.unit}</dd></div>
          <div><dt>MOQ</dt><dd>{o.moq == null ? "—" : `${fmtNum(o.moq)} ${o.unit}`}</dd></div>
          <div><dt>Lead time</dt><dd>{o.lead_time || "—"}</dd></div>
          <div><dt>Trade terms</dt><dd>{o.incoterm || "—"}{o.shipping ? ` · ${o.shipping}` : ""}</dd></div>
          {o.packaging && <div className="rq-span-all"><dt>Packaging</dt><dd>{o.packaging}</dd></div>}
        </dl>
        <table className="rq-fees"><tbody>
          <tr><td>Product <span className="rq-muted">{fmtMoney(o.unit_price, o.currency)} × {fmtNum(o.quantity)}</span></td><td>{fmtMoney(product, o.currency)}</td><td><span className="rq-fee-ok">Confirmed</span></td></tr>
          {o.fees.map((f, i) => <tr key={i} className={f.confirmed ? "" : "rq-fee-pending-row"}><td>{f.label || FEE_LABEL[f.kind]}{f.note ? <span className="rq-muted"> · {f.note}</span> : null}</td>
            <td>{f.amount != null ? fmtMoney(f.amount, o.currency) : "—"}</td><td>{f.confirmed ? <span className="rq-fee-ok">Confirmed</span> : <span className="rq-fee-pending">To be confirmed</span>}</td></tr>)}
          <tr className="rq-fee-total"><td>Confirmed total</td><td>{fmtMoney(o.confirmed_total, o.currency)}</td><td>{o.pending_fees ? <span className="rq-muted">+ {o.pending_fees} to be confirmed</span> : null}</td></tr>
        </tbody></table>
        {o.notes && <p className="rq-option-notes">{o.notes}</p>}
      </div>;
    })}</div>
    {q.terms && <p className="rq-quote-terms">{q.terms}</p>}
    {q.decision && <p className={`rq-decision rq-decision-${q.decision.action}`}>{DECISION_LABEL[q.decision.action]}{q.decision.option_id ? ` · option ${q.options.find(o => o.id === q.decision!.option_id)?.label ?? ""}` : ""}{q.decision.reason ? ` — “${q.decision.reason}”` : ""}</p>}
    {actions && <footer>{actions}</footer>}
  </article>;
}
