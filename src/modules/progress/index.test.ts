/**
 * Live progress message tests.
 *
 * The module's whole risk surface is timing and blast radius: it posts
 * into a real chat on a timer, edits on a second timer, and must be
 * unable to damage anything around it. These pin the four rules that
 * make it safe to leave on for every Telegram chat — the 7s silence
 * window, the byte-identical dedupe, honoring a 429's retry_after, and
 * cleaning up after itself — plus the regression that progress traffic
 * never arms the typing module's post-delivery pause.
 *
 * No outbound.db is created: with the file absent, readProgressState
 * falls through to the empty state and every render is the "🔧 Working…"
 * seed, which is exactly the shape the first post takes in production
 * (7s is often still inside container spawn).
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-progress' };
});

import { setDeliveryAdapter } from '../../delivery.js';
import { heartbeatPath } from '../../session-manager.js';
import { startTypingRefresh, stopTypingRefresh } from '../typing/index.js';
import { renderProgress, startProgress, stopProgress } from './index.js';

interface Sent {
  channelType: string;
  platformId: string;
  threadId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  instance?: string;
}

const DATA_DIR = '/tmp/nanoclaw-test-progress';
const SESSION = 'sess-progress-1';
const POSTED_ID = '-100123:55';

/**
 * Write an outbound.db where the module expects one. `withProgressColumns`
 * false reproduces a session DB created before this feature: the table is
 * there, the two forward-compat ALTERs are not.
 */
function writeOutboundDb(
  state: { recent_tools?: string | null; thinking_line?: string | null },
  withProgressColumns = true,
): void {
  const dir = path.join(DATA_DIR, 'v2-sessions', 'ag-1', SESSION);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'outbound.db'));
  db.pragma('journal_mode = DELETE');
  db.exec(`CREATE TABLE container_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    current_tool TEXT,
    tool_declared_timeout_ms INTEGER,
    tool_started_at TEXT,
    updated_at TEXT NOT NULL
    ${withProgressColumns ? ', recent_tools TEXT, thinking_line TEXT' : ''}
  )`);
  if (withProgressColumns) {
    db.prepare('INSERT INTO container_state (id, updated_at, recent_tools, thinking_line) VALUES (1, ?, ?, ?)').run(
      new Date().toISOString(),
      state.recent_tools ?? null,
      state.thinking_line ?? null,
    );
  } else {
    db.prepare('INSERT INTO container_state (id, updated_at) VALUES (1, ?)').run(new Date().toISOString());
  }
  db.close();
}

let sent: Sent[] = [];
let typingCalls = 0;
/** Per-test override; default posts/edits resolve to the composite id. */
let deliverImpl: (payload: Record<string, unknown>) => Promise<string | undefined>;

function installAdapter(): void {
  // setDeliveryAdapter also forwards the adapter to the typing module,
  // which the pause regression test below relies on.
  setDeliveryAdapter({
    async deliver(channelType, platformId, threadId, kind, content, _files, instance) {
      const payload = JSON.parse(content) as Record<string, unknown>;
      sent.push({ channelType, platformId, threadId, kind, payload, instance });
      return deliverImpl(payload);
    },
    async setTyping() {
      typingCalls++;
    },
  });
}

function start(channelType = 'telegram'): void {
  startProgress(SESSION, 'ag-1', channelType, '-100123', '-100123', 'telegram');
}

/** Shape of the rate-limit error @chat-adapter/shared throws on a 429. */
class FakeRateLimitError extends Error {
  readonly code = 'RATE_LIMITED';
  constructor(readonly retryAfter: number) {
    super(`Rate limited by telegram, retry after ${retryAfter}s`);
    this.name = 'AdapterRateLimitError';
  }
}

/**
 * Mark the container as alive *right now* in fake-clock terms.
 *
 * Liveness is heartbeat-mtime based, and mtime is real wall-clock while
 * Date.now() is faked — so any test that advances fake time past
 * LIVENESS_GRACE_MS (15s) has to re-stamp the file, exactly as a
 * working container would by touching it on every provider event.
 * Without this the module correctly retires the entry, which is the
 * behavior `retires itself when the container stops heartbeating`
 * asserts.
 */
