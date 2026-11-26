import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { QuoteStatus, RfqStatus, SampleRequirement } from "./api/types";

// --- hash router ---
const subscribeHash = (cb: () => void) => { window.addEventListener("hashchange", cb); return () => window.removeEventListener("hashchange", cb); };
export function useRoute(): string[] {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return hash.replace(/^#\/?/, "").split("?")[0]!.split("/").filter(Boolean);
}
export const go = (path: string) => { window.location.hash = path.startsWith("#") ? path : `#${path}`; };
export function Link({ to, className, children, title }: { to: string; className?: string; children: ReactNode; title?: string }) {
  return <a href={`#${to}`} className={className} title={title}>{children}</a>;
}

// --- labels & formatting ---
// Public statuses map 1:1 to HIOAsk statuses; "reviewing" and "sourcing" both mean "in progress" to a buyer.
export const STATUS_LABEL: Record<RfqStatus, string> = { new: "Submitted", reviewing: "In review", awaiting_clarification: "Needs your info", sourcing: "Sourcing", quoted: "Quoted", revision_requested: "Revision requested", accepted: "Accepted", unable_to_source: "Unable to source", closed: "Closed", cancelled: "Cancelled" };
const STATUS_TONE: Record<RfqStatus, string> = { new: "blue", reviewing: "blue", awaiting_clarification: "orange", sourcing: "purple", quoted: "teal", revision_requested: "orange", accepted: "green", unable_to_source: "red", closed: "gray", cancelled: "gray" };
export const QUOTE_LABEL: Record<QuoteStatus, string> = { sent: "Awaiting your decision", accepted: "Accepted", rejected: "Declined", revision_requested: "Revision requested", superseded: "Replaced by a newer version", expired: "Expired", withdrawn: "Withdrawn" };
const QUOTE_TONE: Record<QuoteStatus, string> = { sent: "teal", accepted: "green", rejected: "red", revision_requested: "orange", superseded: "gray", expired: "gray", withdrawn: "gray" };
export const SAMPLE_LABEL: Record<SampleRequirement, string> = { not_specified: "Not specified", none: "No sample needed", preferred: "Sample preferred", required: "Sample required" };
export const CLOSED: RfqStatus[] = ["accepted", "closed", "cancelled", "unable_to_source"];

export const fmtNum = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
export const fmtMoney = (v: number | null | undefined, cur?: string) => (v == null ? "—" : `${cur ?? ""} ${v.toLocaleString("en-US", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 4 })}`.trim());
export const fmtQty = (q: number | null | undefined, unit: string) => (q == null ? "—" : `${fmtNum(q)} ${unit || ""}`.trim());
export const fmtTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "—");
export const fmtDate = (iso?: string | null) => (iso ? iso.slice(0, 10) : "—");

export function StatusChip({ status }: { status: RfqStatus }) { return <span className={`rq-chip rq-tone-${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>; }
export function QuoteChip({ status }: { status: QuoteStatus }) { return <span className={`rq-chip rq-tone-${QUOTE_TONE[status]}`}>{QUOTE_LABEL[status]}</span>; }

// --- modal & toast ---
export function Modal({ title, onClose, children, wide, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current!; if (!d.open) d.showModal(); }, []);
  return <dialog ref={ref} className={`rq-modal${wide ? " rq-modal-wide" : ""}`} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === ref.current) onClose(); }}>
    <button type="button" className="rq-modal-close" aria-label="Close" onClick={onClose}>×</button>
    <h2>{title}</h2>
    <div className="rq-modal-body">{children}</div>
    {footer && <div className="rq-modal-actions">{footer}</div>}
  </dialog>;
}
let toastSet: ((t: string) => void) | null = null;
export const toast = (t: string) => toastSet?.(t);
export function ToastHost() {
  const [text, setText] = useState("");
  useEffect(() => { toastSet = setText; return () => { toastSet = null; }; }, []);
  useEffect(() => { if (!text) return; const id = setTimeout(() => setText(""), 4000); return () => clearTimeout(id); }, [text]);
  return text ? <div className="rq-toast" role="status">{text}</div> : null;
}

// --- images (served through the demo backend; never direct storage URLs) ---
export function ImageGrid({ items }: { items: { id: string; url: string; name: string; pdf?: boolean }[] }) {
  const [open, setOpen] = useState<{ url: string; name: string } | null>(null);
  if (!items.length) return <p className="rq-muted">No files</p>;
  return <>
    <div className="rq-gallery">{items.map(a => a.pdf ? <figure key={a.id} className="rq-att rq-att-pdf">
      <a href={a.url} download className="rq-file" title={`Download ${a.name}`}><span>PDF</span></a>
      <figcaption>{a.name}</figcaption>
    </figure> : <figure key={a.id} className="rq-att rq-att-image">
      <button type="button" onClick={() => setOpen(a)} title={a.name}><img src={a.url} alt={a.name} loading="lazy" /></button>
      <figcaption>{a.name}</figcaption>
    </figure>)}</div>
    {open && <Modal title={open.name} onClose={() => setOpen(null)} wide><img className="rq-lightbox" src={open.url} alt={open.name} /></Modal>}
  </>;
}
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";
/** Demo mode (default) accepts images only; PDFs only when the backend runs with DEMO_MODE=false. */
export const fileAccept = (demoMode: boolean) => (demoMode ? IMAGE_ACCEPT : `${IMAGE_ACCEPT},application/pdf`);
export function KV({ k, children }: { k: ReactNode; children: ReactNode }) { return <div className="rq-kv"><span>{k}</span><div>{children}</div></div>; }
export function Loading() { return <div className="rq-empty">Loading…</div>; }
export function Failed({ error }: { error?: Error }) { return <div className="rq-empty rq-warn">Could not load: {error?.message ?? "unknown error"}</div>; }
