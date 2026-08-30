/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Resolve @usernames to Telegram user ids and verify group membership, using a
 * logged-in USER account (MTProto) via teleproto (a maintained GramJS fork).
 *
 * Unlike a bot, a user account can resolve arbitrary public usernames with no
 * prior interaction from the target, which is what `/add-member` needs. Runs
 * in-process on the host; the string session is full account access and lives
 * only in a host-side file (data/telegram-userbot/), never in a container.
 *
 * teleproto is imported lazily so the MTProto stack is not loaded into every
 * host start — only when an admin actually runs the command. `any` at the
 * client boundary is deliberate: this is a thin wrapper, not worth threading
 * teleproto's deep entity types through.
 *
 * `UserbotNotConfigured` marks setup gaps (no creds, not logged in) so the
 * caller can tell an admin how to fix it, distinct from a normal per-user
 * "no such username" which comes back inside the results.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../config.js';
import { readEnvFile } from '../../env.js';

export type ResolveEntry = {
  username: string;
  userId: string | null; // "telegram:<numeric>" or null when unresolved
  inGroup: boolean;
  error: string | null;
};

export class UserbotNotConfigured extends Error {}

const SESSION_DIR = path.join(DATA_DIR, 'telegram-userbot');
export const SESSION_FILE = path.join(SESSION_DIR, 'session.txt');

function errMsg(e: unknown): string {
  const anyE = e as { errorMessage?: string; message?: string } | null;
  return String(anyE?.errorMessage ?? anyE?.message ?? e);
}

function config(): { apiId: number; apiHash: string; session: string } {
  const env = readEnvFile(['TELEGRAM_API_ID', 'TELEGRAM_API_HASH']);
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
    throw new UserbotNotConfigured('TELEGRAM_API_ID / TELEGRAM_API_HASH are not set in .env');
  }
  let session = '';
  try {
    session = fs.readFileSync(SESSION_FILE, 'utf8').trim();
  } catch {
    /* missing file — handled below */
  }
  if (!session) {
    throw new UserbotNotConfigured('Telegram userbot not logged in — run `pnpm exec tsx scripts/telegram-login.ts`');
  }
  return { apiId: Number(env.TELEGRAM_API_ID), apiHash: env.TELEGRAM_API_HASH, session };
}

/**
 * @param chatId numeric chat id as a string, e.g. "-1001234567890"
 * @param usernames handles without a leading '@'
 */
export async function resolveTelegramUsers(chatId: string, usernames: string[]): Promise<ResolveEntry[]> {
  if (usernames.length === 0) return [];
  const { apiId, apiHash, session } = config();

  const tp: any = await import('teleproto');
  const { TelegramClient, Api } = tp;
  const { StringSession } = tp.sessions;

  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 3 });
  await client.connect();
  try {
    if (!(await client.checkAuthorization())) {
      throw new UserbotNotConfigured('Telegram userbot session is invalid — re-run scripts/telegram-login.ts');
    }
    const chat = await resolveChat(client, chatId);
    const out: ResolveEntry[] = [];
    for (const username of usernames) {
      out.push(await resolveOne(client, Api, chat, username));
    }
    return out;
  } finally {
    await client.disconnect().catch(() => {});
    await client.destroy().catch(() => {});
  }
}

/** The bot-style marked id ("-100…") needs the group in the entity cache; the
 *  userbot is a member, so warming dialogs makes it resolve. */
async function resolveChat(client: any, chatId: string): Promise<any> {
  const marked = Number(chatId);
  try {
    return await client.getEntity(marked);
  } catch {
    await client.getDialogs({ limit: 200 });
    return await client.getEntity(marked);
  }
}

async function resolveOne(client: any, Api: any, chat: any, username: string): Promise<ResolveEntry> {
  let entity: any;
  try {
    entity = await client.getEntity(username);
  } catch {
    return { username, userId: null, inGroup: false, error: 'no such username' };
  }
  const id: string | undefined = entity?.id?.toString?.();
  if (!id) return { username, userId: null, inGroup: false, error: 'not a user account' };
  const userId = `telegram:${id}`;

  try {
    // invoke() resolves the entity-like fields to input types for us.
    await client.invoke(new Api.channels.GetParticipant({ channel: chat, participant: entity }));
    return { username, userId, inGroup: true, error: null };
  } catch (e) {
    const msg = errMsg(e);
    if (msg.includes('USER_NOT_PARTICIPANT')) return { username, userId, inGroup: false, error: null };
    // ponytail: GetParticipant is channel/supergroup only — the groups a bot
    // administers (especially forums) are supergroups. A legacy basic group
    // would need a getParticipants scan; add that if it ever comes up.
    return { username, userId, inGroup: false, error: `membership check failed: ${msg}` };
  }
}
