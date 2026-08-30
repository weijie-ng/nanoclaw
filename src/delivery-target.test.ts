/**
 * Resolving an operation's target message id at delivery time.
 *
 * The case that matters: an agent sends a file and pins it in the same turn.
 * The pin's target is an internal `msg-*` id, because the platform id does not
 * exist until the host delivers the file — which it does, in the same ordered
 * drain, just before it gets to the pin.
 */
import { describe, expect, it } from 'vitest';

import { resolveTargetMessageId } from './delivery.js';

describe('resolveTargetMessageId', () => {
  it('rewrites an internal id to the platform id it was delivered as', () => {
    const content: Record<string, unknown> = { operation: 'pin', messageId: 'msg-abc', unpin: false };

    resolveTargetMessageId(content, () => '1001');

    expect(content.messageId).toBe('1001');
  });

  it('leaves an already-platform id alone', () => {
    const content: Record<string, unknown> = { operation: 'edit', messageId: '1001' };

    resolveTargetMessageId(content, () => {
      throw new Error('lookup should not run');
    });

    expect(content.messageId).toBe('1001');
  });

  it('ignores content with no target at all', () => {
    const content: Record<string, unknown> = { text: 'hello' };

    expect(() => resolveTargetMessageId(content, () => null)).not.toThrow();
  });

  it('throws when the target has no platform id — undelivered or delivery failed', () => {
    const content: Record<string, unknown> = { operation: 'pin', messageId: 'msg-abc' };

    expect(() => resolveTargetMessageId(content, () => null)).toThrow('never delivered');
  });
});
