/**
 * Two-DB connection layer.
 *
 * The session uses two SQLite files to eliminate write contention across
 * the host-container mount boundary:
 *
 *   inbound.db  — host writes new messages here; container opens READ-ONLY
 *   outbound.db — container writes responses + acks here; host opens read-only
 *
 * Each file has exactly one writer, so no cross-process lock contention.
 *
 * ⚠ Cross-mount visibility: inbound.db MUST be journal_mode=DELETE (set by
 * the host when the file is created). WAL's `-shm` is memory-mapped and
 * VirtioFS does not propagate mmap coherency from host to guest, so a
 * WAL-mode inbound.db would leave this reader frozen on an early snapshot
 * and it would silently never see new host messages. See
 * src/session-manager.ts for the full set of cross-mount invariants and
 * scripts/sanity-live-poll.ts for the empirical validation.
 */
import { Database } from 'bun:sqlite';
import fs from 'fs';

const DEFAULT_INBOUND_PATH = '/workspace/inbound.db';
const DEFAULT_OUTBOUND_PATH = '/workspace/outbound.db';
const DEFAULT_HEARTBEAT_PATH = '/workspace/.heartbeat';

let _inbound: Database | null = null;
let _outbound: Database | null = null;
let _heartbeatPath: string = DEFAULT_HEARTBEAT_PATH;
let _testMode = false;

/**
 * Avoid all cached db reads; open inbound.db read-only with mmap and page cache disabled.
 *
 * Use this (not getInboundDb) for readers that need to see host-written rows
 * promptly — e.g. messages_in polling. Caller must .close() the returned
 * connection (try/finally).
 *
 * Needed for mounts where host writes don't reliably invalidate
 * SQLite's caches: virtiofs (Colima, Lima, Podman Machine, Apple
 * Container), NFS.
 *
 * Cost is microseconds per query, so safe for universal use.
 */
