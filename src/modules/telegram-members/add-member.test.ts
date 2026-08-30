import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { getMembers } from '../permissions/db/agent-group-members.js';
import type { InboundEvent } from '../../channels/adapter.js';

// The userbot resolver is external — mock it. `resolveTelegramUsers` is set per test.
vi.mock('./resolve.js', () => ({
  UserbotNotConfigured: class UserbotNotConfigured extends Error {},
  resolveTelegramUsers: vi.fn(),
}));

// Capture host-side replies without a live adapter.
const deliverMock =
  vi.fn<(p: string, t: string | null, m: { kind: string; content: { text: string } }) => Promise<undefined>>();
vi.mock('../../channels/channel-registry.js', async (orig) => ({
  ...(await orig<typeof import('../../channels/channel-registry.js')>()),
  getChannelAdapterExact: () => ({ deliver: deliverMock }),
}));

import { resolveTelegramUsers, UserbotNotConfigured } from './resolve.js';
import { handleAddMember, parseMentions, agentGroupsWiredToChat } from './add-member.js';

const now = '2026-08-24T00:00:00.000Z';

function agentGroup(id: string) {
  createAgentGroup({ id, name: id, folder: id, agent_provider: 'claude', created_at: now });
}
function messagingGroup(id: string, platformId: string) {
  createMessagingGroup({
    id,
    channel_type: 'telegram',
    platform_id: platformId,
    instance: 'telegram',
    name: id,
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
}
function wire(mgId: string, agId: string) {
  getDb()
    .prepare(
      'INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(`${mgId}-${agId}`, mgId, agId, now);
}
function owner(userId: string) {
  getDb()
    .prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?,?,?,?)')
    .run(userId, 'telegram', 'O', now);
  grantRole({ user_id: userId, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
}

function event(text: string, senderId: string, opts: { platformId?: string; isGroup?: boolean } = {}): InboundEvent {
  return {
    channelType: 'telegram',
    instance: 'telegram',
    platformId: opts.platformId ?? 'telegram:-100123',
    threadId: null,
    message: {
      id: 'm1',
      kind: 'chat-sdk',
      content: JSON.stringify({ text, author: { userId: senderId } }),
      timestamp: now,
      isGroup: opts.isGroup ?? true,
    },
  };
}

const lastReply = () => deliverMock.mock.calls.at(-1)?.[2].content.text as string;

beforeEach(() => {
  runMigrations(initTestDb());
  deliverMock.mockClear();
  vi.mocked(resolveTelegramUsers).mockReset();
});
afterEach(() => closeDb());

describe('parseMentions', () => {
  it('splits on comma, space, newline, and concatenation; dedupes', () => {
    // Telegram handles are >= 5 chars; separators are comma, space, newline
    // and bare concatenation (@x@y).
    expect(parseMentions('/add-member @alice, @bobby @carol\n@david@ellen @alice')).toEqual([
      'alice',
      'bobby',
      'carol',
      'david',
      'ellen',
    ]);
  });
  it('is empty when there are no handles', () => {
    expect(parseMentions('/add-member')).toEqual([]);
  });
});

describe('handleAddMember — scope', () => {
  it('ignores non-telegram and non-command messages (does not consume)', async () => {
    expect(await handleAddMember({ ...event('/add-member @a', '1'), channelType: 'discord' })).toBe(false);
    expect(await handleAddMember(event('hello there', '1'))).toBe(false);
  });

  it('rejects use outside a group', async () => {
    expect(await handleAddMember(event('/add-member @a', '1', { isGroup: false }))).toBe(true);
    expect(lastReply()).toMatch(/only in a Telegram group/i);
  });
});

describe('scenario 1 — non-admin caller fails', () => {
  it('denies a non-owner/non-admin and writes nothing', async () => {
    agentGroup('ag1');
    messagingGroup('mg', 'telegram:-100123');
    wire('mg', 'ag1');
    // caller "2" has no role
    const consumed = await handleAddMember(event('/add-member @alice', '2'));
    expect(consumed).toBe(true);
    expect(lastReply()).toMatch(/permission denied/i);
    expect(resolveTelegramUsers).not.toHaveBeenCalled();
    expect(getMembers('ag1')).toHaveLength(0);
  });
});

describe('scenario 2 — target not in the group is skipped', () => {
  it('adds the in-group user and skips the absent one', async () => {
    agentGroup('ag1');
    messagingGroup('mg', 'telegram:-100123');
    wire('mg', 'ag1');
    owner('telegram:1');
    vi.mocked(resolveTelegramUsers).mockResolvedValue([
      { username: 'alice', userId: 'telegram:1001', inGroup: true, error: null },
      { username: 'carol', userId: 'telegram:1003', inGroup: false, error: null },
    ]);

    await handleAddMember(event('/add-member @alice @carol', '1'));

    expect(getMembers('ag1').map((m) => m.user_id)).toEqual(['telegram:1001']);
    expect(lastReply()).toMatch(/@carol \(not in this group\)/);
  });
});

describe('scenarios 3 & 4 — owner adds to ALL agents wired to the chat', () => {
  it('grants each resolved member membership of every wired agent, incl. forum topics', async () => {
    agentGroup('ag1');
    agentGroup('ag2');
    agentGroup('ag3');
    messagingGroup('mg_main', 'telegram:-100123'); // General / chat-level
    messagingGroup('mg_topic', 'telegram:-100123:99'); // a forum topic
    wire('mg_main', 'ag1');
    wire('mg_main', 'ag2');
    wire('mg_topic', 'ag3');
    owner('telegram:1');

    // enumeration covers chat-level + topic agent groups
    expect(agentGroupsWiredToChat('-100123').sort()).toEqual(['ag1', 'ag2', 'ag3']);

    vi.mocked(resolveTelegramUsers).mockResolvedValue([
      { username: 'alice', userId: 'telegram:1001', inGroup: true, error: null },
      { username: 'bob', userId: 'telegram:1002', inGroup: true, error: null },
    ]);

    await handleAddMember(event('/add-member @alice,@bob', '1'));

    for (const ag of ['ag1', 'ag2', 'ag3']) {
      expect(
        getMembers(ag)
          .map((m) => m.user_id)
          .sort(),
      ).toEqual(['telegram:1001', 'telegram:1002']);
    }
    expect(lastReply()).toMatch(/Added @alice, @bob as members\..*all 3 agents in this group/);
  });

  it('recognises the command when the message is prefixed with a bot mention', async () => {
    // Mention-engaged groups deliver "@TheBot /add-member @alice"; the command
    // is not at the start and the bot handle must not be a target.
    agentGroup('ag1');
    messagingGroup('mg', 'telegram:-100123');
    wire('mg', 'ag1');
    owner('telegram:1');
    vi.mocked(resolveTelegramUsers).mockResolvedValue([
      { username: 'alice', userId: 'telegram:1001', inGroup: true, error: null },
    ]);

    const consumed = await handleAddMember(event('@MyNanoClawBot /add-member @alice', '1'));

    expect(consumed).toBe(true);
    expect(vi.mocked(resolveTelegramUsers).mock.calls[0][1]).toEqual(['alice']);
    expect(getMembers('ag1').map((m) => m.user_id)).toEqual(['telegram:1001']);
  });

  it('does not treat the /add-member@BotName command suffix as a target', async () => {
    agentGroup('ag1');
    messagingGroup('mg', 'telegram:-100123');
    wire('mg', 'ag1');
    owner('telegram:1');
    vi.mocked(resolveTelegramUsers).mockResolvedValue([
      { username: 'alice', userId: 'telegram:1001', inGroup: true, error: null },
    ]);

    await handleAddMember(event('/add-member@MyGroupBot @alice', '1'));

    expect(vi.mocked(resolveTelegramUsers).mock.calls[0][1]).toEqual(['alice']);
    expect(getMembers('ag1').map((m) => m.user_id)).toEqual(['telegram:1001']);
  });

  it('accepts the plural /add-members spelling', async () => {
    agentGroup('ag1');
    messagingGroup('mg', 'telegram:-100123');
    wire('mg', 'ag1');
    owner('telegram:1');
    vi.mocked(resolveTelegramUsers).mockResolvedValue([
      { username: 'alice', userId: 'telegram:1001', inGroup: true, error: null },
    ]);

    const consumed = await handleAddMember(event('/add-members @alice', '1'));

    expect(consumed).toBe(true);
    expect(vi.mocked(resolveTelegramUsers).mock.calls[0][1]).toEqual(['alice']);
    expect(getMembers('ag1').map((m) => m.user_id)).toEqual(['telegram:1001']);
  });

  it('a lone mention works too (scenario 4)', async () => {
    agentGroup('ag1');
    messagingGroup('mg', 'telegram:-100123');
    wire('mg', 'ag1');
    owner('telegram:1');
    vi.mocked(resolveTelegramUsers).mockResolvedValue([
      { username: 'alice', userId: 'telegram:1001', inGroup: true, error: null },
    ]);

    await handleAddMember(event('/add-member @alice', '1'));
    expect(getMembers('ag1').map((m) => m.user_id)).toEqual(['telegram:1001']);
  });
});

describe('resolver not configured', () => {
  it('tells the admin instead of crashing', async () => {
    agentGroup('ag1');
    messagingGroup('mg', 'telegram:-100123');
    wire('mg', 'ag1');
    owner('telegram:1');
    vi.mocked(resolveTelegramUsers).mockRejectedValue(new UserbotNotConfigured('session missing'));

    await handleAddMember(event('/add-member @alice', '1'));
    expect(lastReply()).toMatch(/Cannot resolve usernames: session missing/);
    expect(getMembers('ag1')).toHaveLength(0);
  });
});

describe('integration — the interceptor is wired into routeInbound', () => {
  it('routeInbound consumes a group /add-member via the registered interceptor', async () => {
    // Full modules barrel: proves both the module registration and the
    // src/modules/index.ts append. Deleting either lets the message fall
    // through to routing and no permission-denied reply is sent.
    await import('../index.js');
    const { routeInbound } = await import('../../router.js');

    await routeInbound(event('/add-member @alice', '2')); // non-admin -> deny reply
    expect(deliverMock).toHaveBeenCalled();
    expect(lastReply()).toMatch(/permission denied/i);
  });
});
