/**
 * Forum typing indicator — thread-id qualification.
 *
 * Telegram forum supergroups accept a `sendChatAction` that omits
 * message_thread_id with `{"ok":true}` and then render nothing, so the
 * failure is invisible from the API side: verified by hand against a live
 * forum group, where an action with no thread id showed nothing and the
 * same action with message_thread_id=1 showed the indicator.
 *
 * The General topic is what makes this subtle — Telegram encodes it by
 * omitting message_thread_id, so a General message's thread id is
 * `telegram:<chatId>`, byte-identical to a plain (non-forum) group's.
 * Only the chat's `is_forum` flag distinguishes them.
 */
import { describe, expect, it, vi } from 'vitest';

import { createTypingThreadResolver, qualifyForumTypingThreadId } from './telegram.js';

describe('qualifyForumTypingThreadId', () => {
  it('names the General topic explicitly in a forum', () => {
    expect(qualifyForumTypingThreadId('telegram:-1004238703576', true)).toBe('telegram:-1004238703576:1');
  });

  it('leaves a non-forum group untouched', () => {
    expect(qualifyForumTypingThreadId('telegram:-1004238703576', false)).toBe('telegram:-1004238703576');
  });

  it('leaves a DM untouched', () => {
    expect(qualifyForumTypingThreadId('telegram:156239027', false)).toBe('telegram:156239027');
  });

  it('leaves an already topic-qualified id alone', () => {
    // A message in a real (non-General) topic already addresses itself
    // correctly — appending General would move typing to the wrong topic.
    expect(qualifyForumTypingThreadId('telegram:-1004238703576:47', true)).toBe('telegram:-1004238703576:47');
  });

  it('ignores ids that are not telegram thread ids', () => {
    expect(qualifyForumTypingThreadId('slack:C123', true)).toBe('slack:C123');
    expect(qualifyForumTypingThreadId('telegram:', true)).toBe('telegram:');
    expect(qualifyForumTypingThreadId('nonsense', true)).toBe('nonsense');
  });
});

describe('createTypingThreadResolver', () => {
  it('qualifies a forum chat and passes a plain group through', async () => {
    const isForumChat = vi.fn(async (chatId: string) => chatId === '-1004238703576');
    const resolve = createTypingThreadResolver(isForumChat);

    expect(await resolve('telegram:-1004238703576')).toBe('telegram:-1004238703576:1');
    expect(await resolve('telegram:-1009999999999')).toBe('telegram:-1009999999999');
  });

  it('looks a chat up once however often typing fires', async () => {
    const isForumChat = vi.fn(async () => true);
    const resolve = createTypingThreadResolver(isForumChat);

    for (let i = 0; i < 5; i++) await resolve('telegram:-1004238703576');

    expect(isForumChat).toHaveBeenCalledTimes(1);
  });

  it('does not start a second lookup while the first is still in flight', async () => {
    // Typing re-fires every 4s; caching on resolve rather than on call would
    // start a getChat per tick until the first one lands.
    let release: (v: boolean) => void = () => {};
    const isForumChat = vi.fn(() => new Promise<boolean>((r) => (release = r)));
    const resolve = createTypingThreadResolver(isForumChat);

    const inFlight = [resolve('telegram:-100123'), resolve('telegram:-100123'), resolve('telegram:-100123')];
    expect(isForumChat).toHaveBeenCalledTimes(1);

    release(true);
    expect(await Promise.all(inFlight)).toEqual(['telegram:-100123:1', 'telegram:-100123:1', 'telegram:-100123:1']);
  });

  it('retries after a failed lookup instead of caching the failure', async () => {
    // A cached `false` from one flaky getChat would leave the typing
    // indicator dead for that chat until the host restarts.
    const isForumChat = vi
      .fn<(chatId: string) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(true);
    const resolve = createTypingThreadResolver(isForumChat);

    expect(await resolve('telegram:-100123')).toBe('telegram:-100123');
    expect(await resolve('telegram:-100123')).toBe('telegram:-100123:1');
    expect(isForumChat).toHaveBeenCalledTimes(2);
  });

  it('does not call out at all for an id it cannot parse', async () => {
    const isForumChat = vi.fn(async () => true);
    const resolve = createTypingThreadResolver(isForumChat);

    expect(await resolve('telegram:-100123:47')).toBe('telegram:-100123:47');
    expect(isForumChat).not.toHaveBeenCalled();
  });
});
