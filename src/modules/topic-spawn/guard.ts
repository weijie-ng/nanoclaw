/**
 * Topic-spawn guard adapter — the module's catalog entry, composed at the
 * module edge (imported by ./index.ts).
 *
 * topics.spawn is agents.create's decision, for the same reason: the body
 * writes CENTRAL-DB state (agent_groups, container_configs,
 * messaging_groups, messaging_group_agents, agent_group_members,
 * agent_destinations), scaffolds host filesystem state, AND creates a real
 * conversation on the platform — privileged work a confined container is
 * architecturally barred from. The MCP tool that emits the request lives
 * inside the (untrusted) container and is visible to EVERY agent group —
 * there is no per-group tool selection — so the container-side surface
 * carries no authorization at all: it is trivially bypassed by writing the
 * outbound system row directly. Authorization is host-side only, here.
 *
 * `global` cli_scope is the trusted owner agent group (spawning a topic per
 * task is the intended primitive for a concierge, and an approval tap on
 * every spawn would be needless friction) → allow. Anything else — the
 * default `group` scope, the realistic prompt-injection victim, and any
 * unknown/missing config, fail-closed — holds for the requesting group's
 * admin chain. On approve the continuation re-enters the wrapped delivery
 * action with the approval row as its grant and the checks re-run live.
 */
import { getContainerConfig } from '../../db/container-configs.js';
import { ALLOW, DENY, HOLD, defineGuardedAction } from '../../guard/index.js';

export const topicsSpawn = defineGuardedAction({
  action: 'topics.spawn',
  grantActionName: 'spawn_topic_agent',
  // Bind a spawn_topic_agent grant to the name that was approved.
  grantCoversRequest: (grant, input) => {
    try {
      return (JSON.parse(grant.payload) as { name?: string }).name === input.payload.name;
    } catch {
      return false;
    }
  },
  decide: (input) => {
    if (input.actor.kind !== 'agent') return DENY('spawn_topic_agent is a container-originated action.');
    const cliScope = getContainerConfig(input.actor.agentGroupId)?.cli_scope ?? 'group';
    if (cliScope === 'global') {
      return ALLOW('trusted global-scope agent group');
    }
    return HOLD('agent-initiated spawn_topic_agent requires admin approval');
  },
});