function beatHeartbeat(): void {
  const p = heartbeatPath('ag-1', SESSION);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
  const now = Date.now() / 1000;
  fs.utimesSync(p, now, now);
}

/** Advance fake time in steps, keeping the heartbeat warm throughout. */
async function advanceAlive(totalMs: number, stepMs = 2_000): Promise<void> {
  let left = totalMs;
  while (left > 0) {
    const step = Math.min(stepMs, left);
    beatHeartbeat();
    await vi.advanceTimersByTimeAsync(step);
    left -= step;
  }
  beatHeartbeat();
}

beforeEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  sent = [];
  typingCalls = 0;
  deliverImpl = async (payload) => (payload.operation === 'delete' ? undefined : POSTED_ID);
  vi.useFakeTimers();
  installAdapter();
});

afterEach(async () => {
  await stopProgress(SESSION);
  stopTypingRefresh(SESSION);
  vi.useRealTimers();
});

describe('renderProgress', () => {
  it('renders thinking, tools and elapsed in order', () => {
    expect(
      renderProgress({ thinkingLine: 'Checking the build logs', recentTools: ['Read', 'Grep', 'Bash'] }, 34_000),
    ).toBe('🤔 Checking the build logs\n🔧 Read · Grep · Bash\n⏱ 34s');
  });

  it('drops the lines it has nothing for and never renders empty', () => {
    expect(renderProgress({ thinkingLine: null, recentTools: ['Edit'] }, 9_400)).toBe('🔧 Edit\n⏱ 9s');
    // Empty text is a ValidationError from Telegram's editMessage, so
    // the no-data case still has to produce something.
    expect(renderProgress({ thinkingLine: null, recentTools: [] }, 7_000)).toBe('🔧 Working…\n⏱ 7s');
  });
});

describe('startProgress', () => {
  it('sends nothing before the first-post delay', async () => {
    start();
    await vi.advanceTimersByTimeAsync(6_900);
    expect(sent).toHaveLength(0);
  });

  it('posts once the first-post delay elapses', async () => {
    start();
    await vi.advanceTimersByTimeAsync(7_050);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      channelType: 'telegram',
      platformId: '-100123',
      threadId: '-100123',
      kind: 'chat-sdk',
      instance: 'telegram',
      payload: { text: '🔧 Working…\n⏱ 7s' },
    });
  });

  it('edits the posted message in place on the following ticks', async () => {
    start();
    await vi.advanceTimersByTimeAsync(7_050);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(2);
    expect(sent[1].payload).toEqual({
      operation: 'edit',
      messageId: POSTED_ID,
      text: '🔧 Working…\n⏱ 12s',
    });
  });

  it('does not re-send a render byte-identical to the last one', async () => {
    // Leave Date real (and therefore effectively frozen for the few ms
    // this test takes) while keeping the timers fake, so both ticks
    // render the same elapsed value. Telegram answers an unchanged edit
    // with 400 "message is not modified".
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

    start();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(1);
  });

  it('backs off for retry_after seconds after a 429 instead of hammering', async () => {
    deliverImpl = async () => {
      throw new FakeRateLimitError(30);
    };
    start();
    beatHeartbeat();
    await vi.advanceTimersByTimeAsync(7_050); // first post → 429
    expect(sent).toHaveLength(1);

    // Four edit ticks fall inside the 30s backoff and must all be skipped.
    // The container is still working throughout, so keep the heartbeat
    // warm — a stale one would retire the entry instead of backing off.
    await advanceAlive(20_000);
    expect(sent).toHaveLength(1);

    // The first tick past the 30s backoff retries — and since the post
    // never landed, it retries as a post, not as an edit against an id
    // we never got.
    deliverImpl = async () => POSTED_ID;
    await advanceAlive(10_000);
    expect(sent).toHaveLength(2);
    expect(sent[1].payload.operation).toBeUndefined();
    expect(sent[1].payload.text).toBe('🔧 Working…\n⏱ 37s');
  });

  it('retires itself when the container stops heartbeating', async () => {
    // The defect this guards: stopProgress only fires on a delivered
    // user-facing reply or a failed wake. A turn can end with neither —
    // container killed, no <message> envelope emitted, delivery failed
    // permanently, host restarted mid-turn. Without a liveness check the
    // message sits in a live group chat being edited every 5s forever.
    start();
    await advanceAlive(12_000); // posts at 7s, edits at 12s, still working
    expect(sent[0].payload.operation).toBeUndefined(); // the post
    expect(sent.filter((s) => s.payload.operation === 'delete')).toHaveLength(0);

    // Container dies: heartbeat goes stale. Past the grace window the
    // next tick must delete the message and stop the interval.
    await vi.advanceTimersByTimeAsync(20_000);
    const deletes = sent.filter((s) => s.payload.operation === 'delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].payload.messageId).toBe(POSTED_ID);

    // And it must stay stopped — no further traffic of any kind.
    const after = sent.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(after);
  });

  it('does not retire during the spawn grace window, before any heartbeat exists', async () => {
    // Cold container spawn takes 5–12s and writes no heartbeat until the
    // agent-runner's first poll, so an absent heartbeat inside the grace
    // window must not be read as "dead".
    start();
    await vi.advanceTimersByTimeAsync(7_050); // no heartbeat written at all
    expect(sent).toHaveLength(1);
    expect(sent.filter((s) => s.payload.operation === 'delete')).toHaveLength(0);
  });

  it("renders the container's thinking line and tool ring from outbound.db", async () => {
    writeOutboundDb({
      thinking_line: 'Tracing the delivery path',
      recent_tools: JSON.stringify(['Read', 'Grep', 'Bash', 'Edit']),
    });
    start();
    await vi.advanceTimersByTimeAsync(7_050);
    expect(sent[0].payload.text).toBe('🤔 Tracing the delivery path\n🔧 Read · Grep · Bash · Edit\n⏱ 7s');
  });

  it('falls back to the seed when the session DB predates the progress columns', async () => {
    writeOutboundDb({}, false);
    start();
    await vi.advanceTimersByTimeAsync(7_050);
    expect(sent[0].payload.text).toBe('🔧 Working…\n⏱ 7s');
  });

  it('is fully inert on a non-telegram channel', async () => {
    start('slack');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(0);
    await stopProgress(SESSION);
    expect(sent).toHaveLength(0);
  });
});

