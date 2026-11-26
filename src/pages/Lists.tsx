import { useState } from "react";
import type { Rfq } from "../api/types";
import { api, useApi } from "../api/client";
import { CLOSED, Failed, fmtMoney, fmtQty, fmtTime, Link, Loading, StatusChip } from "../ui";

type Filter = "action" | "open" | "closed" | "all";
export const needsAction = (r: Rfq) => r.status === "awaiting_clarification" || r.latest_quotation?.status === "sent";
const quoteSummary = (r: Rfq) => {
  const q = r.latest_quotation;
  if (!q) return "—";
  return `v${q.version} · ${q.options.length > 1 ? `${q.options.length} options` : fmtMoney(q.options[0]?.unit_price, q.options[0]?.currency)}`;
};

export function RfqList() {
  const { data, error, loading } = useApi(() => api.listRfqs());
  const [filter, setFilter] = useState<Filter>("all"), [q, setQ] = useState("");
  if (loading && !data) return <Loading />;
  if (!data) return <Failed error={error} />;
  const rfqs = data;
  const shown = rfqs.filter(r => (filter === "all" || (filter === "action" ? needsAction(r) : filter === "closed" ? CLOSED.includes(r.status) : !CLOSED.includes(r.status)))
    && (!q || `${r.your_ref ?? ""} ${r.requirement.title} ${r.number}`.toLowerCase().includes(q.toLowerCase())));
  const counts = { action: rfqs.filter(needsAction).length, open: rfqs.filter(r => !CLOSED.includes(r.status)).length, closed: rfqs.filter(r => CLOSED.includes(r.status)).length, all: rfqs.length };
  return <>
    <div className="page-header rq-page-head"><div><h1>Requests for quotation</h1><p className="rq-muted">Send structured sourcing requests; the sourcing team replies with formal quotations. Accepting a quotation is not an order or a payment — ordering continues in your own flow.</p></div>
      <Link to="/new" className="btn btn-primary">New RFQ</Link></div>
    <div className="card rq-card">
      <div className="rq-toolbar">
        <div className="rq-seg">{([["action", "Needs your action"], ["open", "Open"], ["closed", "Finished"], ["all", "All"]] as [Filter, string][]).map(([k, label]) => <button key={k} type="button" className={filter === k ? "active" : ""} onClick={() => setFilter(k)}>{label} <span className="rq-count">{counts[k]}</span></button>)}</div>
        <input className="rq-search" placeholder="Search reference, product, RFQ number" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      {shown.length ? <div className="table-wrap"><table className="table rq-table"><thead><tr><th>Your reference</th><th>Product</th><th>Quantity</th><th>Status</th><th>Quotation</th><th>Updated</th></tr></thead>
        <tbody>{shown.map(r => <tr key={r.id} className={needsAction(r) ? "rq-row-action" : ""}>
          <td><Link to={`/rfqs/${r.id}`}><b>{r.your_ref ?? "—"}</b></Link><div className="rq-muted">{r.number}</div></td>
          <td><Link to={`/rfqs/${r.id}`}>{r.requirement.title}</Link>
            {r.req_version > 1 && <div className="rq-muted">requirement v{r.req_version}{r.latest_quotation?.is_stale ? " · quote based on an older version" : ""}</div>}</td>
          <td>{fmtQty(r.requirement.quantity, r.requirement.unit)}</td><td><StatusChip status={r.status} /></td>
          <td>{quoteSummary(r)}</td><td className="rq-muted">{fmtTime(r.updated_at)}</td></tr>)}</tbody></table></div>
        : <div className="rq-empty">{rfqs.length ? "No requests match." : <>No RFQs yet. <Link to="/new">Create one</Link>.</>}</div>}
    </div>
  </>;
}
