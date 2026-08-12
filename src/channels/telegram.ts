/**
 * Telegram channel adapter (v2) — uses Chat SDK bridge, with a pairing
 * interceptor wrapped around onInbound to verify chat ownership before
 * registration. See telegram-pairing.ts for the why.
 */
import { createTelegramAdapter } from '@chat-adapter/telegram';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { createMessagingGroup, getMessagingGroupByPlatform, updateMessagingGroup } from '../db/messaging-groups.js';
import { grantRole, hasAnyOwner } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { createChatSdkBridge, type ReplyContext, type ReplyContextExtractor } from './chat-sdk-bridge.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, InboundMessage } from './adapter.js';
import { tryConsume } from './telegram-pairing.js';

/**
 * Dedicated bot identity, non-threaded platform (supportsThreads:false), so
 * group engagement can never be sticky-per-thread — 'mention' keeps a group
 * wiring from staying engaged forever in the single shared session.
 */
const TELEGRAM_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

/**
 * Retry a one-shot operation that can fail on transient network errors at
 * cold-start (DNS hiccups, brief upstream outages). Exponential backoff capped
 * at 5 attempts — if the network is truly down we surface it instead of
 * hanging the service indefinitely.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = Math.min(16000, 1000 * 2 ** (attempt - 1));
      log.warn('Telegram setup failed, retrying', { label, attempt, delayMs: delay, err });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Reply-context extractor, closed over the bot's own username so it can flag
 * replies aimed at us (`toBot`) — the bridge promotes those to isMention, which
 * is what lets a group wiring in engage_mode 'mention' answer a plain reply
 * without the user re-typing @botname. Telegram's own mention detection is
 * text-only (@username / text_mention / bot_command entities), so a reply
 * carries no mention signal of its own.
 *
 * `getBotUsername` is a getter, not a value: getMe resolves asynchronously
 * after the adapter is constructed. Until it lands (or if it failed outright)
 * we fall back to `is_bot` — over-matching in the rare two-bot group beats a
 * feature that silently does nothing.
 */
export function createReplyContextExtractor(getBotUsername: () => string | null): ReplyContextExtractor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (raw: Record<string, any>): ReplyContext | null => {
    if (!raw.reply_to_message) return null;
    const reply = raw.reply_to_message;
    const from = reply.from ?? {};
    const botUsername = getBotUsername();
    const toBot = botUsername
      ? typeof from.username === 'string' && from.username.toLowerCase() === botUsername.toLowerCase()
      : from.is_bot === true;
    return {
      text: reply.text || reply.caption || '',
      sender: from.first_name || from.username || 'Unknown',
      toBot,
    };
  };
}

/** Look up the bot username via Telegram getMe. Cached after first call. */
async function fetchBotUsername(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
    return json.ok ? (json.result?.username ?? null) : null;
  } catch (err) {
    log.warn('Telegram getMe failed', { err });
    return null;
  }
}

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

/** getChat → is this chat a forum supergroup? Failure reads as "not a forum". */
async function fetchIsForum(token: string, chatId: string): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId }),
  });
  const data = (await res.json()) as { ok?: boolean; result?: { is_forum?: boolean } };
  return data.ok === true && data.result?.is_forum === true;
}

/**
 * Builds the bridge's `resolveTypingThreadId` hook: caches each chat's
 * forum-ness, then defers to `qualifyForumTypingThreadId`.
 */
export function createTypingThreadResolver(
  isForumChat: (chatId: string) => Promise<boolean>,
): (threadId: string) => Promise<string> {
  const cache = new Map<string, Promise<boolean>>();
  return async (threadId: string): Promise<string> => {
    const parts = threadId.split(':');
    if (parts.length !== 2 || parts[0] !== 'telegram' || !parts[1]) return threadId;
    const chatId = parts[1];
    let pending = cache.get(chatId);
    if (!pending) {
      // Cache the promise rather than the result: typing re-fires every 4s,
      // so caching only on resolve would start a getChat per tick until the
      // first one lands.
      pending = isForumChat(chatId).catch((err) => {
        // Evict on failure. A cached `false` from one flaky getChat would
        // disable the typing indicator for that chat until the next restart.
        cache.delete(chatId);
        log.warn('Telegram getChat (is_forum) failed', { chatId, err });
        return false;
      });
      cache.set(chatId, pending);
    }
    return qualifyForumTypingThreadId(threadId, await pending);
  };
}

function isGroupPlatformId(platformId: string): boolean {
  // platformId is "telegram:<chatId>". Negative chat IDs are groups/channels.
  const id = platformId.split(':').pop() ?? '';
  return id.startsWith('-');
}

interface InboundFields {
  text: string;
  authorUserId: string | null;
}

function readInboundFields(message: InboundMessage): InboundFields {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') {
    return { text: '', authorUserId: null };
  }
  const c = message.content as { text?: string; author?: { userId?: string } };
  return { text: c.text ?? '', authorUserId: c.author?.userId ?? null };
}

