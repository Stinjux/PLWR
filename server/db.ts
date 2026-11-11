import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.ts';

export type Row = Record<string, any>;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Toronto',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

-- Agenda : rendez-vous fixes (kind=fixed) et tâches flexibles (kind=flexible)
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fixed','flexible')),
  start_at TEXT,
  end_at TEXT,
  duration_min INTEGER NOT NULL DEFAULT 30,
  due_at TEXT,
  priority INTEGER NOT NULL DEFAULT 2,
  preferred_window TEXT,
  plan_date TEXT,
  location TEXT,
  notes TEXT,
  rrule TEXT,
  series_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  recurrence_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','cancelled')),
  focus_date TEXT,
  reminders TEXT NOT NULL DEFAULT '[]',
  due_reminders TEXT NOT NULL DEFAULT '[]',
  sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_user_start ON events(user_id, start_at);
CREATE INDEX IF NOT EXISTS idx_events_series ON events(series_id, recurrence_id);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('check','quantity','duration','amount')),
  target REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL CHECK (period IN ('once','daily','weekly','monthly')),
  start_date TEXT NOT NULL,
  deadline TEXT,
  reminder_days INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goal_links (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, goal_id)
);

CREATE TABLE IF NOT EXISTS goal_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  value REAL NOT NULL,
  planned REAL,
  event_id TEXT,
  occurrence TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_goal_entry_block ON goal_entries(goal_id, event_id, occurrence) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_goal_entries ON goal_entries(goal_id, date);

CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (user_id, key)
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  grp TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income')),
  default_amount_cents INTEGER NOT NULL DEFAULT 0,
  keywords TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS allocations (
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  PRIMARY KEY (category_id, month)
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  merchant TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  orig_amount_cents INTEGER,
  orig_currency TEXT,
  type TEXT NOT NULL DEFAULT 'expense' CHECK (type IN ('expense','income','refund')),
  refund_of TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manuel',
  draft_id TEXT UNIQUE,
  import_id TEXT,
  recurring_id TEXT,
  sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, date);

CREATE TABLE IF NOT EXISTS transaction_splits (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id),
  amount_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_splits_tx ON transaction_splits(transaction_id);
CREATE INDEX IF NOT EXISTS idx_splits_cat ON transaction_splits(category_id);

CREATE TABLE IF NOT EXISTS recurring (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  merchant TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income')),
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','biweekly','monthly','yearly')),
  next_date TEXT NOT NULL,
  reminder_days INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'budget',
  file_hash TEXT NOT NULL,
  phash TEXT,
  file_path TEXT,
  status TEXT NOT NULL DEFAULT 'processing',
  provider TEXT,
  error TEXT,
  redactions INTEGER NOT NULL DEFAULT 0,
  duplicate_of TEXT,
  image_deleted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imports_hash ON imports(user_id, file_hash);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  import_id TEXT REFERENCES imports(id) ON DELETE SET NULL,
  line_index INTEGER NOT NULL DEFAULT 0,
  fields TEXT NOT NULL,
  uncertain TEXT NOT NULL DEFAULT '[]',
  raw_text TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled')),
  transaction_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_user_status ON drafts(user_id, status);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages(user_id, created_at);

CREATE TABLE IF NOT EXISTS chat_pending (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL,
  field TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merchant_rules (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_key TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  hits INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, merchant_key, category_id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_ok_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT,
  fire_at TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  read_at TEXT,
  UNIQUE (user_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS snoozes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT,
  fire_at TEXT NOT NULL,
  ref_key TEXT,
  created_at TEXT NOT NULL
);
`;

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(process.env.DB_FILE === ':memory:' ? ':memory:' : path.join(config.dataDir, process.env.DB_FILE || 'plwr.sqlite'));
db.exec(SCHEMA);

export const uid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

export function all<T = Row>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function get<T = Row>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function run(sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}

/** Exécute fn dans une transaction SQLite (BEGIN IMMEDIATE pour sérialiser les écritures). */
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
