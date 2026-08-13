/**
 * Telegram forum-supergroup handling: topic-aware typing qualification,
 * inbound topic routing, and topic creation.
 *
 * TRUNK-OWNED ON PURPOSE. `src/channels/telegram.ts` is branch-owned (copied
 * verbatim from the `channels` branch by `/add-telegram`), so anything that
 * lives there is wholesale-overwritten on the next re-apply. The pure halves
 * of the forum feature live here instead: `telegram.ts` keeps only the wiring
 * that hands these functions the bot token and the bridge hooks, and the
 * tests import from this module, so a re-apply of the adapter can never break
 * the build. See CLAUDE.md "Channels and Providers (skill-installed)".
 *
 * Nothing here touches the DB or the router — it is all id arithmetic plus
 * three Bot API calls.
 */
import { log } from '../log.js';
import type { ChannelSetup, InboundMessage } from './adapter.js';

/** Telegram's reserved message_thread_id for a forum's General topic. */
const GENERAL_TOPIC_ID = 1;

/**
 * Pure half of the forum typing fix.
 *
 * Thread ids are `telegram:<chatId>[:<messageThreadId>]`. Telegram encodes a
 * forum's General topic by OMITTING message_thread_id, so a General message
 * produces a two-part id indistinguishable from one in a plain group.
 * `sendMessage` infers General from that and delivers fine; `sendChatAction`
 * accepts it with `ok:true` and then renders nothing, which is why the typing
 * indicator was invisible in forum groups while every log line said it had
 * been sent. Naming General explicitly is what makes it show up.
 *
 * Leaves an already topic-qualified id alone — that one is addressed correctly.
 */
export function qualifyForumTypingThreadId(threadId: string, isForum: boolean): string {
  if (!isForum) return threadId;
  const parts = threadId.split(':');
  if (parts.length !== 2 || parts[0] !== 'telegram' || !parts[1]) return threadId;
  return `${threadId}:${GENERAL_TOPIC_ID}`;
}

/**
 * getChat → is this chat a forum supergroup?
 *
 * THROWS on anything that isn't a successful `ok:true` answer, transport
 * failures and API-level failures alike. That distinction is the whole
 * contract with `createCachedForumProbe`: the probe caches the promise and
 * evicts only on rejection, so an API-level failure that resolved to `false`
 * (429 "Too Many Requests", 502, a revoked token) would pin `false` in the
 * cache for the lifetime of the process and permanently disable forum
 * handling for that chat — every topic collapsing back onto the chat-level
 * messaging group. Only a real `ok:true` answer is cacheable.
 */
export async function fetchIsForum(token: string, chatId: string): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId }),
  });
  const data = (await res.json()) as { ok?: boolean; description?: string; result?: { is_forum?: boolean } };
  if (data.ok !== true) {
    throw new Error(`Telegram getChat failed: ${data.description ?? `HTTP ${res.status}`}`);
  }
  return data.result?.is_forum === true;
}

/**
 * Memoizing wrapper around the is_forum probe, shared by every consumer that
 * needs to know whether a chat is a forum (typing qualification, inbound topic
 * routing).
 *
 * Caches the promise rather than the result: typing re-fires every 4s and
 * inbound fires per message, so caching only on resolve would start a getChat
 * per event until the first one lands. Evicts on failure — a cached `false`
 * from one flaky getChat would disable forum handling for that chat until the
 * next restart — and reads a failure as "not a forum", which is the
 * pass-through (do-nothing) answer for both consumers.
 */
export function createCachedForumProbe(
  isForumChat: (chatId: string) => Promise<boolean>,
): (chatId: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return (chatId: string): Promise<boolean> => {
    let pending = cache.get(chatId);
    if (!pending) {
      pending = isForumChat(chatId).catch((err) => {
        cache.delete(chatId);
        log.warn('Telegram getChat (is_forum) failed', { chatId, err });
        return false;
      });
      cache.set(chatId, pending);
    }
    return pending;
  };
}

/**
 * Builds the bridge's `resolveTypingThreadId` hook: caches each chat's
 * forum-ness, then defers to `qualifyForumTypingThreadId`.
 *
 * CONTRACT: `isForumChat` must REJECT on a failed lookup — this resolver owns
 * its own cache and evicts on rejection, so a fetcher that swallows failure
 * into `false` (e.g. an already-wrapped `createCachedForumProbe`) pins that
 * `false` for the process lifetime and silently kills the typing indicator in
 * that forum. Pass the raw probe; do not pre-wrap it.
 */
export function createTypingThreadResolver(
  isForumChat: (chatId: string) => Promise<boolean>,
): (threadId: string) => Promise<string> {
  const probe = createCachedForumProbe(isForumChat);
  return async (threadId: string): Promise<string> => {
    const parts = threadId.split(':');
    if (parts.length !== 2 || parts[0] !== 'telegram' || !parts[1]) return threadId;
    return qualifyForumTypingThreadId(threadId, await probe(parts[1]));
  };
}

