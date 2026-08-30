/**
 * One-time login for the Telegram userbot behind `/add-member`.
 *
 *   pnpm exec tsx scripts/telegram-login.ts
 *
 * Reads TELEGRAM_API_ID / TELEGRAM_API_HASH from .env, prompts for your phone
 * number and the login code Telegram sends (and a two-step password if set),
 * and writes the string session to data/telegram-userbot/session.txt.
 *
 * That session file is FULL ACCESS to the account — it is chmod 600 under the
 * gitignored data/ dir and never enters a container. Run this in a real
 * terminal (it needs a tty for the prompts). The account must be a member of
 * any group you later resolve against.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { DATA_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';

const SESSION_DIR = path.join(DATA_DIR, 'telegram-userbot');
const SESSION_FILE = path.join(SESSION_DIR, 'session.txt');

async function main(): Promise<void> {
  const env = readEnvFile(['TELEGRAM_API_ID', 'TELEGRAM_API_HASH']);
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
    console.error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first.');
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tp: any = await import('teleproto');
  const { TelegramClient } = tp;
  const { StringSession } = tp.sessions;

  const existing = fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, 'utf8').trim() : '';
  const client = new TelegramClient(new StringSession(existing), Number(env.TELEGRAM_API_ID), env.TELEGRAM_API_HASH, {
    connectionRetries: 3,
  });

  const rl = readline.createInterface({ input, output });
  const ask = (q: string) => rl.question(q);
  await client.start({
    phoneNumber: async () => (await ask('Phone number (e.g. +15551234567): ')).trim(),
    phoneCode: async () => (await ask('Login code Telegram sent you: ')).trim(),
    password: async () => (await ask('Two-step password (blank if none): ')).trim(),
    onError: (e: unknown) => console.error('login error:', e),
  });
  rl.close();

  const me = await client.getMe();
  const handle = me?.username ? `@${me.username}` : String(me?.id);

  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.chmodSync(SESSION_DIR, 0o700);
  fs.writeFileSync(SESSION_FILE, String(client.session.save()), { mode: 0o600 });

  console.log(`Logged in as ${handle}. Session saved to ${SESSION_FILE}`);
  await client.disconnect();
  await client.destroy();
  process.exit(0);
}

main();