/**
 * Build an onInbound interceptor that consumes pairing codes before they
 * reach the router. On match: records the chat + its paired user, promotes
 * the user to owner if the instance has no owner yet, and short-circuits.
 * On miss: forwards to the host.
 */
/**
 * Send a one-shot confirmation back to the paired chat. Best-effort — failures
 * are logged but never propagated, so a Telegram outage can't undo a successful
 * pairing or trigger the interceptor's fail-open path.
 */
async function sendPairingConfirmation(token: string, platformId: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: 'Pairing success! Head back to the NanoClaw installer to finish setup.',
      }),
    });
    if (!res.ok) {
      log.warn('Telegram pairing confirmation non-OK', { status: res.status });
    }
  } catch (err) {
    log.warn('Telegram pairing confirmation failed', { err });
  }
}

function createPairingInterceptor(
  botUsernamePromise: Promise<string | null>,
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    try {
      const botUsername = await botUsernamePromise;
      if (!botUsername) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const { text, authorUserId } = readInboundFields(message);
      if (!text) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const consumed = await tryConsume({
        text,
        botUsername,
        platformId,
        isGroup: isGroupPlatformId(platformId),
        adminUserId: authorUserId,
      });
      if (!consumed) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      // Pairing matched — record the chat and short-circuit so the
      // code-bearing message never reaches an agent. Privilege is now a
      // property of the paired user, not the chat: upsert the user, and if
      // this instance has no owner yet, promote them to owner.
      const existing = getMessagingGroupByPlatform('telegram', platformId);
      if (existing) {
        updateMessagingGroup(existing.id, {
          is_group: consumed.consumed!.isGroup ? 1 : 0,
        });
      } else {
        createMessagingGroup({
          id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel_type: 'telegram',
          platform_id: platformId,
          name: consumed.consumed!.name,
          is_group: consumed.consumed!.isGroup ? 1 : 0,
          // Same context-appropriate default as router auto-create, so a
          // paired chat behaves like any other telegram messaging group.
          unknown_sender_policy: (consumed.consumed!.isGroup ? TELEGRAM_DEFAULTS.group : TELEGRAM_DEFAULTS.dm)
            .unknownSenderPolicy,
          created_at: new Date().toISOString(),
        });
      }

      const pairedUserId = `telegram:${consumed.consumed!.adminUserId}`;
      upsertUser({
        id: pairedUserId,
        kind: 'telegram',
        display_name: null,
        created_at: new Date().toISOString(),
      });

      let promotedToOwner = false;
      if (!hasAnyOwner()) {
        grantRole({
          user_id: pairedUserId,
          role: 'owner',
          agent_group_id: null,
          granted_by: null,
          granted_at: new Date().toISOString(),
        });
        promotedToOwner = true;
      }

      log.info('Telegram pairing accepted — chat registered', {
        platformId,
        pairedUser: pairedUserId,
        promotedToOwner,
        intent: consumed.intent,
      });

      await sendPairingConfirmation(token, platformId);
    } catch (err) {
      log.error('Telegram pairing interceptor error', { err });
      // Fail open: pass through so a pairing bug doesn't break normal traffic.
      hostOnInbound(platformId, threadId, message);
    }
  };
}

registerChannelAdapter('telegram', {
  factory: () => {
    const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    if (!env.TELEGRAM_BOT_TOKEN) return null;
    const token = env.TELEGRAM_BOT_TOKEN;
    const telegramAdapter = createTelegramAdapter({
      botToken: token,
      mode: 'polling',
    });

    // Resolved once at startup and shared by the pairing interceptor (which
    // awaits it) and the reply extractor (which reads it synchronously per
    // message, tolerating the brief window before it lands).
    const botUsernamePromise = fetchBotUsername(token);
    let botUsername: string | null = null;
    void botUsernamePromise.then((name) => {
      botUsername = name;
    });

    const bridge = createChatSdkBridge({
      adapter: telegramAdapter,
      concurrency: 'concurrent',
      extractReplyContext: createReplyContextExtractor(() => botUsername),
      resolveTypingThreadId: createTypingThreadResolver((chatId) => fetchIsForum(token, chatId)),
      supportsThreads: false,
      defaults: TELEGRAM_DEFAULTS,
      transformOutboundText: sanitizeTelegramLegacyMarkdown,
      maxTextLength: 4000,
    });

    const wrapped: ChannelAdapter = {
      ...bridge,
      resolveChannelName: async (platformId: string) => {
        const chatId = platformId.split(':').slice(1).join(':');
        if (!chatId) return null;
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId }),
          });
          const data = (await res.json()) as { ok?: boolean; result?: { title?: string } };
          return data.ok ? (data.result?.title ?? null) : null;
        } catch {
          return null;
        }
      },
      async setup(hostConfig: ChannelSetup) {
        const intercepted: ChannelSetup = {
          ...hostConfig,
          onInbound: createPairingInterceptor(botUsernamePromise, hostConfig.onInbound, token),
        };
        return withRetry(() => bridge.setup(intercepted), 'bridge.setup');
      },
    };
    return wrapped;
  },
  defaults: TELEGRAM_DEFAULTS,
});
