/**
 * Reply-to-bot → isMention promotion in the Chat SDK bridge.
 *
 * Drives the bridge's real onNewMessage handler through real Chat SDK dispatch
 * (`chat.processMessage`): `bridge.setup()` registers the handlers on a real
 * Chat instance, which the test captures from the webhook-server registration
 * (mocked so no HTTP server binds a port). A plain group message that replies
 * to the bot carries no platform mention entity, so the SDK hands it to
 * onNewMessage with isMention false — the bridge must still emit
 * `isMention: true` on the InboundMessage so the router's engage_mode
 * 'mention' fires (src/router.ts evaluateEngage).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Message, type Adapter, type Chat } from 'chat';

const captured = vi.hoisted(() => ({ chat: null as unknown }));

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn((chat: unknown) => {
    captured.chat = chat;
  }),
}));

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import type { ChannelSetup, InboundMessage } from './adapter.js';
import { createChatSdkBridge, resolveInboundMention, type ReplyContext } from './chat-sdk-bridge.js';

function makeAdapter(): Adapter {
  return {
    name: 'stub',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => `stub:${threadId}`,
  } as unknown as Adapter;
}

function makeMessage(raw: Record<string, unknown>, text = 'and what about tuesday?'): Message {
  return new Message({
    attachments: [],
    author: { userId: 'U-weijie', userName: 'weijie', fullName: 'Wei Jie' } as never,
    formatted: { type: 'root', children: [] } as never,
    id: 'msg-1',
    metadata: { dateSent: new Date('2026-08-12T09:00:00Z') } as never,
    raw,
    text,
    threadId: 'T-1',
  });
}

/**
 * Dispatch one plain (unsubscribed, unmentioned) group message and return the
 * InboundMessage the bridge forwarded to the host.
 */
async function dispatchPlainMessage(extractReplyContext?: (raw: Record<string, never>) => ReplyContext | null) {
  const inbound: InboundMessage[] = [];
  const adapter = makeAdapter();
  const bridge = createChatSdkBridge({
    adapter,
    supportsThreads: false,
    extractReplyContext: extractReplyContext as never,
  });

  await bridge.setup({
    onInbound: async (_platformId: string, _threadId: string, message: InboundMessage) => {
      inbound.push(message);
    },
    onInboundEvent: async () => {},
    onMetadata: () => {},
    onAction: () => {},
  } as unknown as ChannelSetup);

  const chat = captured.chat as Chat;
  expect(chat).toBeTruthy();
  await chat.processMessage(adapter, 'T-1', makeMessage({ reply_to_message: { text: 'tuesday works', from: {} } }));
  await bridge.teardown();
  return inbound;
}

beforeEach(() => {
  captured.chat = null;
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
});

describe('resolveInboundMention', () => {
  it('promotes a reply aimed at the bot', () => {
    expect(resolveInboundMention(false, { text: 't', sender: 'Bot', toBot: true })).toBe(true);
  });

  it('leaves a reply aimed at anyone else alone', () => {
    expect(resolveInboundMention(false, { text: 't', sender: 'Wei Jie', toBot: false })).toBe(false);
  });

  it('is inert for platforms whose extractor does not set toBot', () => {
    expect(resolveInboundMention(false, { text: 't', sender: 'Wei Jie' })).toBe(false);
    expect(resolveInboundMention(false, null)).toBe(false);
    expect(resolveInboundMention(false, undefined)).toBe(false);
  });

  it('never demotes an actual @mention', () => {
    expect(resolveInboundMention(true, { text: 't', sender: 'Wei Jie', toBot: false })).toBe(true);
    expect(resolveInboundMention(true, null)).toBe(true);
  });
});

describe('chat-sdk-bridge reply-to-bot dispatch', () => {
  it('emits isMention on a plain group message that replies to the bot', async () => {
    const inbound = await dispatchPlainMessage(() => ({ text: 'tuesday works', sender: 'NanoClaw', toBot: true }));

    expect(inbound).toHaveLength(1);
    expect(inbound[0].isMention).toBe(true);
    // The quoted context still reaches the container formatter unchanged.
    expect((inbound[0].content as { replyTo?: ReplyContext }).replyTo).toMatchObject({
      text: 'tuesday works',
      sender: 'NanoClaw',
    });
  });

  it('leaves a reply to another user unengaged', async () => {
    const inbound = await dispatchPlainMessage(() => ({ text: 'tuesday works', sender: 'Zz', toBot: false }));

    expect(inbound).toHaveLength(1);
    expect(inbound[0].isMention).toBe(false);
  });

  it('leaves channels without a reply extractor unchanged', async () => {
    const inbound = await dispatchPlainMessage(undefined);

    expect(inbound).toHaveLength(1);
    expect(inbound[0].isMention).toBe(false);
  });
});
