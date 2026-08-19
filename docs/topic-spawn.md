# Topic agents

A concierge agent wired to a chat's main conversation can open a new topic
next to it and put a *new agent* in that topic — one call, `spawn_topic_agent`.
The topic, the agent behind it, the wiring, and the access that lets the same
humans talk to it are all created host-side in one step.

Written for Telegram forum supergroups, which is where it is used today, but
nothing in the module is Telegram-specific: the one platform capability
required is `adapter.createThread(parentPlatformId, name)`.

Module: `src/modules/topic-spawn/`. Container tool:
`container/agent-runner/src/mcp-tools/topics.ts`.

## The problem

A Telegram supergroup with topics enabled looks like several conversations to
the humans in it and like exactly one conversation to NanoClaw.

The Telegram adapter declares `supportsThreads: false`, and the router hard-
strips `threadId` for non-threaded adapters (step 0 of `src/router.ts`). Even
before that, the Chat SDK's `channelIdFromThreadId` reduces
`telegram:<chatId>:<topicId>` to `telegram:<chatId>`. So every topic in the
supergroup resolves to the one chat-level messaging group, all of them share
one session and one agent, and replies come back addressed to the chat — which
Telegram renders in **General**. Ten topics, one agent, one context window, and
every answer in the wrong place.

Outbound was never the problem. The underlying `@chat-adapter/telegram` parses
a 3-part thread id and sends with `message_thread_id`, and the bridge's
`deliver()` uses `tid = threadId ?? platformId` — so a messaging group whose
`platform_id` is already `telegram:<chatId>:<topicId>` addresses its topic
correctly with no changes at all. Only inbound collapsed.

## The model: one topic = one messaging group

**A topic is a messaging group, not a thread id.**

This is the load-bearing decision, and it is forced by where wirings live.
A wiring (`messaging_group_agents`) attaches an agent group to a *messaging
group*. Threads sit one level below that: `sessions` keys on
`(agent_group_id, messaging_group_id, thread_id)`. So a thread can have its own
session, but it cannot have its own agent — the agent is chosen before the
thread id is consulted.

| Modeled as | Per topic you get | Per topic you don't get |
|------------|-------------------|-------------------------|
| Thread (`threads: 1` on the wiring) | its own session and context window | its own agent, instructions, memory, workspace, destinations |
| Messaging group (what we do) | its own wiring, agent group, session, memory, access list, destinations | — |

Turning threads on for Telegram would give per-topic *sessions* under a single
agent identity: one CLAUDE.md, one memory tree, one set of destinations, one
name. That is a different feature (and a change to a branch-owned adapter's
declared capability). Per-topic *agents* are only expressible as per-topic
messaging groups.

So each spawned topic gets a `messaging_groups` row with a 3-part
`platform_id` — `telegram:<chatId>:<topicId>` — on a channel that still
declares `supportsThreads: false`. Inbound is taught to route topic messages to
that row (`createForumTopicRewriter` in `src/channels/telegram-forum.ts` —
trunk-owned on purpose, because `src/channels/telegram.ts` is branch-owned and
is overwritten wholesale by `/add-telegram`). Three ids deliberately pass
through untouched:

- **General** — Telegram encodes it by *omitting* `message_thread_id`, so its
  thread id is 2-part and byte-identical to a plain group's. The concierge's
  existing chat-level wiring keeps working exactly as before.
- **a reply / discussion thread** — Telegram sets `message_thread_id` for two
  unrelated things, and `is_forum` is *chat*-level, so a forum supergroup that
  is also a channel's linked discussion group produces both shapes. The
  per-message `is_topic_message` flag is what separates them; the bridge
  projects it onto inbound content as `isSubConversation`
  (`detectSubConversation` in `chat-sdk-bridge.ts`) because raw is dropped
  before the host sees the message. Rewriting a reply chain would shatter one
  chat into a messaging group per comment thread.
- **anything in a non-forum chat** — when the per-message flag is absent (a
  stale adapter copy), the chat-level `is_forum` probe is the fallback, cached
  per chat and failing safe to "not a forum".

## The flow, end to end

A human posts in General: *"spin up something to track the Q3 migration —
first thing, summarize the runbook Dana posted."*

1. **Route.** General's thread id is 2-part, passes through the rewriter
   untouched, and lands in the concierge's session as normal.
