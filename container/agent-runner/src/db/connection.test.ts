import { beforeEach, describe, expect, test } from 'bun:test';

import {
  clearContainerProgress,
  clearContainerToolInFlight,
  getOutboundDb,
  initTestSessionDb,
  setContainerThinkingLine,
  setContainerToolInFlight,
} from './connection.js';

beforeEach(() => {
  initTestSessionDb();
});

type ProgressRow = {
  current_tool: string | null;
  tool_declared_timeout_ms: number | null;
  tool_started_at: string | null;
  recent_tools: string | null;
  thinking_line: string | null;
};

/** Read the single container_state row as the host would (null when absent). */
function readState(): ProgressRow | null {
  return getOutboundDb()
    .prepare(
      `SELECT current_tool, tool_declared_timeout_ms, tool_started_at, recent_tools, thinking_line
       FROM container_state WHERE id = 1`,
    )
    .get() as ProgressRow | null;
}

function readRecentTools(): string[] | null {
  const raw = readState()?.recent_tools ?? null;
  return raw === null ? null : (JSON.parse(raw) as string[]);
}

describe('container_state — recent_tools ring buffer', () => {
  test('first tool creates the row with a one-entry buffer', () => {
    setContainerToolInFlight('Read', null);

    const row = readState()!;
    expect(row.current_tool).toBe('Read');
    expect(JSON.parse(row.recent_tools!)).toEqual(['Read']);
  });

  test('appends most-recent-LAST', () => {
    setContainerToolInFlight('Read', null);
    setContainerToolInFlight('Grep', null);
    setContainerToolInFlight('Bash', 600_000);

    expect(readRecentTools()).toEqual(['Read', 'Grep', 'Bash']);
  });

  test('caps at 5 entries, dropping the oldest', () => {
    for (const tool of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      setContainerToolInFlight(tool, null);
    }

    expect(readRecentTools()).toEqual(['C', 'D', 'E', 'F', 'G']);
  });

  test('repeated tool names are kept as distinct entries', () => {
    setContainerToolInFlight('Read', null);
    setContainerToolInFlight('Read', null);
    setContainerToolInFlight('Edit', null);

    expect(readRecentTools()).toEqual(['Read', 'Read', 'Edit']);
  });

  test('the in-flight columns still track the latest tool', () => {
    setContainerToolInFlight('Read', null);
    setContainerToolInFlight('Bash', 900_000);

    const row = readState()!;
    expect(row.current_tool).toBe('Bash');
    expect(row.tool_declared_timeout_ms).toBe(900_000);
    // Timestamps are always ISO-8601 UTC.
    expect(row.tool_started_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  test('a malformed recent_tools value is discarded, not thrown on', () => {
    // Simulates an outbound.db written by a different revision.
    getOutboundDb()
      .prepare('INSERT INTO container_state (id, recent_tools, updated_at) VALUES (1, ?, ?)')
      .run('not json', new Date().toISOString());

    setContainerToolInFlight('Read', null);

    expect(readRecentTools()).toEqual(['Read']);
  });
});

describe('container_state — clearContainerToolInFlight', () => {
  test('clears the in-flight columns but preserves recent_tools', () => {
    setContainerToolInFlight('Read', null);
    setContainerToolInFlight('Grep', null);

    clearContainerToolInFlight();

    const row = readState()!;
    expect(row.current_tool).toBeNull();
    expect(row.tool_declared_timeout_ms).toBeNull();
    expect(row.tool_started_at).toBeNull();
    expect(JSON.parse(row.recent_tools!)).toEqual(['Read', 'Grep']);
  });

  test('preserves thinking_line too', () => {
    setContainerThinkingLine('Checking the router wiring');
    setContainerToolInFlight('Read', null);

    clearContainerToolInFlight();

    expect(readState()!.thinking_line).toBe('Checking the router wiring');
  });
});

describe('container_state — setContainerThinkingLine', () => {
  test('collapses newlines and runs of whitespace to single spaces', () => {
    setContainerThinkingLine('  Reading   the\nrouter\n\n  wiring  ');

    expect(readState()!.thinking_line).toBe('Reading the router wiring');
  });

  test('truncates at 200 characters', () => {
    const line = 'x'.repeat(500);
    setContainerThinkingLine(line);

    expect(readState()!.thinking_line).toHaveLength(200);
  });

  test('ignores empty and whitespace-only input', () => {
    setContainerThinkingLine('Something real');

    setContainerThinkingLine('');
    setContainerThinkingLine('   \n\t  ');

    // The previous value survives — blanking would make the host message flicker.
    expect(readState()!.thinking_line).toBe('Something real');
  });

  test('whitespace-only input on a fresh DB writes no row at all', () => {
    setContainerThinkingLine('  \n  ');

    expect(readState()).toBeNull();
  });

  test('does not disturb the tool columns', () => {
    setContainerToolInFlight('Bash', 600_000);

    setContainerThinkingLine('Running the test suite');

    const row = readState()!;
    expect(row.current_tool).toBe('Bash');
    expect(row.tool_declared_timeout_ms).toBe(600_000);
    expect(JSON.parse(row.recent_tools!)).toEqual(['Bash']);
    expect(row.thinking_line).toBe('Running the test suite');
  });
});

describe('container_state — clearContainerProgress', () => {
  test('nulls both progress columns', () => {
    setContainerToolInFlight('Read', null);
    setContainerThinkingLine('Working on it');

    clearContainerProgress();

    const row = readState()!;
    expect(row.recent_tools).toBeNull();
    expect(row.thinking_line).toBeNull();
  });

  test('is safe when no row exists yet', () => {
    expect(() => clearContainerProgress()).not.toThrow();

    const row = readState()!;
    expect(row.recent_tools).toBeNull();
    expect(row.thinking_line).toBeNull();
  });

  test('the next turn starts from an empty buffer', () => {
    setContainerToolInFlight('Read', null);
    setContainerToolInFlight('Grep', null);
    clearContainerProgress();

    setContainerToolInFlight('Edit', null);

    expect(readRecentTools()).toEqual(['Edit']);
  });
});
