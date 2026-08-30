# Skill, general worker, or specialist brief

Below the standing-agent tier, a unit of work runs one of three ways: a **skill** in
your own context, **`general` plus that skill** in a fresh context, or a **named
specialist brief**. Two cuts decide it. The first is *isolation* - your context or a
separate one. The second, only once you have chosen a separate context, is
*specialisation* - the generalist worker or a dedicated brief. `patterns.md` settles
the topology once the substrate is fixed; this file settles the substrate.

## Cut 1: skill, or subagent

A **skill** is a method - instructions, and often scripts, that load into whatever
context calls them and *stay there*. It runs once, in sequence, in your context, keeps
its output in front of you, and a human can invoke it by name (`/fact-check`). A
**subagent** is the same kind of instructions run in a *fresh context window* that
returns only its result. So the question is never "is there a skill or an agent for
this": the agent usually *runs* the skill. `fact-checker`'s whole body is "follow the
`fact-check` skill". The real question is whether you want the method in your context or
out of it.

By default a skill runs in your context, and isolation is the one thing a subagent adds
over it. (Claude Code can also run a skill *itself* in a forked, isolated context with
`context: fork` - that is simply the subagent version of the skill, and in NanoClaw the
same move is `general` plus the skill, which is why the two cuts below are one decision,
not two kinds of thing.) Reach past an inline skill into a subagent when, and only when,
one of these holds:

| Reach for a subagent when | Why the skill inline will not do |
|---|---|
| The byproduct exceeds what you want to keep - scrapes, a huge file, search results | A skill leaves all of it in your context; context you never load can never degrade your reasoning |
| You are fanning out one worker per item, in parallel | A skill runs once, in sequence, in your context |
| You want a cheaper or different model, or restricted tools | A skill runs on your model with your tools |
| You need an independent second opinion that did not inherit your reasoning | A skill shares your history; only a fresh context (and a different model) is blind to how you got here |

Item count is a *proxy* for the first row, not the rule: a single 200-page report is one
item that still wants isolation, because its page images would bury your context. If
none of the rows hold, it is a skill inline - do not spawn a subagent for a one-off
whose output you would keep anyway.

## Cut 2: `general`, or a named specialist brief

Both `general` and a specialist run in an isolated context, so isolation does **not**
decide between them. A named specialist is `general` plus four things:

- **A routing description.** The planner or caller auto-routes "verify this claim" to
  `fact-checker` by its description. With `general` you hand it the skill and the right
  framing on every call.
- **A fixed return schema.** The brief pins the shape, so a fan-out of N comes back
  identical and you can merge it. `general` returns freeform "what came of it", which you
  cannot cleanly aggregate.
- **Saved task guardrails.** "Stop at the verdict, do not run the challenge step, do not
  spawn a sub-subagent" lives in the brief instead of being re-typed each call.
- **A model or tool pin.** `verifier` runs on Haiku, `refuter` on Gemini. `general` only
  ever runs the group model, so those two **cannot** be `general` at all.

| Keep the named specialist when | Collapse to `general` + skill when |
|---|---|
| You fan out and merge, and need the identical parseable return schema | You want only isolation, for a one-off |
| The planner should auto-route to it by description | You would name the skill and framing yourself anyway |
| The guardrails are worth saving rather than repeating | The task carries no special discipline to preserve |
| It needs a model or tool pin (`verifier`, `refuter`) | It inherits the group model and full tools |

**The costume test.** `fact-checker` is the thinnest specialist on the roster: it
inherits the model and its body is "run the skill", so for a single check `general` plus
the `fact-check` skill is the same thing minus a file. It earns its brief by being
*routable, parseable and repeatable* across a fan-out, not by being isolated. `verifier`
and `refuter` are not collapsible on any account - the model pin is load-bearing. When a
would-be specialist has no return schema to guarantee, no guardrails to save, no model
pin and no fan-out to route, it is `general` + a skill wearing a costume.

## The mirror: pulling a brief's method out into a skill

Some specialists (`profile-builder`, `media-monitor`) carry the method *inside the
brief* with no backing skill. Promote that method into its own skill when any one of
three holds:

- a **second caller** needs the same method (another agent, or an inline path),
- you want a **human to invoke it by name** (`/profile <name>`) - a brief cannot be
  called directly, a skill can,
- you want it under the **skill test and eval machinery** (skill-directives, `/learn`,
  the guidelines harness all operate on skills, not briefs).

