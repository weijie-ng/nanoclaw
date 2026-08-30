---
name: multi-agent-design
description: >-
  Decide whether work should be handled inline, fanned out to subagents, or given its own standing agent - and, when standing agents are involved, how they reach each other. Use after topic-agent-charter has fixed the purpose, before calling create_agent or spawn_topic_agent, before fanning out subagents, and when a request feels too big or too mixed for one conversation. Use when the user asks how their agents should be architected, designed or structured. It is easy to reach for a new agent when subagents would do, and that mistake is expensive because agents persist. Triggers on "should this be a new agent", "spawn an agent for this", "one agent or several", "multi-agent", "split this up", "make me a researcher/builder/reviewer agent", "how do the agents talk to each other", "agent architecture", "how should I design my agents", "chief agent", "one agent coordinating others", "this is too much for one conversation". Decides agent topology only; once that is settled, loop-design engineers how a single task's execution loop actually runs. Triggers also on the pattern names it maps: "fan-out", "fan-in", "router pattern", "reflect and critique", "consensus", "debate", "generate then critique", and on "explain the patterns", "teach me the architectures", "show me the patterns". Triggers too on the skill-versus-agent choice: "should this be a skill or an agent", "when do I use a skill or a subagent", "when should I create a skill", "skill or a specialist agent", "why a fact-checker agent when there is a fact-check skill". This skill decides and explains topology; it does not visualise a run that already happened - "show me the multi-agent orchestration", "what did the subagents do", "diagram of this run" is the multi-agent-display skill.
---

# Multi-Agent Design

Two questions, in order: **does this need more than one mind**, and if the extra minds are standing agents, **how do they reach each other**. The mechanics of the heavyweight options are in the `create_agent` and `spawn_topic_agent` instructions already loaded in your context. This skill is the judgment they do not cover.

## Step 0: climb the cheap rungs first

Two things force work apart, and only two: **context** - what one mind can hold and still reason over - and **ownership** - what has to be maintained, scheduled, or addressed by someone other than you. Every split below is one of those two getting expensive. Reasons that are not on that list ("these feel like different jobs", "a specialist would be better at it") are aesthetics, and here they cost real money.

So climb, and stop at the first rung that holds:

| Rung | What it costs | What promotes you off it |
|---|---|---|
| Sharpen the standing instructions - a tighter brief in `instructions.prepend.md`, a fact moved into memory | nothing | Two jobs' rules contradict each other, or the brief is now so long its middle stops being obeyed |
| Add a skill or a tool | one directory, read only when it is relevant | The knowledge fits fine; it is the *work* that is bulky - big payloads, many files, long sweeps |
| Fan out subagents | one call each, all inside this turn, nothing to maintain | Something must survive the turn, be addressable, or run while you are not |
| Stand up a standing agent | a container, a workspace, wiring, and a maintainer indefinitely | Nothing. This is the last rung |

Add capability before you add minds, and climb only when the rung below has visibly failed, not when you can imagine it failing.

## Step 1: does anything have to outlive this turn

This is the question that separates a standing agent from a subagent, and the one people get wrong. A standing agent earns its keep when one of these is true, and only these:

| Signal | Why a subagent cannot cover it |
|---|---|
| It must accumulate knowledge across days | Subagents start cold every spawn. There is nothing to accumulate into. |
| It must be addressable - messaged directly, or speak as itself | Subagents are invisible outside your turn. Only agent groups get names, destinations and chats. |
| It must act while you are not running | Subagents only exist inside a turn of yours. They cannot be given `ncl tasks` schedules. |
| It must work independently without blocking you | A subagent's whole purpose is to return into your turn. |
| It holds something the user should not see mixed with this conversation | Subagents share your context and your workspace. They isolate nothing. |

If none of these hold, it is a subagent - say so and go to step 2.

Beware the pull of "this feels like a different job". Splitting by *role* - a planner, an implementer, a tester, each a separate standing agent - is the classic mistake. Every handoff has to re-transfer the context the last one built, and that coordination overhead usually costs more than the specialisation gains.

