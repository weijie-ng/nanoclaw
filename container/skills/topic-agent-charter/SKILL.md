---
name: topic-agent-charter
description: Interviews the user and writes a Problem Statement plus Objective and Key Results (OKRs) before a new standing agent is created, so the agent's purpose is stated, measurable, and its unresolved assumptions are written down rather than silently guessed. Use when someone asks for a new agent, a new topic, or a dedicated place for a piece of work — "make a topic for the Q3 migration", "spin up something to track this", "can we get a channel for the client", "watch the deploy pipeline and tell me when it breaks", "I want an agent that keeps up with papers on retrieval" — and use it before calling spawn_topic_agent or create_agent, not after, and before multi-agent-design, which then decides the shape. Use it especially when the request is vague, ambitious, or open-ended, since that is exactly when the charter is doing the most work. Also use it when the user asks to review, sharpen, or rewrite an existing agent's brief, objective, key results, or standing instructions.
---

# Topic Agent Charter

Spawning is permanent and unmetered: every `spawn_topic_agent` call leaves a topic in a shared chat and an agent group with its own container behind it, and nothing cleans either up. The expensive failure is not a wasted container though. It is an agent that runs for a month against a purpose nobody ever wrote down, so nobody can say whether it is working, and nobody can safely change it.

That gap is **intent debt**: the goals and constraints that should be steering the system, absent from the artefacts that carry it. It lives in `instructions.prepend.md` and in memory, not in anyone's head, and it compounds. A future turn of this agent, a future human, or a future agent editing this agent has only what was written to work from.

Your job before spawning is to close as much of that gap as a short conversation can, and to write down what is left as an explicit open question rather than a quiet assumption.

## The shape of the work

```
1. Harvest   - pull everything already said in this conversation
2. Draft     - fill the charter yourself, guessing where you must
3. Ask       - one round of questions, only about what you had to guess
4. Sharpen   - a second round only if the key results are still unmeasurable
5. Confirm   - show the charter, get a yes
6. Spawn     - charter into `instructions`, today's ask into `brief`
```

Draft before you ask. This is the whole trick over a messaging channel. "What are your success criteria?" makes the user do your work and they will answer vaguely because the question is vague. "I've written KR1 as *runbook gaps found and assigned by 5 September* - is that the date you care about?" is answerable in three words. Concrete proposals surface disagreement; open questions surface silence.

## The charter

Six sections. This is the structure you fill in and the structure that goes into `instructions`.

Spawn prepends one thing you do not write: a shared-bot identity clause, telling the child that inside its own topic the shared bot is *it*, so a mention there is addressed to it even when the handle is named after the agent that spawned it. It is always added at creation, so leave identity out of your charter and start at Problem.

**Problem** - what is wrong now, and for whom. Present tense, current state, no solution in it. If you cannot name who is hurting, you probably have a task rather than a problem, and a task does not need its own agent.

**Objective** - the qualitative, directional change wanted. One sentence, no numbers. It should still read as the point of the thing in three months.

**Key results** - two to four measurable outcomes that would make the objective true. Each carries a number and a date or cadence.

**Non-goals** - what this agent will not do, especially the adjacent things people will assume it does. Cheap to write, and it is the section that stops scope drift later.

**Constraints** - budget, access, tools, people, deadlines, anything that bounds the approach. Include what the agent does *not* have access to, since that is what it will otherwise waste turns discovering.

**Open questions** - the intent-debt ledger. Everything you had to assume, and who can settle it.

### What makes a key result a key result

The test: **at the deadline, could two reasonable people disagree about whether this was hit?** If yes, it is not a key result yet.

The most common failure is a key result that is an activity. Activities are things the agent does; key results are things that become true.

| Not a key result | A key result |
|---|---|
| Review the migration runbook | Every runbook step has a named owner by 5 September |
| Monitor the deploy pipeline | Every failed deploy reported within 10 minutes, no false alarms over a rolling week |
| Keep up with retrieval papers | A weekly digest of papers that change our approach, sent Fridays, zero weeks missed |
| Improve onboarding docs | Time from repo clone to first passing test under 30 minutes, measured on two new hires |

For a **standing beat** with no end date - monitoring, digesting, watching - the key results are service levels rather than milestones: coverage, latency, precision, cadence. "Nothing missed, nothing spurious, delivered on time" is a legitimate set of key results and often the honest one. Do not invent a fake project deadline to make an ongoing job look like a quarterly plan.

Ambition is the user's call, not yours. Do not talk someone down to a key result that is certain, and do not inflate one to sound impressive. Ask which they want if the level is genuinely unclear.

## Asking

