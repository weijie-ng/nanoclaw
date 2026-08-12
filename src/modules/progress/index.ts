/**
 * Live progress message — default module.
 *
 * A typing indicator says "something is happening" but nothing about
 * what. On a long turn (research, a build, a chain of tool calls) the
 * user is left staring at "typing…" for minutes. This module posts a
 * single throwaway message into the chat and edits it in place while
 * the agent works: a one-line thinking summary, the last few tool
 * names, and elapsed time. When the real reply lands, the message is
 * deleted — the transcript keeps only the answer.
 *
 * Shape mirrors src/modules/typing/index.ts: a per-session Map, one
 * unref'd timer chain per entry, adapter reached through the delivery
 * module, and every failure swallowed. Progress is decoration; it must
 * never be able to break routing or delivery.
 *
 * Telegram only. It is the one channel here whose adapter implements
 * both editMessage and deleteMessage, and the edit-in-place illusion
 * falls apart without the delete (a channel that can't delete would
 * leave a stale "⏱ 34s" fossil above every answer).
 *
 * Default module status:
 *   - Lives in src/modules/ for signaling (not really core), but ships
 *     on main and is imported directly by core. No registry, no hook.
 *   - Removing requires editing src/router.ts and src/delivery.ts to
 *     drop the calls.
 */
import fs from 'fs';

import type Database from 'better-sqlite3';

import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { heartbeatPath, openOutboundDb } from '../../session-manager.js';

/**
 * Don't post at all until the turn has been running this long. Most
 * turns finish in a few seconds, and a message that flashes up and
 * deletes itself is worse than no message — it reads as a glitch and
 * (on Telegram) pushes a notification for content that no longer
 * exists by the time the user looks.
 */
const FIRST_POST_DELAY_MS = 7000;
/**
 * Edit cadence once posted. Telegram's per-chat budget is roughly 20
 * messages/minute and edits draw from the same bucket, so 5s (12/min)
 * leaves headroom for the agent's actual replies.
 */
const EDIT_INTERVAL_MS = 5000;
/** Ring-buffer size the container writes; mirrored here for rendering. */
const MAX_TOOLS = 5;
/** Fallback backoff when a 429 arrives without a usable retry_after. */
const DEFAULT_BACKOFF_MS = 30_000;
/** Ceiling on honored retry_after, so a pathological value can't wedge
 *  the entry past any plausible turn length. */
const MAX_BACKOFF_MS = 300_000;
/**
 * Liveness, on the same signal the typing module uses: the container
 * touches /workspace/.heartbeat on every provider event, so a mtime
 * older than this means the agent is no longer working.
 *
 * This is what terminates the loop. stopProgress fires on a delivered
 * reply, but a turn can end without ever producing one — the container
 * is killed, the agent emits no <message> block, delivery fails
 * permanently, the host restarts mid-turn. Without a liveness check
 * those all leave a message in a live group chat being edited every 5s
 * forever. Progress must be able to retire itself.
 */
const HEARTBEAT_FRESH_MS = 6000;
/**
 * Grace from startProgress before the heartbeat is consulted at all —
 * cold container spawn takes 5–12s and writes no heartbeat until the
 * agent-runner's first poll. Matches the typing module's window.
 */
const LIVENESS_GRACE_MS = 15_000;
/**
 * Hard ceiling regardless of heartbeat, mirroring the host sweep's
 * absolute container ceiling (host-sweep.ts). A wedged container that
 * somehow keeps its heartbeat warm still can't hold a progress message
 * up indefinitely.
 */
const ABSOLUTE_CEILING_MS = 1_800_000;

interface ProgressTarget {
  /** Carried on the entry so liveness can resolve the heartbeat path
   *  without threading the id through every helper. */
  sessionId: string;
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  /** Adapter instance that owns the chat; undefined = default (= channelType). */
  instance?: string;
  /** Fires once at FIRST_POST_DELAY_MS, then hands off to `interval`. */
  firstPost: NodeJS.Timeout;
  interval: NodeJS.Timeout | null;
  startedAt: number;
  /** Platform id of the posted progress message; undefined until posted. */
  messageId?: string;
  /** Exact text last handed to the adapter — dedupe key. */
  lastText?: string;
  /** Epoch ms; 0 = not backing off. Set from a 429's retry_after. */
  backoffUntil: number;
  /** An adapter call is in flight — ticks skip rather than pile up. */
  busy: boolean;
}

