/**
 * A permanently-failed queued op (pin/edit/reaction/delete) has no return path
 * to the child — the tool call already returned "queued". notifyOpFailure drops
 * a `system` row into the child's inbox so its next turn sees the failure.
 * Scoped to ops: a failed chat/file send must NOT be re-surfaced (resend loop).
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { INBOUND_SCHEMA } from './db/schema.js';
import { notifyOpFailure } from './delivery.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(INBOUND_SCHEMA);
});

afterEach(() => db.close());

function rows() {
  return db.prepare('SELECT kind, content, trigger FROM messages_in').all() as Array<{
    kind: string;
    content: string;
    trigger: number;
  }>;
}

describe('notifyOpFailure', () => {
  it('writes a non-waking system note for a failed pin op', () => {
    notifyOpFailure(
      db,
      { id: 'msg-1', content: JSON.stringify({ operation: 'pin', messageId: '-100:530' }) },
      new Error('Telegram pinChatMessage failed: not enough rights to pin a message'),
    );
    const [row] = rows();
    expect(row.kind).toBe('system');
    expect(row.trigger).toBe(0); // context only, no wake
    const c = JSON.parse(row.content);
    expect(c).toMatchObject({ action: 'pin', status: 'failed' });
    expect(c.result).toContain('not enough rights');
  });

  it('ignores a failed chat send (no operation field) — no resend loop', () => {
    notifyOpFailure(
      db,
      { id: 'msg-2', content: JSON.stringify({ text: 'hello', files: [] }) },
      new Error('network down'),
    );
    expect(rows()).toHaveLength(0);
  });

  it('swallows unparseable content rather than throwing', () => {
    expect(() => notifyOpFailure(db, { id: 'msg-3', content: 'not-json' }, new Error('x'))).not.toThrow();
    expect(rows()).toHaveLength(0);
  });
});
