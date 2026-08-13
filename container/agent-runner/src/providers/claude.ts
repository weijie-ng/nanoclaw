import fs from 'fs';
import os from 'os';
import path from 'path';

import { query as sdkQuery, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import {
  clearContainerProgress,
  clearContainerToolInFlight,
  setContainerThinkingLine,
  setContainerToolInFlight,
} from '../db/connection.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import { TIMEZONE, formatLocalStamp } from '../timezone.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

export interface SdkRateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  errorCode?: string;
  overageDisabledReason?: string;
}

/**
 * Map an SDK `rate_limit_event` to a provider event — or to NOTHING.
 *
 * The SDK emits this "when rate limit info changes": it is TELEMETRY, and
 * `status` is usually 'allowed' (here's your remaining headroom). We used to
 * treat every one as a terminal quota error: on a stock install that logged a
 * spurious "Rate limit (retryable: false, quota)" on perfectly healthy turns
 * (#3016), and any consumer acting on the classification aborted those turns
 * outright. **Only 'rejected' is an actual block.**
 *
 * When it IS rejected the SDK tells us WHY, so we distinguish properly instead
 * of guessing: `errorCode: 'credits_required'` / `overageDisabledReason:
 * 'out_of_credits'` means genuinely out of credits (billing); anything else is a
 * transient window limit that resets (`resetsAt`, `rateLimitType`).
 *
 * Returns null when the event is informational (do not disturb the turn).
 */
export function classifyRateLimitEvent(
  info: SdkRateLimitInfo | undefined,
): { message: string; classification: 'rate_limit' | 'quota' } | null {
  if (info?.status !== 'rejected') return null;
  const outOfCredits = info.errorCode === 'credits_required' || info.overageDisabledReason === 'out_of_credits';
  let detail = '';
  if (typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)) {
    const ms = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
    detail = ` (resets ${new Date(ms).toISOString()})`;
  }
  const window = info.rateLimitType ? ` [${info.rateLimitType}]` : '';
  return {
    message: `${outOfCredits ? 'Out of credits' : 'Rate limit'}${window}${detail}`,
    classification: outOfCredits ? 'quota' : 'rate_limit',
  };
}

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via `ncl tasks`.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - SendMessage: addresses Claude Code's own in-session subagents, which are
//   unrelated to NanoClaw agent groups — but the name reads as the obvious
//   way to message another agent, so an agent that just called
//   mcp__nanoclaw__create_agent reaches for it and gets "No agent named 'x'
//   is currently addressable". mcp__nanoclaw__send_message is the real
//   agent-to-agent path (it resolves the destination map in inbound.db).
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
// - DesignSync: desktop design-tool integration — nothing to sync with in a
//   headless container (~9.3KB/turn schema).
// - ReportFindings: code-review-reporting UI affordance with no headless
//   host surface to receive it (~1.9KB/turn schema).
export const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'SendMessage',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'DesignSync',
  'ReportFindings',
];

// Tool allowlist for NanoClaw agent containers. MCP-tool entries are derived
// at the call site from the registered `mcpServers` map so that any server
// added via `add_mcp_server` (or wired in container.json directly) is
// reachable to the agent — without this, the SDK's allowedTools filter
// silently drops every MCP namespace not listed here.
export const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
];

