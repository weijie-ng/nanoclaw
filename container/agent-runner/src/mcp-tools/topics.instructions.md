## Topic agents (`spawn_topic_agent`)

`mcp__nanoclaw__spawn_topic_agent({ name, instructions, brief })` creates a new topic in **this** chat and a dedicated agent that lives in it. Available where the chat supports topics (a Telegram supergroup with topics enabled) — elsewhere the host refuses the call and tells you so.

### How it works

- A real topic appears in this chat titled `name`, and a new agent group is created and wired to it. `name` is also your destination for that agent: `send_message({ to: "<name>", ... })`.
- Inside its own topic the new agent answers **everything** — no `@mention`, no trigger word. That is the point: the topic is its conversation, not a shared room it has to be summoned into.
- `instructions` becomes its `instructions.prepend.md` (standing role); `brief` is replayed into the topic as its first message, so it wakes up already knowing what was asked.
- It gets its own container, workspace, and memory — a full standalone agent that accumulates context, not a one-shot query.
- The humans who can talk to you here can talk to it there; destinations are wired both ways, so it can report back to you and you can send it work later.
- **Fire-and-forget:** the call returns immediately. If your agent group isn't a trusted one, the request sits pending admin approval first, and the topic only appears once an admin approves.

### When to spawn

Someone asks for an **ongoing helper for a specific area** — work that will keep producing messages after today:

- "Can we get a channel for the Q3 migration?" → a topic agent that tracks that migration.
- "I want somewhere to dump papers on retrieval and have something keep up with them." → a research-thread agent.
- "Watch the deploy pipeline and tell me when it breaks." → a recurring-job agent that owns that beat.
- A project, client, or investigation that deserves its own place and its own memory.

The test: would this conversation still be running in a week, and would it be noise in the main chat until then?

### When NOT to spawn

- **One-off questions.** Just answer them here.
- **Anything you can finish in this chat**, now or in the next few turns.
- **Anything that completes before the user's next message.** Use the SDK `Agent` tool for stateless side-work, or `create_agent` for a companion agent that doesn't need a topic of its own.

Spawning is not free: every call leaves a permanent topic in a shared chat and a permanent agent behind it. Nobody cleans these up for you. **Confirm with the user before spawning** unless the request is unambiguous ("make a topic for X" is unambiguous; "I've got a lot going on with X" is not) — propose the name and the role, and spawn once they say yes.

### `instructions` vs `brief` — not the same thing

This is the distinction that is easiest to collapse. Send both, and keep them separate:

- **`instructions` — the standing role.** True on every future turn, forever. Who the agent is, what it owns, who it takes work from (you, by name), how and when it reports back, domain rules. Written about the *job*, not about today.
- **`brief` — this specific request.** The thing the user just asked for, in their terms, with the details they gave. Delivered once as the agent's opening message and then it's history.

For "spin up something to track the Q3 migration — first thing, summarize the runbook Dana posted":

```
spawn_topic_agent({
  name: "Q3 Migration",
  instructions: "You own the Q3 database migration. Track decisions, blockers, and owners in memory. Report to Concierge on milestones and anything that slips; stay quiet otherwise.",
  brief: "Summarize the migration runbook Dana posted and flag anything that looks underspecified."
})
```

Putting the brief into `instructions` makes the agent re-do today's task forever. Putting the role into `brief` gives it a personality for exactly one turn and none after.

Don't restate NanoClaw base behavior in `instructions` — the shared base is already loaded on the agent's end.
