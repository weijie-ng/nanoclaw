/**
 * `/add-member @a @b` — an owner or global admin, from a Telegram group the
 * bot administers, grants those accounts membership of EVERY agent wired to
 * that chat, so they can interact with all of the group's agents. Targets do
 * not need to have messaged first: usernames are resolved via the Telethon
 * userbot (resolve.ts).
 *
 * Runs as a router message-interceptor (registered in index.ts). It owns the
 * command end-to-end and never reaches the container: the container agent
 * can neither resolve usernames, check the caller's role, nor write across
 * sibling agent groups. Returns true (consume) once it recognises the command,
 * false for everything else so normal routing is untouched.
 */
import type { InboundEvent } from '../../channels/adapter.js';
import { getChannelAdapterExact } from '../../channels/channel-registry.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { addMember } from '../permissions/db/agent-group-members.js';
import { isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';
import { createUser, getUser } from '../permissions/db/users.js';
import { resolveTelegramUsers, UserbotNotConfigured } from './resolve.js';

// Match /add-member (or the plural /add-members) anywhere after
// start-or-whitespace, with an optional "@BotName" suffix. NOT anchored to ^ —
// in a mention-engaged group the text arrives as "@TheBot /add-member @alice",
// so the command is not at the start.
const ADD_MEMBER_RE = /(?:^|\s)\/add-members?(?:@\S+)?(?=\s|$)/i;

/** Extract every @handle regardless of separator (comma, space, newline, or
 *  concatenated like "@a@b"). '@' is not a valid username char, so the greedy
 *  class stops at the next '@'. Deduped, '@' stripped. */
export function parseMentions(text: string): string[] {
  const matches = text.match(/@[A-Za-z0-9_]{4,32}/g) ?? [];
  return [...new Set(matches.map((s) => s.slice(1)))];
}

function jsonContent(event: InboundEvent): Record<string, unknown> | null {
  try {
    return JSON.parse(event.message.content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Caller's namespaced user id from the inbound payload, or null. */
function callerUserId(content: Record<string, unknown>): string | null {
  const author = content.author as { userId?: unknown } | undefined;
  const raw =
    (typeof content.senderId === 'string' && content.senderId) ||
    (typeof content.sender === 'string' && content.sender) ||
    (author && typeof author.userId === 'string' && author.userId) ||
    null;
  if (!raw) return null;
  return raw.includes(':') ? raw : `telegram:${raw}`;
}

/** "telegram:<chatId>" / "telegram:<chatId>:<topic>" -> "<chatId>". */
function chatIdFromPlatform(platformId: string): string | null {
  const parts = platformId.split(':');
  if (parts[0] !== 'telegram' || !parts[1]) return null;
  return parts[1];
}

/** Every distinct agent group wired to this Telegram chat, across the
 *  chat-level conversation AND any forum topics (separate messaging groups). */
export function agentGroupsWiredToChat(chatId: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT mga.agent_group_id AS id
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
        WHERE mg.channel_type = 'telegram'
          AND (mg.platform_id = ? OR mg.platform_id LIKE ?)`,
    )
    .all(`telegram:${chatId}`, `telegram:${chatId}:%`) as { id: string }[];
  return rows.map((r) => r.id);
}

async function reply(event: InboundEvent, text: string): Promise<void> {
  const adapter = getChannelAdapterExact(event.instance ?? event.channelType);
  if (!adapter) {
    log.warn('add-member: no adapter to reply on', { channelType: event.channelType });
    return;
  }
  await adapter.deliver(event.platformId, event.threadId, { kind: 'chat', content: { text } });
}

/**
 * The interceptor. Consumes only a Telegram group `/add-member`; leaves
 * everything else to normal routing.
 */
export async function handleAddMember(event: InboundEvent): Promise<boolean> {
  if (event.channelType !== 'telegram') return false;
  const content = jsonContent(event);
  const text = typeof content?.text === 'string' ? content.text : '';
  const match = ADD_MEMBER_RE.exec(text);
  if (!match) return false;

  // We now own this message: consume (return true) on every path below.
  const chatId = chatIdFromPlatform(event.platformId);
  if (event.message.isGroup === false || !chatId || !chatId.startsWith('-')) {
    await reply(event, 'The /add-member command works only in a Telegram group.');
    return true;
  }

  const caller = content ? callerUserId(content) : null;
  if (!caller || !(isOwner(caller) || isGlobalAdmin(caller))) {
    await reply(event, 'Permission denied: only an owner or global admin can add members.');
    return true;
  }

  // Targets are only the text AFTER the command token. Anything before it (a
  // leading "@TheBot" mention, or "/add-member@TheBot" itself) is not a target.
  const usernames = parseMentions(text.slice(match.index + match[0].length));
  if (usernames.length === 0) {
    await reply(event, 'Usage: /add-member @username [@username ...]');
    return true;
  }

  const groups = agentGroupsWiredToChat(chatId);
  if (groups.length === 0) {
    await reply(event, 'No agents are wired to this group, so there is nothing to grant.');
    return true;
  }

  let results;
  try {
    results = await resolveTelegramUsers(chatId, usernames);
  } catch (e) {
    if (e instanceof UserbotNotConfigured) {
      await reply(event, `Cannot resolve usernames: ${e.message}`);
    } else {
      log.error('add-member: resolve failed', { err: String(e) });
      await reply(event, 'Could not resolve usernames right now, please try again.');
    }
    return true;
  }

  const now = new Date().toISOString();
  const added: string[] = [];
  const skipped: string[] = [];
  for (const r of results) {
    if (r.userId && r.inGroup) {
      if (!getUser(r.userId)) {
        createUser({ id: r.userId, kind: 'telegram', display_name: `@${r.username}`, created_at: now });
      }
      for (const g of groups) {
        addMember({ user_id: r.userId, agent_group_id: g, added_by: caller, added_at: now });
      }
      added.push(`@${r.username}`);
    } else {
      skipped.push(`@${r.username} (${r.error ?? (r.userId ? 'not in this group' : 'no such username')})`);
    }
  }

  const agentCount = `${groups.length} agent${groups.length === 1 ? '' : 's'}`;
  const lines: string[] = [];
  if (added.length) {
    const who = added.join(', ');
    const noun = added.length === 1 ? 'a member' : 'members';
    lines.push(`✅ Added ${who} as ${noun}. They can now talk to all ${agentCount} in this group.`);
  }
  if (skipped.length) {
    lines.push(`⚠️ Couldn't add ${skipped.join(', ')}.`);
  }
  await reply(event, lines.join('\n') || 'Nothing to add.');
  return true;
}