If it really is standing work, there are two shapes: `create_agent` gives you a private collaborator wired to you by destination, and `spawn_topic_agent` gives the user a visible topic beside this chat with an agent in it. Pick the second when a human needs to talk to it directly. Either way, write the charter first - see the `topic-agent-charter` skill. Both write to the central DB, so unless your group has `global` cli_scope the call is held for admin approval.

### How many

One standing concern, one agent. Several are right only when they are separate *concerns*, never the stages of one job: a distinct chat or audience (one per client, one per brand), memory that must not mix, separate schedules, or a different person maintaining the brief and skills. If two candidates would share a chat, a memory and a beat, they are one agent with subagents.

Splitting for confidentiality does not work on its own. The social cache (`social-search`, `page-read`, `news-search`) is install-wide by default, so every agent group reads every other group's collection history. Isolating that is an operator change to `SOCIAL_CACHE_DIR`, not a topology choice you can make from here - say so rather than spawning agents that do not deliver the separation asked for.

## Step 2: if nothing outlives the turn, is it even worth a subagent

Spawn one when a piece of the work would produce a lot of output you do not need (log sweeps, file reads, large payloads, search results - context you never load can never degrade your reasoning), when several facets are genuinely independent, or when it needs a different stance: the shared briefs in `.claude/agents/` are `planner`, `general`, `fact-checker`, `refuter`, `verifier`, `data-analyst`, `media-monitor`, `narrative-analyst` and `profile-builder`, and each one's description says what it will not take.

Cut by **what context can stay outside your head**, never by job title. *"Read these six adapters and report which declare channel defaults"* works, because the file bodies never enter your context and only the answer does. *"You plan it, then you build it, then you check it"* does not, because each stage needs most of what the last one knew. The test: if the subagent needs most of what you already know in order to start, the split is losing - keep it inline.

Two shapes hold up under that test. A **chain**, where each stage takes the previous stage's *output* rather than its context - parse, then extract from the parse, then summarise the extract - stays cheap because the handoff is small by construction; if a stage has to re-read what the last one read, it was never a chain. And a **generate-then-critique loop**, where one subagent drafts and a *different* one attacks the draft (`refuter` and `fact-checker` exist for exactly this) before it is revised. Name the exit condition and the iteration cap before you start it - "until it is good" runs forever - and never let the drafter grade its own work, which is the only reason the second call exists.

Under all of this sits one more choice: a **skill** run inline needs no subagent at all, because isolation is the only thing a subagent adds over a skill, and a one-off whose output you would keep does not need it. Above that, `general` plus a skill buys isolation without specialisation; a named brief buys isolation plus routing, a fixed return schema, saved guardrails and, for `verifier` and `refuter`, a model pin `general` cannot give. `fact-checker` is the thinnest of these, its body is "follow the `fact-check` skill", so a single check is `general` + that skill minus a file. The full decision, and when to pull a brief's method out into its own skill, is `reference/skill-vs-agent.md`.

Then hand over to `loop-design`, which owns the mechanics: fan width and cost, the return contract, the verifier, and who writes state. For the named patterns mapped onto these costs - fan-out/fan-in, router, reflect-and-critique, consensus/debate, and the chain above - see `reference/patterns.md`.

## How standing agents relate

Between standing agents there is no function call, only messages.

- **Destinations are the access list.** `send_message({ to })` resolves a name in your destination map; no row, no send, and the host denies it. `create_agent` writes both rows for you - you get the child under the name you chose, it gets you as `parent`. Two agents where neither created the other have no rows at all and cannot reach each other until an operator adds one.
- **Every exchange costs a turn on each side.** `send_message` returns as soon as the message is queued. The reply arrives later as a new inbound message that wakes you fresh - there is no waiting for an answer inside your turn. A design that needs three round trips to settle one question is three wakes on each side, each re-reading its own notes to remember why.
- **A send can be held.** A message policy on your pair parks the message for a named approver before it is delivered. Never write a step that assumes the previous message arrived.
- **One owner per piece of state.** Agent groups have separate workspaces: nothing you write is visible to another agent, and nothing it writes is visible to you. Facts move by message or not at all.
- **Fan-in is your job.** Nobody aggregates for you. If three agents report to you, you hold the running answer, and you decide what to do when only two have replied by the time you are woken.