const progressTargets = new Map<string, ProgressTarget>();

/** What the container publishes about the in-flight turn. */
interface ProgressState {
  thinkingLine: string | null;
  recentTools: string[];
}

const EMPTY_STATE: ProgressState = { thinkingLine: null, recentTools: [] };

/**
 * Read the container's progress columns from outbound.db (read-only —
 * the container is the sole writer of that file).
 *
 * Opened and closed per tick, the same open-read-close discipline
 * host-sweep uses for container_state. Both columns are forward-compat
 * ALTERs, so a session DB created before this feature has the table but
 * not the columns: the SELECT throws SQLITE_ERROR and we fall through
 * to the empty state rather than probing PRAGMA table_info every 5s.
 */
function readProgressState(agentGroupId: string, sessionId: string): ProgressState {
  let db: Database.Database;
  try {
    db = openOutboundDb(agentGroupId, sessionId);
    // eslint-disable-next-line no-catch-all/no-catch-all -- no session DB yet is the normal pre-spawn state, not an error to surface
  } catch {
    return EMPTY_STATE; // outbound.db doesn't exist yet (container still spawning)
  }
  try {
    const row = db.prepare('SELECT recent_tools, thinking_line FROM container_state WHERE id = 1').get() as
      | { recent_tools: string | null; thinking_line: string | null }
      | undefined;
    if (!row) return EMPTY_STATE;
    return {
      thinkingLine: row.thinking_line && row.thinking_line.trim().length > 0 ? row.thinking_line.trim() : null,
      recentTools: parseTools(row.recent_tools),
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- a pre-feature session DB lacks these columns by design; the empty state is the answer
  } catch {
    // Missing table/columns on an older session DB — nothing to show.
    return EMPTY_STATE;
  } finally {
    db.close();
  }
}

function parseTools(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === 'string' && t.length > 0).slice(-MAX_TOOLS);
    // eslint-disable-next-line no-catch-all/no-catch-all -- a torn or malformed ring buffer is tolerated input, never a reason to fail a tick
  } catch {
    return [];
  }
}

/**
 * Render the progress body. Order is thinking → tools → elapsed, each
 * line dropped when it has nothing to say.
 *
 * Never returns an empty string: Telegram's editMessage rejects empty
 * text with a ValidationError, and the very first post routinely lands
 * before the container has written either column (7s is often still
 * inside container spawn). "🔧 Working…" is the seed for that gap.
 *
 * Exported for tests — pure, no clock and no I/O of its own.
 */
export function renderProgress(state: ProgressState, elapsedMs: number): string {
  const lines: string[] = [];
  if (state.thinkingLine) lines.push(`🤔 ${state.thinkingLine}`);
  if (state.recentTools.length > 0) lines.push(`🔧 ${state.recentTools.join(' · ')}`);
  if (lines.length === 0) lines.push('🔧 Working…');
  lines.push(`⏱ ${Math.floor(elapsedMs / 1000)}s`);
  return lines.join('\n');
}

/**
 * A 429 surfaces as `AdapterRateLimitError` from `@chat-adapter/shared`
 * carrying `retryAfter` in seconds. That package is a transitive dep of
 * a skill-installed channel adapter — trunk can't import it (it isn't
 * in the host's dependency tree at all on an install with no channels),
 * so this duck-types on the two fields the class sets: `name` and the
 * `RATE_LIMITED` code inherited from AdapterError.
 *
 * Returns the backoff in ms, or null when the error isn't a rate limit.
 */
