/**
 * Telegram pin / unpin.
 *
 * TRUNK-OWNED ON PURPOSE, for the same reason as telegram-forum.ts:
 * `src/channels/telegram.ts` is branch-owned (copied verbatim from the
 * `channels` branch by `/add-telegram`), so anything living there is
 * overwritten wholesale on the next re-apply. Unlike the forum feature this
 * one needs NO wiring in telegram.ts at all — the bridge dispatches the pin
 * operation on `adapter.name`, and the token comes from the same `.env` the
 * adapter factory reads. See CLAUDE.md "Channels and Providers".
 *
 * Bot API note: pinChatMessage takes no thread parameter. Telegram derives the
 * topic from the message being pinned, so a message posted in a forum topic
 * pins inside that topic and the chat id is all the addressing needed — which
 * is why a 3-part topic thread id collapses to its chat id here.
 */
import { readEnvFile } from '../env.js';

/**
 * Pin (or unpin) one message in a Telegram chat.
 *
 * THROWS on any non-`ok` answer, carrying Telegram's own `description` —
 * "not enough rights to pin a message" is the common one, and the delivery
 * loop's bounded retry surfaces it in the error log rather than silently
 * dropping the request.
 */
export async function pinTelegramMessage(threadId: string, messageId: string, unpin = false): Promise<void> {
  // `telegram:<chatId>` or `telegram:<chatId>:<topicId>` — the topic is dropped.
  const [prefix, chatId] = threadId.split(':');
  if (prefix !== 'telegram' || !chatId) {
    throw new Error(`Cannot pin in "${threadId}" — expected a thread id like telegram:<chatId>`);
  }
  const token = readEnvFile(['TELEGRAM_BOT_TOKEN']).TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Cannot pin: TELEGRAM_BOT_TOKEN is not set');

  // The container hands us the composite platform id (`<chatId>:<messageId>`) —
  // the same shape edit/react/delete pass to the branch adapter, which decodes
  // it. pinChatMessage wants the bare integer, so take the numeric tail (a bare
  // id from an older caller or a test still works). `Number('<chat>:<id>')` is
  // NaN, which Telegram rejects as "message to pin not found".
  const rawId = messageId.includes(':') ? messageId.slice(messageId.lastIndexOf(':') + 1) : messageId;
  const numericId = Number(rawId);
  if (!Number.isInteger(numericId)) {
    throw new Error(`Cannot pin: "${messageId}" has no numeric message id`);
  }

  const method = unpin ? 'unpinChatMessage' : 'pinChatMessage';
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: numericId }),
  });
  const data = (await res.json()) as { ok?: boolean; description?: string };
  if (data.ok !== true) {
    throw new Error(`Telegram ${method} failed: ${data.description ?? `HTTP ${res.status}`}`);
  }
}
