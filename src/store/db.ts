import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Db = Database.Database;

export const SCHEMA_VERSION = 1;

/**
 * PRD 32 - SQLite is enough for the MVP. One file, one writer (the daemon), WAL so that
 * `contextd status` and the MCP server can read while ingestion is running.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  agent       TEXT,
  cwd         TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  meta        TEXT NOT NULL DEFAULT '{}'
);

-- L2 raw history (PRD 10). Never injected into a prompt; kept for audit and replay.
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  ordinal      INTEGER,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,
  source       TEXT NOT NULL,
  importance   TEXT NOT NULL,
  -- Whether the adapter deliberately claimed that importance, or it was inferred here.
  importance_source TEXT NOT NULL DEFAULT 'engine',
  payload      TEXT NOT NULL,
  dedupe_hash  TEXT NOT NULL,
  action       TEXT NOT NULL,
  reasons      TEXT NOT NULL DEFAULT '[]',
  tokens       INTEGER NOT NULL DEFAULT 0,
  -- NULL until a worker has folded it into state; drives the pending queue.
  processed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe ON events(session_id, dedupe_hash);
CREATE INDEX IF NOT EXISTS events_pending ON events(processed_at, session_id);
CREATE INDEX IF NOT EXISTS events_session_ts ON events(session_id, ts);

-- The patch log is the source of truth for memory (PRD 33/34); items are a materialization.
CREATE TABLE IF NOT EXISTS patches (
  id            TEXT PRIMARY KEY,
  seq           INTEGER NOT NULL,
  session_id    TEXT,
  base_version  INTEGER NOT NULL,
  new_version   INTEGER NOT NULL,
  patch         TEXT NOT NULL,
  note          TEXT,
  origin        TEXT NOT NULL,
  worker_run_id TEXT,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS patches_seq ON patches(seq);

CREATE TABLE IF NOT EXISTS memory_items (
  id                TEXT PRIMARY KEY,
  category          TEXT NOT NULL,
  text              TEXT NOT NULL,
  fields            TEXT NOT NULL DEFAULT '{}',
  importance        TEXT NOT NULL,
  confidence        REAL NOT NULL,
  status            TEXT NOT NULL,
  source            TEXT NOT NULL,
  evidence          TEXT NOT NULL DEFAULT '[]',
  reason            TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  last_used_at      TEXT,
  last_validated_at TEXT,
  ttl_seconds       INTEGER,
  supersedes        TEXT NOT NULL DEFAULT '[]',
  superseded_by     TEXT,
  tags              TEXT NOT NULL DEFAULT '[]',
  -- PRD 29 gains a precision signal: an item never retrieved was never worth storing.
  retrieved_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS memory_category ON memory_items(category, status);
CREATE INDEX IF NOT EXISTS memory_status ON memory_items(status, importance);

-- PRD 20 - keyword retrieval over structured metadata is enough for the MVP; BM25 comes
-- free with FTS5 and needs no embedding provider, which also keeps privacy defaults local.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  text, tags, reason, category UNINDEXED,
  content='memory_items', content_rowid='rowid', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_items BEGIN
  INSERT INTO memory_fts(rowid, text, tags, reason, category)
  VALUES (new.rowid, new.text, new.tags, new.reason, new.category);
END;
CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_items BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text, tags, reason, category)
  VALUES ('delete', old.rowid, old.text, old.tags, old.reason, old.category);
END;
CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory_items BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text, tags, reason, category)
  VALUES ('delete', old.rowid, old.text, old.tags, old.reason, old.category);
  INSERT INTO memory_fts(rowid, text, tags, reason, category)
  VALUES (new.rowid, new.text, new.tags, new.reason, new.category);
END;

-- L0 working memory is project scoped, not session scoped: K5 requires a fresh agent to
-- resume from repository + memory alone, so it must outlive the session that wrote it.
CREATE TABLE IF NOT EXISTS working_memory (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_runs (
  id            TEXT PRIMARY KEY,
  session_id    TEXT,
  task          TEXT NOT NULL,
  tier          TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  status        TEXT NOT NULL,
  event_count   INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 1,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  error         TEXT,
  patch_id      TEXT
);
CREATE INDEX IF NOT EXISTS worker_runs_started ON worker_runs(started_at);
CREATE INDEX IF NOT EXISTS worker_runs_session ON worker_runs(session_id);

-- PRD 19 - the repository stays the source of truth for code; we only track fingerprints.
CREATE TABLE IF NOT EXISTS file_index (
  path         TEXT PRIMARY KEY,
  content_hash TEXT,
  purpose      TEXT,
  last_commit  TEXT,
  last_seen_at TEXT NOT NULL
);

-- PRD 29 - retrieval accuracy needs a record of what was asked and what was served.
CREATE TABLE IF NOT EXISTS retrieval_log (
  id         TEXT PRIMARY KEY,
  session_id TEXT,
  query      TEXT NOT NULL,
  item_ids   TEXT NOT NULL DEFAULT '[]',
  tokens     INTEGER NOT NULL DEFAULT 0,
  at         TEXT NOT NULL
);

-- PRD 28 - baseline accounting: what the coding agent itself spent, so the comparison
-- "with vs without the manager" is measured rather than asserted.
CREATE TABLE IF NOT EXISTS agent_usage (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  at            TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  model         TEXT
);
CREATE INDEX IF NOT EXISTS agent_usage_session ON agent_usage(session_id, at);

-- PRD 56 - typed relations between memory items, so retrieval can reach the reasoning
-- around a hit rather than only the text that matched.
CREATE TABLE IF NOT EXISTS memory_edges (
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  reason     TEXT,
  confidence REAL NOT NULL DEFAULT 0.8,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS memory_edges_from ON memory_edges(from_id);
CREATE INDEX IF NOT EXISTS memory_edges_to ON memory_edges(to_id);

-- Phase 4 semantic retrieval. Optional: empty unless an embedding provider is configured,
-- which keeps the local-only default of PRD 37 intact.
CREATE TABLE IF NOT EXISTS memory_embeddings (
  item_id    TEXT PRIMARY KEY,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  -- Float32Array bytes. A dedicated vector store is not worth a dependency at this size.
  vec        BLOB NOT NULL,
  -- Hash of the text embedded, so a changed item is recognised as stale.
  text_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- PRD 31 - an explicit latency budget needs measurements to be judged against.
CREATE TABLE IF NOT EXISTS op_latency (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  op       TEXT NOT NULL,
  ms       REAL NOT NULL,
  at       TEXT NOT NULL,
  detail   TEXT
);
CREATE INDEX IF NOT EXISTS op_latency_op ON op_latency(op, id);

-- Adapter bookkeeping: how far a transcript has been tailed (PRD 22).
CREATE TABLE IF NOT EXISTS ingest_cursors (
  key        TEXT PRIMARY KEY,
  offset     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Contradiction pairs already judged compatible, keyed by the content of both items: an edit to
-- either one changes the fingerprint and the pair is reported again. Not memory - a record of
-- what detection need not ask about twice - so it is outside the patch log.
CREATE TABLE IF NOT EXISTS conflict_reviews (
  pair        TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  reason      TEXT,
  reviewed_at TEXT NOT NULL
);
`;

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function dbPath(storageDir: string): string {
  return join(storageDir, 'state.db');
}

function migrate(db: Db): void {
  db.exec(SCHEMA);
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    );
  }
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('state_version', '0') ON CONFLICT(key) DO NOTHING`,
  ).run();
  db.prepare(`INSERT INTO meta (key, value) VALUES ('patch_seq', '0') ON CONFLICT(key) DO NOTHING`).run();
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function getIntMeta(db: Db, key: string, fallback = 0): number {
  const v = getMeta(db, key);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