// MCP server names are sanitized by the SDK when forming tool prefixes:
// any character outside [A-Za-z0-9_-] becomes '_'. Mirror that here so our
// allowlist patterns match what the SDK actually exposes.
function mcpAllowPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── Transcript archiving (PreCompact hook) ──

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
const preToolUseHook: HookCallback = async (input) => {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }
  // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
  // tool: no declared timeout.
  const declaredTimeoutMs =
    toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs, toolLabel(toolName, i.tool_input));
  } catch (err) {
    log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/**
 * Longest tool-input detail we keep. The host renders one tool per line beside
 * a marker, so this is roughly what survives on a phone without wrapping — the
 * point is to identify the call ("which file", "which command"), not to
 * reproduce it.
 */
const TOOL_DETAIL_MAX = 44;

/** Trailing path segments kept for a file argument — a bare basename is too
 *  often ambiguous (every package has an index.ts). */
const PATH_SEGMENTS_KEPT = 2;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clampDetail(detail: string): string {
  const flat = collapse(detail);
  return flat.length <= TOOL_DETAIL_MAX ? flat : flat.slice(0, TOOL_DETAIL_MAX - 1).trimEnd() + '…';
}

function shortenPath(p: string): string {
  const segments = p.split('/').filter(Boolean);
  return segments.slice(-PATH_SEGMENTS_KEPT).join('/');
}

function urlHost(raw: string): string {
  try {
    return new URL(raw).host || raw;
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unparseable url is still worth showing verbatim
  } catch {
    return raw;
  }
}

/**
 * Display name for a tool. MCP tools arrive as `mcp__<server>__<tool>`, which
 * eats a whole progress line in prefix; the tool half is the informative part.
 */
export function displayToolName(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return toolName;
  const parts = toolName.split('__').filter(Boolean);
  return parts[parts.length - 1] || toolName;
}

/**
 * Reduce a tool's input to the one field that says which call this was.
 *
 * Returns '' when there is nothing worth showing — the caller then renders the
 * bare tool name. Everything is clamped, so an input carrying a whole file's
 * contents costs one short line, not the message.
 */
export function summarizeToolInput(toolName: string, input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const str = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '');
  switch (displayToolName(toolName)) {
    case 'Bash':
      return clampDetail(str('command'));
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return clampDetail(shortenPath(str('file_path')));
    case 'Glob':
      return clampDetail(str('pattern'));
    case 'Grep': {
      const where = shortenPath(str('path'));
      const pattern = str('pattern');
      return clampDetail(where ? `${pattern} · ${where}` : pattern);
    }
    case 'WebSearch':
      return clampDetail(str('query'));
    case 'WebFetch':
      return clampDetail(urlHost(str('url')));
    case 'Task':
    case 'Agent':
      return clampDetail(str('description'));
    case 'Skill':
      return clampDetail(str('skill'));
    default: {
      // Unknown tool (an MCP tool, most often). Object key order follows the
      // model's own JSON, so the first string field is the closest thing to a
      // primary argument available without a per-tool schema.
      for (const value of Object.values(input)) {
        if (typeof value === 'string' && collapse(value)) return clampDetail(value);
      }
      return '';
    }
  }
}

/** "Bash(pnpm test)" — what the host renders as one progress line. */
export function toolLabel(toolName: string, input: Record<string, unknown> | undefined): string {
  const name = displayToolName(toolName);
  const detail = summarizeToolInput(toolName, input);
  return detail ? `${name}(${detail})` : name;
}

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/**
 * Longest thinking summary we keep. The host renders it as one line of a
 * progress message alongside the tool list, so it has to survive on a phone
 * screen — `setContainerThinkingLine` enforces a hard 200-char cap, this is
 * the "readable" budget we aim for before falling back to a word-boundary cut.
 */
const THINKING_LINE_TARGET = 120;

/**
 * A sentence terminator this early is almost always an abbreviation ("e.g.",
 * "i.e.", "No.") rather than the end of a thought, so we keep scanning.
 */
const MIN_SENTENCE_CHARS = 24;

/**
 * Reduce a thinking block to a single short line for the host progress message.
 *
 * Summarized thinking usually arrives as a bolded title line followed by the
 * body ("**Checking the wiring defaults**\n\nI need to..."). That title is
 * already exactly the one-line summary we want, so take it verbatim when it's
 * there — sentence-splitting would otherwise run straight past it (titles carry
 * no terminating period) and return the first sentence of the body instead.
 *
 * Otherwise: flatten, take the first sentence, and fall back to a word-boundary
 * cut when that sentence is still too long. Returns '' when there is nothing
 * usable — callers must skip empty strings rather than writing them (an empty
 * write would leave the previous turn's line in place; see
 * `setContainerThinkingLine`, which ignores blank input).
 */
export function summarizeThinkingText(text: string): string {
  const title = /^\s*\*\*(.+?)\*\*\s*(?:\n|$)/.exec(text);
  if (title) return clampToWordBoundary(title[1].replace(/\s+/g, ' ').trim());

  // Collapse newlines first: a thinking block is multi-paragraph and we want a
  // sentence, not a line.
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';

  let sentence = flat;
  const terminators = /[.!?](?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = terminators.exec(flat)) !== null) {
    if (m.index + 1 >= MIN_SENTENCE_CHARS) {
      sentence = flat.slice(0, m.index + 1);
      break;
    }
  }
  return clampToWordBoundary(sentence);
}

/** Trim to THINKING_LINE_TARGET without slicing a word in half. */
function clampToWordBoundary(line: string): string {
  if (line.length <= THINKING_LINE_TARGET) return line;
  const cut = line.slice(0, THINKING_LINE_TARGET);
  const lastSpace = cut.lastIndexOf(' ');
  // Only honour the word boundary if it isn't so early that we'd emit a stub.
  const kept = lastSpace > THINKING_LINE_TARGET / 2 ? cut.slice(0, lastSpace) : cut;
  return kept.trimEnd() + '…';
}

