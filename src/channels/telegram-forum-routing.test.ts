/**
 * Forum topics as messaging groups.
 *
 * Telegram is a non-threaded adapter: the SDK's channelIdFromThreadId strips
 * the topic, so every topic of a forum supergroup would land in the one
 * chat-level messaging group. The inbound rewrite promotes the topic-qualified
 * thread id to the platform id instead, which is what lets a spawned topic
 * agent own its own messaging group / wiring / session.
 *
 * Two shapes must NOT be rewritten, and both are easy to get wrong:
 *  - General, because Telegram encodes it by omitting message_thread_id, so
 *    its thread id is two-part and byte-identical to a plain group's;
 *  - a non-forum supergroup, which also sets message_thread_id on discussion
 *    replies — rewriting there shatters one ordinary chat into a messaging
 *    group per reply chain.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCachedForumProbe,
  createForumTopic,
  createForumTopicRewriter,
  fetchIsForum,
  forumTopicPlatformId,
} from './telegram-forum.js';

const CHAT = 'telegram:-1004238703576';

/** A message the bridge could not answer the topic question for (no hook / no raw). */
function inbound() {
  return { id: 'm1', kind: 'chat-sdk' as const, content: { text: 'hi' }, timestamp: '2026-08-12T00:00:00.000Z' };
}

/** A message carrying the bridge's projected per-message topic flag. */
function inboundWithTopicFlag(isSubConversation: boolean) {
  return { ...inbound(), content: { text: 'hi', isSubConversation } };
}

describe('forumTopicPlatformId', () => {
  it('routes a topic message as its own messaging group', () => {
    expect(forumTopicPlatformId(CHAT, `${CHAT}:42`, true)).toBe(`${CHAT}:42`);
  });

  it('leaves the General topic on the chat-level id', () => {
    expect(forumTopicPlatformId(CHAT, CHAT, true)).toBe(CHAT);
  });

  it('leaves a non-forum chat alone even with a thread id', () => {
    expect(forumTopicPlatformId(CHAT, `${CHAT}:42`, false)).toBe(CHAT);
  });

  it('ignores a thread id belonging to another chat', () => {
    expect(forumTopicPlatformId(CHAT, 'telegram:-1009999999999:42', true)).toBe(CHAT);
  });

  it('ignores ids it cannot parse', () => {
    expect(forumTopicPlatformId(CHAT, null, true)).toBe(CHAT);
    expect(forumTopicPlatformId(CHAT, `${CHAT}:`, true)).toBe(CHAT);
    expect(forumTopicPlatformId(CHAT, 'slack:C123:456', true)).toBe(CHAT);
    expect(forumTopicPlatformId(`${CHAT}:42`, `${CHAT}:42`, true)).toBe(`${CHAT}:42`);
  });
});

describe('createForumTopicRewriter', () => {
  it('rewrites a topic message in a forum', async () => {
    const host = vi.fn();
    const rewrite = createForumTopicRewriter(async () => true, host);

    await rewrite(CHAT, `${CHAT}:42`, inbound());

    expect(host).toHaveBeenCalledWith(`${CHAT}:42`, `${CHAT}:42`, expect.anything());
  });

  it('passes General straight through without probing at all', async () => {
    const isForumChat = vi.fn(async () => true);
    const host = vi.fn();
    const rewrite = createForumTopicRewriter(isForumChat, host);

    await rewrite(CHAT, CHAT, inbound());

    expect(host).toHaveBeenCalledWith(CHAT, CHAT, expect.anything());
    expect(isForumChat).not.toHaveBeenCalled();
  });

  it('passes a non-forum chat through unchanged', async () => {
    const host = vi.fn();
    const rewrite = createForumTopicRewriter(async () => false, host);

    await rewrite(CHAT, `${CHAT}:42`, inbound());

    expect(host).toHaveBeenCalledWith(CHAT, `${CHAT}:42`, expect.anything());
  });

  it('fails safe through the cached probe when getChat throws', async () => {
    // Composed exactly as the adapter composes it: a failed getChat must read
    // as "not a forum" and deliver the message to the chat-level wiring, never
    // drop it or blow up the inbound path.
    const host = vi.fn();
    const rewrite = createForumTopicRewriter(
      createCachedForumProbe(async () => {
        throw new Error('network');
      }),
      host,
    );

    await rewrite(CHAT, `${CHAT}:42`, inbound());

    expect(host).toHaveBeenCalledWith(CHAT, `${CHAT}:42`, expect.anything());
  });

  it('a per-message topic flag rewrites without spending a getChat', async () => {
    const isForumChat = vi.fn(async () => true);
    const host = vi.fn();
    const rewrite = createForumTopicRewriter(isForumChat, host);

    await rewrite(CHAT, `${CHAT}:42`, inboundWithTopicFlag(true));

    expect(host).toHaveBeenCalledWith(`${CHAT}:42`, `${CHAT}:42`, expect.anything());
    expect(isForumChat).not.toHaveBeenCalled();
  });

  it('a reply thread inside a forum chat is NOT promoted to its own messaging group', async () => {
    // The regression this guards: `is_forum` is CHAT-level and does not
    // disable Telegram's reply/discussion threads, which set
    // message_thread_id of their own (a linked discussion group's comments
    // carry the root post's message id). Routing those as their own platform
    // id drops plain comments entirely (no messaging_groups row, not a
    // mention) and mints a junk messaging group + a channel-registration card
    // per comment thread for @mentions. Only `is_topic_message` separates the
    // two, and it is per message — so the flag must win over the probe.
    const isForumChat = vi.fn(async () => true);
    const host = vi.fn();
    const rewrite = createForumTopicRewriter(isForumChat, host);

    await rewrite(CHAT, `${CHAT}:8817`, inboundWithTopicFlag(false));

    expect(host).toHaveBeenCalledWith(CHAT, `${CHAT}:8817`, expect.anything());
  });

  it('probes once per chat, not once per message', async () => {
    // Inbound fires per message; an uncached probe would be a getChat per
    // message on every busy forum.
    const isForumChat = vi.fn(async () => true);
    const rewrite = createForumTopicRewriter(createCachedForumProbe(isForumChat), vi.fn());

    for (let i = 0; i < 5; i++) await rewrite(CHAT, `${CHAT}:${i}`, inbound());

    expect(isForumChat).toHaveBeenCalledTimes(1);
  });
});

