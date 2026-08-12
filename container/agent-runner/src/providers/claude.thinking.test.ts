import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Database } from 'bun:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The host renders a live "what am I doing" message from container_state. Its
// thinking line originates here: the SDK's `assistant` messages carry the
// thinking blocks, and this provider is the only thing that sees them.
//
// Two silent-failure modes are guarded below, because neither surfaces as an
// error anywhere — the progress message just renders blank or stale:
//   1. `thinking.display` falling back to 'omitted'. The blocks still arrive
//      under 'omitted'; their `.thinking` text is simply the empty string.
//   2. progress state surviving past the end of a turn, so the next turn opens
//      showing the previous turn's tools and reasoning.

const sdkMessages: unknown[] = [];
let lastOptions: Record<string, unknown> | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options?: Record<string, unknown> }) => {
    lastOptions = args.options;
    return (async function* () {
      for (const m of sdkMessages) yield m;
    })();
  },
}));

const { ClaudeProvider, summarizeThinkingText } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
const { initTestSessionDb, closeSessionDb } = await import('../db/connection.js');

let tmp: string;
let prevHome: string | undefined;
let outbound: Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thinking-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  ({ outbound } = initTestSessionDb());
  sdkMessages.length = 0;
});

afterEach(() => {
  closeSessionDb();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface ProgressRow {
  recent_tools: string | null;
  thinking_line: string | null;
}

function progressState(): ProgressRow {
  const row = outbound.prepare('SELECT recent_tools, thinking_line FROM container_state WHERE id = 1').get();
  return (row as ProgressRow | null) ?? { recent_tools: null, thinking_line: null };
}

/** A started turn's event stream. The provider requires the memory hook. */
function startQuery(): AsyncGenerator<{ type: string; text?: string | null }> {
  const provider = new ClaudeProvider({});
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return provider.query({ prompt: 'hi', cwd: tmp }).events as AsyncGenerator<{ type: string; text?: string | null }>;
}

describe('thinking SDK option', () => {
  it("requests summarized display — under the 'omitted' default the text is empty", async () => {
    sdkMessages.push({ type: 'result', subtype: 'success', result: 'ok' });
    for await (const e of startQuery()) void e;

    // Not merely "thinking is set": adaptive+omitted is the model default and
    // would still deliver blocks, so only `display: 'summarized'` actually
    // makes the feature render anything.
    expect(lastOptions?.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });
});

describe('assistant-message thinking capture', () => {
  it('records the LAST thinking block of the message and clears it when the turn ends', async () => {
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'First I should read the router.' },
            { type: 'text', text: 'ignore me' },
            { type: 'thinking', thinking: 'Now checking the wiring defaults. Then I will edit.' },
          ],
        },
      },
      { type: 'result', subtype: 'success', result: '<message to="user">done</message>' },
    );

    // Stepped by hand: the branch runs AFTER the per-message `activity` yield,
    // and the turn-end clear runs only once the generator is exhausted — so a
    // plain `for await` could never observe the state in between.
    const events = startQuery();
    await events.next(); // activity (init)
    await events.next(); // init
    await events.next(); // activity (assistant)
    await events.next(); // activity (result) — the assistant branch has now run

    expect(progressState().thinking_line).toBe('Now checking the wiring defaults.');

    await events.next(); // result
    expect((await events.next()).done).toBe(true);
    // clearContainerProgress() ran in the generator's finally.
    expect(progressState().thinking_line).toBeNull();
    expect(progressState().recent_tools).toBeNull();
  });

  it('ignores blocks with empty text — that is exactly what display:omitted delivers', async () => {
    sdkMessages.push(
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } },
      { type: 'result', subtype: 'success', result: 'ok' },
    );

    const events = startQuery();
    await events.next(); // activity (assistant)
    await events.next(); // activity (result)
    expect(progressState().thinking_line).toBeNull();
    while (!(await events.next()).done);
  });

  it('never lets a malformed assistant message break the event stream', async () => {
    sdkMessages.push(
      { type: 'assistant' },
      { type: 'assistant', message: { content: 'not-an-array' } },
      { type: 'assistant', message: { content: [null, { type: 'text', text: 'hi' }] } },
      { type: 'result', subtype: 'success', result: '<message to="user">done</message>' },
    );

    const collected: { type: string; text?: string | null }[] = [];
    for await (const e of startQuery()) collected.push(e);

    const results = collected.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toBe('<message to="user">done</message>');
  });

  it('does not turn assistant messages into extra provider events', async () => {
    sdkMessages.push(
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'thinking about it' }] } },
      { type: 'result', subtype: 'success', result: 'ok' },
    );

    const collected: { type: string }[] = [];
    for await (const e of startQuery()) collected.push(e);

    // One activity per SDK message, plus the single result. An assistant
    // message must not surface as a result — the poll loop treats result text
    // as the agent's turn output and would deliver it twice.
    expect(collected.map((e) => e.type)).toEqual(['activity', 'activity', 'result']);
  });
});

describe('summarizeThinkingText', () => {
  it('prefers a bolded title line — it is already the one-line summary', () => {
    expect(summarizeThinkingText('**Checking the wiring defaults**\n\nI need to read channel-defaults.ts first.')).toBe(
      'Checking the wiring defaults',
    );
  });

  it('takes the first sentence of an untitled block, flattening newlines', () => {
    expect(summarizeThinkingText('I should read the router\nfirst. Then edit delivery.ts.')).toBe(
      'I should read the router first.',
    );
  });

  it('does not stop at an early abbreviation', () => {
    expect(summarizeThinkingText('The env vars, e.g. HOME, are set by the runner. Next step is the DB.')).toBe(
      'The env vars, e.g. HOME, are set by the runner.',
    );
  });

  it('cuts a long sentence on a word boundary rather than mid-word', () => {
    const long = 'xxxxxxxxxx ' + Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ') + '.';
    const out = summarizeThinkingText(long);
    expect(out.length).toBeLessThanOrEqual(121); // 120-char target + the ellipsis
    expect(out.endsWith('…')).toBe(true);
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
  });

  it('returns empty for nothing usable, so callers can skip the write', () => {
    expect(summarizeThinkingText('')).toBe('');
    expect(summarizeThinkingText('   \n\t ')).toBe('');
  });
});