2. **Tool call.** The concierge calls `spawn_topic_agent({ name, instructions,
   brief })`. `instructions` is the standing role; `brief` is this specific
   request. The tool writes a `kind: 'system'` row to `messages_out` and
   returns immediately — fire-and-forget.
3. **Pick-up.** The host's delivery poll (`src/delivery.ts`) sees the system
   row and dispatches the registered `spawn_topic_agent` delivery action.
4. **Guard.** `runGuarded` consults `topics.spawn`. Allow → step 5 now. Hold →
   an approval is DM'd to the admin chain and the flow parks; on approve the
   handler re-enters the wrapped action with the approval row as its grant and
   the checks re-run live. (See [Authorization](#authorization).)
5. **Preflight.** The session must be attached to a chat; the chat's adapter
   must be running and implement `createThread`; the chat must not itself
   already be a topic. Every refusal that can happen happens here, before
   anything is written, and is reported back to the concierge.
6. **Topic.** `createForumTopic` → `telegram:<chatId>:<topicId>`. From this
   point on every write is unconditional; nothing is rolled back.
7. **Agent group.** New `agent_groups` row, folder deduplicated against
   `agent_groups.folder`, filesystem scaffolded with `instructions` as
   `instructions.prepend.md` — prefixed with a channel-agnostic identity
   preamble (`TOPIC_AGENT_IDENTITY_PREAMBLE` in `spawn.ts`), always, even for a
   bare spawn with no `instructions`, so a topic agent never disowns a mention
   in its own topic (see [Limits and sharp edges](#limits-and-sharp-edges)). The
   child inherits its parent's *effective* provider, never the instance-wide
   default, so it is never spawned on a runtime this install can't reach.
8. **Messaging group.** The 3-part `platform_id` from step 6, `is_group: 1`,
   `instance` copied from the parent, `unknown_sender_policy` **inherited from
   the parent chat**.
9. **Wiring.** `engage_mode` / `engage_pattern` come from the channel's own
   **group-context declaration** via `resolveWiringDefaults`, the same
   resolution `ncl wirings create`, the setup wizard and the channel-approval
   connect path use — a spawned wiring is not a special case. On a mention
   channel (Telegram, Slack, Discord) that is `'mention'`, and the Chat SDK
   bridge promotes a **reply to the bot** to a mention too, so "@it or reply to
   it" engages while people talking to each other in the topic do not. A topic
   holds only one *agent*, but it is still a shared conversation between
   *humans*, which is why it is not wired always-on. Plus
   `ignored_message_policy: 'drop'`, `session_mode: 'shared'`, and
   `sender_scope` **inherited from the concierge's own wiring** (fallback
   `'known'`). The two gates are independent: on a `'public'` messaging group
   the access gate allows before it ever asks who the sender is, so the
   wiring's `sender_scope` is the only thing keeping non-members out. A spawn
   can only ever be as strict as the chat it came from, never looser.
10. **Access.** Every `agent_group_members` row of the concierge is copied onto
    the new agent group, `added_by` preserved. (See
    [Access inheritance](#access-inheritance).)
11. **Destinations.** Bidirectional `agent_destinations`: the concierge reaches
    the child by its name, the child reaches the concierge as `parent`. The
    new destination is projected into the concierge's running `inbound.db`
    via `writeDestinations` — skip that and the concierge's first
    `send_message` to its own child is dropped as *unknown destination*.
12. **Replay.** The `brief` is routed into the new topic with `routeInbound`,
    as the install owner's identity (see below), so the new agent's first turn
    already carries the request instead of starting cold. It is sent with
    `isMention: true` — **coupled to step 9**: under a mention-mode wiring a
    synthetic replay carries no platform mention signal, so without the flag
    the brief routes, is judged not-addressed, and the brand-new agent never
    wakes on the request it was spawned for.
13. **Report.** The concierge is notified: the destination name to use, and
    that anyone in the chat can now talk to the new agent in its topic.

Steps 10 and 11 are `hasTable`-guarded — the permissions and agent-to-agent
modules are optional, and the spawn still works (with less connectivity) when
either is absent.

## Authorization

The `spawn_topic_agent` MCP tool is registered in
`container/agent-runner/src/mcp-tools/` and is therefore visible to **every**
agent container. There is no per-group tool selection, and the container is
untrusted — the tool's own argument checks are trivially bypassed by writing
the outbound system row directly. **Authorization is host-side only.**

The decision lives in `src/modules/topic-spawn/guard.ts` and is `agents.create`'s
decision verbatim:

| Actor | Decision |
|-------|----------|
| Not an agent | **deny** — `spawn_topic_agent` is a container-originated action |
| Agent, `cli_scope: 'global'` | **allow** — trusted owner agent group; spawning a topic per task is the intended primitive for a concierge, and an approval tap on every spawn is needless friction |
| Agent, anything else (`group`, `disabled`, unknown or missing config) | **hold** — card the requesting group's admin chain |

The default is `group`, so by default every spawn is carded. The hold's payload
carries `name`, `instructions`, and `brief` — the brief travels on the approval
row because the approved replay re-reads that payload as its content, and
without it the new agent would wake cold. The grant is bound to the approved
`name`, so an approval for one topic cannot be replayed into another.

Approvals are visible with `ncl approvals list`; the delivered card explains
that the new agent will be reachable by everyone who can reach the concierge.

## Access inheritance

Access is per **agent group** — `canAccessAgentGroup` in
`src/modules/permissions/access.ts` resolves owner / global admin / scoped
admin / member against `user_roles` and `agent_group_members`. A brand-new
agent group has zero member rows.

**If you skip the member copy, the feature is broken for everyone except the
owner.** Owners, global admins, and scoped admins are implicit members and pass
unconditionally — which is exactly why this is easy to miss in testing, since
the person who built it is the owner. Every other human who could talk to the
concierge is refused on their first message in the new topic, and the drop is
recorded as `not_member` (or `unknown_user` for an identity with no `users`
row at all). The topic sits there looking alive and answers nobody.

Two things are inherited, for two different reasons:

- **`unknown_sender_policy`, copied from the parent chat.** A spawn must never
  widen — or narrow — who may talk to this install. The new topic is exactly as
  open or as closed as the chat it was spawned from.
- **`agent_group_members`, copied from the concierge**, with `added_by`
  preserved. The access these people have in the topic is the access they were
  granted on the concierge, attributed to whoever granted it.

The replayed brief (step 12) is sent as the **install owner's** user id, not as
the human who asked. The system row doesn't carry the original requester, and
the replay has to arrive as somebody who passes the gate for a group that has
existed for milliseconds; owners pass unconditionally and always exist as a
`users` row. Without the permissions module there is no gate at all and a
synthetic `system:topic-spawn` id is used.

## Operator recipes

**See the spawned topics.** A spawned topic is a messaging group whose
`platform_id` has three parts:

```bash
ncl messaging-groups list --channel-type telegram
ncl wirings list                       # which agent group each one is wired to
ncl groups list
```

**Read one end to end.**

```bash
ncl messaging-groups get <mg-id>
ncl members list --agent-group-id <ag-id>       # who inherited access
ncl destinations list --agent-group-id <ag-id>  # the "parent" link back
```

**Retire a topic agent.** Unwire it first; the agent group and the Telegram
topic both survive.

```bash
ncl wirings delete <wiring-id>     # topic goes quiet; agent group untouched
ncl groups delete <ag-id>          # remove the agent group itself
ncl messaging-groups delete <mg-id>  # forget the topic
```

**What happens to the Telegram topic.** Nothing. NanoClaw never deletes a
topic it created — deleting the agent group, the wiring, or the messaging group
leaves the topic in the chat, now unanswered. Delete or close it in Telegram
yourself if you want it gone.

**The reverse is also true.** Deleting or closing the topic in Telegram does
not delete the agent group, the messaging group, or the wiring. They stay in
the central DB, addressing a conversation that no longer exists; the agent
never wakes and any outbound to it fails at the adapter. Clean it up with the
commands above.

**Re-open a spawn by hand.** Nothing about a spawned topic is special — it is
an ordinary messaging group. You can wire a different agent to it, change its
engage mode, or add members exactly as you would for any chat.

## Limits and sharp edges

- **Existing forum chats change behavior on upgrade, feature unused.** The
  inbound rewrite is not opt-in: it applies to every message Telegram marks
  `is_topic_message`. If you already had such a chat wired at chat
  level, messages posted in its non-General topics used to route to that
  chat-level wiring (and the reply landed back in General, which is the bug
  this fixes). After the upgrade those messages address a 3-part
  `platform_id` with no `messaging_groups` row: an @mention auto-creates the
  row and escalates to the owner as a channel-registration request, and
  anything unaddressed is dropped. The agent goes quiet in those topics until
  each one is approved or wired. General is unaffected. To restore the old
  behavior for one topic, wire it like any other chat:
  `ncl wirings create --messaging-group-id <mg> --agent-group-id <ag>` (the
  auto-created row is listed by `ncl messaging-groups list --channel-type
  telegram` with a `telegram:<chatId>:<topicId>` platform id).
- **A topic inherits its chat's decisions at auto-create.** Because a topic is
  addressed by extending its chat's `platform_id`, an unwired topic reaches the
  router as an unknown id. `findParentMessagingGroup` (`src/db/messaging-groups.ts`)
  resolves the chat it hangs off, and the router refuses to auto-create a row
  under a chat the owner has **denied** (otherwise anyone with topic-creation
  rights in a rejected chat could mint an unlimited stream of
  channel-registration cards in the owner's DM) and copies the chat's
  `unknown_sender_policy` onto the new row instead of using the channel-wide
  default.
- **The tool is visible to every agent container.** Visibility is not the
  authorization boundary; the guard is. Any agent group can *emit* a
  `spawn_topic_agent` request, and a confined one gets carded rather than
  refused outright — so admins on a busy install will see approval cards from
  agent groups they never thought of as concierges. Set `cli_scope: 'disabled'`
  if you want a group to stop trying; the host still refuses it.
- **One level only.** Spawning from inside a spawned topic is refused. There is
  no parent/child column on `messaging_groups` to read, so this is detected
  advisorily: a registered sibling row whose `platform_id` is a proper prefix
  of ours at a delimiter boundary means we are already somebody's child. A
  platform whose sub-ids aren't derived from the parent's id reads as a root,
  and the adapter's own `createThread` is the backstop — Telegram refuses to
  nest topics.
- **Adapters without `createThread` refuse cleanly.** Feature detection
  (`typeof adapter.createThread === 'function'`), not the type, is the
  contract: `createThread` is optional on `ChannelAdapter` and absent from
  stale skill-installed adapter copies. The concierge is told which channel
  can't do it and to ask an admin instead. `/add-telegram` from the `channels`
  branch is what brings the Telegram implementation in — an old installed copy
  simply won't have it.
- **Instance-exact resolution.** The adapter is resolved by
  `instance ?? channel_type` with no fallback to the channel type, for the same
  reason outbound delivery does it: a sibling instance of the same platform is
  a different bot identity with a different token, and it would create the
  topic in the wrong place or not at all.
- **Nothing is rolled back.** Every check that can refuse runs before
  `createThread`; after that, all writes are unconditional. The one soft
  failure is the brief replay — if it fails, the topic and its agent exist and
  are wired, the concierge is told the opening brief didn't land, and the next
  human message wakes the agent normally.
- **A deleted topic leaves an orphan.** See the recipe above. There is no
  reconciliation sweep.
- **Spawning is permanent and unmetered.** Every call leaves a topic in a
  shared chat and an agent group with its own container behind it, and nothing
  garbage-collects either. The container-side guidance
  (`mcp-tools/topics.instructions.md`) tells the agent to confirm with the user
  before spawning unless the request is unambiguous, but that is guidance, not
  a limit.
- **One bot fronts every topic agent, so identity is ambiguous by default.**
  There is one platform bot per instance; inside a spawned topic that same bot
  *is* the child, but its handle is whatever the install named it — usually
  after the concierge that spawned it. The engage model makes this unavoidable:
  a topic agent is `'mention'`-wired (step 9), so the only way to reach it is to
  @mention that shared handle or reply to the bot — the very handle the child
  may read as belonging to the concierge, concluding the message is not for it
  and staying silent in its own topic. Routing is fine (the mention engages the
  child correctly); *identity* is what fails. `TOPIC_AGENT_IDENTITY_PREAMBLE`
  (step 7) is the mitigation — it tells the child that in its own topic the
  shared bot is it, so a mention there is addressed to it whatever the handle is
  named after. It is a persona clause, not an enforced rule: if that proves too
  soft, the adapter-level precedent is the shared-identity pattern in
  [setup-wiring.md](setup-wiring.md) (WhatsApp shared-number mode).
