'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

const dbPath = process.env.DB_PATH || './data/app.db';
if (dbPath !== ':memory:') {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    subsonic_password TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    is_active INTEGER NOT NULL DEFAULT 1,
    last_active_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS playlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    thumbnail TEXT,
    duration INTEGER,
    added_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_playlists_user_id ON playlists(user_id);
  CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist_id ON playlist_items(playlist_id);
`);

// Idempotent column migrations for existing databases
const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
const migrations = [
  ['subsonic_password', 'ALTER TABLE users ADD COLUMN subsonic_password TEXT'],
  ['role',             "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'"],
  ['is_active',        'ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1'],
  ['last_active_at',   'ALTER TABLE users ADD COLUMN last_active_at INTEGER'],
];
for (const [col, sql] of migrations) {
  if (!userColumns.includes(col)) db.prepare(sql).run();
}

// Admin bootstrap — driven by env vars, falls back to hard-coded defaults
const adminUsername = process.env.ADMIN_USERNAME || 'KishanGollamudi';
const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123';
const adminHash = bcrypt.hashSync(adminPassword, 10);

const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get(adminUsername);
if (existingAdmin) {
  db.prepare(`
    UPDATE users
    SET password_hash = ?, subsonic_password = ?, role = 'admin', is_active = 1
    WHERE username = ?
  `).run(adminHash, adminPassword, adminUsername);
} else {
  db.prepare(`
    INSERT INTO users (username, password_hash, subsonic_password, role, is_active, created_at)
    VALUES (?, ?, ?, 'admin', 1, ?)
  `).run(adminUsername, adminHash, adminPassword, Date.now());
}

module.exports = db;
