/**
 * Tests for spawn_topic_agent — host-side authorization and the spawn body.
 *
 * `spawn_topic_agent` is a privileged central-DB write reachable from an MCP
 * tool that every agent container can see, so the only gate is the guard's
 * `topics.spawn` decision — trusted owner agent groups ('global') spawn
 * directly; confined groups ('group', the default and the prompt-injection
 * victim) hold for admin approval. These tests drive the REAL wrapped
 * delivery action (the only reachable path), plus the parts of the body whose
 * absence is silently wrong rather than loud: the inherited
 * unknown_sender_policy, the copied members, and the replayed brief.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentGroupMember,
  MessagingGroup,
  MessagingGroupAgent,
  PendingApproval,
  Session,
  UserRole,
} from '../../types.js';

// vi.hoisted: the module barrel import below runs before this file's const
// initializers, and the mock factories close over this state.
const {
  mockRequestApproval,
  mockNotifyAgent,
  mockGetContainerConfig,
  mockUpdateContainerConfigScalars,
  mockCreateAgentGroup,
  mockInitGroupFilesystem,
  mockCreateMessagingGroup,
  mockCreateMessagingGroupAgent,
  mockCreateDestination,
  mockWriteDestinations,
  mockAddMember,
  mockRouteInbound,
  mockCreateThread,
  liveApprovals,
  approvalHandlers,
  state,
} = vi.hoisted(() => ({
  mockRequestApproval: vi.fn().mockResolvedValue(undefined),
  mockNotifyAgent: vi.fn(),
  mockGetContainerConfig: vi.fn(),
  mockUpdateContainerConfigScalars: vi.fn(),
  mockCreateAgentGroup: vi.fn(),
  mockInitGroupFilesystem: vi.fn(),
  mockCreateMessagingGroup: vi.fn(),
  mockCreateMessagingGroupAgent: vi.fn(),
  mockCreateDestination: vi.fn(),
  mockWriteDestinations: vi.fn(),
  mockAddMember: vi.fn(),
  mockRouteInbound: vi.fn().mockResolvedValue(undefined),
  mockCreateThread: vi.fn().mockResolvedValue('telegram:-1001:42'),
  // The approval rows the host still considers live, keyed by approval_id —
  // the grant check re-reads the row, so a resolved row is a dead grant.
  liveApprovals: new Map<string, PendingApproval>(),
  approvalHandlers: new Map<string, (ctx: Record<string, unknown>) => Promise<void>>(),
  state: {
    // Every registered messaging_groups row: the session's own chat is
    // looked up here, and so is the sub-conversation check.
    messagingGroups: [] as unknown[],
    adapterLive: true,
    adapterCanCreateThreads: true,
    // Wirings on those messaging groups — the caller's own wiring is what
    // the new topic's sender_scope is inherited from.
    wirings: [] as unknown[],
    members: [] as unknown[],
    owners: [] as unknown[],
    tables: new Set<string>(),
  },
}));

vi.mock('../approvals/index.js', () => ({
  requestApproval: (...a: unknown[]) => mockRequestApproval(...a),
  notifyAgent: (...a: unknown[]) => mockNotifyAgent(...a),
  registerApprovalHandler: (action: string, handler: (ctx: Record<string, unknown>) => Promise<void>) => {
    approvalHandlers.set(action, handler);
  },
}));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: (...a: unknown[]) => mockGetContainerConfig(...a),
  ensureContainerConfig: () => {},
  updateContainerConfigScalars: (...a: unknown[]) => mockUpdateContainerConfigScalars(...a),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => ({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: '' }),
  getAgentGroupByFolder: () => undefined,
  createAgentGroup: (...a: unknown[]) => mockCreateAgentGroup(...a),
}));
vi.mock('../../group-init.js', () => ({
  initGroupFilesystem: (...a: unknown[]) => mockInitGroupFilesystem(...a),
}));
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({}),
  hasTable: (_db: unknown, name: string) => state.tables.has(name),
}));
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: (id: string) => (state.messagingGroups as MessagingGroup[]).find((mg) => mg.id === id),
  getMessagingGroupByPlatform: () => undefined,
  getMessagingGroupsByChannel: () => state.messagingGroups,
  // Same boundary rule as the real one (proved against a live DB in
  // src/db/messaging-groups-parent.test.ts) over the in-memory rows.
  findParentMessagingGroup: (channelType: string, instance: string, platformId: string) =>
    (state.messagingGroups as MessagingGroup[]).find(
      (other) =>
        other.channel_type === channelType &&
        (other.instance ?? other.channel_type) === instance &&
        other.platform_id !== platformId &&
        [':', '/'].some((d) => platformId.startsWith(other.platform_id + d)),
    ),
  getMessagingGroupAgentByPair: (messagingGroupId: string, agentGroupId: string) =>
    (state.wirings as MessagingGroupAgent[]).find(
      (w) => w.messaging_group_id === messagingGroupId && w.agent_group_id === agentGroupId,
    ),
  createMessagingGroup: (...a: unknown[]) => mockCreateMessagingGroup(...a),
  createMessagingGroupAgent: (...a: unknown[]) => mockCreateMessagingGroupAgent(...a),
}));
// The adapter is rebuilt per call so a test can flip the capability.
vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapterExact: () => {
    if (!state.adapterLive) return undefined;
    return {
      name: 'telegram',
      channelType: 'telegram',
      supportsThreads: false,
      ...(state.adapterCanCreateThreads ? { createThread: mockCreateThread } : {}),
    };
  },
  // Telegram's real declaration (src/channels/telegram.ts). resolveWiringDefaults
  // reads through here, so the wiring assertions below exercise the same
  // resolution ncl and the setup wizard use rather than a stubbed answer.
  getChannelDefaults: () => ({
    dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
    group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
    mentions: 'platform',
  }),
  hasDeclaredChannelDefaults: () => true,
}));
vi.mock('../agent-to-agent/db/agent-destinations.js', () => ({
  getDestinationByName: () => undefined,
  createDestination: (...a: unknown[]) => mockCreateDestination(...a),
  hasDestination: () => true,
  normalizeName: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
}));
vi.mock('../agent-to-agent/write-destinations.js', () => ({
  writeDestinations: (...a: unknown[]) => mockWriteDestinations(...a),
}));
vi.mock('../permissions/db/agent-group-members.js', () => ({
  getMembers: () => state.members,
  addMember: (...a: unknown[]) => mockAddMember(...a),
  removeMember: vi.fn(),
  isMember: () => true,
  hasMembershipRow: () => false,
}));
vi.mock('../permissions/db/user-roles.js', () => ({
  getOwners: () => state.owners,
}));
vi.mock('../../router.js', () => ({
  routeInbound: (...a: unknown[]) => mockRouteInbound(...a),
}));
// delivery.ts and the notify path pull these at import time; stub them.
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: vi.fn(),
  openInboundDb: vi.fn(),
  openOutboundDb: vi.fn(),
  clearOutbox: vi.fn(),
  readOutboxFiles: vi.fn().mockReturnValue([]),
  resolveSession: vi.fn(),
  sessionDir: vi.fn().mockReturnValue('/tmp/nowhere'),
  inboundDbPath: vi.fn().mockReturnValue('/tmp/nowhere/inbound.db'),
  heartbeatPath: vi.fn().mockReturnValue('/tmp/nowhere/.heartbeat'),
}));
vi.mock('../../db/sessions.js', () => ({
  getSession: (id: string) => ({ id, agent_group_id: 'ag-1' }),
  getPendingApproval: (approvalId: string) => liveApprovals.get(approvalId),
  getRunningSessions: () => [],
  getActiveSessions: () => [],
  createPendingQuestion: vi.fn(),
  isTaskThread: () => false,
  TASKS_SYSTEM_THREAD_ID: 'system:tasks',
}));

// The module registers ./guard.js (catalog entry) and the guard-wrapped
// spawn_topic_agent delivery action — the path under test.
import './index.js';
import { getDeliveryAction } from '../../delivery.js';
import { guard } from '../../guard/index.js';
import { topicsSpawn } from './guard.js';

const SESSION = { id: 'sess-1', agent_group_id: 'ag-1', messaging_group_id: 'mg-parent' } as Session;

const PARENT_MG: MessagingGroup = {
  id: 'mg-parent',
  channel_type: 'telegram',
  platform_id: 'telegram:-1001',
  instance: 'telegram',
  name: 'General',
  is_group: 1,
  unknown_sender_policy: 'request_approval',
  denied_at: null,
  created_at: '',
};

const PARENT_WIRING: MessagingGroupAgent = {
  id: 'mga-parent',
  messaging_group_id: 'mg-parent',
  agent_group_id: 'ag-1',
  engage_mode: 'mention',
  engage_pattern: null,
  sender_scope: 'known',
  ignored_message_policy: 'accumulate',
  session_mode: 'shared',
  priority: 0,
  created_at: '',
};

async function runSpawn(content: Record<string, unknown>): Promise<void> {
  const wrapped = getDeliveryAction('spawn_topic_agent');
  expect(wrapped).toBeDefined();
  await wrapped!(content, SESSION, undefined as never);
}

/** An approval row the host still considers pending — a live grant. */
function liveGrant(approvalId: string, payload: Record<string, unknown>): PendingApproval {
  const row = {
    approval_id: approvalId,
    session_id: SESSION.id,
    request_id: approvalId,
    action: 'spawn_topic_agent',
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    agent_group_id: 'ag-1',
    channel_type: null,
    platform_id: null,
    platform_message_id: null,
    expires_at: null,
    status: 'pending',
    title: '',
    options_json: '[]',
    approver_user_id: null,
  } as PendingApproval;
  liveApprovals.set(approvalId, row);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateThread.mockResolvedValue('telegram:-1001:42');
  mockRouteInbound.mockResolvedValue(undefined);
  state.messagingGroups = [PARENT_MG];
  state.wirings = [PARENT_WIRING];
  liveApprovals.clear();
  state.adapterLive = true;
  state.adapterCanCreateThreads = true;
  state.members = [];
  state.owners = [];
  state.tables = new Set(['agent_destinations', 'agent_group_members', 'user_roles']);
  mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
});

