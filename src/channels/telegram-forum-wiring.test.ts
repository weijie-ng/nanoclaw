/**
 * Wiring guard for forum support.
 *
 * `src/channels/telegram.ts` is BRANCH-OWNED: `/add-telegram` and
 * `/update-skills` overwrite it wholesale from the `channels` branch, which
 * knows nothing about `telegram-forum.ts` or `telegram-reply.ts`. All of the
 * forum logic lives in those trunk-owned modules and survives a re-apply — but
 * the handful of lines in telegram.ts that *activate* them do not.
 *
 * Losing that wiring is silent. The channel still registers, still delivers,
 * and simply stops routing topics: every topic in a forum supergroup collapses
 * back onto the one chat-level messaging group, replies land in General, and
 * `spawn_topic_agent` loses the `createThread` capability it requires. Nothing
 * throws, so nothing else goes red.
 *
 * This test is the alarm. It asserts the seam, not the modules — the routing,
 * typing-qualification, and reply-mention behaviour each have their own tests
 * (telegram-forum-routing, telegram-forum-typing, telegram-reply-mention).
 * Here we invoke the registered factory and check that the bridge config was
 * handed each trunk-owned hook, and that the adapter exposes createThread.
 *
 * Not covered: the `createForumTopicRewriter` wrap around `onInbound`, which
 * happens inside `setup()` and needs a live is_forum probe to exercise. If a
 * re-apply strips only that wrap, the three hooks below still pass. Inbound
 * topic routing has its own coverage in telegram-forum-routing.test.ts.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';

const captured = vi.hoisted(() => ({
  registration: null as { factory: () => unknown } | null,
  bridgeConfig: null as Record<string, unknown> | null,
}));

// Capture the registration instead of driving the real registry: the factory
// is what we need, and initChannelAdapters would start every other channel.
vi.mock('./channel-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./channel-registry.js')>()),
  registerChannelAdapter: (_name: string, registration: { factory: () => unknown }) => {
    captured.registration = registration;
  },
}));

// The bridge is the sink every hook is handed to, so mocking it is how we read
// what telegram.ts wired without standing up a Chat SDK adapter.
vi.mock('./chat-sdk-bridge.js', () => ({
  createChatSdkBridge: (config: Record<string, unknown>) => {
    captured.bridgeConfig = config;
    return { channelType: 'telegram' };
  },
}));

vi.mock('@chat-adapter/telegram', () => ({ createTelegramAdapter: () => ({}) }));

vi.mock('../env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../env.js')>()),
  readEnvFile: () => ({ TELEGRAM_BOT_TOKEN: 'test-token' }),
}));

let adapter: Record<string, unknown>;

beforeAll(async () => {
  // getMe fires at factory time and is not what we are testing.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: { username: 'testbot' } }) })),
  );
  await import('./telegram.js'); // top-level registerChannelAdapter runs here
  adapter = captured.registration!.factory() as Record<string, unknown>;
});

describe('telegram forum wiring', () => {
  it('registers a factory that builds an adapter', () => {
    expect(captured.registration?.factory).toBeTypeOf('function');
    expect(adapter).toBeTruthy();
  });

  it('hands the bridge the trunk-owned reply extractor', () => {
    const extract = captured.bridgeConfig?.extractReplyContext as (
      raw: Record<string, unknown>,
    ) => { toBot?: boolean } | null;
    expect(extract).toBeTypeOf('function');
    // The branch version wires an extractor of its own, so presence proves
    // nothing. `toBot` is the fork's addition — it is what promotes a plain
    // reply to the bot into a mention, and upstream's extractor has no such
    // field. Assert the behaviour, matched against the getMe username stubbed
    // above rather than is_bot, so the username path is what is exercised.
    expect(extract({ reply_to_message: { from: { username: 'TestBot', is_bot: true }, text: 'hi' } })?.toBot).toBe(
      true,
    );
    expect(extract({ reply_to_message: { from: { username: 'someone_else' }, text: 'hi' } })?.toBot).toBe(false);
  });

  it('hands the bridge the per-message topic detector', () => {
    const detect = captured.bridgeConfig?.detectSubConversation as (raw: Record<string, unknown>) => boolean;
    expect(detect).toBeTypeOf('function');
    // Behavioural, so a stub wired in its place still fails: only
    // is_topic_message separates a real topic from a reply thread.
    expect(detect({ is_topic_message: true, message_thread_id: 42 })).toBe(true);
    expect(detect({ message_thread_id: 42 })).toBe(false);
  });

  it('hands the bridge the forum typing-thread resolver', () => {
    expect(captured.bridgeConfig?.resolveTypingThreadId).toBeTypeOf('function');
  });

  it('exposes createThread — the capability spawn_topic_agent requires', () => {
    expect(adapter.createThread).toBeTypeOf('function');
  });
});
