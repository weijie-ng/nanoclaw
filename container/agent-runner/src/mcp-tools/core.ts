/**
 * Core MCP tools: send_message, send_file, edit_message, add_reaction, pin_message.
 *
 * All outbound tools resolve destinations via the local destination map
 * (see destinations.ts). Agents reference destinations by name; the map
 * translates name → routing tuple. Permission enforcement happens on
 * the host side in delivery.ts via the agent_destinations table.
 */
import fs from 'fs';
import path from 'path';

import { findByName, getAllDestinations } from '../destinations.js';
import { getMessageIdBySeq, getRoutingBySeq, writeMessageOut } from '../db/messages-out.js';
import { getCurrentInReplyTo } from '../db/session-state.js';
import { getSessionRouting } from '../db/session-routing.js';
import { alreadyDelivered, recordDelivery } from '../turn-ledger.js';
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

function destinationList(): string {
  const all = getAllDestinations();
  if (all.length === 0) return '(none)';
  return all.map((d) => d.name).join(', ');
}

/**
 * Resolve a destination name to routing fields.
 *
 * Look up the explicitly named destination. If it resolves to
 * the same channel the session is bound to, the session's thread_id is
 * preserved so replies land in the correct thread. Otherwise thread_id
 * is null (a cross-destination send starts a new conversation).
 */
function resolveRouting(
  to: string,
): { channel_type: string; platform_id: string; thread_id: string | null; resolvedName: string } | { error: string } {
  const dest = findByName(to);
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  if (dest.type === 'channel') {
    // If the destination is the same channel the session is bound to,
    // preserve the thread_id so replies land in the correct thread.
    const session = getSessionRouting();
    const threadId =
      session.channel_type === dest.channelType && session.platform_id === dest.platformId ? session.thread_id : null;
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id: threadId,
      resolvedName: to,
    };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to };
}

export const sendMessage: McpToolDefinition = {
  tool: {
    name: 'send_message',
    description: 'Send a message to a named destination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Destination name (e.g., "family", "worker-1").',
        },
        text: { type: 'string', description: 'Message content' },
      },
      required: ['to', 'text'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const text = args.text as string;
    if (!to) return err(`to is required. Options: ${destinationList()}`);
    if (!text) return err('text is required');

    const routing = resolveRouting(to);
    if ('error' in routing) return err(routing.error);

    // Turn-scoped idempotency: if this exact reply already went to this
    // destination this turn (the other door, or a repeat tool call), don't
    // send it again — hand back the id it already landed as.
    const existing = alreadyDelivered(routing.resolvedName, text);
    if (existing !== null) {
      log(`send_message: duplicate of #${existing} this turn → not resent (${routing.resolvedName})`);
      return ok(`Message already sent to ${routing.resolvedName} this turn (id: ${existing})`);
    }

    const id = generateId();
    const seq = writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text }),
    });
    recordDelivery(routing.resolvedName, text, seq);

    log(`send_message: #${seq} → ${routing.resolvedName}`);
    return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

export const sendFile: McpToolDefinition = {
  tool: {
    name: 'send_file',
    description: 'Send a file to a named destination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name.' },
        path: { type: 'string', description: 'File path (relative to /workspace/agent/ or absolute)' },
        text: { type: 'string', description: 'Optional accompanying message' },
        filename: { type: 'string', description: 'Display name (default: basename of path)' },
      },
      required: ['to', 'path'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const filePath = args.path as string;
    if (!to) return err(`to is required. Options: ${destinationList()}`);
    if (!filePath) return err('path is required');

    const routing = resolveRouting(to);
    if ('error' in routing) return err(routing.error);

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/agent', filePath);
    if (!fs.existsSync(resolvedPath)) return err(`File not found: ${filePath}`);

    const id = generateId();
    const filename = (args.filename as string) || path.basename(resolvedPath);

    const outboxDir = path.join('/workspace/outbox', id);
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.copyFileSync(resolvedPath, path.join(outboxDir, filename));

    // The SEQ is what comes back, not the internal id: it is the handle every
    // message-targeting tool takes (`pin_message`, `edit_message`,
    // `add_reaction`), so an agent that sends a document and then wants to pin
    // it has something to pass. The internal id stays the outbox directory name.
    const seq = writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text: (args.text as string) || '', files: [filename] }),
    });

    log(`send_file: #${seq} → ${routing.resolvedName} (${filename})`);
    return ok(`File sent to ${routing.resolvedName} (id: ${seq}, filename: ${filename})`);
  },
};

/**
 * Queue an operation targeting a message the agent already saw (edit, react,
 * pin). All three need the same four things: the platform message id behind
 * `#N`, the routing that message was delivered with, a fresh id, and a write
 * to messages_out — the host bridge dispatches on `content.operation`.
 */
function queueOp(seq: number, op: Record<string, unknown>) {
  const platformId = getMessageIdBySeq(seq);
  if (!platformId) return { error: err(`Message #${seq} not found`) };

  const routing = getRoutingBySeq(seq);
  if (!routing || !routing.channel_type || !routing.platform_id) {
    return { error: err(`Cannot determine destination for message #${seq}`) };
  }

  writeMessageOut({
    id: generateId(),
    kind: 'chat',
    platform_id: routing.platform_id,
    channel_type: routing.channel_type,
    thread_id: routing.thread_id,
    content: JSON.stringify({ ...op, messageId: platformId }),
  });
  return { platformId };
}

export const editMessage: McpToolDefinition = {
  tool: {
    name: 'edit_message',
    description: 'Edit a previously sent message. Targets the same destination the original message was sent to.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        text: { type: 'string', description: 'New message content' },
      },
      required: ['messageId', 'text'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const text = args.text as string;
    if (!seq || !text) return err('messageId and text are required');

    const queued = queueOp(seq, { operation: 'edit', text });
    if (queued.error) return queued.error;

    log(`edit_message: #${seq} → ${queued.platformId}`);
    return ok(`Message edit queued for #${seq}`);
  },
};

export const addReaction: McpToolDefinition = {
  tool: {
    name: 'add_reaction',
    description: 'Add an emoji reaction to a message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        emoji: { type: 'string', description: 'Emoji name (e.g., thumbs_up, heart, check)' },
      },
      required: ['messageId', 'emoji'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const emoji = args.emoji as string;
    if (!seq || !emoji) return err('messageId and emoji are required');

    const queued = queueOp(seq, { operation: 'reaction', emoji });
    if (queued.error) return queued.error;

    log(`add_reaction: #${seq} → ${emoji} on ${queued.platformId}`);
    return ok(`Reaction queued for #${seq}`);
  },
};

export const pinMessage: McpToolDefinition = {
  tool: {
    name: 'pin_message',
    description:
      'Pin (or unpin) a message in the chat it was sent to. Telegram only — other channels ignore it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        unpin: { type: 'boolean', description: 'Unpin instead of pinning (default false)' },
      },
      required: ['messageId'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const unpin = args.unpin === true;
    if (!seq) return err('messageId is required');

    const queued = queueOp(seq, { operation: 'pin', unpin });
    if (queued.error) return queued.error;

    log(`pin_message: #${seq} → ${unpin ? 'unpin' : 'pin'} ${queued.platformId}`);
    return ok(`${unpin ? 'Unpin' : 'Pin'} queued for #${seq}`);
  },
};

registerTools([sendMessage, sendFile, editMessage, addReaction, pinMessage]);
