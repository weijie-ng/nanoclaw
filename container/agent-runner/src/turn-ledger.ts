/**
 * Per-turn delivery ledger — makes the two delivery doors idempotent.
 *
 * The runner can deliver a user-facing reply two ways: the `send_message` MCP
 * tool (mid-turn, explicit) and `dispatchResultText`'s `<message to="…">` blocks
 * in the agent's final result text (the fallback door for prose-only answers).
 * On a cold turn — e.g. the first message after `/clear` resets the SDK
 * continuation — the agent sometimes uses BOTH for the same reply, so it goes
 * out twice (see the double-send class).
 *
 * Both doors record here, keyed on (destination name, text). A door skips a
 * (destination, text) already delivered THIS turn, so the same reply lands once
 * no matter which/how many doors the agent used — while genuinely different
 * content through either door still flows. Turn-scoped: no wall-clock window, no
 * cross-turn false positives. Reset by processQuery at the start of every turn.
 */
const delivered = new Map<string, number>(); // key -> seq of the first delivery this turn

// JSON-encoded tuple: unambiguous (no separator a name or message body could
// forge) and plain text (a NUL separator would make git treat this as binary).
function key(destination: string, text: string): string {
  return JSON.stringify([destination, text.trim()]);
}

/** Start of a new user turn — forget the previous turn's deliveries. */
export function resetTurnLedger(): void {
  delivered.clear();
}

/**
 * seq this (destination, text) was already delivered as this turn, or null.
 * A non-null result means the caller should NOT send again.
 */
export function alreadyDelivered(destination: string, text: string): number | null {
  const seq = delivered.get(key(destination, text));
  return seq ?? null;
}

/** Record a delivery's seq for (destination, text). First writer wins. */
export function recordDelivery(destination: string, text: string, seq: number): void {
  const k = key(destination, text);
  if (!delivered.has(k)) delivered.set(k, seq);
}