describe('spawn_topic_agent — guard-based authorization (wrapped delivery action)', () => {
  it('global scope: spawns directly, no approval requested', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runSpawn({ name: 'Trip planning', instructions: 'plan the trip', brief: 'book flights' });

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateThread).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
  });

  it('group scope (default): holds for approval, creates nothing', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await runSpawn({ name: 'Trip planning', brief: 'book flights' });

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockRequestApproval.mock.calls[0][0]).toMatchObject({
      action: 'spawn_topic_agent',
      // The brief rides on the row — the approved replay re-reads this
      // payload, and without it the new agent would wake cold.
      payload: { name: 'Trip planning', brief: 'book flights' },
    });
    expect(mockCreateThread).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('missing config: fails closed to approval (no direct spawn)', async () => {
    mockGetContainerConfig.mockReturnValue(undefined);

    await runSpawn({ name: 'Trip planning' });

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it('non-agent actor is denied outright', () => {
    for (const actor of [{ kind: 'human' as const, userId: 'telegram:1' }, { kind: 'host' as const }]) {
      expect(guard(topicsSpawn, { actor, payload: { name: 'Trip planning' } }).effect).toBe('deny');
    }
  });

  it('empty name: neither spawns nor requests approval', async () => {
    await runSpawn({ name: '', brief: 'book flights' });

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateThread).not.toHaveBeenCalled();
  });
});