Until one of those holds, the method stays in the brief: one fewer file, and no
hard-coded cross-boundary path to rot. Extraction is not free - `fact-checker` hard-codes
`/app/skills/fact-check/scripts/factcheck.py`, a seam that breaks silently if the skill
restructures. Extract for a real second caller, human invocation, or testing, not for the
aesthetics of "this could be a skill".

## Reconciles

- SKILL.md Step 0 ladder, rungs 2-3 (add a skill, versus fan out subagents): this file is
  the finer choice under those rungs.
- SKILL.md Step 2 names the shared briefs; this file says when one of them beats
  `general` running the same skill, and when the method belongs in a skill at all.
- `reference/patterns.md` settles topology (chain, router, fan-out, ...) once the
  substrate is chosen; `loop-design` owns how the chosen shape then executes.

## Sources

These distinctions are established, not asserted. Each is backed below by a verbatim quote
from the Claude Code docs, Anthropic's agent-skills best practices, or NanoClaw's own
guides. What is *not* here - the "independent second opinion that did not inherit your
reasoning" framing, and the costume test - is NanoClaw reasoning built on top of these, not
a documented rule, and is flagged as such rather than dressed up as a citation.

**A skill loads into your context; a subagent runs isolated and returns only a summary.**
- Best practices: "At startup, only the metadata (name and description) from all Skills is
  pre-loaded. Claude reads SKILL.md only when the Skill becomes relevant, and reads
  additional files only as needed."
  (platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- Claude Code skills: "a skill's body loads only when it's used, so long reference material
  costs almost nothing until you need it." (code.claude.com/docs/en/skills)
- Claude Code subagents: "Each subagent runs in its own context window with a custom system
  prompt, specific tool access, and independent permissions." and "the subagent does that
  work in its own context and returns only the summary." (code.claude.com/docs/en/sub-agents)
- The explicit skills-versus-subagents line: "Consider Skills instead when you want reusable
  prompts or workflows that run in the main conversation context rather than isolated
  subagent context." (same)

**The exception that proves it is not absolute.** A skill can opt into isolation, at which
point "skill" and "run it in a subagent" converge: "Add `context: fork` to your frontmatter
when you want a skill to run in isolation... It won't have access to your conversation
history." (code.claude.com/docs/en/sub-agents). In NanoClaw that convergence is `general`
plus the skill.

**Why reach for a subagent (Cut 1 table).** Claude Code subagents, "Subagents help you:" -
"**Preserve context** by keeping exploration and implementation out of your main
conversation"; "**Enforce constraints** by limiting which tools a subagent can use";
"**Control costs** by routing tasks to faster, cheaper models like Haiku"; "**Specialize
behavior** with focused system prompts for specific domains."
(code.claude.com/docs/en/sub-agents)

**A skill is invoked by name and triggered by its description.** "Claude uses skills when
relevant, or you can invoke one directly with `/skill-name`." (code.claude.com/docs/en/skills).
"The 'name' and 'description' in your Skill's metadata are particularly critical. Claude uses
these when determining whether to trigger the Skill in response to the current task."
(best-practices).

**A specialist brief is `general` plus routing, a return schema, guardrails and a model pin
(Cut 2).** NanoClaw subagent-brief guide (`container/agents/README.md`): "`description`
(required): the routing signal."; "Your final message is the return value your caller reads:
no preamble, no narration, no offer to continue."; "`model` (optional): omit to inherit the
group's model... Pin only when a tier is genuinely intended: a cheap model for a narrow
mechanical agent (`verifier` -> `claude-haiku-4-5-20251001`), or a specific tier for a
specialised one (`planner` -> `claude-opus-4-8`)... a cross-provider pin (`refuter` ->
`gemini-3.7-flash`)."; "Single responsibility. One job per brief; route the rest to a
sibling."

**When to pull a brief's method into a skill (the mirror).** Skill single-responsibility is
NanoClaw's rule, not Anthropic's: `docs/skill-guidelines.md` Principle 1 - "A skill provides
one independently useful customization and has one cohesive reason to change." The
eval/test case: best practices - "Create evaluations BEFORE writing extensive
documentation"; skill-guidelines - the tests "define a maintainable skill".

**Checked and deliberately not cited to best practices.** Reading the best-practices page in
full, it mentions **no** subagents and states **no** single-responsibility rule for skills.
So the isolation contrast and the subagent reasons are cited to the Claude Code subagents
doc, and skill single-responsibility to `skill-guidelines.md` - never to the best-practices
page, which does not support them.