One round of two to four questions. Batch them into a single message and number them so the user can answer in a line each.

Ask only where you had to guess and the guess is load-bearing. Two guesses that would change what the agent does are worth asking about; five cosmetic ones are not. Everything you did not ask about becomes an assumption in the charter, stated as one.

A second round is warranted only if the key results are still unmeasurable after the first. Then it is one question, about the one that matters most.

Never block on this. If the user will not or cannot sharpen something, that is an answer. Write it into Open questions with what you assumed instead, and spawn. A charter that says "we do not yet know what good looks like here, assuming X for now" is enormously more useful than no charter, and vastly more honest than a made-up metric. Intent debt you can see is intent debt someone can pay down.

Skip the interview entirely only when the user has already given you problem, objective, and a measurable outcome. Then draft the charter, show it, and spawn on their yes.

## Confirming

Show the whole charter before spawning, in the message where you propose the name. Keep it tight enough to read on a phone. Then spawn on a yes.

If the exchange has been long, say what you assumed rather than burying it: "Two things I've guessed at, flag if either is wrong."

## Spawning

The charter goes into `instructions`, because it must be true on every future turn. Today's request goes into `brief`, because it happens once. Collapsing the two is the classic error: a brief in `instructions` makes the agent redo today's task forever, a role in `brief` gives it a personality for exactly one turn.

Add three standing habits to `instructions` so the charter stays live rather than becoming a decorative preamble:

- Re-read the key results before reporting, and say which one the work moved.
- When an open question starts blocking real work, ask the named owner. Do not settle it silently.
- Keep the charter pinned in the topic, as the standing-instructions file itself.

The second is what converts recorded debt into paid debt. Without it the ledger is just a nicer way of writing down the same guess.

The third makes the charter the first thing anyone opening the topic sees, rather than a preamble buried in a container nobody can read. What gets pinned is `instructions.prepend.md` — the file `instructions` is written to at spawn (`/workspace/agent/instructions.prepend.md` inside the container), not a copy of it. A copy is worse than no pin at all: it drifts the moment either side is edited, and the stale one is the one that looks authoritative.

On Telegram this needs the bot to hold `can_pin_messages` in the supergroup — `spawn_topic_agent` only requires `can_manage_topics`, so pinning can fail in a chat where topic creation works. If it does, the child says so and leaves the file sent but unpinned.

### The child's first turn

Three more things happen on the child's first turn, and they only happen if the working agreement says so:

- **Plan before working.** The child runs the `planner` subagent on the charter's objective and key results. Planner decides the shape — inline work, a single subagent, or a fan-out that `assignment-loop` executes — and returns the plan as text. The child saves it verbatim to `plans/<date>-<slug>.md` before acting on it.
- **Fan-outs get approved as a picture.** If the plan runs more than one unit in parallel, the child renders the plan's Fan-out mermaid block to a PNG with `diagram-design` and sends it into the topic with `send_file`, then starts on a yes. This is a multi-step path, not a one-shot command: `mermaid_extract.py` to read the block, redraw it per the skill, then `references/export.md` to screenshot the SVG node (Chromium is preinstalled, nothing is downloaded). Budget for it. A sequential or inline plan needs no approval round — say the shape in one line and go.
- **Schedules are self-service.** If the ask has a cadence, the child creates its own task (`ncl tasks create --recurrence <cron>`) on its first turn. You cannot pre-load a schedule into the child's group: `ncl tasks create` always targets the calling group, whatever `--group` says. So put the cadence in the charter, and the working agreement tells the child to schedule itself. **Cron is interpreted in the install (or group-override) timezone, never UTC.** Write the cron in local wall-clock time and never "helpfully" convert to UTC: for 09:00 in a Singapore install the cron is `0 9 …`, not `0 1 …`. A UTC conversion in the charter is the commonest scheduling bug — the digest fires hours off and nobody notices until the wrong-time delivery lands.
- **A recurring deliverable is built data-driven, once.** If the charter's deliverable is a file regenerated on a cadence — a digest, a dashboard, a standing report — the biggest failure mode is the child hand-writing the whole artefact every cycle. A large HTML build (tens of KB of cards/rows emitted token by token) runs many minutes and trips the API request timeout (~10 min per request), and it is slow every single cycle. Say so in the charter's deliverable format: build the template **once** as a fixed render script over a single `DATA` object, and each cycle refill **only** `DATA` — counts, ordering and filters computed from it, never tallied by hand. The recurring workload also belongs in the scheduled task, not an inline reply; a "run it now" should trigger that task, not a 15-minute turn the user waits on.