describe('spawn_topic_agent — channel capability', () => {
  it('an adapter without createThread is refused cleanly, nothing is created', async () => {
    state.adapterCanCreateThreads = false;

    await runSpawn({ name: 'Trip planning', brief: 'book flights' });

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockCreateMessagingGroup).not.toHaveBeenCalled();
    // The refusal names the channel so the agent can explain it.
    expect(String(mockNotifyAgent.mock.calls.at(-1)?.[1])).toContain('telegram');
  });

  it('a session with no messaging group is refused', async () => {
    await getDeliveryAction('spawn_topic_agent')!(
      { name: 'Trip planning' },
      { ...SESSION, messaging_group_id: null } as Session,
      undefined as never,
    );

    expect(mockCreateThread).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('refuses to spawn a topic from inside a topic', async () => {
    // The caller's own chat is a child of another registered chat — the only
    // generic signal that we are already one level down.
    const topicMg: MessagingGroup = { ...PARENT_MG, id: 'mg-topic', platform_id: 'telegram:-1001:7' };
    state.messagingGroups = [PARENT_MG, topicMg];

    await getDeliveryAction('spawn_topic_agent')!(
      { name: 'Nested', brief: 'nope' },
      { ...SESSION, messaging_group_id: 'mg-topic' } as Session,
      undefined as never,
    );

    expect(mockCreateThread).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('a numeric sibling is not mistaken for a parent', async () => {
    // 'telegram:-100' is a prefix of 'telegram:-1001' as a STRING, but not at
    // a delimiter boundary — it must not read as this chat's parent.
    state.messagingGroups = [PARENT_MG, { ...PARENT_MG, id: 'mg-other', platform_id: 'telegram:-100' }];

    await runSpawn({ name: 'Trip planning', brief: 'book flights' });

    expect(mockCreateThread).toHaveBeenCalledTimes(1);
  });
});

describe('spawn_topic_agent — what a successful spawn writes', () => {
  it('creates the agent group, the topic messaging group, the wiring and both destinations', async () => {
    await runSpawn({ name: 'Trip planning', instructions: 'plan the trip', brief: 'book flights' });

    expect(mockCreateThread).toHaveBeenCalledWith('telegram:-1001', 'Trip planning');

    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    const newGroup = mockCreateAgentGroup.mock.calls[0][0] as { id: string; name: string; folder: string };
    expect(newGroup.name).toBe('Trip planning');
    expect(mockInitGroupFilesystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ instructions: 'plan the trip' }),
    );

    // The topic is its own messaging group, addressed by the 3-part
    // platform_id the adapter returned.
    const topicMg = mockCreateMessagingGroup.mock.calls[0][0] as MessagingGroup;
    expect(topicMg).toMatchObject({
      channel_type: 'telegram',
      platform_id: 'telegram:-1001:42',
      instance: 'telegram',
      name: 'Trip planning',
      is_group: 1,
    });

    // Engagement comes from the channel's group-context declaration, not a
    // spawn-specific override: a topic is still a shared conversation between
    // humans, so the agent engages on an @mention (or a reply to it, which the
    // bridge promotes to one) and stays out of the rest.
    expect(mockCreateMessagingGroupAgent.mock.calls[0][0]).toMatchObject({
      messaging_group_id: topicMg.id,
      agent_group_id: newGroup.id,
      engage_mode: 'mention',
      engage_pattern: null,
    });

    // Bidirectional parent/child destinations + the projection into the
    // caller's live session (without it the concierge's first send to the
    // child is "dropped: unknown destination").
    expect(mockCreateDestination).toHaveBeenCalledTimes(2);
    expect(mockCreateDestination.mock.calls[0][0]).toMatchObject({
      agent_group_id: 'ag-1',
      local_name: 'trip-planning',
      target_type: 'agent',
      target_id: newGroup.id,
    });
    expect(mockCreateDestination.mock.calls[1][0]).toMatchObject({
      agent_group_id: newGroup.id,
      local_name: 'parent',
      target_type: 'agent',
      target_id: 'ag-1',
    });
    expect(mockWriteDestinations).toHaveBeenCalledWith('ag-1', 'sess-1');
  });

  it('the child inherits the parent group provider, not the instance default', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global', provider: 'codex' });

    await runSpawn({ name: 'Trip planning', brief: 'book flights' });

    expect(mockInitGroupFilesystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: 'codex' }),
    );
  });

  it('the child inherits the parent group model', async () => {
    // On an install whose gateway serves a fixed model list, the parent's model
    // is the only name known to be reachable — falling back to the provider
    // default can spawn a child onto a name that 403s on its first turn.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global', model: 'claude-sonnet' });

    await runSpawn({ name: 'Trip planning', brief: 'book flights' });

    expect(mockUpdateContainerConfigScalars).toHaveBeenCalledWith(
      expect.stringMatching(/^ag-/),
      expect.objectContaining({ model: 'claude-sonnet' }),
    );
  });

  it('leaves the child model unset when the parent has none', async () => {
    // Red-on-delete: writing the parent's `undefined` would look like a
    // deliberate pin and could shadow a future default.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await runSpawn({ name: 'Trip planning', brief: 'book flights' });

    expect(mockUpdateContainerConfigScalars).not.toHaveBeenCalled();
  });

  it('the new topic inherits the parent chat unknown_sender_policy', async () => {
    // Red-on-delete: hardcoding a policy would make a spawned topic more open
    // (or more closed) than the chat it came from.
    state.messagingGroups = [{ ...PARENT_MG, unknown_sender_policy: 'strict' }];

    await runSpawn({ name: 'Trip planning', brief: 'book flights' });

    expect((mockCreateMessagingGroup.mock.calls[0][0] as MessagingGroup).unknown_sender_policy).toBe('strict');
  });

  it('copies the parent group members forward so non-owner humans keep access', async () => {
    // Without the copy these users hit 'not_member' on their first message in
    // the new topic (src/modules/permissions/access.ts).
    state.members = [
      { user_id: 'telegram:1', agent_group_id: 'ag-1', added_by: 'telegram:owner', added_at: '' },
      { user_id: 'telegram:2', agent_group_id: 'ag-1', added_by: null, added_at: '' },
    ] satisfies AgentGroupMember[];

    await runSpawn({ name: 'Trip planning', brief: 'book flights' });

    const newGroupId = (mockCreateAgentGroup.mock.calls[0][0] as { id: string }).id;
    expect(mockAddMember).toHaveBeenCalledTimes(2);
    expect(mockAddMember.mock.calls[0][0]).toMatchObject({ user_id: 'telegram:1', agent_group_id: newGroupId });
    expect(mockAddMember.mock.calls[1][0]).toMatchObject({ user_id: 'telegram:2', agent_group_id: newGroupId });
  });

  it('skips the member copy when the permissions module is not installed', async () => {
    state.tables = new Set(['agent_destinations']);
    state.members = [{ user_id: 'telegram:1', agent_group_id: 'ag-1', added_by: null, added_at: '' }];

    await runSpawn({ name: 'Trip planning', brief: 'book flights' });

    expect(mockAddMember).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1); // the spawn still completes
  });

  it('replays the brief into the new topic as a gate-passing sender', async () => {
    state.owners = [
      { user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: '' },
    ] satisfies UserRole[];

    await runSpawn({ name: 'Trip planning', instructions: 'plan the trip', brief: 'book flights to Lisbon' });

    expect(mockRouteInbound).toHaveBeenCalledTimes(1);
    const event = mockRouteInbound.mock.calls[0][0] as {
      channelType: string;
      instance: string;
      platformId: string;
      threadId: string | null;
      message: { content: string; isMention?: boolean };
    };
    expect(event).toMatchObject({
      channelType: 'telegram',
      instance: 'telegram',
      platformId: 'telegram:-1001:42',
      threadId: null,
    });
    // Coupled to the wiring above: the topic is wired 'mention', and a
    // synthetic replay carries no platform mention signal. Without this flag
    // the brief routes and is judged not-addressed, and the agent that was
    // just spawned to handle it never wakes.
    expect(event.message.isMention).toBe(true);
    const content = JSON.parse(event.message.content) as { text: string; senderId: string };
    expect(content.text).toBe('book flights to Lisbon');
    // The owner passes canAccessAgentGroup for a group with no members yet.
    expect(content.senderId).toBe('telegram:owner');
  });

  it('no brief, no replay', async () => {
    await runSpawn({ name: 'Trip planning', instructions: 'plan the trip' });

    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    expect(mockRouteInbound).not.toHaveBeenCalled();
  });

  it('a brief-only request scopes the new agent to the brief', async () => {
    await runSpawn({ name: 'Trip planning', brief: 'book flights' });

    expect(mockInitGroupFilesystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ instructions: 'book flights' }),
    );
  });

  // The container/host seam. The MCP tool normalizes omitted optional args to
  // null (never undefined) so the host can read payload.brief without an
  // undefined branch — see container/agent-runner/src/mcp-tools/topics.ts and
  // its "normalizes omitted optional args to null" test. Pin the host end of
  // that contract: a literal wire payload, nulls and all, must spawn.
  it('accepts the exact system-row shape the container emits', async () => {
    await runSpawn({
      action: 'spawn_topic_agent',
      requestId: 'msg-1',
      name: 'Reading Group',
      instructions: null,
      brief: null,
    });

    expect(mockCreateThread).toHaveBeenCalledWith('telegram:-1001', 'Reading Group');
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    // No brief to fall back to → no standing instructions, and no replay.
    expect(mockInitGroupFilesystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ instructions: undefined }),
    );
    expect(mockRouteInbound).not.toHaveBeenCalled();
  });

  it('a null instructions with a brief still scopes the new agent', async () => {
    await runSpawn({ name: 'Trip planning', instructions: null, brief: 'book flights' });

    expect(mockInitGroupFilesystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ instructions: 'book flights' }),
    );
  });

  it('a failed replay leaves the topic wired and says so', async () => {
    mockRouteInbound.mockRejectedValue(new Error('router down'));

    await runSpawn({ name: 'Trip planning', brief: 'book flights' });

    expect(mockCreateMessagingGroupAgent).toHaveBeenCalledTimes(1);
    expect(mockNotifyAgent).toHaveBeenCalled();
  });
});

