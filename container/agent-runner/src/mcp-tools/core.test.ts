/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 *
 * The stamp is published through session_state in outbound.db, not module
 * state — the MCP server runs as a separate stdio subprocess from the poll
 * loop, so it can only see the stamp through the shared DB. These tests seed
 * it the same way the poll-loop process does (a direct DB write) rather than
 * via any in-memory helper, so they exercise the real process boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { addReaction, editMessage, pinMessage, sendMessage } from './core.js';

/**
 * Publish the a2a reply stamp the way the poll loop does: a direct write to
 * session_state in outbound.db. `ageMs` back-dates updated_at to exercise the
 * staleness guard MCP tools apply when reading it.
 */
function publishInReplyTo(id: string, ageMs = 0): void {
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('current_in_reply_to', id, updatedAt);
}

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps the batch in_reply_to (published via the DB) on outbound rows', async () => {
    publishInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // Nothing published to session_state — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  it('ignores a stale stamp left behind by a killed container', async () => {
    publishInReplyTo('inbound-msg-1', 60 * 60 * 1000); // an hour old

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

/**
 * The three message-targeting tools share one `queueOp` preamble (resolve `#N`
 * → platform message id + the routing it arrived on, then write messages_out).
 * What the host bridge dispatches on is the `operation` field, so that is what
 * these pin down — one per op, plus the shared failure when `#N` is unknown.
 */
describe('edit / react / pin — queued operation payloads', () => {
  function seedInbound(seq: number): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, platform_id, channel_type, thread_id, content)
         VALUES ('tg-1001', ?, 'chat', '2026-01-01T00:00:00.000Z', 'telegram:-100123', 'telegram',
                 'telegram:-100123:7', '{}')`,
      )
      .run(seq);
  }

  it('targets the platform message id and inherits its routing', async () => {
    seedInbound(2);

    await pinMessage.handler({ messageId: 2 });

    const [out] = getUndeliveredMessages();
    expect(out.platform_id).toBe('telegram:-100123');
    expect(out.thread_id).toBe('telegram:-100123:7');
    expect(JSON.parse(out.content)).toEqual({ operation: 'pin', unpin: false, messageId: 'tg-1001' });
  });

  it('carries each op’s own fields', async () => {
    seedInbound(2);

    await editMessage.handler({ messageId: 2, text: 'new' });
    await addReaction.handler({ messageId: 2, emoji: 'eyes' });
    await pinMessage.handler({ messageId: 2, unpin: true });

    const ops = getUndeliveredMessages().map((m) => JSON.parse(m.content));
    expect(ops).toEqual([
      { operation: 'edit', text: 'new', messageId: 'tg-1001' },
      { operation: 'reaction', emoji: 'eyes', messageId: 'tg-1001' },
      { operation: 'pin', unpin: true, messageId: 'tg-1001' },
    ]);
  });

  it('queues nothing for an unknown message id', async () => {
    const res = await pinMessage.handler({ messageId: 99 });

    expect(res.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
