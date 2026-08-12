/**
 * Edit / delete operations in the Chat SDK bridge.
 *
 * These two ops are what a caller needs to own a message over time: post it,
 * edit it on a cadence, delete it when it stops being useful (the Telegram
 * progress indicator is the first consumer). Both go through the same
 * `deliver()` dispatch as everything else, so the contract they pin is the
 * returned platform message id — without it there is nothing to target on the
 * next pass.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

import { createChatSdkBridge } from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface EditCall {
  threadId: string;
  messageId: string;
  message: AdapterPostableMessage;
}

interface DeleteCall {
  threadId: string;
  messageId: string;
}

function makeEditCapture(id = 'telegram:42:1001') {
  const calls: EditCall[] = [];
  const editMessage = async (
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<unknown>> => {
    calls.push({ threadId, messageId, message });
    return { id, threadId, raw: {} };
  };
  return { calls, editMessage };
}

function makeDeleteCapture() {
  const calls: DeleteCall[] = [];
  const deleteMessage = async (threadId: string, messageId: string): Promise<void> => {
    calls.push({ threadId, messageId });
  };
  return { calls, deleteMessage };
}

describe('createChatSdkBridge.deliver — edit returns the platform message id', () => {
  it('returns the edited message id on the plain markdown path', async () => {
    const { calls, editMessage } = makeEditCapture();
    const bridge = createChatSdkBridge({ adapter: stubAdapter({ editMessage }), supportsThreads: false });

    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { operation: 'edit', messageId: 'telegram:42:1001', text: '⏱ 12s' },
    });

    expect(id).toBe('telegram:42:1001');
    expect(calls).toEqual([{ threadId: 'telegram:42', messageId: 'telegram:42:1001', message: { markdown: '⏱ 12s' } }]);
  });

  it('returns the edited message id on the terminal-card path too (approval cards keep their shape)', async () => {
    const { calls, editMessage } = makeEditCapture('slack:C1:9');
    const bridge = createChatSdkBridge({ adapter: stubAdapter({ editMessage }), supportsThreads: false });

    const id = await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: 'msg-1',
        text: 'Credentials Request\n\nbody\n\n⏱️ Timed out',
        terminalCard: { title: 'Credentials Request', question: 'body', resolution: '⏱️ Timed out' },
      },
    });

    expect(id).toBe('slack:C1:9');
    // Card path untouched: still a Card with the muted resolution, no actions row.
    const edited = calls[0].message as {
      card: { title: string; children: Array<{ type: string; content?: string; style?: string }> };
    };
    expect(edited.card.title).toBe('Credentials Request');
    expect(edited.card.children).toEqual([
      { type: 'text', content: 'body' },
      { type: 'text', content: '⏱️ Timed out', style: 'muted' },
    ]);
  });

  it('applies the outbound text transform before editing (parse-mode sanitizers still run)', async () => {
    const { calls, editMessage } = makeEditCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ editMessage }),
      supportsThreads: false,
      transformOutboundText: (t) => t.replace(/_/g, '-'),
    });

    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { operation: 'edit', messageId: 'telegram:42:1001', markdown: 'a_b_c' },
    });

    expect((calls[0].message as { markdown: string }).markdown).toBe('a-b-c');
  });

  it('tolerates an adapter whose editMessage resolves to nothing', async () => {
    // Several installed adapters return void from editMessage despite the SDK
    // type; the bridge must yield undefined rather than throw on `.id`.
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ editMessage: (async () => undefined) as unknown as Adapter['editMessage'] }),
      supportsThreads: false,
    });

    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { operation: 'edit', messageId: 'telegram:42:1001', text: 'hi' },
    });

    expect(id).toBeUndefined();
  });
});

describe('createChatSdkBridge.deliver — delete', () => {
  it('calls adapter.deleteMessage with the resolved thread id and message id', async () => {
    const { calls, deleteMessage } = makeDeleteCapture();
    const bridge = createChatSdkBridge({ adapter: stubAdapter({ deleteMessage }), supportsThreads: false });

    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { operation: 'delete', messageId: 'telegram:42:1001' },
    });

    // Delete has no resulting message, so there is nothing to return.
    expect(id).toBeUndefined();
    expect(calls).toEqual([{ threadId: 'telegram:42', messageId: 'telegram:42:1001' }]);
  });

  it('prefers an explicit threadId over the platform id (Telegram rejects a mismatched chat)', async () => {
    // @chat-adapter/telegram throws ValidationError when the chat id inside the
    // composite message id does not match the thread it is asked to act on, so
    // the thread the caller names must win over the group's platform id.
    const { calls, deleteMessage } = makeDeleteCapture();
    const bridge = createChatSdkBridge({ adapter: stubAdapter({ deleteMessage }), supportsThreads: true });

    await bridge.deliver('telegram:42', 'telegram:42:77', {
      kind: 'chat-sdk',
      content: { operation: 'delete', messageId: 'telegram:42:1001' },
    });

    expect(calls[0].threadId).toBe('telegram:42:77');
  });

  it('degrades to a no-op when the adapter cannot delete, instead of throwing into delivery', async () => {
    const { calls, postMessage } = (() => {
      const posts: string[] = [];
      return {
        calls: posts,
        postMessage: async (threadId: string) => {
          posts.push(threadId);
          return { id: 'msg-stub', threadId, raw: {} };
        },
      };
    })();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage: postMessage as unknown as Adapter['postMessage'] }),
      supportsThreads: false,
    });

    const id = await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: { operation: 'delete', messageId: 'msg-1' },
    });

    expect(id).toBeUndefined();
    // Crucially it must NOT fall through to the normal-message path and post
    // anything: an unsupported delete is silence, not a stray chat message.
    expect(calls).toHaveLength(0);
  });

  it('ignores a delete with no messageId rather than deleting something arbitrary', async () => {
    const { calls, deleteMessage } = makeDeleteCapture();
    const bridge = createChatSdkBridge({ adapter: stubAdapter({ deleteMessage }), supportsThreads: false });

    await bridge.deliver('telegram:42', null, { kind: 'chat-sdk', content: { operation: 'delete' } });

    expect(calls).toHaveLength(0);
  });
});