describe('spawn_topic_agent — approved replay (grant-carrying re-entry)', () => {
  // The DEFAULT path: cli_scope defaults to 'group', so every ordinary agent
  // group's spawn goes hold → admin taps approve → this continuation. Without
  // coverage here, a typo'd grantActionName or a grantCoversRequest reading
  // the wrong field leaves the whole suite green while every real approval
  // resolves the card and produces nothing but a denial back to the agent.
  const payload = { name: 'Trip planning', instructions: 'plan the trip', brief: 'book flights' };

  beforeEach(() => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
  });

  it('a valid grant spawns exactly once, with no second card', async () => {
    const approval = liveGrant('appr-ts-1', payload);

    const continuation = approvalHandlers.get('spawn_topic_agent');
    expect(continuation).toBeDefined();
    await continuation!({ session: SESSION, payload, approval, userId: 'telegram:admin', notify: vi.fn() });

    expect(mockCreateThread).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    expect(mockCreateMessagingGroupAgent).toHaveBeenCalledTimes(1);
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });

  it('the approved brief still reaches the new topic', async () => {
    // The brief rides on the approval row precisely so the post-approval
    // spawn wakes the child with the request instead of cold.
    state.owners = [
      { user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: '' },
    ] satisfies UserRole[];
    const approval = liveGrant('appr-ts-2', payload);

    await approvalHandlers.get('spawn_topic_agent')!({
      session: SESSION,
      payload,
      approval,
      userId: 'telegram:admin',
      notify: vi.fn(),
    });

    expect(mockRouteInbound).toHaveBeenCalledTimes(1);
    const event = mockRouteInbound.mock.calls[0][0] as { message: { content: string } };
    expect(JSON.parse(event.message.content).text).toBe('book flights');
  });

  it('a dead grant (row already resolved) refuses the replay', async () => {
    const approval = liveGrant('appr-ts-3', payload);
    liveApprovals.delete('appr-ts-3'); // resolution consumed the row

    await approvalHandlers.get('spawn_topic_agent')!({
      session: SESSION,
      payload,
      approval,
      userId: 'telegram:admin',
      notify: vi.fn(),
    });

    expect(mockCreateThread).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockRequestApproval).not.toHaveBeenCalled(); // refused, not re-held
  });

  it('a grant approved for a different topic name refuses the replay', async () => {
    const approval = liveGrant('appr-ts-4', { ...payload, name: 'Something else' });

    await approvalHandlers.get('spawn_topic_agent')!({
      session: SESSION,
      payload,
      approval,
      userId: 'telegram:admin',
      notify: vi.fn(),
    });

    expect(mockCreateThread).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });
});

