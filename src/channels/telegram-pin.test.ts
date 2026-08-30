/**
 * Telegram pin / unpin.
 *
 * The two things worth pinning down: a forum-topic thread id must collapse to
 * its chat id (pinChatMessage has no thread parameter, so a 3-part id would
 * otherwise reach the API as a bogus chat), and an `ok:false` answer must
 * throw with Telegram's own description — the delivery loop's retry/give-up
 * path is the only place a missing pin right ever becomes visible.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pinTelegramMessage } from './telegram-pin.js';

vi.mock('../env.js', () => ({
  readEnvFile: () => ({ TELEGRAM_BOT_TOKEN: 'TOKEN' }),
}));

function captureFetch(response: unknown) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { status: 200, json: async () => response } as unknown as Response;
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pinTelegramMessage', () => {
  it('pins a topic message against the chat id, not the topic id', async () => {
    const calls = captureFetch({ ok: true });
    await pinTelegramMessage('telegram:-1001234:42', '77');
    expect(calls[0].url).toContain('/botTOKEN/pinChatMessage');
    expect(calls[0].body).toEqual({ chat_id: '-1001234', message_id: 77 });
  });

  it('decodes the composite <chatId>:<messageId> the container actually sends', async () => {
    // getMessageIdBySeq hands back `<chatId>:<messageId>`, not a bare int —
    // Number() of that is NaN, which Telegram rejects as "message to pin not found".
    const calls = captureFetch({ ok: true });
    await pinTelegramMessage('telegram:-1001234567890:526', '-1001234567890:530');
    expect(calls[0].body).toEqual({ chat_id: '-1001234567890', message_id: 530 });
  });

  it('throws on a message id with no numeric part rather than sending NaN', async () => {
    captureFetch({ ok: true });
    await expect(pinTelegramMessage('telegram:-1001234', 'not-a-number')).rejects.toThrow('no numeric message id');
  });

  it('unpins via unpinChatMessage', async () => {
    const calls = captureFetch({ ok: true });
    await pinTelegramMessage('telegram:-1001234', '77', true);
    expect(calls[0].url).toContain('/botTOKEN/unpinChatMessage');
  });

  it('throws with Telegram’s description on failure', async () => {
    captureFetch({ ok: false, description: 'not enough rights to pin a message' });
    await expect(pinTelegramMessage('telegram:-1001234', '77')).rejects.toThrow('not enough rights');
  });

  it('rejects a thread id that is not a Telegram chat', async () => {
    captureFetch({ ok: true });
    await expect(pinTelegramMessage('slack:C123', '77')).rejects.toThrow('expected a thread id');
  });
});
