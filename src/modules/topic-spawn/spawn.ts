/**
 * `spawn_topic_agent` delivery-action bodies.
 *
 * SECURITY: `spawn_topic_agent` writes to the CENTRAL DB (agent_groups,
 * messaging_groups, messaging_group_agents, agent_group_members,
 * agent_destinations), scaffolds host filesystem state, and creates a
 * conversation on the platform — a privileged operation a confined container
 * is otherwise architecturally barred from. The MCP tool that emits the
 * request is visible to every agent container and lives inside the untrusted
 * container, so it is not a gate: authorization MUST be enforced host-side.
 * The delivery registry wraps this action with the guard, whose
 * `topics.spawn` decision (./guard.ts) allows trusted global-scope groups and
 * holds everything else — including unknown config, fail-closed — for admin
 * approval. On approve the continuation re-enters the wrapped action with the
 * approval row as its grant and `spawnTopicAgent` runs.
 * `performSpawnTopicAgent` is the module-private body.
 *
 * Nothing here is Telegram-specific. The one platform capability required is
 * `adapter.createThread(parentPlatformId, name) -> platform_id of the new
 * sub-conversation`; every step below works for any adapter that implements
 * it. Adapters that don't are refused with a message naming the channel.
 */
import { randomUUID } from 'crypto';
import path from 'path';

import type { ChannelAdapter } from '../../channels/adapter.js';
import { resolveWiringDefaults } from '../../channels/channel-defaults.js';
import { getChannelAdapterExact } from '../../channels/channel-registry.js';
import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  findParentMessagingGroup,
  getMessagingGroup,
  getMessagingGroupAgentByPair,
} from '../../db/messaging-groups.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { routeInbound } from '../../router.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';
import { createDestination, getDestinationByName, normalizeName } from '../agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../agent-to-agent/write-destinations.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';
import { addMember, getMembers } from '../permissions/db/agent-group-members.js';
import { getOwners } from '../permissions/db/user-roles.js';