export function openInboundDb(): Database {
  // In test mode return a thin wrapper over the in-memory singleton.
  // Callers do try/finally { db.close() } — the wrapper no-ops close()
  // so the singleton survives for the rest of the test.
  if (_testMode && _inbound) {
    const db = _inbound;
    return {
      prepare: (sql: string) => db.prepare(sql),
      exec: (sql: string) => db.exec(sql),
      close: () => {},
    } as unknown as Database;
  }
  const db = new Database(DEFAULT_INBOUND_PATH, { readonly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA mmap_size = 0');
  return db;
}

/**
 * Inbound DB — long-lived singleton, OK for tables the host writes once
 * at spawn and never again (destinations, session_routing). For
 * messages_in polling — where the host writes continuously and a stale
 * view causes the pollHandle hang — use `openInboundDb()` instead.
 */
export function getInboundDb(): Database {
  if (!_inbound) {
    _inbound = new Database(DEFAULT_INBOUND_PATH, { readonly: true });
    _inbound.exec('PRAGMA busy_timeout = 5000');
    _inbound.exec('PRAGMA mmap_size = 0');
  }
  return _inbound;
}

/** Outbound DB — container owns this file (sole writer). */
export function getOutboundDb(): Database {
  if (!_outbound) {
    _outbound = new Database(DEFAULT_OUTBOUND_PATH);
    _outbound.exec('PRAGMA journal_mode = DELETE');
    _outbound.exec('PRAGMA busy_timeout = 5000');
    _outbound.exec('PRAGMA foreign_keys = ON');
    // Lightweight forward-compat: session_state was added after the initial
    // v2 schema, so older session DBs don't have it. Create it on demand
    // instead of requiring a formal migration pass. Also handle the case
    // where an earlier revision of this table existed without updated_at —
    // ALTER TABLE to add any missing columns.
    _outbound.exec(`
      CREATE TABLE IF NOT EXISTS session_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const cols = new Set(
      (_outbound.prepare("PRAGMA table_info('session_state')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('updated_at')) {
      _outbound.exec(`ALTER TABLE session_state ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
    }
    // container_state: tracks the current tool in flight (if any) so the host
    // sweep can widen its stuck tolerance when Bash is running with a user-
    // declared long timeout. It also carries the live progress fields the host
    // renders into the "what am I doing" message. Forward-compat for older
    // outbound.db files.
    _outbound.exec(`
      CREATE TABLE IF NOT EXISTS container_state (
        id                       INTEGER PRIMARY KEY CHECK (id = 1),
        current_tool             TEXT,
        tool_declared_timeout_ms INTEGER,
        tool_started_at          TEXT,
        recent_tools             TEXT,
        thinking_line            TEXT,
        updated_at               TEXT NOT NULL
      );
    `);
    // recent_tools / thinking_line landed after container_state shipped, so
    // outbound.db files created by an earlier container have the table but not
    // the columns. Same ALTER-if-absent idiom as session_state.updated_at above.
    const containerCols = new Set(
      (_outbound.prepare("PRAGMA table_info('container_state')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!containerCols.has('recent_tools')) {
      _outbound.exec(`ALTER TABLE container_state ADD COLUMN recent_tools TEXT`);
    }
    if (!containerCols.has('thinking_line')) {
      _outbound.exec(`ALTER TABLE container_state ADD COLUMN thinking_line TEXT`);
    }
  }
  return _outbound;
}

/** How many tool names the recent_tools ring buffer keeps, most-recent-last. */
const RECENT_TOOLS_MAX = 5;

/** Longest thinking line we persist — the host renders it on one chat line. */
const THINKING_LINE_MAX = 200;

/**
 * Decode recent_tools, tolerating anything that isn't a JSON array of strings.
 * A malformed value means the previous writer was a different (older or newer)
 * revision; dropping it is strictly better than throwing inside a tool hook.
 */
function parseRecentTools(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    return [];
  }
}

/**
 * Record that a tool is starting. `declaredTimeoutMs` is the tool's own
 * timeout hint when one is available (Bash exposes it in the tool_use input);
 * omit for tools with no declared timeout.
 *
 * Also appends `label` to the recent_tools ring buffer (most-recent-LAST, capped
 * at RECENT_TOOLS_MAX) which the host renders as its "🔧 Bash(pnpm test)" lines.
 * That history outlives the individual tool call — only clearContainerProgress()
 * resets it, at turn boundaries.
 *
 * `label` is the display form ("Bash(pnpm test)"); `tool` stays the bare SDK
 * name because current_tool is not decoration — the host sweep matches it
 * exactly ('Bash') to widen its stuck tolerance for a long-declared script
 * (host-sweep.ts). Defaults to the bare name for callers that have no input to
 * summarize.
 */
export function setContainerToolInFlight(
  tool: string,
  declaredTimeoutMs: number | null,
  label: string = tool,
): void {
  const now = new Date().toISOString();
  const db = getOutboundDb();
  // The ring buffer is a read-modify-write, so it runs inside a transaction:
  // the row must never be observed (or overwritten) between the SELECT and the
  // UPSERT. The container is outbound.db's sole writer and uses this single
  // connection, so the transaction is all the mutual exclusion needed — there
  // is no second writer to race with.
  db.transaction(() => {
    const row = db.prepare('SELECT recent_tools FROM container_state WHERE id = 1').get() as
      | { recent_tools: string | null }
      | undefined;
    const recent = parseRecentTools(row?.recent_tools);
    recent.push(label);
    db.prepare(
      `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, recent_tools, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_tool = excluded.current_tool,
         tool_declared_timeout_ms = excluded.tool_declared_timeout_ms,
         tool_started_at = excluded.tool_started_at,
         recent_tools = excluded.recent_tools,
         updated_at = excluded.updated_at`,
    ).run(tool, declaredTimeoutMs, now, JSON.stringify(recent.slice(-RECENT_TOOLS_MAX)), now);
  })();
}

/**
 * Clear the in-flight tool — called on PostToolUse / PostToolUseFailure.
 * Deliberately leaves recent_tools and thinking_line alone: those describe the
 * turn, not the individual call, and the host keeps rendering them between tools.
 */
export function clearContainerToolInFlight(): void {
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
       VALUES (1, NULL, NULL, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_tool = NULL,
         tool_declared_timeout_ms = NULL,
         tool_started_at = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(now);
}

/**
 * Record the one-line summary of what the agent is currently thinking about.
 * Fed from the SDK's summarized thinking blocks, so the text arrives as prose
 * with newlines — collapse it to a single line and cap it, because the host
 * renders it verbatim as one chat line. Empty (or whitespace-only) input is
 * ignored rather than written: blanking the line mid-turn would make the
 * progress message flicker for no information gain.
 */
export function setContainerThinkingLine(line: string): void {
  const cleaned = line.replace(/\s+/g, ' ').trim().slice(0, THINKING_LINE_MAX);
  if (!cleaned) return;
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, thinking_line, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         thinking_line = excluded.thinking_line,
         updated_at = excluded.updated_at`,
    )
    .run(cleaned, now);
}

/**
 * Reset the per-turn progress fields — called when a turn ends, so the next
 * turn doesn't open showing the previous turn's tools and thinking line.
 * Leaves the tool-in-flight columns alone; those have their own lifecycle.
 */
export function clearContainerProgress(): void {
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, recent_tools, thinking_line, updated_at)
       VALUES (1, NULL, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         recent_tools = NULL,
         thinking_line = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(now);
}

/**
 * Touch the heartbeat file — replaces the old touchProcessing() DB writes.
 * The host checks this file's mtime for stale container detection.
 * A file touch is cheaper and avoids cross-boundary DB write contention.
 */
export function touchHeartbeat(): void {
  const p = _heartbeatPath;
  const now = new Date();
  try {
    fs.utimesSync(p, now, now);
  } catch {
    try {
      fs.writeFileSync(p, '');
    } catch {
      // Silently ignore — parent dir may not exist (e.g., in-memory test DBs)
    }
  }
}

/**
 * Clear stale processing_ack entries on container startup.
 * If the previous container crashed, 'processing' entries are leftover.
 * Clearing them lets the new container re-process those messages.
 */
export function clearStaleProcessingAcks(): void {
  getOutboundDb().prepare("DELETE FROM processing_ack WHERE status = 'processing'").run();
}

/** For tests — creates in-memory DBs with the session schemas. */
export function initTestSessionDb(): { inbound: Database; outbound: Database } {
  _testMode = true;
  _inbound = new Database(':memory:');
  _inbound.exec('PRAGMA foreign_keys = ON');
  _inbound.exec(`
    CREATE TABLE messages_in (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      kind           TEXT NOT NULL,
      timestamp      TEXT NOT NULL,
      status         TEXT DEFAULT 'pending',
      process_after  TEXT,
      recurrence     TEXT,
      series_id      TEXT,
      tries          INTEGER DEFAULT 0,
      trigger        INTEGER NOT NULL DEFAULT 1,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL,
      on_wake        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE delivered (
      message_out_id      TEXT PRIMARY KEY,
      platform_message_id TEXT,
      status              TEXT NOT NULL DEFAULT 'delivered',
      delivered_at        TEXT NOT NULL
    );
    CREATE TABLE destinations (
      name            TEXT PRIMARY KEY,
      display_name    TEXT,
      type            TEXT NOT NULL,
      channel_type    TEXT,
      platform_id     TEXT,
      agent_group_id  TEXT
    );
  `);

  _outbound = new Database(':memory:');
  _outbound.exec('PRAGMA foreign_keys = ON');
  _outbound.exec(`
    CREATE TABLE messages_out (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      in_reply_to    TEXT,
      timestamp      TEXT NOT NULL,
      deliver_after  TEXT,
      recurrence     TEXT,
      kind           TEXT NOT NULL,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL
    );
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
    CREATE TABLE session_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE container_state (
      id                       INTEGER PRIMARY KEY CHECK (id = 1),
      current_tool             TEXT,
      tool_declared_timeout_ms INTEGER,
      tool_started_at          TEXT,
      recent_tools             TEXT,
      thinking_line            TEXT,
      updated_at               TEXT NOT NULL
    );
  `);

  return { inbound: _inbound, outbound: _outbound };
}

export function closeSessionDb(): void {
  _inbound?.close();
  _inbound = null;
  _testMode = false;
  _outbound?.close();
  _outbound = null;
}
