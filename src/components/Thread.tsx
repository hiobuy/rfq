import { useEffect, useRef, useState } from "react";
import type { Message } from "../api/types";
import { messageImageUrl } from "../api/client";
import { fmtTime, ImageGrid } from "../ui";

/** The RFQ's linked conversation. Staff replies arrive in your language (machine-translated by HIOAsk). */
export function Thread({ messages, providerName }: { messages: Message[]; providerName: string }) {
  const box = useRef<HTMLDivElement>(null);
  // Scroll only the conversation pane (scrollIntoView would also scroll the page).
  useEffect(() => { const pane = box.current?.parentElement; if (pane) pane.scrollTop = pane.scrollHeight; }, [messages.length]);
  if (!messages.length) return <p className="rq-muted rq-thread-empty">No messages yet. Questions from the sourcing team appear here.</p>;
  return <div className="rq-thread" ref={box}>
    {messages.map(m => {
      const mine = m.sender_type === "customer";
      if (m.recalled) return <div key={m.id} className="rq-system">{providerName} withdrew a message</div>;
      return <article key={m.id} className={`rq-bubble ${mine ? "rq-out" : "rq-in"}`}>
        <div className="rq-bubble-meta"><strong>{mine ? "You" : providerName}</strong><time>{fmtTime(m.created_at)}</time></div>
        {m.content && <div className="rq-bubble-text">{m.content}</div>}
        {m.attachments.length > 0 && <ImageGrid items={m.attachments.map(a => ({ id: a.id, url: messageImageUrl(a.id), name: a.filename }))} />}
      </article>;
    })}
  </div>;
}

export function Composer({ onSend, placeholder, disabled }: { onSend: (text: string) => Promise<unknown>; placeholder?: string; disabled?: boolean }) {
  const [text, setText] = useState(""), [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try { await onSend(text.trim()); setText(""); } catch { /* the caller shows the error */ } finally { setBusy(false); }
  };
  return <div className="rq-composer">
    <div className="rq-compose-row">
      <textarea rows={2} value={text} placeholder={placeholder} disabled={disabled} maxLength={4000} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      <button type="button" className="btn btn-primary" disabled={disabled || busy || !text.trim()} onClick={() => void send()}>{busy ? "Sending…" : "Send"}</button>
    </div>
    <div className="rq-composer-foot"><span className="rq-muted">Enter to send · translated for the sourcing team</span></div>
  </div>;
}
