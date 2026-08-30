/**
 * Telegram reply-to-bot engagement: the reply-context extractor that lets a
 * plain reply to the bot count as a mention.
 *
 * TRUNK-OWNED ON PURPOSE. `src/channels/telegram.ts` is branch-owned (copied
 * verbatim from the `channels` branch by `/add-telegram`), so anything that
 * lives there is wholesale-overwritten on the next re-apply. The pure half of
 * the reply feature lives here instead: `telegram.ts` keeps only the wiring
 * that hands this function the bot-username getter, and the tests import from
 * this module, so a re-apply of the adapter can never break the build. See
 * CLAUDE.md "Channels and Providers (skill-installed)".
 *
 * Nothing here touches the DB, the router, or the Bot API — it is a pure
 * projection of one raw Telegram message onto the bridge's ReplyContext.
 */
import type { ReplyContext, ReplyContextExtractor } from './chat-sdk-bridge.js';

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
    // FORUM TOPICS: Telegram threads EVERY message in a topic off the topic's
    // root, so an ordinary message that replies to nothing still arrives with
    // reply_to_message set to the `forum_topic_created` SERVICE message. That
    // service message is authored by whoever opened the topic — and topics
    // opened by spawn_topic_agent are authored by the BOT. Read literally,
    // every message in such a topic is "a reply to the bot", so toBot would be
    // true throughout, the bridge would promote all of them to isMention, and
    // an engage_mode 'mention' wiring would engage on every message —
    // silently indistinguishable from always-on. (Observed: plain topic
    // messages carrying replyTo {text:'', sender:<bot>, toBot:true}, while the
    // same user's plain messages in the parent chat carried no replyTo at all.)
    //
    // Two independent signals, either one sufficient, because the root is
    // reachable both implicitly and by an explicit reply to it:
    //  - forum_topic_created present — the replied-to message IS the topic
    //    creation service message.
    //  - message_id === message_thread_id — Telegram keys a topic by its root
    //    message's id, so this equality identifies the root even if the
    //    service payload is absent.
    // Returning null (rather than toBot:false) is deliberate: there is no
    // reply here to render either, and an empty quoted block is noise in the
    // agent's context.
    if (
      reply.forum_topic_created !== undefined ||
      (raw.message_thread_id !== undefined && reply.message_id === raw.message_thread_id)
    ) {
      return null;
    }
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
