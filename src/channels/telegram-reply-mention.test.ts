/**
 * Telegram reply-to-bot detection.
 *
 * Telegram's own mention detection is text-only (@username / text_mention /
 * bot_command entities), so a plain reply to the bot carries no mention
 * signal. The extractor supplies one via ReplyContext.toBot, which the bridge
 * promotes to isMention (see chat-sdk-bridge resolveInboundMention) so a group
 * wiring in engage_mode 'mention' answers replies without a re-@mention.
 */
import { describe, expect, it } from 'vitest';

import { createReplyContextExtractor } from './telegram-reply.js';

const KNOWN = () => 'MyNanoClawBot';
const UNRESOLVED = () => null;

function replyFrom(from: Record<string, unknown>, text = 'previous message') {
  return { reply_to_message: { text, from } };
}

describe('createReplyContextExtractor', () => {
  it('returns null when the message is not a reply', () => {
    expect(createReplyContextExtractor(KNOWN)({ text: 'hello' })).toBeNull();
  });

  it('flags a reply to our own bot (case-insensitive on username)', () => {
    const extract = createReplyContextExtractor(KNOWN);
    expect(extract(replyFrom({ username: 'MyNanoClawBot', is_bot: true }))?.toBot).toBe(true);
    expect(extract(replyFrom({ username: 'mynanoclawbot', is_bot: true }))?.toBot).toBe(true);
  });

  it('does not flag a reply to a different bot once our username is known', () => {
    const extract = createReplyContextExtractor(KNOWN);
    expect(extract(replyFrom({ username: 'SomeOtherBot', is_bot: true }))?.toBot).toBe(false);
  });

  it('does not flag a reply to a human', () => {
    const extract = createReplyContextExtractor(KNOWN);
    expect(extract(replyFrom({ username: 'alice', first_name: 'Alice' }))?.toBot).toBe(false);
  });

  it('falls back to is_bot before getMe resolves (over-match beats silent no-op)', () => {
    const extract = createReplyContextExtractor(UNRESOLVED);
    expect(extract(replyFrom({ username: 'SomeOtherBot', is_bot: true }))?.toBot).toBe(true);
    expect(extract(replyFrom({ username: 'alice', first_name: 'Alice' }))?.toBot).toBe(false);
  });

  it('picks up the username as soon as getMe resolves (getter, not snapshot)', () => {
    let name: string | null = null;
    const extract = createReplyContextExtractor(() => name);
    const other = replyFrom({ username: 'SomeOtherBot', is_bot: true });
    expect(extract(other)?.toBot).toBe(true); // fallback window
    name = 'MyNanoClawBot';
    expect(extract(other)?.toBot).toBe(false); // resolved: precise match
  });

  it('still carries the quoted text and sender the formatter renders', () => {
    const extract = createReplyContextExtractor(KNOWN);
    const ctx = extract(replyFrom({ first_name: 'Alice', username: 'alice' }, 'are you coming tonight?'));
    expect(ctx).toMatchObject({ text: 'are you coming tonight?', sender: 'Alice' });
  });

  // Forum topics: Telegram threads every topic message off the topic-root
  // service message, which for a spawn_topic_agent topic the BOT authored.
  // Left unsuppressed, every plain message in the topic reads as a reply to
  // the bot and an engage_mode 'mention' wiring degrades to always-on.
  describe('forum topic root is not a reply', () => {
    const BOT = { username: 'MyNanoClawBot', is_bot: true };

    it('ignores the implicit root pointer via forum_topic_created', () => {
      const extract = createReplyContextExtractor(KNOWN);
      expect(
        extract({
          message_thread_id: 35,
          reply_to_message: { message_id: 35, from: BOT, forum_topic_created: { name: 'Tech Watch' } },
        }),
      ).toBeNull();
    });

    it('ignores the implicit root pointer on message_id === message_thread_id alone', () => {
      const extract = createReplyContextExtractor(KNOWN);
      expect(extract({ message_thread_id: 35, reply_to_message: { message_id: 35, text: '', from: BOT } })).toBeNull();
    });

    it('still flags a genuine reply to the bot INSIDE a topic', () => {
      const extract = createReplyContextExtractor(KNOWN);
      const ctx = extract({
        message_thread_id: 35,
        reply_to_message: { message_id: 58, text: 'here is the digest', from: BOT },
      });
      expect(ctx).toMatchObject({ text: 'here is the digest', toBot: true });
    });

    it('leaves an ordinary chat reply alone when ids coincidentally differ in shape', () => {
      const extract = createReplyContextExtractor(KNOWN);
      // No message_thread_id at all — the parent-chat case, unchanged.
      expect(extract({ reply_to_message: { message_id: 35, text: 'hi', from: BOT } })?.toBot).toBe(true);
    });
  });

  it('reads caption for media replies, and tolerates a missing from', () => {
    const extract = createReplyContextExtractor(KNOWN);
    expect(extract({ reply_to_message: { caption: 'a photo', from: { first_name: 'Zz' } } })?.text).toBe('a photo');
    expect(extract({ reply_to_message: { text: 'x' } })).toMatchObject({ sender: 'Unknown', toBot: false });
  });
});