/** The three fields a `spawn_topic_agent` system row carries. */
interface SpawnRequest {
  /** Display name of both the new topic and the new agent group. */
  name: string;
  /** Standing instructions scaffolded into the new group's CLAUDE.md. */
  instructions: string;
  /** The user's actual request, replayed into the new topic (may be empty). */
  brief: string;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readRequest(content: Record<string, unknown>): SpawnRequest {
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const brief = str(content.brief);
  // A caller that sends only a brief gets an agent whose standing
  // instructions ARE that brief — the concierge relays the user's request
  // verbatim and the new agent wakes scoped to it.
  return { name: str(content.name), instructions: str(content.instructions) || brief, brief };
}

/**
 * The one platform capability this action needs. Declared structurally rather
 * than read off `ChannelAdapter` because it is optional on the adapter
 * contract and absent from stale (skill-installed, branch-owned) adapter
 * copies — feature detection is the contract, not the type.
 */
interface ThreadCreatingAdapter {
  createThread(parentPlatformId: string, name: string): Promise<string>;
}

function threadCreator(adapter: ChannelAdapter): ThreadCreatingAdapter | null {
  const candidate = adapter as ChannelAdapter & Partial<ThreadCreatingAdapter>;
  return typeof candidate.createThread === 'function' ? (candidate as ThreadCreatingAdapter) : null;
}

/**
 * Step 3 — is this messaging group itself a sub-conversation?
 *
 * `findParentMessagingGroup` (src/db/messaging-groups.ts) carries the whole
 * derivation: a registered row whose platform_id is a proper prefix of ours at
 * a delimiter boundary is our parent, which here means "spawned from inside a
 * spawned topic" — every topic this module creates is registered there. Shared
 * with the router, which inherits a denied parent's decisions onto
 * sub-conversations at auto-create time.
 *
 * Advisory: a chat whose parent was never registered reads as a root, and a
 * platform whose sub-ids aren't derived from the parent's id reads as a root
 * too — in which case the adapter's own `createThread` is the backstop
 * (Telegram, for one, refuses to nest topics).
 */
function isSubConversation(mg: MessagingGroup): boolean {
  return findParentMessagingGroup(mg.channel_type, mg.instance ?? mg.channel_type, mg.platform_id) !== undefined;
}

/**
 * Whose message is the replayed brief (step 10)?
 *
 * The access gate is per AGENT GROUP and identity-based
 * (src/modules/permissions/access.ts): the replay has to arrive as somebody
 * who passes `canAccessAgentGroup` for the brand-new group, or the first
 * message into the new topic is dropped as `unknown_user` / `not_member`.
 * The system row doesn't carry the human who asked the concierge, so we use
 * the install owner: owners pass the gate unconditionally, need no
 * agent_group_members row, and always exist as a `users` row. Without the
 * permissions module there is no gate at all (core defaults to allow-all)
 * and the synthetic id is fine.
 */
function replaySenderId(): string {
  if (hasTable(getDb(), 'user_roles')) {
    const owner = getOwners()[0];
    if (owner) return owner.user_id;
  }
  return 'system:topic-spawn';
}

/** Guard precheck: malformed requests are answered without ever creating a hold. */
export function validateSpawnTopicAgent(content: Record<string, unknown>, session: Session): boolean {
  const { name } = readRequest(content);
  if (!name) {
    notifyAgent(session, 'spawn_topic_agent failed: name is required.');
    return false;
  }
  if (!getAgentGroup(session.agent_group_id)) {
    notifyAgent(session, 'spawn_topic_agent failed: source agent group not found.');
    log.warn('spawn_topic_agent failed: missing source group', { sessionAgentGroup: session.agent_group_id, name });
    return false;
  }
  return true;
}

/** Guard hold: card the requesting group's admin chain. */
export async function requestSpawnTopicAgentHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const { name, instructions, brief } = readRequest(content);
  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!sourceGroup) return;

  await requestApproval({
    session,
    agentName: sourceGroup.name,
    action: 'spawn_topic_agent',
    // The brief travels on the row: the approved replay re-reads this payload
    // as its content, and without it the new agent would wake cold.
    payload: { name, instructions, brief },
    title: `Spawn topic agent: ${name}`,
    question:
      `Agent "${sourceGroup.name}" wants to open a new topic "${name}" in this chat and put a new agent ` +
      `(its own workspace and container) in it, reachable by everyone who can reach "${sourceGroup.name}". Approve?`,
  });
}

/** Guard allow body: performs the spawn (fresh global-scope call or approved replay). */
export async function spawnTopicAgent(content: Record<string, unknown>, session: Session): Promise<void> {
  const request = readRequest(content);
  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!request.name || !sourceGroup) return; // precheck already answered the requester

  await performSpawnTopicAgent(request, session, sourceGroup, (text) => notifyAgent(session, text));
}

/**
 * Core spawn: creates the platform topic, the agent group behind it, the
 * messaging group that addresses it, the wiring, the access copy, the
 * bidirectional destinations, and replays the brief. Authorization is the
 * CALLER's responsibility (the guard's topics.spawn decision) — never call
 * this from an unauthorized path, as it performs privileged central-DB writes
 * and creates a real conversation on the platform.
 *
 * Steps run in dependency order and nothing is rolled back: each refusal is
 * reported to the requesting agent and leaves the state coherent for a retry
 * (the checks that can refuse all run BEFORE the topic is created; after
 * that, every write is unconditional).
 */