describe('stopProgress', () => {
  it('deletes the posted progress message', async () => {
    start();
    await vi.advanceTimersByTimeAsync(7_050);
    expect(sent).toHaveLength(1);

    await stopProgress(SESSION);
    expect(sent).toHaveLength(2);
    expect(sent[1].payload).toEqual({ operation: 'delete', messageId: POSTED_ID });

    // Timers are gone too — no zombie edits against a deleted message.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(2);
  });

  it('is a no-op when nothing was ever posted', async () => {
    start();
    await vi.advanceTimersByTimeAsync(2_000); // still inside the silence window
    await stopProgress(SESSION);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(0);
  });

  it('is a no-op for a session that was never started', async () => {
    await expect(stopProgress('sess-never-started')).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it('swallows a failed delete', async () => {
    start();
    await vi.advanceTimersByTimeAsync(7_050);
    deliverImpl = async () => {
      throw new Error('message to delete not found');
    };
    await expect(stopProgress(SESSION)).resolves.toBeUndefined();
  });
});

describe('progress vs. the typing indicator', () => {
  it('does not arm the post-delivery typing pause', async () => {
    // Progress calls the delivery ADAPTER directly rather than going
    // through drainSession, so it must never trip
    // pauseTypingRefreshAfterDelivery. If it did, the 10s pause would be
    // re-armed every 5s and the working "typing…" indicator would be
    // suppressed for the rest of the turn.
    startTypingRefresh(SESSION, 'ag-1', 'telegram', '-100123', '-100123', 'telegram');
    start();

    // 12s: typing's immediate tick plus ticks at 4s, 8s and 12s — all
    // inside its 15s grace window, so all four fire unless paused. The
    // progress post lands at 7s, between the 4s and 8s typing ticks.
    await vi.advanceTimersByTimeAsync(12_100);

    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(typingCalls).toBeGreaterThanOrEqual(4);
  });
});
