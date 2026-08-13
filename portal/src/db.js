'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

// Append-only migration list; PRAGMA user_version tracks progress.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    name TEXT,
    picture TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_blocked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );
  CREATE INDEX idx_users_email ON users (email);

  CREATE TABLE services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '🔗',
    sort_order INTEGER NOT NULL DEFAULT 100,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE user_services (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, service_id)
  );

  CREATE TABLE sessions (
    sid TEXT PRIMARY KEY,
    expires INTEGER NOT NULL,
    user_id INTEGER,
    data TEXT NOT NULL
  );
  CREATE INDEX idx_sessions_expires ON sessions (expires);
  CREATE INDEX idx_sessions_user ON sessions (user_id);
  `,
  `
  CREATE TABLE invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    invited_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    accepted_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE UNIQUE INDEX idx_invites_pending_email ON invites (email) WHERE accepted_at IS NULL;

  CREATE TABLE invite_services (
    invite_id INTEGER NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
    service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    PRIMARY KEY (invite_id, service_id)
  );
  `,
];

const DEFAULT_SERVICES = [
  {
    slug: 'immich',
    name: 'Immich',
    description: 'Photo & video library — backup, search and share',
    url: 'https://im.lordblight.com',
    icon: '📸',
    sort_order: 10,
  },
  {
    slug: 'nextcloud',
    name: 'Nextcloud',
    description: 'Files, documents, calendars and contacts',
    url: 'https://nc.lordblight.com',
    icon: '☁️',
    sort_order: 20,
  },
  {
    slug: '2fauth',
    name: '2FAuth',
    description: 'Two-factor authentication codes',
    url: 'https://2fa.lordblight.com',
    icon: '🔐',
    sort_order: 30,
  },
];

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'portal.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  migrate(db);
  seed(db);
  return db;
}

function migrate(db) {
  let version = db.pragma('user_version', { simple: true });
  while (version < MIGRATIONS.length) {
    const target = version + 1;
    db.transaction(() => {
      db.exec(MIGRATIONS[target - 1]);
      db.pragma(`user_version = ${target}`);
    })();
    version = target;
  }
}

function seed(db) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM services').get();
  if (count > 0) return;
  const insert = db.prepare(
    `INSERT INTO services (slug, name, description, url, icon, sort_order)
     VALUES (@slug, @name, @description, @url, @icon, @sort_order)`
  );
  db.transaction((rows) => rows.forEach((row) => insert.run(row)))(DEFAULT_SERVICES);
}

module.exports = { openDb, DEFAULT_SERVICES };