function rateLimitBackoffMs(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { name?: unknown; code?: unknown; retryAfter?: unknown };
  if (e.name !== 'AdapterRateLimitError' && e.code !== 'RATE_LIMITED') return null;
  const secs = typeof e.retryAfter === 'number' && Number.isFinite(e.retryAfter) && e.retryAfter > 0 ? e.retryAfter : 0;
  return Math.min(secs > 0 ? secs * 1000 : DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS);
}

/**
 * Send one Chat-SDK envelope for this target. Resolves to the platform
 * message id where the operation produces one (post and edit both do;
 * delete returns undefined).
 *
 * Goes straight to the delivery adapter rather than through
 * messages_out: that queue is polled on a 1s floor serially across
 * sessions, is never pruned, and every progress frame would burn an
 * odd `seq` out of the agent's own message-id space. Progress owns its
 * timer and its failures; the outbound queue stays the agent's.
 */
async function send(entry: ProgressTarget, payload: Record<string, unknown>): Promise<string | undefined> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return undefined;
  return adapter.deliver(
    entry.channelType,
    entry.platformId,
    entry.threadId,
    'chat-sdk',
    JSON.stringify(payload),
    undefined,
    entry.instance,
  );
}

async function deleteMessage(entry: ProgressTarget, messageId: string): Promise<void> {
  try {
    await send(entry, { operation: 'delete', messageId });
    // eslint-disable-next-line no-catch-all/no-catch-all -- cleanup is best-effort; a failed delete must never propagate into the delivery path
  } catch (err) {
    // Already gone (user deleted it, chat cleared) or the platform is
    // unhappy — either way there's nothing useful to retry.
    log.warn('Failed to delete progress message', { messageId, err });
  }
}

/**
 * Is the agent still working? Heartbeat mtime, after a spawn grace
 * window, plus an absolute ceiling. See HEARTBEAT_FRESH_MS — this is
 * the loop's own termination condition, independent of stopProgress.
 */
function stillWorking(entry: ProgressTarget): boolean {
  const age = Date.now() - entry.startedAt;
  if (age > ABSOLUTE_CEILING_MS) return false;
  if (age < LIVENESS_GRACE_MS) return true; // container may still be spawning
  try {
    const stat = fs.statSync(heartbeatPath(entry.agentGroupId, entry.sessionId));
    return Date.now() - stat.mtimeMs < HEARTBEAT_FRESH_MS;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a missing heartbeat past the grace window means the container is gone, which is exactly the retire signal
  } catch {
    return false; // no heartbeat file past the grace window = not working
  }
}

async function tick(sessionId: string): Promise<void> {
  const entry = progressTargets.get(sessionId);
  if (!entry) return; // stopped externally since this tick was scheduled
  if (entry.busy) return; // previous adapter call hasn't come back yet
  if (!stillWorking(entry)) {
    // The turn ended without a delivered reply (container killed, no
    // <message> envelope, delivery failed, host restarted). Retire the
    // message ourselves rather than editing it into a live chat until
    // the process dies.
    log.debug('Progress retiring — agent no longer working', { sessionId });
    await stopProgress(sessionId);
    return;
  }
  if (entry.backoffUntil > Date.now()) return; // honoring a 429's retry_after

  const state = readProgressState(entry.agentGroupId, sessionId);
  const text = renderProgress(state, Date.now() - entry.startedAt);
  // Telegram answers a no-op edit with 400 "message is not modified",
  // which the adapter raises as a ValidationError. Cheaper to not ask.
  if (text === entry.lastText) return;

  entry.busy = true;
  try {
    if (!entry.messageId) {
      const posted = await send(entry, { text });
      // Identity, not mere presence: an agent-shared session can change
      // address mid-flight, and startProgress then replaces the entry.
      // Writing `posted` onto that replacement would bind the OLD
      // chat's message id to the NEW chat — every later edit would then
      // fail the adapter's composite-id chat check, and the old message
      // would never be cleaned up.
      if (progressTargets.get(sessionId) !== entry) {
        if (posted) await deleteMessage(entry, posted);
        return;
      }
      entry.messageId = posted;
      entry.lastText = text;
      return;
    }
    await send(entry, { operation: 'edit', messageId: entry.messageId, text });
    if (progressTargets.get(sessionId) === entry) entry.lastText = text;
    // eslint-disable-next-line no-catch-all/no-catch-all -- progress is decoration: rate limits back off, everything else drops the frame, nothing reaches routing
  } catch (err) {
    const backoff = rateLimitBackoffMs(err);
    if (backoff !== null) {
      entry.backoffUntil = Date.now() + backoff;
      log.warn('Progress message rate limited — backing off', { sessionId, backoffMs: backoff });
      return;
    }
    // Anything else: drop this frame. A failed post leaves messageId
    // unset, so the next tick retries the post rather than editing an
    // id we never got.
    log.warn('Progress message update failed', { sessionId, err });
  } finally {
    entry.busy = false;
  }
}

