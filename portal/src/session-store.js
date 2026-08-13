'use strict';

const { Store } = require('express-session');

const ONE_DAY_MS = 86_400_000;
// touch() only writes when it would extend expiry by more than this, so the
// forward-auth hot path (one subrequest per proxied request) stays write-free.
const TOUCH_WRITE_THRESHOLD_MS = 60 * 60 * 1000;

class SqliteSessionStore extends Store {
  constructor(db, { pruneIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    this.selectStmt = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?');
    this.upsertStmt = db.prepare(
      `INSERT INTO sessions (sid, expires, user_id, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, user_id = excluded.user_id, data = excluded.data`
    );
    this.deleteStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ? AND ? - expires > ?');
    this.pruneStmt = db.prepare('DELETE FROM sessions WHERE expires <= ?');
    this.pruneTimer = setInterval(() => {
      try {
        this.pruneStmt.run(Date.now());
      } catch {
        // Pruning is best-effort; expired rows are also filtered on read.
      }
    }, pruneIntervalMs);
    this.pruneTimer.unref();
  }

  expiryOf(session) {
    const expires = session && session.cookie && session.cookie.expires;
    const at = expires ? new Date(expires).getTime() : NaN;
    if (Number.isFinite(at)) return at;
    const maxAge = session && session.cookie && session.cookie.maxAge;
    return Date.now() + (Number.isFinite(maxAge) ? maxAge : ONE_DAY_MS);
  }

  get(sid, callback) {
    try {
      const row = this.selectStmt.get(sid, Date.now());
      callback(null, row ? JSON.parse(row.data) : undefined);
    } catch (err) {
      callback(err);
    }
  }

  set(sid, session, callback = () => {}) {
    try {
      this.upsertStmt.run(sid, this.expiryOf(session), session.userId ?? null, JSON.stringify(session));
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.deleteStmt.run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  touch(sid, session, callback = () => {}) {
    try {
      const expires = this.expiryOf(session);
      this.touchStmt.run(expires, sid, expires, TOUCH_WRITE_THRESHOLD_MS);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
}

module.exports = { SqliteSessionStore };