describe('spawn_topic_agent — sender_scope is inherited, never widened', () => {
  it("copies the caller's wiring sender_scope onto the new topic", async () => {
    // The two gates are independent and sender_scope is the stricter one: on
    // a 'public' messaging group the access gate allows before it ever asks
    // who the sender is, so the wiring's 'known' is the ONLY thing keeping
    // non-members out. Hardcoding 'all' here would hand a stranger in an open
    // community chat their own agent — with its own container and a
    // destination back to the concierge — in a chat where the same stranger
    // is bounced from the concierge itself.
    state.messagingGroups = [{ ...PARENT_MG, unknown_sender_policy: 'public' }];
    state.wirings = [{ ...PARENT_WIRING, sender_scope: 'known' }];

    await runSpawn({ name: 'Trip planning', brief: 'book flights' });

    const wiring = mockCreateMessagingGroupAgent.mock.calls[0][0] as MessagingGroupAgent;
    expect(wiring.sender_scope).toBe('known');
    expect((mockCreateMessagingGroup.mock.calls[0][0] as MessagingGroup).unknown_sender_policy).toBe('public');
  });

  it("keeps an open chat open — an 'all' parent wiring stays 'all'", async () => {
    state.wirings = [{ ...PARENT_WIRING, sender_scope: 'all' }];

    await runSpawn({ name: 'Trip planning', brief: 'book flights' });

    expect((mockCreateMessagingGroupAgent.mock.calls[0][0] as MessagingGroupAgent).sender_scope).toBe('all');
  });

  it("falls back to 'known' when the caller's wiring cannot be resolved", async () => {
    // Strictest of the two, so an unresolvable parent can only narrow.
    state.wirings = [];

    await runSpawn({ name: 'Trip planning', brief: 'book flights' });

    expect((mockCreateMessagingGroupAgent.mock.calls[0][0] as MessagingGroupAgent).sender_scope).toBe('known');
  });
});