/**
 * Pull the newest thinking text out of an SDK `assistant` message.
 *
 * The message carries a content-block array; a turn can emit several thinking
 * blocks interleaved with tool calls, and the LAST one is the agent's most
 * current state of mind — that's what the progress message should show. Blocks
 * are read through a structural cast rather than the SDK's block union so a
 * future SDK content-block shape can't turn this into a type error on a
 * cosmetic code path.
 */
function lastThinkingText(message: unknown): string | null {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as { type?: string; thinking?: unknown };
    if (block?.type !== 'thinking') continue;
    // Under `display: 'omitted'` the blocks still arrive but `.thinking` is an
    // empty string — nothing to show, and an earlier block won't be any better.
    return typeof block.thinking === 'string' && block.thinking.trim() ? block.thinking : null;
  }
  return null;
}

/**
 * Read a Claude transcript .jsonl, render a markdown summary, and drop it into
 * the agent's `conversations/` folder so context survives a compaction or a
 * session rotation. Best-effort: returns false (and logs) on any failure.
 */
function archiveTranscriptFile(
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  assistantName?: string,
): boolean {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    log('No transcript found for archiving');
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);
    if (messages.length === 0) return false;

    // Try to get summary from sessions index
    let summary: string | undefined;
    const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
    if (fs.existsSync(indexPath)) {
      try {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        summary = index.entries?.find(
          (e: { sessionId: string; summary?: string }) => e.sessionId === sessionId,
        )?.summary;
      } catch {
        /* ignore */
      }
    }

    const name = summary
      ? summary
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 50)
      : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

    const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR || '/workspace/agent/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });
    // Local calendar date — the fallback `name` above already uses local
    // hours, and the agent navigates conversations/ by these date prefixes.
    const filename = `${formatLocalStamp(new Date(), TIMEZONE).slice(0, 10)}-${name}.md`;
    fs.writeFileSync(path.join(conversationsDir, filename), formatTranscriptMarkdown(messages, summary, assistantName));
    log(`Archived conversation to ${filename}`);
    return true;
  } catch (err) {
    log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    archiveTranscriptFile(preCompact.transcript_path, preCompact.session_id, assistantName);
    return {};
  };
}

// ── Continuation rotation (cold-resume guard) ──

/**
 * Resume cost is dominated by transcript size. Past this many bytes a fresh
 * cold container can't reload the .jsonl before the host's 30-min idle ceiling
 * fires, so the session is dropped and started clean. Operator-overridable.
 */
function transcriptRotateBytes(): number {
  return Number(process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES) || 12 * 1024 * 1024;
}

/**
 * Secondary age trigger, measured from the transcript's first entry. 0 (or a
 * non-positive value) disables the age check; size alone then governs.
 */
function transcriptRotateAgeMs(): number {
  const raw = process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS;
  if (raw === undefined || raw.trim() === '') return 14 * 86_400_000;
  const days = Number(raw);
  if (!Number.isFinite(days)) return 14 * 86_400_000;
  // Explicit non-positive override disables the age check; size alone governs.
  return days > 0 ? days * 86_400_000 : Infinity;
}

function claudeProjectsDir(): string {
  return path.join(claudeConfigDir(), 'projects');
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
}

function writeMemorySessionHook(hook: MemorySessionHookRegistration): void {
  const configDir = claudeConfigDir();
  const settingsFile = path.join(configDir, 'settings.json');
  fs.mkdirSync(configDir, { recursive: true });

  const parsed: unknown = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) : {};
  if (!isRecord(parsed)) throw new Error(`${settingsFile} must contain a JSON object`);

  const hooks = parsed.hooks === undefined ? {} : parsed.hooks;
  if (!isRecord(hooks)) throw new Error(`${settingsFile} hooks must be a JSON object`);

  const sessionStart = hooks.SessionStart === undefined ? [] : hooks.SessionStart;
  if (!Array.isArray(sessionStart)) throw new Error(`${settingsFile} hooks.SessionStart must be an array`);

  const memoryCommands = new Set([hook.command, ...hook.legacyCommands]);
  const nextSessionStart = sessionStart
    .map((entry) => removeMemoryCommands(entry, memoryCommands))
    .filter((entry) => entry !== undefined);
  nextSessionStart.push({
    matcher: hook.sources.join('|'),
    hooks: [{ type: 'command', command: hook.command, timeout: 10 }],
  });

  hooks.SessionStart = nextSessionStart;
  parsed.hooks = hooks;
  fs.writeFileSync(settingsFile, JSON.stringify(parsed, null, 2) + '\n');
}