describe('fetchIsForum', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads is_forum off an ok answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, result: { is_forum: true } }) })),
    );

    expect(await fetchIsForum('TOKEN', '-1004238703576')).toBe(true);
  });

  it('answers false for a chat that is not a forum', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, result: {} }) })),
    );

    expect(await fetchIsForum('TOKEN', '-1004238703576')).toBe(false);
  });

  it('THROWS on an API-level failure instead of answering "not a forum"', async () => {
    // The whole contract with createCachedForumProbe: the probe caches the
    // promise and evicts ONLY on rejection. A 429/502 that resolved to `false`
    // would pin `false` for the process lifetime, collapsing every topic of
    // that supergroup back onto the chat-level wiring until a restart.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 5' }),
      })),
    );

    await expect(fetchIsForum('TOKEN', '-1004238703576')).rejects.toThrow('Too Many Requests');
  });

  it('a transient API failure is re-probed, not cached', async () => {
    // Composed exactly as the adapter composes it.
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++;
        return {
          status: 200,
          json: async () =>
            call === 1 ? { ok: false, description: 'Bad Gateway' } : { ok: true, result: { is_forum: true } },
        };
      }),
    );
    const probe = createCachedForumProbe((chatId) => fetchIsForum('TOKEN', chatId));

    expect(await probe('-1004238703576')).toBe(false); // fail-safe answer
    expect(await probe('-1004238703576')).toBe(true); // …but the entry was evicted, so we ask again
  });
});

describe('createForumTopic', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(payload: unknown, status = 200) {
    const fetchMock = vi.fn(async () => ({ status, json: async () => payload }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('composes the new topic id from the chat and message_thread_id', async () => {
    const fetchMock = stubFetch({ ok: true, result: { message_thread_id: 42, name: 'Deploys' } });

    expect(await createForumTopic('TOKEN', CHAT, 'Deploys')).toBe(`${CHAT}:42`);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botTOKEN/createForumTopic');
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: '-1004238703576', name: 'Deploys' });
  });

  it("throws with Telegram's own description on ok:false", async () => {
    stubFetch({ ok: false, description: 'Bad Request: the chat is not a forum' });

    await expect(createForumTopic('TOKEN', CHAT, 'Deploys')).rejects.toThrow('Bad Request: the chat is not a forum');
  });

  it('throws when the response carries no topic id', async () => {
    stubFetch({ ok: true, result: {} }, 500);

    await expect(createForumTopic('TOKEN', CHAT, 'Deploys')).rejects.toThrow('HTTP 500');
  });

  it('propagates a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );

    await expect(createForumTopic('TOKEN', CHAT, 'Deploys')).rejects.toThrow('ECONNRESET');
  });

  it('refuses to nest a topic inside a topic', async () => {
    const fetchMock = stubFetch({ ok: true, result: { message_thread_id: 43 } });

    await expect(createForumTopic('TOKEN', `${CHAT}:42`, 'Deploys')).rejects.toThrow('expected a chat id');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