/**
 * The bridge's `detectSubConversation` hook for Telegram: does this raw
 * message belong to a forum TOPIC, as opposed to merely carrying a
 * message_thread_id?
 *
 * Telegram sets `message_thread_id` for two unrelated things: a forum topic,
 * and a reply/discussion thread in an ordinary supergroup (notably a
 * channel's linked discussion group, where the field holds the root post's
 * message id). Only the first is a separate conversation. `is_topic_message`
 * is the field that tells them apart, and it is per MESSAGE — the chat-level
 * `is_forum` flag does not disable the reply-thread mechanism, so a forum
 * supergroup that is also a linked discussion group produces both shapes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isTelegramTopicMessage(raw: Record<string, any>): boolean {
  return raw.is_topic_message === true;
}

/**
 * Pure half of forum-topic routing: which platform id an inbound message
 * should route as.
 *
 * Telegram is a non-threaded adapter (supportsThreads:false), and the SDK's
 * `channelIdFromThreadId` strips the topic — so every topic of a forum
 * supergroup lands in the one chat-level messaging group. Rewriting the
 * platform id to the topic-qualified thread id makes each topic its own
 * messaging group, hence its own wiring and its own session. Outbound already
 * understands the 3-part id (the SDK adapter sends with message_thread_id),
 * so this is the only end that needs teaching.
 *
 * Two ids pass through untouched:
 *  - the General topic — Telegram encodes it by OMITTING message_thread_id, so
 *    its thread id is two-part and byte-identical to a plain group's. The
 *    existing chat-level wiring keeps working exactly as before.
 *  - anything in a non-forum chat — a plain supergroup also sets
 *    message_thread_id on discussion replies, and rewriting there would
 *    shatter one ordinary chat into a messaging group per reply chain.
 *
 * `isTopic` is the caller's answer to "is this thread id a topic": see
 * `createForumTopicRewriter` for how it is resolved.
 */
export function forumTopicPlatformId(platformId: string, threadId: string | null, isTopic: boolean): string {
  if (!isTopic || !threadId) return platformId;
  const chat = platformId.split(':');
  if (chat.length !== 2 || chat[0] !== 'telegram' || !chat[1]) return platformId;
  const parts = threadId.split(':');
  if (parts.length !== 3 || parts[0] !== 'telegram' || parts[1] !== chat[1] || !parts[2]) return platformId;
  return threadId;
}

/**
 * Per-message topic flag as the bridge projected it (see
 * `detectSubConversation` / `isTelegramTopicMessage`). `undefined` means the
 * question was never asked — a stale adapter copy that doesn't pass the hook,
 * or a dispatch path with no raw payload.
 */
function inboundTopicFlag(message: InboundMessage): boolean | undefined {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') return undefined;
  const flag = (message.content as { isSubConversation?: unknown }).isSubConversation;
  return typeof flag === 'boolean' ? flag : undefined;
}

/**
 * onInbound wrapper that routes each forum topic as its own messaging group.
 *
 * Three-way resolution, because the two available signals answer different
 * questions and only one of them is per-message:
 *  - `is_topic_message === true` — authoritative, this message IS in a topic;
 *    rewrite without spending a getChat.
 *  - `is_topic_message === false` — authoritative the other way: a reply /
 *    discussion thread that merely carries message_thread_id, inside a forum
 *    chat or not. Never rewrite; rewriting shatters one ordinary conversation
 *    into a messaging group per reply chain (and, for an @mention, one
 *    channel-registration card per reply chain).
 *  - flag absent — fall back to the chat-level `is_forum` probe, the pre-hook
 *    behavior, so a stale adapter copy degrades instead of breaking. The probe
 *    is cached per chat and fails safe: a failed getChat reads as "not a
 *    forum" and the message passes through unchanged.
 */
export function createForumTopicRewriter(
  isForumChat: (chatId: string) => Promise<boolean>,
  hostOnInbound: ChannelSetup['onInbound'],
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    let routed = forumTopicPlatformId(platformId, threadId, true);
    if (routed !== platformId) {
      const isTopic = inboundTopicFlag(message);
      if (isTopic === false) routed = platformId;
      else if (isTopic === undefined && !(await isForumChat(platformId.split(':')[1]))) routed = platformId;
    }
    await hostOnInbound(routed, threadId, message);
  };
}

/**
 * Create a forum topic in `platformId`'s supergroup, returning the platform id
 * that addresses it (`telegram:<chatId>:<messageThreadId>`) — directly usable
 * as a messaging_groups.platform_id. Errors carry Telegram's own
 * `description`; the caller surfaces it to the agent that asked for the topic.
 */
export async function createForumTopic(token: string, platformId: string, name: string): Promise<string> {
  const parts = platformId.split(':');
  // Topics do not nest: the source must be the chat itself, not a topic.
  if (parts.length !== 2 || parts[0] !== 'telegram' || !parts[1]) {
    throw new Error(`Cannot create a Telegram topic in "${platformId}" — expected a chat id like telegram:<chatId>`);
  }
  const chatId = parts[1];
  const res = await fetch(`https://api.telegram.org/bot${token}/createForumTopic`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, name }),
  });
  const data = (await res.json()) as {
    ok?: boolean;
    description?: string;
    result?: { message_thread_id?: number };
  };
  if (data.ok !== true || typeof data.result?.message_thread_id !== 'number') {
    throw new Error(`Telegram createForumTopic failed: ${data.description ?? `HTTP ${res.status}`}`);
  }
  return `telegram:${chatId}:${data.result.message_thread_id}`;
}
