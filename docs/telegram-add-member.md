# `/add-member` — Telegram group membership grant

A host-side command that lets an **owner or global admin**, from inside a Telegram
group the bot administers, grant one or more Telegram accounts membership of
**every agent wired to that chat** — so the added users can talk to all of the
group's agents. Targets do **not** need to have messaged the bot or the group
first: their `@usernames` are resolved directly via a logged-in Telegram *user*
account (MTProto).

Runs entirely on the host as a router message-interceptor. It never reaches a
container: the container agent cannot resolve usernames, check the caller's role,
or write membership across sibling agent groups, so the whole command is owned
by the host.

## User journey

| # | Caller | Argument | Result |
|---|--------|----------|--------|
| 1 | member (no role) | any `@mention` | **FAIL** — `Permission denied` |
| 2 | owner / global admin | `@mention` of an account **not in** the TG group | **SKIPPED** — reported as not in this group |
| 3 | owner / global admin | list of `@mentions` (comma, space, newline, or `@a@b`) all in the group | **SUCCESS** — each added to all wired agents |
| 4 | owner / global admin | a lone `@mention` in the group | **SUCCESS** |

SUCCESS ⇒ the added user(s) become members (`agent_group_members`) of every
agent group wired to the chat, chat-level **and** every forum topic under it.

Example replies:

```
✅ Added @alice as a member. They can now talk to all 9 agents in this group.
⚠️ Couldn't add @carol (not in this group).
```

## Why a userbot, not the bot

The Telegram **Bot API cannot** map `@username → numeric id` or list members
(privacy restriction). A logged-in **user account** over MTProto can resolve any
public username with no prior interaction from the target, which is exactly what
scenarios 3 and 4 require. We use [`teleproto`](https://github.com/sanyok12345/teleproto)
(a maintained GramJS fork) in-process on the host.

The user account only needs to be a **member of the same group** it resolves
against; membership is checked with `channels.GetParticipant`.

## Setup

1. Get an `api_id` / `api_hash` from <https://my.telegram.org> → API development tools.
2. Put them in `.env`:

   ```
   TELEGRAM_API_ID=1234567
   TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
   ```

   These are **not** OneCLI-managed: OneCLI injects HTTP credentials, and MTProto
   is not HTTP. They live in `.env` like any other host config.

3. Log in once, in a real terminal (needs a tty for the code prompt):

   ```bash
   pnpm exec tsx scripts/telegram-login.ts
   ```

   It writes a string session to `data/telegram-userbot/session.txt` (chmod 600,
   under the gitignored `data/` dir, never mounted into a container). The session
   is **full account access** — treat it like a password.

4. Build + restart the host (the service runs compiled `dist/`, not `src/`):

   ```bash
   pnpm run build && systemctl --user restart nanoclaw-v2-<slug>
   ```

If step 2 or 3 is missing, the command replies with a `Cannot resolve usernames:`
message naming the gap rather than crashing.

## How it works

1. **Interceptor** (`add-member.ts` → `handleAddMember`) is registered as a router
   `MessageInterceptor` at import time. It runs before normal routing and returns
   `true` (consume) once it recognises the command, `false` otherwise.
2. **Command match** is un-anchored: `/(?:^|\s)\/add-member(?:@\S+)?(?=\s|$)/i`.
   Mention-engaged groups deliver `@TheBot /add-member @alice`, so the command is
   not at the start; the optional `@BotName` suffix (`/add-member@MyBot`) is also
   tolerated and is **not** treated as a target. Targets are parsed only from the
   text *after* the command token.
3. **Gate**: caller id is read from the inbound payload and must satisfy
   `isOwner || isGlobalAdmin`. Group + Telegram only.
4. **Resolve** (`resolve.ts` → `resolveTelegramUsers`) maps each `@username` to
   `telegram:<id>` and checks group membership. `teleproto` is imported lazily so
   the MTProto stack only loads when an admin actually runs the command.
5. **Grant**: for each resolved, in-group user, the module upserts the `users` row
   and adds `agent_group_members` for every agent group wired to the chat
   (`agentGroupsWiredToChat` — a `DISTINCT` over chat-level `telegram:<chat>` and
   topic `telegram:<chat>:%` messaging groups).

## Files

| File | Purpose |
|------|---------|
| `src/modules/telegram-members/add-member.ts` | The interceptor: match, gate, resolve, grant, reply |
| `src/modules/telegram-members/resolve.ts` | teleproto userbot: `@username → id` + membership; `UserbotNotConfigured` |
| `src/modules/telegram-members/index.ts` | Registers the interceptor (imported from `src/modules/index.ts`) |
| `src/modules/telegram-members/add-member.test.ts` | Covers all 4 scenarios + bot-mention/suffix + wiring guard |
| `scripts/telegram-login.ts` | One-time interactive login → `data/telegram-userbot/session.txt` |

## Gotchas

- **Host rebuild required.** The service runs `dist/index.js`. A `src/` edit does
  nothing until `pnpm run build` + service restart.
- **Supergroups only.** `channels.GetParticipant` is channel/supergroup-only. Any
  group a bot administers (especially forums) is a supergroup, so this is fine in
  practice; a legacy *basic* group would need a `getParticipants` scan (not
  implemented).
- **Session is a secret.** `data/telegram-userbot/session.txt` grants full account
  access. It is host-only and never enters a container.
- **This is an install-local customization**, not upstream trunk. It depends on a
  Telegram adapter being installed (`/add-telegram`).