### Chief and workers

This star is the standing-agent row of fan-out/fan-in in `reference/patterns.md`, which names when it is a costume. `create_agent` builds a star by default: you hold a destination per worker, each worker holds `parent` back, and nothing connects the workers. The constraints follow from that shape.

- **Workers cannot reach each other.** Every fact moving between two workers goes through you - two sends, and a wake on each side of each. If they need to compare notes, they were one agent.
- **Nothing tells you a worker went quiet.** There is no ack, no timeout, no retry. A worker that crashed and one whose reply is parked for approval both look exactly like one still thinking. Keep the roster and what you asked of whom in your state note, and book a check with `ncl tasks --process-after` if silence matters.
- **Replies are ordinary inbound messages** tagged `from="<name>"`, arriving in whatever order they finish and interleaved with everything else. Correlate against what you wrote down, not against arrival order.
- **Anything you need in order to continue is a subagent, not a worker.** A standing worker cannot answer inside your turn.

The test for the whole pattern: a chief that mostly relays and aggregates is paying two wakes per hop for the privilege. Worth it when the workers are genuinely standing concerns with their own chats, memory and schedules. Pure overhead when they exist only to serve your request - that is a fan-out of subagents wearing a costume.

## What tends to go wrong

- **A new agent starts nearly empty.** It inherits your provider and the shared container skills, and nothing else: not your memory, not your group's own skills, not the packages or MCP servers you had approved. Everything else has to be re-established in its instructions.
- **Subagents are not sandboxes.** They share your workspace mount - they can write files, edit memory, run `ncl`. "No memory" means no conversation continuity, not no reach. If the point of the split is that someone should not see something, only a separate agent group does that.
- **Parallel subagents clobber each other.** They share one workspace, so two running at once that write the same path - a scratch note, a report, a memory file - race, and one of them wins silently. Give each its own filename, or have them return their findings and write once yourself.
- **Nobody cleans up.** An agent is a container, a workspace, and a standing thing someone maintains. Nothing reaps it when the reason for it ends.
- **Wrong subagent, no harm; wrong agent, lasting mess.** A subagent costs one call and vanishes. An agent accretes memory and wiring, and gets more expensive to unwind the longer it runs. When genuinely torn, take the subagent path - promoting later is easy, demoting is not.

Say the choice in one line - *"I'll fan out three readers so the file contents stay out of my context"* - and go.

## When a user asks to learn the patterns

The judgment above is for you. When a *user* asks to have the patterns explained, taught, or laid
out - "explain the patterns", "teach me the architectures", "one agent or several, show me the
options" - send them the rendered one-pager instead of retyping it:

`send_file /app/skills/multi-agent-design/assets/patterns-overview.html` with a one-line caption.

It is the five patterns as a user-facing card each: a centred wireframe, a plain "what it is", and
pros, cons and use-cases. Accurate to the cost model in `reference/patterns.md` but pitched for a
curious reader. Send it, then answer their actual question; the page is a map, not a replacement for
the decision.

A different request looks similar but is not this skill: *"show me the multi-agent orchestration"* /
*"what did the subagents do"* / *"diagram of this run"* wants the *real* spawn trace of a turn that
already ran, not the pattern theory. That is the `multi-agent-display` skill - hand it over.

## When a user asks skill or agent

*"When do I use an agent and when a skill", "should this be a skill or its own agent",
"when should I create a skill", "why is there a fact-checker agent and a fact-check skill
too"* - answer from `reference/skill-vs-agent.md`, in plain words rather than the cost
jargon. The one-line version: a **skill** is a method that runs in the current chat and
anyone can trigger by name; an **agent** runs that same method in a *separate* context,
which you want only when the work would flood the chat, needs to fan out over many items,
needs a cheaper or different model, or needs an independent check that did not see your
reasoning. The agent usually *runs* the skill, so they are layers not rivals, which is
why fact-check exists as both. Give the short answer, then offer the fuller decision from
the reference if they want it.
