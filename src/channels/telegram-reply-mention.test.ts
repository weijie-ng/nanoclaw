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

import { createReplyContextExtractor } from './telegram.js';

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
    expect(extract(replyFrom({ username: 'weijie', first_name: 'Wei Jie' }))?.toBot).toBe(false);
  });

  it('falls back to is_bot before getMe resolves (over-match beats silent no-op)', () => {
    const extract = createReplyContextExtractor(UNRESOLVED);
    expect(extract(replyFrom({ username: 'SomeOtherBot', is_bot: true }))?.toBot).toBe(true);
    expect(extract(replyFrom({ username: 'weijie', first_name: 'Wei Jie' }))?.toBot).toBe(false);
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
    const ctx = extract(replyFrom({ first_name: 'Wei Jie', username: 'weijie' }, 'are you coming tonight?'));
    expect(ctx).toMatchObject({ text: 'are you coming tonight?', sender: 'Wei Jie' });
  });

  it('reads caption for media replies, and tolerates a missing from', () => {
    const extract = createReplyContextExtractor(KNOWN);
    expect(extract({ reply_to_message: { caption: 'a photo', from: { first_name: 'Zz' } } })?.text).toBe('a photo');
    expect(extract({ reply_to_message: { text: 'x' } })).toMatchObject({ sender: 'Unknown', toBot: false });
  });
});
