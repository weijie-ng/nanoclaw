---
name: topic-agent-charter
description: Interviews the user and writes a Problem Statement plus Objective and Key Results (OKRs) before a new standing agent is created, so the agent's purpose is stated, measurable, and its unresolved assumptions are written down rather than silently guessed. Use this whenever someone asks for a new agent, a new topic, or a dedicated place for a piece of work — "make a topic for the Q3 migration", "spin up something to track this", "can we get a channel for the client", "watch the deploy pipeline and tell me when it breaks", "I want an agent that keeps up with papers on retrieval" — and use it before calling spawn_topic_agent or create_agent, not after. Use it especially when the request is vague, ambitious, or open-ended, since that is exactly when the charter is doing the most work. Also use it when the user asks to review, sharpen, or rewrite an existing agent's brief, objective, key results, or standing instructions.
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

Add two standing habits to `instructions` so the charter stays live rather than becoming a decorative preamble:

- Re-read the key results before reporting, and say which one the work moved.
- When an open question starts blocking real work, ask the named owner. Do not settle it silently.

The second is what converts recorded debt into paid debt. Without it the ledger is just a nicer way of writing down the same guess.

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
Track decisions, blockers, and owners in memory. Before reporting, re-read the
key results and say which one moved. Treat them as your done-condition, and cap
the loop at three attempts unless the task sets its own; at the cap, report the
partial and what is still open rather than stopping quietly. When Q1 or Q2
starts blocking real work, ask the owner named above rather than deciding it
yourself.
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
