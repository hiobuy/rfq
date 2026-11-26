// Demo state on SQLite: Node `node:sqlite` locally, Durable Object SQLite in a Worker.
// It holds only what an integrator backend needs: visitor sessions, which RFQs belong to
// which visitor, the requirement-change log, received webhook events and a short API call log.
// It never stores the HIOBuy API key, request bodies or customer content.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (sid_hash TEXT PRIMARY KEY, visitor TEXT NOT NULL UNIQUE, csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS owned (kind TEXT NOT NULL, id TEXT NOT NULL, visitor TEXT NOT NULL, parent TEXT,
  created_at INTEGER NOT NULL, PRIMARY KEY (kind, id));
CREATE INDEX IF NOT EXISTS owned_visitor ON owned (visitor, kind, created_at);
CREATE TABLE IF NOT EXISTS req_history (rfq_id TEXT NOT NULL, version INTEGER NOT NULL, changed TEXT NOT NULL,
  note TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (rfq_id, version));
CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, type TEXT NOT NULL, rfq_id TEXT, conversation_id TEXT,
  summary TEXT NOT NULL, created_at TEXT, received_at INTEGER NOT NULL, deliveries INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS events_rfq ON events (rfq_id, received_at);
CREATE INDEX IF NOT EXISTS events_conversation ON events (conversation_id, received_at);
CREATE TABLE IF NOT EXISTS calls (seq INTEGER PRIMARY KEY AUTOINCREMENT, visitor TEXT NOT NULL, at INTEGER NOT NULL,
  method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL, ms INTEGER NOT NULL, code TEXT);