function scheduleTick(sessionId: string): void {
  void tick(sessionId).catch((err) => {
    // tick already swallows adapter failures; this is the last net so a
    // bug in here can't surface as an unhandled rejection.
    log.warn('Progress tick threw', { sessionId, err });
  });
}

function sameAddress(
  entry: ProgressTarget,
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
): boolean {
  return (
    entry.channelType === channelType &&
    entry.platformId === platformId &&
    entry.threadId === threadId &&
    entry.instance === instance
  );
}

/**
 * Begin tracking progress for a session's turn. Called from the router
 * alongside startTypingRefresh, on the same wake.
 *
 * Nothing is sent for FIRST_POST_DELAY_MS; a turn that finishes inside
 * that window never touches the chat at all.
 */
export function startProgress(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
): void {
  if (channelType !== 'telegram') {
    // Every other channel is inert. An agent-shared session can move
    // between platforms mid-life, so also retire anything a previous
    // telegram message left up rather than orphaning it.
    void stopProgress(sessionId);
    return;
  }

  const existing = progressTargets.get(sessionId);
  if (existing) {
    if (sameAddress(existing, channelType, platformId, threadId, instance)) {
      // Same chat, turn still running — keep the live message and let
      // the elapsed clock keep counting from the first wake. The agent
      // has been working continuously; restarting the clock would lie.
      return;
    }
    // Address moved (agent-shared sessions span messaging groups). The
    // posted id is scoped to the old chat — Telegram's composite
    // "<chatId>:<messageId>" would fail validation against the new
    // threadId — so retire it and start over in the new chat. The
    // synchronous prefix of stopProgress clears the map entry before
    // this function continues, so the new entry can't be clobbered.
    void stopProgress(sessionId);
  }

  const firstPost = setTimeout(() => {
    const entry = progressTargets.get(sessionId);
    if (!entry) return;
    scheduleTick(sessionId);
    const interval = setInterval(() => scheduleTick(sessionId), EDIT_INTERVAL_MS);
    interval.unref();
    entry.interval = interval;
  }, FIRST_POST_DELAY_MS);
  // unref so a leaked entry can't hold the event loop alive.
  firstPost.unref();

  progressTargets.set(sessionId, {
    sessionId,
    agentGroupId,
    channelType,
    platformId,
    threadId,
    instance,
    firstPost,
    interval: null,
    startedAt: Date.now(),
    backoffUntil: 0,
    busy: false,
  });
}

/**
 * Stop tracking and delete the posted progress message, if any. Called
 * when the real reply is delivered (and when a wake fails, so a session
 * that never started doesn't leave a timer behind).
 *
 * Safe to call for a session that never posted, was never started, or
 * isn't on Telegram at all — all of those are a no-op.
 */
export async function stopProgress(sessionId: string): Promise<void> {
  const entry = progressTargets.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.firstPost);
  if (entry.interval) clearInterval(entry.interval);
  // Drop the entry before awaiting: an in-flight tick checks the map
  // after its await and cleans up its own orphan post when we're gone.
  progressTargets.delete(sessionId);
  if (!entry.messageId) return;
  await deleteMessage(entry, entry.messageId);
}
