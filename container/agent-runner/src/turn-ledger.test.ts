/**
 * Turn-scoped delivery ledger — the cross-door idempotency the two delivery
 * paths (send_message tool + final-text <message> dispatch) share to avoid
 * sending the same reply twice on a cold turn (e.g. first message after /clear).
 */
import { beforeEach, describe, expect, it } from 'bun:test';

import { alreadyDelivered, recordDelivery, resetTurnLedger } from './turn-ledger.js';

describe('turn-ledger', () => {
  beforeEach(() => resetTurnLedger());

  it('reports nothing delivered on a fresh turn', () => {
    expect(alreadyDelivered('wei-jie', 'hi')).toBeNull();
  });

  it('dedups the same (destination, text) after it is recorded — first seq wins', () => {
    recordDelivery('wei-jie', 'hi', 5);
    expect(alreadyDelivered('wei-jie', 'hi')).toBe(5);
    // Second door tries to record the same reply — first seq is kept.
    recordDelivery('wei-jie', 'hi', 7);
    expect(alreadyDelivered('wei-jie', 'hi')).toBe(5);
  });

  it('ignores trailing whitespace so a trimmed <message> body matches the tool text', () => {
    recordDelivery('wei-jie', 'hi', 5);
    expect(alreadyDelivered('wei-jie', '  hi\n')).toBe(5);
  });

  it('keys on destination — same text to a different destination is not a dup', () => {
    recordDelivery('wei-jie', 'hi', 5);
    expect(alreadyDelivered('the-group', 'hi')).toBeNull();
  });

  it('keys on text — different content to the same destination is not a dup', () => {
    recordDelivery('wei-jie', 'hi', 5);
    expect(alreadyDelivered('wei-jie', 'bye')).toBeNull();
  });

  it('destination and text cannot collide across the separator', () => {
    // "a" + "b|c" must not equal "a|b" + "c" for any separator choice.
    recordDelivery('a', 'b c', 1);
    expect(alreadyDelivered('a b', 'c')).toBeNull();
  });

  it('forgets the previous turn after a reset', () => {
    recordDelivery('wei-jie', 'hi', 5);
    resetTurnLedger();
    expect(alreadyDelivered('wei-jie', 'hi')).toBeNull();
  });
});
