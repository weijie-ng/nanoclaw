/**
 * Topic-agent MCP tool: spawn_topic_agent.
 *
 * Creates a forum topic in the current chat and a dedicated agent group wired
 * to it, so an ongoing area of work gets its own thread and its own agent
 * instead of crowding this one.
 *
 * Like create_agent, this writes central-DB state and platform state, so the
 * host authorizes it by CLI scope: trusted owner agent groups (scope 'global')
 * spawn directly; confined groups require admin approval. This tool just writes
 * the outbound request; authorization is enforced host-side, not here — the
 * container is untrusted and cannot be relied on to gate itself. That also
 * covers the case where the calling agent isn't wired to a forum-capable chat
 * at all: only the host knows, and it refuses there.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/** Optional string arg → trimmed value or null (never undefined — the host reads these fields directly). */
function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export const spawnTopicAgent: McpToolDefinition = {
  tool: {
    name: 'spawn_topic_agent',
    description:
      'Create a new topic in THIS chat with its own dedicated agent, for an ongoing area of work (a project, a research thread, a recurring job). Both the topic and the agent are permanent: the new agent answers everything posted in its topic without being mentioned, keeps its own workspace and memory, and becomes a destination you can message by name. Not for one-off questions or anything you can answer here — spawning is not free. May require admin approval; fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Short name for the work — becomes both the topic title and the new agent\'s name/destination',
        },
        instructions: {
          type: 'string',
          description:
            "The new agent's standing role: who it is, what it owns, how it should report back. Becomes its instructions.prepend.md and applies to every future turn.",
        },
        brief: {
          type: 'string',
          description:
            "The specific request that prompted this spawn, in the user's own terms. Replayed into the new topic so the agent's first turn already has the context — one-time, not standing instructions.",
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return err('name is required');

    const requestId = generateId();
    const brief = optionalText(args.brief);
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'spawn_topic_agent',
        requestId,
        name,
        instructions: optionalText(args.instructions),
        brief,
      }),
    });

    log(`spawn_topic_agent: ${requestId} → "${name}"`);
    // Say only what actually happens. The brief is the ONLY thing that wakes
    // the new agent (the host replays it into the topic); with no brief the
    // topic is created, wired, and silent until someone posts in it. Promising
    // an introduction there would be a promise nothing on the host keeps.
    return ok(
      brief
        ? `Creating topic "${name}" and its agent. Your brief is posted there as its first message once it exists.`
        : `Creating topic "${name}" and its agent. It answers everything posted in that topic, but nothing was sent to ` +
            `it — post there, or send_message to it, to start it off.`,
    );
  },
};

registerTools([spawnTopicAgent]);