CREATE INDEX IF NOT EXISTS calls_visitor ON calls (visitor, seq);
CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
`;

export const SESSION_TTL_MS = 7 * 24 * 3600_000;

export class SqlStore {
  /** db: { exec(sql), prepare(sql) -> { get(...), all(...), run(...) } } */
  constructor(db, { now = () => Date.now(), transaction = (fn) => fn() } = {}) {
    this.db = db;
    this.now = now;
    this.transaction = transaction;
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) db.exec(stmt);
  }

  // ---- sessions ----
  createSession(sidHash, visitor, csrf) {
    const t = this.now();
    this.db.prepare("INSERT INTO sessions (sid_hash, visitor, csrf, created_at, last_seen) VALUES (?,?,?,?,?)").run(sidHash, visitor, csrf, t, t);
  }
  session(sidHash) {
    const row = this.db.prepare("SELECT visitor, csrf, last_seen FROM sessions WHERE sid_hash = ?").get(sidHash);
    if (!row || this.now() - row.last_seen > SESSION_TTL_MS) return null;
    if (this.now() - row.last_seen > 60_000) this.db.prepare("UPDATE sessions SET last_seen = ? WHERE sid_hash = ?").run(this.now(), sidHash);
    return { visitor: row.visitor, csrf: row.csrf };
  }
  purge() {
    const t = this.now();
    this.db.prepare("DELETE FROM sessions WHERE last_seen < ?").run(t - SESSION_TTL_MS);
    this.db.prepare("DELETE FROM limits WHERE expires_at <= ?").run(t);
    this.db.prepare("DELETE FROM events WHERE received_at < ?").run(t - 30 * 24 * 3600_000);
  }

  // ---- ownership (the integrator's own authorization layer) ----
  own(kind, id, visitor, parent = null) {
    this.db.prepare("INSERT INTO owned (kind, id, visitor, parent, created_at) VALUES (?,?,?,?,?) ON CONFLICT (kind, id) DO NOTHING")
      .run(kind, id, visitor, parent, this.now());
  }
  owner(kind, id) {
    return this.db.prepare("SELECT visitor, parent FROM owned WHERE kind = ? AND id = ?").get(kind, id) ?? null;
  }
  owns(kind, id, visitor) { return this.owner(kind, id)?.visitor === visitor; }
  ownedIds(kind, visitor, limit = 500) {
    return this.db.prepare("SELECT id FROM owned WHERE kind = ? AND visitor = ? ORDER BY created_at DESC LIMIT ?").all(kind, visitor, limit).map((r) => r.id);
  }
  /** RFQ that owns a conversation, if any (used to route message webhooks). */
  rfqForConversation(conversationId) {
    return this.db.prepare("SELECT parent FROM owned WHERE kind = 'conversation' AND id = ?").get(conversationId)?.parent ?? null;
  }

  // ---- requirement history (the public API exposes the current version only) ----
  recordRequirementChange(rfqId, version, changed, note, at) {
    this.db.prepare("INSERT INTO req_history (rfq_id, version, changed, note, at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING")
      .run(rfqId, version, JSON.stringify(changed), note, at);
  }
  requirementHistory(rfqId) {
    return this.db.prepare("SELECT version, changed, note, at FROM req_history WHERE rfq_id = ? ORDER BY version").all(rfqId)
      .map((r) => ({ version: r.version, changed: JSON.parse(r.changed), note: r.note, at: r.at }));
  }

  // ---- webhook events (deduplicated by event id; delivery is at-least-once) ----
  /** Returns true for a new event, false for a duplicate delivery. */
  recordEvent(e) {
    const inserted = this.db.prepare(`INSERT INTO events (event_id, type, rfq_id, conversation_id, summary, created_at, received_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT (event_id) DO NOTHING`)
      .run(e.eventId, e.type, e.rfqId, e.conversationId, JSON.stringify(e.summary), e.createdAt, this.now());
    if (Number(inserted.changes) === 1) return true;
    this.db.prepare("UPDATE events SET deliveries = deliveries + 1 WHERE event_id = ?").run(e.eventId);
    return false;
  }
  /** Events about RFQs (or their conversations) that belong to the visitor, newest first. */
  eventsFor(visitor, afterSeq = 0, limit = 50) {
    return this.db.prepare(`SELECT e.rowid AS seq, e.event_id, e.type, e.rfq_id, e.conversation_id, e.summary, e.created_at, e.received_at, e.deliveries
      FROM events e WHERE e.rowid > ? AND (
        EXISTS (SELECT 1 FROM owned o WHERE o.kind = 'rfq' AND o.id = e.rfq_id AND o.visitor = ?)
        OR EXISTS (SELECT 1 FROM owned o WHERE o.kind = 'conversation' AND o.id = e.conversation_id AND o.visitor = ?))
      ORDER BY e.rowid DESC LIMIT ?`).all(afterSeq, visitor, visitor, limit)
      .map((r) => ({ seq: r.seq, event_id: r.event_id, type: r.type, rfq_id: r.rfq_id ?? this.rfqForConversation(r.conversation_id),
        conversation_id: r.conversation_id, summary: JSON.parse(r.summary), created_at: r.created_at,
        received_at: new Date(r.received_at).toISOString(), deliveries: r.deliveries }));
  }

  // ---- API call log shown on the Integration page (method/path/status only, never bodies) ----
  logCall(visitor, method, path, status, ms, code = null) {
    this.db.prepare("INSERT INTO calls (visitor, at, method, path, status, ms, code) VALUES (?,?,?,?,?,?,?)").run(visitor, this.now(), method, path, status, ms, code);
    this.db.prepare("DELETE FROM calls WHERE visitor = ? AND seq <= (SELECT seq FROM calls WHERE visitor = ? ORDER BY seq DESC LIMIT 1 OFFSET 80)").run(visitor, visitor);
  }
  callsFor(visitor) {
    return this.db.prepare("SELECT seq, at, method, path, status, ms, code FROM calls WHERE visitor = ? ORDER BY seq DESC LIMIT 80").all(visitor)
      .map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
  }

  // ---- fixed-window rate limits; returns seconds to wait, or 0 ----
  limit(key, maximum, periodMs) {
    const t = this.now(), window = Math.floor(t / periodMs), expires = (window + 1) * periodMs, id = `${key}:${window}`;
    const row = this.db.prepare(`INSERT INTO limits (key, count, expires_at) VALUES (?,1,?)
      ON CONFLICT (key) DO UPDATE SET count = count + 1 RETURNING count`).get(id, expires);
    return row.count > maximum ? Math.max(1, Math.ceil((expires - t) / 1000)) : 0;
  }
}