async function performSpawnTopicAgent(
  request: SpawnRequest,
  session: Session,
  sourceGroup: AgentGroup,
  notify: (text: string) => void,
): Promise<void> {
  const { name, instructions, brief } = request;

  // 1. The chat we spawn a sibling topic in is the session's own chat.
  const parentMg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  if (!parentMg) {
    notify(`Cannot spawn "${name}": this session isn't attached to a chat, so there's no conversation to spawn in.`);
    log.warn('spawn_topic_agent failed: session has no messaging group', { sessionId: session.id });
    return;
  }

  // 2. The adapter that owns this chat. EXACT-key resolution (instance ??
  //    channel_type, no channelType fallback) for the same reason outbound
  //    delivery uses it: creating a topic is an instance-addressed action, and
  //    a sibling instance of the same platform is a different bot identity
  //    with a different token.
  const channelKey = parentMg.instance ?? parentMg.channel_type;
  const adapter = getChannelAdapterExact(channelKey);
  if (!adapter) {
    notify(`Cannot spawn "${name}": the ${channelKey} channel adapter isn't running right now.`);
    log.warn('spawn_topic_agent failed: no live adapter', { channelKey, messagingGroupId: parentMg.id });
    return;
  }
  const creator = threadCreator(adapter);
  if (!creator) {
    notify(
      `Cannot spawn "${name}": the ${parentMg.channel_type} channel can't create sub-conversations — ` +
        `its adapter doesn't implement createThread. Ask an admin to create the channel and wire an agent to it.`,
    );
    log.info('spawn_topic_agent refused: adapter cannot create threads', {
      channelKey,
      channelType: parentMg.channel_type,
    });
    return;
  }

  // 3. One level only — see isSubConversation for how this is detected
  //    without a parent/child column.
  if (isSubConversation(parentMg)) {
    notify(`Cannot spawn "${name}": this chat is already a topic. Spawn new topics from the main chat instead.`);
    log.info('spawn_topic_agent refused: caller is already a sub-conversation', {
      messagingGroupId: parentMg.id,
      platformId: parentMg.platform_id,
    });
    return;
  }

  // 4. Create the platform conversation. Everything after this point is
  //    unconditional: a failure here is reported and nothing was written.
  let topicPlatformId: string;
  try {
    topicPlatformId = await creator.createThread(parentMg.platform_id, name);
  } catch (err) {
    notify(`Cannot spawn "${name}": the ${parentMg.channel_type} channel refused to create the topic.`);
    log.error('spawn_topic_agent failed: createThread threw', { channelKey, parent: parentMg.platform_id, err });
    return;
  }

  const now = new Date().toISOString();
  const slug = normalizeName(name);

  // 5. Agent group + filesystem scaffold. Folder derivation and the
  //    path-traversal check mirror performCreateAgent exactly.
  let folder = slug;
  let folderSuffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${slug}-${folderSuffix}`;
    folderSuffix++;
  }
  const resolvedPath = path.resolve(path.join(GROUPS_DIR, folder));
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) {
    notify(`Cannot spawn "${name}": invalid folder path.`);
    log.error('spawn_topic_agent path traversal attempt', { folder, resolvedPath });
    return;
  }

  const agentGroupId = generateId('ag');
  const newGroup: AgentGroup = {
    id: agentGroupId,
    name,
    folder,
    agent_provider: null,
    created_at: now,
  };
  createAgentGroup(newGroup);
  // Same inheritance rule as the subagent path: the child runs on its
  // parent's EFFECTIVE provider, never the instance-wide default, so it is
  // never spawned on a runtime this install can't reach.
  const parentConfig = getContainerConfig(sourceGroup.id);
  const parentProvider = parentConfig?.provider ?? 'claude';
  initGroupFilesystem(newGroup, { instructions: instructions || undefined, provider: parentProvider });

  // Model inheritance, for the same reason as the provider above: an install
  // whose gateway only serves a fixed model list (a LiteLLM key's `models`
  // allowlist, say) has no instance-wide notion of "a model that works" — the
  // only name known to be reachable is the one the parent is already running
  // on. A child stamped with the parent's model is therefore never spawned
  // onto a name this install can't reach, and a topic agent that would
  // otherwise fall back to the provider's own default (often a costlier tier)
  // inherits the deliberate choice instead.
  //
  // Stamped once at spawn, not resolved per read: re-pointing the parent later
  // leaves existing children where they are, matching how the provider hint
  // behaves. Left unset when the parent has none, so the provider default still
  // applies — inheriting `undefined` must not look like a decision.
  if (parentConfig?.model) {
    updateContainerConfigScalars(agentGroupId, { model: parentConfig.model });
  }

  // 6. The topic is its own messaging group — a 3-part platform_id on a
  //    non-threaded adapter, which outbound delivery already addresses
  //    correctly. It inherits the PARENT chat's unknown_sender_policy so the
  //    new topic is exactly as open or as closed as the chat it was spawned
  //    from: a spawn must never widen (or narrow) who may talk to this
  //    install.
  const messagingGroupId = generateId('mg');
  const topicMg: MessagingGroup = {
    id: messagingGroupId,
    channel_type: parentMg.channel_type,
    platform_id: topicPlatformId,
    instance: channelKey,
    name,
    is_group: 1,
    unknown_sender_policy: parentMg.unknown_sender_policy,
    denied_at: null,
    created_at: now,
  };
  createMessagingGroup(topicMg);

  // 7. Wire it. Engagement comes from the CHANNEL DECLARATION for a group
  //    context (resolveWiringDefaults), exactly as every other
  //    wiring-creation surface resolves it — ncl, the setup wizard, the
  //    channel-approval connect path. This used to hardcode engage_mode
  //    'pattern' with the '.' sentinel on the reasoning that the topic holds
  //    only one agent so it may answer everything. That holds for AGENTS and
  //    not for HUMANS: a topic is still a shared forum conversation, so an
  //    always-on wiring makes the agent answer people talking to each other.
  //    On a mention channel the declaration resolves to 'mention', which the
  //    bridge already satisfies for a REPLY to the bot as well as an @mention
  //    (resolveInboundMention in src/channels/chat-sdk-bridge.ts promotes
  //    reply-to-bot to isMention) — so "@it or reply to it" engages and
  //    ambient chatter does not. Channels that declare an always-on group
  //    context still get always-on here; the decision moved to the
  //    declaration rather than being overridden per spawn.
  //
  //    COUPLED to step 10: the replayed brief must carry isMention so the new
  //    agent still wakes on it under a mention-mode wiring.
  //
  //    Falls back to 'mention' if the declaration is malformed (a 'pattern'
  //    context with no pattern makes resolveWiringDefaults throw). By this
  //    point the topic and the agent group exist and every remaining write is
  //    unconditional, so throwing here would strand them with no wiring at
  //    all; the conservative mode keeps the spawn coherent and recoverable
  //    with one `ncl wirings update`.
  //
  //    sender_scope is INHERITED from the wiring that asked for the spawn, not
  //    fixed at 'all': the two gates are independent, and sender_scope is the
  //    stricter one. On a 'public' messaging group the access gate returns
  //    allow before it ever asks who the sender is
  //    (src/modules/permissions/index.ts), so a wiring's sender_scope='known'
  //    is the ONLY thing keeping non-members from driving the agent — which is
  //    exactly what the channel-approval connect path writes. Hardcoding 'all'
  //    would hand a stranger in an open community chat their own agent, with
  //    its own container and a destination back to the concierge. Falling back
  //    to 'known' when the parent wiring can't be resolved keeps the rule
  //    one-directional: a spawn can only ever be as strict as the chat it came
  //    from, never looser.
  const parentWiring = getMessagingGroupAgentByPair(parentMg.id, sourceGroup.id);
  let engage: { engage_mode: 'pattern' | 'mention' | 'mention-sticky'; engage_pattern: string | null };
  try {
    engage = resolveWiringDefaults(channelKey, true, name, parentMg.channel_type);
  } catch (err) {
    engage = { engage_mode: 'mention', engage_pattern: null };
    log.warn('spawn_topic_agent: channel declares malformed group defaults, wiring as mention', { channelKey, err });
  }
  createMessagingGroupAgent({
    id: generateId('mga'),
    messaging_group_id: messagingGroupId,
    agent_group_id: agentGroupId,
    engage_mode: engage.engage_mode,
    engage_pattern: engage.engage_pattern,
    sender_scope: parentWiring?.sender_scope ?? 'known',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });

  // 8. Copy access forward. Access is per AGENT GROUP
  //    (src/modules/permissions/access.ts) and a brand-new group has zero
  //    agent_group_members rows, so without this every non-owner human who
  //    could talk to the concierge is refused with 'not_member' on their
  //    first message in the new topic. Owners / global admins / scoped admins
  //    are implicit members and need no row. Guarded on the table: the
  //    permissions module is optional (same hasTable discipline as
  //    ensureAgentDestinationForWiring).
  if (hasTable(getDb(), 'agent_group_members')) {
    for (const member of getMembers(sourceGroup.id)) {
      // added_by carries the original grantor forward — the access these
      // people have here is the access they were granted over there.
      addMember({ user_id: member.user_id, agent_group_id: agentGroupId, added_by: member.added_by, added_at: now });
    }
  }

  // 9. Bidirectional destinations (= ACL grants): the concierge refers to the
  //    child by its own name, the child refers to the concierge as "parent".
  //    Guarded on the table — agent-to-agent is an optional module; without
  //    it the pair simply can't message each other directly.
  let localName = slug;
  if (hasTable(getDb(), 'agent_destinations')) {
    // Unlike performCreateAgent, a name collision suffixes instead of
    // refusing: by this point the topic and the agent group exist, and a
    // refusal here would strand them.
    let suffix = 2;
    while (getDestinationByName(sourceGroup.id, localName)) {
      localName = `${slug}-${suffix}`;
      suffix++;
    }
    createDestination({
      agent_group_id: sourceGroup.id,
      local_name: localName,
      target_type: 'agent',
      target_id: agentGroupId,
      created_at: now,
    });
    let parentName = 'parent';
    let parentSuffix = 2;
    while (getDestinationByName(agentGroupId, parentName)) {
      parentName = `parent-${parentSuffix}`;
      parentSuffix++;
    }
    createDestination({
      agent_group_id: agentGroupId,
      local_name: parentName,
      target_type: 'agent',
      target_id: sourceGroup.id,
      created_at: now,
    });

    // REQUIRED: project the new destination into the running container's
    // inbound.db. See the top-of-file invariant in
    // agent-to-agent/db/agent-destinations.ts — forgetting this causes
    // "dropped: unknown destination" when the concierge tries to send to the
    // agent it just spawned.
    writeDestinations(session.agent_group_id, session.id);
  }

  // 10. Replay the brief into the new topic so the new agent wakes with the
  //     user's actual request instead of a cold start. Same InboundEvent
  //     shape as `ncl messaging-groups send` (src/cli/resources/messaging-groups.ts).
  //     threadId is null: the topic's identity is its platform_id, and the
  //     adapters this targets are non-threaded anyway (the router would strip
  //     it). isGroup marks the topic as a group context for the gate.
  //
  //     isMention is REQUIRED, not decorative: step 7 wires the topic from the
  //     channel declaration, which on a mention channel is engage_mode
  //     'mention', and the router engages on `event.message.isMention === true`
  //     (src/router.ts). A synthetic replay carries no platform mention signal,
  //     so without this flag the brief routes, is judged not-addressed, and the
  //     brand-new agent never wakes on the request it was spawned for. Setting
  //     it is honest rather than a workaround: this message IS addressed to
  //     that agent — the whole topic was created to carry it.
  if (brief) {
    try {
      await routeInbound({
        channelType: topicMg.channel_type,
        instance: channelKey,
        platformId: topicPlatformId,
        threadId: null,
        message: {
          id: `spawn-${randomUUID()}`,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          // Display name credits the concierge that relayed it; the identity
          // is the one the access gate resolves (see replaySenderId).
          content: JSON.stringify({ text: brief, sender: sourceGroup.name, senderId: replaySenderId() }),
          isGroup: true,
          isMention: true,
        },
      });
    } catch (err) {
      // The topic and its agent exist and are wired — only the kickoff
      // message failed, and the next human message wakes it normally.
      notify(`Topic "${name}" was created, but the opening brief could not be delivered into it.`);
      log.error('spawn_topic_agent failed to replay the brief', { messagingGroupId, err });
    }
  }

  // 11. Report back.
  notify(
    `Agent "${localName}" spawned in a new "${name}" topic. You can message it with ` +
      `send_message({ to: "${localName}", ... }), and anyone in this chat can talk to it there.`,
  );
  log.info('Topic agent spawned', {
    agentGroupId,
    messagingGroupId,
    name,
    localName,
    folder,
    topicPlatformId,
    parent: sourceGroup.id,
    parentMessagingGroupId: parentMg.id,
  });
}
