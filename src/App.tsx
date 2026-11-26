import { useEffect, useState } from "react";
import { api, loadSession, useApi, useOnline, useSession } from "./api/client";
import { demoConfig } from "./demo.config";
import { go, Link, ToastHost, useRoute } from "./ui";
import { needsAction, RfqList } from "./pages/Lists";
import { NewRfq } from "./pages/NewRfq";
import { RfqDetail } from "./pages/RfqDetail";
import { Integration } from "./pages/Integration";

const NAV: [string, string, string][] = [
  ["rfqs", "RFQs", "M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5M9 13h6M9 17h4"],
  ["new", "New", "M12 5v14M5 12h14"],
  ["integration", "API", "M8 9l-4 3 4 3M16 9l4 3-4 3M13 6l-2 12"],
];

export function App() {
  const session = useSession();
  const [failure, setFailure] = useState("");
  useEffect(() => { loadSession().catch(e => setFailure(String(e?.message ?? e))); }, []);
  if (!session) return <div className="rq-empty">{failure ? <>The demo backend is not reachable: {failure}</> : "Starting demo session…"}</div>;
  return <Shell />;
}

function Shell() {
  const route = useRoute(), session = useSession()!, online = useOnline();
  const page = route[0] ?? "";
  useEffect(() => { if (!page) go("/rfqs"); }, [page]);
  const list = useApi(() => api.listRfqs());
  const action = (list.data ?? []).filter(needsAction).length;
  const ready = session.app.ok && session.app.rfq?.enabled && session.app.rfq.read && session.app.rfq.write;
  let body;
  if (page === "rfqs" && route[1]) body = <RfqDetail id={route[1]} />;
  else if (page === "new") body = <NewRfq />;
  else if (page === "integration") body = <Integration />;
  else body = <RfqList />;
  return <div className="rq-root">
    <header className="rq-demobar">
      <span className="rq-demobar-tag">RFQ Developer Demo</span>
      {session.demo_mode && <span className="rq-demobar-flag" title="DEMO_MODE is on: image uploads only, no PDFs">DEMO</span>}
      <span className="rq-demobar-note">Sample buyer portal on the live HIOBuy RFQ API · requests reach a real sourcing team · do not enter sensitive data</span>
      <Link to="/integration" className={`rq-demobar-mode${!ready || !online ? " offline" : ""}`}>{!online ? "Backend unreachable" : ready ? "Live API" : "API not ready"}</Link>
    </header>
    <div className="rq-shell">
      <nav className="rq-rail" aria-label="Navigation">
        <span className="rq-rail-logo" role="img" aria-label={demoConfig.appName}>{demoConfig.appName.slice(0, 1)}</span>
        {NAV.map(([to, label, d]) => <Link key={to} to={`/${to}`} className={page === to ? "rq-rail-item active" : "rq-rail-item"} title={label}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg><span>{label}</span>
          {to === "rfqs" && action > 0 && <i className="rq-rail-dot">{action}</i>}</Link>)}
      </nav>
      <div className="rq-main">
        <header className="rq-top"><span><b>{demoConfig.appName}</b> · Request for Quotation</span><span className="rq-muted">Your app's buyer portal · signed in as {session.visitor.label}</span></header>
        {!ready && <p className="rq-banner-orange rq-inline-banner rq-page-banner">RFQ is not available for the demo's App yet{session.app.ok ? "" : ` (${session.app.code})`}. See <Link to="/integration">Integration</Link>.</p>}
        <div className="rq-page">{body}</div>
      </div>
    </div>
    <ToastHost />
  </div>;
}