Give the child one workspace layout it repeats for every task: `plans/` for every plan planner returns, `outputs/` for deliverables, `outputs/.verify/` for the evidence its done-condition check produced, and `.templates/` for the copy-me deliverable skeletons and any report tooling it reuses. The child preloads it on its first turn with `python3 /app/skills/topic-agent-charter/scripts/preload_workspace.py <type ...>` (run from `/workspace/agent`; idempotent, never touches existing files), passing the deliverable type(s) the charter names — `report`, `presentation` (or `pptx`), `infographic`, `html` — which seeds a matching skeleton under `.templates/`. No type, no template: folders only. There is no spec folder — the charter in `instructions.prepend.md` *is* the spec, and a spec beside it would be the drifting second copy the pinning rule forbids.

```
spawn_topic_agent({
  name: "Q3 Migration",
  instructions: `
You own the Q3 database migration and report to Concierge.

## Problem
The Q3 migration has a runbook Dana wrote, no named owners, and no shared view
of what is blocked. Ops finds out a step was missed when it fails in staging.

## Objective
Make the migration's state legible enough that nobody is surprised by it.

## Key results
- KR1: Every runbook step has a named owner, by 5 September.
- KR2: Blockers surfaced to Concierge within one working day of appearing.
- KR3: A weekly status that Ops does not have to ask for, Mondays, zero missed.

## Non-goals
Not executing migration steps. Not owning the rollback plan (Dana has it).
Not tracking cost.

## Constraints
Read access to the runbook and this chat only, no production access.
Dana is away from 20 August.

## Open questions
- Q1: "Blocked" is undefined. Assuming: no progress possible without a decision
  from someone outside the team. Owner: Dana.
- Q2: Whether staging failures count as blockers. Assuming yes. Owner: Ops.

## Working agreement
On your first turn, preload your workspace with
`python3 /app/skills/topic-agent-charter/scripts/preload_workspace.py report`
from `/workspace/agent` (the weekly status is a report). Then, and again whenever a new assignment lands, run the
`planner` subagent on this charter and save the plan it returns to
`plans/<date>-<slug>.md`. If the plan runs units in parallel, render its
fan-out mermaid to a PNG with `diagram-design` (`mermaid_extract.py` → redraw →
`references/export.md`), send it here with `send_file`, and start on a yes;
otherwise say the shape in one line and go. Keep deliverables in
`outputs/` and the evidence your done-condition check produced in
`outputs/.verify/`. Schedule KR3 yourself on your first turn:
`ncl tasks create --recurrence "0 9 * * 1" ...`.

Track decisions, blockers, and owners in memory. Before reporting, re-read the
key results and say which one moved. Treat them as your done-condition, and cap
the loop at three attempts unless the task sets its own; at the cap, report the
partial and what is still open rather than stopping quietly. When Q1 or Q2
starts blocking real work, ask the owner named above rather than deciding it
yourself.

Your charter is `instructions.prepend.md` — the file that makes you who you
are on every turn. On your first turn, send it into this topic with
`send_file({ path: "instructions.prepend.md", filename: "okr.md" })` and pin
the result with `pin_message` (`send_file` returns the message id to pass).
When a key result, constraint, or open question changes, edit that file, then
re-send and re-pin. Never keep a second copy of the charter: the pinned
message is the file itself.
`.trim(),
  brief: "Summarise Dana's runbook and flag any step without a clear owner."
})
```

Keep `instructions` about the job. The NanoClaw base behaviour is already loaded on the agent's end, so restating it wastes the child's context every turn.

## Worked example: a standing beat

> "Watch the deploy pipeline and tell me when it breaks."

Harvest gives you the objective almost verbatim and nothing else. Draft, then ask the two things that decide what the agent actually does:

> Setting this up as its own topic. Two questions:
> 1. Tell you about every red build, or only ones that stay red past a retry?
> 2. How fast does it need to reach you to be useful - minutes, or is a morning digest fine?

Answers: only persistent failures, within about ten minutes. That is enough for real key results (every persistent failure reported within 10 minutes, no false alarms over a rolling week, no red build older than an hour unreported) and it leaves one honest open question: nobody has said who fixes the failures, so the agent should assume it reports rather than pages, and ask.

## Reviewing an existing agent

Same charter, applied backwards. Read the agent's `instructions.prepend.md`, work out what it is actually optimising for, and name the drift: key results that were activities all along, key results whose date has passed, non-goals it has quietly started doing, open questions that were settled in practice but never written back.

The last one matters most. A question answered in conversation and never written into `instructions` is intent debt that looks paid and is not, because the next turn of the agent, and the next person to read it, still cannot see the answer. Propose the rewrite, get a yes, and say that standing-instruction changes take effect after the group container restarts.
