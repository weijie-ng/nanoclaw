import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { spawnTopicAgent } from './topics.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('spawn_topic_agent', () => {
  it('writes exactly one system row carrying the request', async () => {
    const result = await spawnTopicAgent.handler({
      name: 'Q3 Migration',
      instructions: 'You own the Q3 database migration.',
      brief: 'Summarize the runbook Dana posted.',
    });

    expect(result.isError).not.toBe(true);
    const rows = getUndeliveredMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('system');

    const payload = JSON.parse(rows[0].content);
    expect(payload).toMatchObject({
      action: 'spawn_topic_agent',
      name: 'Q3 Migration',
      instructions: 'You own the Q3 database migration.',
      brief: 'Summarize the runbook Dana posted.',
    });
    // requestId is the host's handle for the reply; it must be present and match the row id.
    expect(payload.requestId).toBe(rows[0].id);
  });

  it('normalizes omitted optional args to null, not undefined', async () => {
    const result = await spawnTopicAgent.handler({ name: 'Reading Group' });

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(getUndeliveredMessages()[0].content);
    expect(payload.instructions).toBeNull();
    expect(payload.brief).toBeNull();
    expect('instructions' in payload).toBe(true);
    expect('brief' in payload).toBe(true);
  });

  it('treats blank optional args as absent', async () => {
    await spawnTopicAgent.handler({ name: 'Reading Group', instructions: '   ', brief: '' });

    const payload = JSON.parse(getUndeliveredMessages()[0].content);
    expect(payload.instructions).toBeNull();
    expect(payload.brief).toBeNull();
  });

  it('rejects a missing or blank name without writing a row', async () => {
    for (const args of [{}, { name: '' }, { name: '   ' }, { name: 42 }, { brief: 'no name given' }]) {
      const result = await spawnTopicAgent.handler(args);
      expect(result.isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