function removeMemoryCommands(value: unknown, commands: ReadonlySet<string>): unknown {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return value;
  const hooks = value.hooks.filter((hook) => {
    if (!isRecord(hook)) return true;
    return typeof hook.command !== 'string' || !commands.has(hook.command);
  });
  return hooks.length > 0 ? { ...value, hooks } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Locate the .jsonl backing a session id. The SDK names project dirs by a
 * mangled cwd; rather than reproduce that convention we scan project dirs for
 * `<sessionId>.jsonl` (session ids are UUIDs, so this is unambiguous).
 */
function findTranscriptPath(sessionId: string): string | null {
  const projects = claudeProjectsDir();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Epoch-ms of the first transcript entry, or null if unreadable. */
function transcriptStartMs(transcriptPath: string): number | null {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const firstLine = buf.toString('utf-8', 0, n).split('\n', 1)[0];
      const ts = JSON.parse(firstLine)?.timestamp;
      const ms = ts ? Date.parse(ts) : NaN;
      return Number.isNaN(ms) ? null : ms;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// ── Provider ──

/**
 * Claude Code auto-compacts context at this window (tokens). Kept here so
 * the generic bootstrap doesn't need to know about Claude-specific env vars.
 *
 * Operator override: set CLAUDE_CODE_AUTO_COMPACT_WINDOW in the host env to
 * raise or lower the threshold without editing source — useful when running
 * with a 1M-context model variant or when emergency-tuning a deployment.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000';

/** Reset the progress scratch state. Best-effort, like every other
 *  container_state write here — never fail a turn over decoration. */
function clearProgressBestEffort(): void {
  try {
    clearContainerProgress();
  } catch (err) {
    log(`Failed to clear progress state: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  private model?: string;
  private effort?: string;
  private memorySessionHook?: MemorySessionHookRegistration;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.model = options.model;
    this.effort = options.effort;
    this.env = {
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    };
  }

  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    writeMemorySessionHook(hook);
    this.memorySessionHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  maybeRotateContinuation(continuation: string): string | null {
    const transcriptPath = findTranscriptPath(continuation);
    if (!transcriptPath) return null;

    let size: number;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      return null;
    }

    const maxBytes = transcriptRotateBytes();
    const startMs = transcriptStartMs(transcriptPath);
    const ageMs = startMs === null ? 0 : Date.now() - startMs;
    const maxAgeMs = transcriptRotateAgeMs();

    let reason: string | null = null;
    if (size > maxBytes) {
      reason = `transcript ${(size / 1_048_576).toFixed(1)}MB > ${(maxBytes / 1_048_576).toFixed(0)}MB cap`;
    } else if (startMs !== null && ageMs > maxAgeMs) {
      reason = `transcript ${(ageMs / 86_400_000).toFixed(1)}d old > ${(maxAgeMs / 86_400_000).toFixed(0)}d cap`;
    }
    if (!reason) return null;

    // Preserve a readable summary, then move the heavy .jsonl out of the
    // resume path so the SDK starts a fresh session and the disk is reclaimed.
    archiveTranscriptFile(transcriptPath, continuation, this.assistantName);
    try {
      fs.renameSync(transcriptPath, `${transcriptPath}.rotated-${Date.now()}`);
    } catch (err) {
      log(`Failed to move rotated transcript aside: ${err instanceof Error ? err.message : String(err)}`);
    }
    return reason;
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memorySessionHook) throw new Error('Claude memory session hook was not registered');
    const stream = new MessageStream();
    stream.push(input.prompt);

    const instructions = input.systemContext?.instructions;

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: instructions
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions }
          : undefined,
        allowedTools: [...TOOL_ALLOWLIST, ...Object.keys(this.mcpServers).map(mcpAllowPattern)],
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: this.env,
        model: this.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        effort: this.effort as any,
        // `display: 'summarized'` is LOAD-BEARING, not decoration. On every
        // model this install runs (Opus 4.7+ / 4.8 / Opus 5 / Sonnet 5) the
        // adaptive default is `display: 'omitted'`, and under "omitted" the
        // thinking blocks STILL ARRIVE on the assistant message — their
        // `.thinking` field is just an empty string. So dropping this line
        // doesn't disable a feature loudly; it makes the host's live progress
        // message silently render blank forever. Leave it.
        thinking: { type: 'adaptive', display: 'summarized' },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user', 'local'],
        mcpServers: this.mcpServers,
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      try {
        for await (const message of sdkResult) {
          if (aborted) return;
          messageCount++;

          // Yield activity for every SDK event so the poll loop knows the agent is working
          yield { type: 'activity' };

          if (message.type === 'system' && message.subtype === 'init') {
            yield { type: 'init', continuation: message.session_id };
          } else if (message.type === 'result') {
            // `result` text exists only on subtype:"success"; error subtypes
            // (e.g. a non-retryable 403 billing_error) carry their message in
            // `errors[]` instead. Surface either so the poll-loop can deliver a
            // billing/quota notice to the user rather than dropping the turn.
            const m = message as { result?: string; is_error?: boolean; errors?: string[] };
            const text = m.result ?? (m.errors && m.errors.length > 0 ? m.errors.join('\n') : null);
            yield { type: 'result', text, isError: m.is_error === true };
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
            yield { type: 'error', message: 'API retry', retryable: true };
          } else if (message.type === 'rate_limit_event') {
            // The SDK emits this "when rate limit info CHANGES" — it is telemetry,
            // not necessarily an error. `rate_limit_info.status` is usually
            // 'allowed' (here's your remaining headroom). Treating every one of
            // these as a terminal quota error logged a spurious rate-limit line
            // on healthy turns (#3016) — and aborted them outright wherever the
            // classification is acted on. ONLY 'rejected' is an actual block.
            //
            // When it IS rejected the SDK tells us WHY, so we can finally
            // distinguish the two cases properly instead of guessing:
            //   errorCode 'credits_required' / overageDisabledReason
            //   'out_of_credits'  → genuinely out of credits (billing)
            //   otherwise         → a transient window limit that resets.
            const info = (message as { rate_limit_info?: SdkRateLimitInfo }).rate_limit_info;
            const blocked = classifyRateLimitEvent(info);
            if (!blocked) {
              // Informational ('allowed' / 'allowed_warning') — never kill the turn.
              if (info?.status === 'allowed_warning') {
                log(
                  `rate-limit warning: ${info.rateLimitType ?? 'window'} at ${
                    info.utilization != null ? `${Math.round(info.utilization * 100)}%` : 'high'
                  } utilization`,
                );
              }
            } else {
              yield {
                type: 'error',
                message: blocked.message,
                retryable: false,
                classification: blocked.classification,
              };
            }
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
            const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
            const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
            // Not a `result`: the poll loop treats result text as the agent's turn
            // output — a synthetic "Context compacted." result has no <message>
            // block, so it triggers the "response was not delivered — please
            // re-send" nudge and the agent duplicates its previous message.
            // Compaction is bookkeeping: log it, count it as activity only.
            log(`Context compacted${detail}.`);
            yield { type: 'activity' };
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
            const tn = message as { summary?: string };
            yield { type: 'progress', message: tn.summary || 'Task notification' };
          } else if (message.type === 'assistant') {
            // Feed the host's live progress message: record the agent's newest
            // thinking summary in container_state so the host can render it next
            // to the recent-tool list. Purely cosmetic side channel — it yields
            // nothing (the `activity` event at the top of the loop already
            // covered this message) and never throws into the loop, exactly like
            // the PreToolUse hook's container_state write.
            const thinking = lastThinkingText(message);
            if (thinking) {
              try {
                setContainerThinkingLine(summarizeThinkingText(thinking));
              } catch (err) {
                log(`Failed to record thinking line: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        }
        log(`Query completed after ${messageCount} SDK messages`);
      } finally {
        // A turn is over — drop the progress scratch state so the NEXT turn
        // starts from an empty tool list and no stale thinking line. In
        // `finally` rather than after the loop because the turn also ends via
        // the abort path (`if (aborted) return`) and via an SDK throw, and a
        // leftover tool list from a crashed turn is exactly what the host
        // would render on the next one. Best-effort, like every other
        // container_state write here.
        clearProgressBestEffort();
      }
    }

    return {
      push: (msg) => {
        // A pushed message starts a NEW turn inside the SAME query — the
        // poll loop feeds follow-ups into the live stream rather than
        // opening a fresh query. Reset the progress scratch here so turn
        // N+1 doesn't render turn N's tool list. Clearing at turn START
        // rather than turn end also avoids blanking the display in the
        // window between the result event and the host deleting the
        // message.
        clearProgressBestEffort();
        stream.push(msg);
      },
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
