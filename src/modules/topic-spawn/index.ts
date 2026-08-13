/**
 * Topic-spawn module — an agent opening a new conversation next to its own,
 * with a new agent in it.
 *
 * A concierge agent wired to a chat's main conversation calls the container's
 * `spawn_topic_agent` tool; the host creates the sub-conversation on the
 * platform, an agent group scoped to the caller's brief, the messaging group
 * that addresses the new sub-conversation (its own row — the platforms this
 * targets are non-threaded, so a topic is a messaging group, not a thread id),
 * the wiring that makes the new agent answer everything inside it, the access
 * copy that keeps the same humans able to talk to it, and the parent/child
 * destination pair. The brief is then replayed into the new conversation so
 * the new agent wakes with the request rather than cold.
 *
 * Registers its guard-catalog entry (./guard.js) and one guard-wrapped
 * delivery action (`spawn_topic_agent`) — the body writes central-DB state
 * and creates a real conversation, so the guard's topics.spawn decision holds
 * confined (non-global) groups for admin approval while trusted global-scope
 * groups spawn directly; the approval handler re-enters the wrapped action
 * carrying the approval row as its grant.
 *
 * Depends on the approvals module for the request/handler plumbing, and
 * reads (never requires) the agent-to-agent and permissions modules: the
 * destination pair and the member copy are each `hasTable`-guarded, so the
 * spawn still works — with less connectivity — when either is absent.
 *
 * Without this module: the container tool still writes its outbound system
 * row, but delivery logs "Unknown system action" and drops it. No topic is
 * created, no admin is carded, and the requesting agent gets no answer.
 */
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { notifyAgent, registerApprovalHandler } from '../approvals/index.js';
import { topicsSpawn } from './guard.js';
import { requestSpawnTopicAgentHold, spawnTopicAgent, validateSpawnTopicAgent } from './spawn.js';

registerDeliveryAction('spawn_topic_agent', spawnTopicAgent, {
  guardAction: topicsSpawn,
  precheck: validateSpawnTopicAgent,
  requestHold: requestSpawnTopicAgentHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `spawn_topic_agent denied: ${reason}`),
});
registerApprovalHandler('spawn_topic_agent', reenterGuardedDeliveryAction('spawn_topic_agent'));
