---
name: loop-design
description: >-
  Turns a task an analyst or a colleague hands over into an engineered loop
  - a written done-condition, a check that can actually fail, subagents
  fanned out over the work and over the checking, state on disk, and an
  explicit stop - instead of one pass and a confident reply. Use when the
  answer is assembled from many pieces rather than produced in one go, and
  something outside the draft itself could prove it wrong: research and
  market scans, drafting a deliverable to a quality bar, reconciling numbers
  between sources, monitoring and watch briefs. The clock is not the trigger
  - the same loop runs entirely inside this turn, or on a cron. Trigger
  phrases include "find every", "put together a report on", "is this still
  true", "keep an eye on". Use at the start, while the plan is still cheap
  to change, and on each wake of a recurring task. Not for deciding whether
  to stand up a new agent to own a watch - that is topic-agent-charter
  (purpose) and multi-agent-design (topology); loop-design engineers the loop
  an existing agent runs, once this turn or on a cron.
---

# Loop Design

An analyst hands you a task, not a prompt. "Find every competitor that changed pricing this quarter" is not answerable in one pass: the answer is assembled, some of it is wrong, and nobody will know which parts unless you check. Your job is to design the loop that finishes it — what starts it, what counts as done, how you catch your own mistakes, what you write down, when you stop — and then run it.

The failure this prevents is not laziness. It is the confident single pass: a tidy list of six competitors, delivered as if it were all of them, with two entries half-remembered and no record of where you looked. The analyst cannot see the difference between that and real work. You can, but only if you built something that could have told you.

Two things make the design non-optional here. A loop running unattended is a loop making mistakes unattended. And your container forgets everything between wakes — anything you do not write down did not happen.

## Before you start work

Five things. Write them into memory, in the task's own note, before the first search or the first draft. Most take one line each; skipping them is what turns a task into a wander.

| Part | What it means here |
|---|---|
| **Trigger** | Ad-hoc (this message), a one-shot `ncl tasks create --process-after`, or a `--recurrence` cron. Decide now: a loop that will wake again needs its state designed for a reader who has never seen this conversation, and retrofitting that is a rewrite. |
| **Done-condition** | The check you will run to prove it. "All twelve accounts in the sheet have a verdict and a source URL" — not "a good overview". |
| **Tools** | Which skills give you real feedback rather than recall: `web-search`, `news-search`, `page-read`, `social-search`, `forum-search`, `fact-check`, `agent-browser`. Naming them upfront stops you answering from memory. Plus `Task`, if the work splits — see below. |
| **State** | Where the running answer, the sources, the dead ends and the attempt count live. Memory, and `ncl tasks append-log --msg` for a recurring series. |
| **Stop rules** | All three: done, gave up (a hard cap, two passes by default — see Stopping), handed back (ambiguous or risky). |

If you cannot write a done-condition that a check could fail, stop and ask the analyst one question. That is the single most useful thing you can ask, and it is far cheaper now than after you have delivered the wrong shape of thing.

## Pick the loop shape

| Shape | Cycle | Use when |
|---|---|---|
| **Draft and verify** | draft → check → revise | Correctness is checkable. Research answers, claim-heavy summaries, anything with numbers or attributions. The default for analyst research. |
| **Draft and score** | draft → score against a rubric → revise | Quality is a spectrum, not a pass/fail. A memo, a client-facing summary, a headline. Write the rubric before the first draft, or the score is just your mood. |
| **Plan, execute, replan** | plan → do a step → revise the plan | The work reveals itself as you go. "Find every X" — you do not know how many X there are until you are looking. Revise the plan out loud in state, not silently. |
| **Watch** | wait → check → act → wait | No finish line. Monitoring, digests, "let me know when". Lives as a `ncl tasks --recurrence`; each fire is one turn of the loop. |

Ad-hoc and scheduled are the same loop with a different clock. If the task has a deadline rather than a cadence — "I need it Thursday" — run it now and, if it will not finish in one turn, book the next turn with a one-shot `--process-after` rather than hoping you get woken. `ncl tasks run --id <id>` fires an existing task once without touching its schedule, which is how you test a recurrence before trusting it.

Mixing is normal. A pricing sweep is plan-execute-replan on the outside with draft-and-verify inside each competitor.

## The check has to be able to fail

Iterating without a check is just producing more text. A real check consults something outside your own draft.

| Not a check | A check |
|---|---|
| Rereading your summary and finding it reasonable | `fact-check` over the draft, or `page-read` on each cited URL to confirm it says what you claimed |
| "I searched thoroughly" | A named coverage test: every account in the analyst's list has a row; three independent searches surfaced no seventh competitor |
| Deciding the numbers look right | Two sources per number, and the reconciliation written down where they disagreed |
| Confidence that the source was recent | The publication date, read off the page, against the quarter you were asked about |

Check with fresh eyes, not the eyes that drafted — literally, where it matters: spawn the check as a subagent. Go back to the source rather than to your own notes about the source. The specific mistake this catches is the one you cannot catch any other way: a fact you never had, which arrived in the draft looking exactly like the ones you did.

When the check fails, feed the *specific* failure into the next attempt — "the Q2 figure came from a 2023 page, find a dated Q2 source" — not "try again". A retry with no new information reproduces the same answer and burns the one corrective pass the default cap gives you.

## Fan out with subagents

You have `Task`, and it is the strongest tool in this skill. A subagent runs with its own context and reports back a conclusion, which buys two things a single pass cannot: work that happens in parallel, and a checker that never saw how the draft was made.

Three uses, in order of how often they earn their cost:

- **Coverage fan-out.** One subagent per item in the analyst's list — per competitor, per account, per document. Each reads its own sources and returns a row. Nine shallow lookups done at once beat nine done in sequence with your context filling up on page four.
- **The verifier.** Spawn the check as its own agent, and tell it to *refute* the draft rather than confirm it. It has no memory of your reasoning, so it cannot inherit your mistake. This is the writer/checker split made real instead of pretended.
- **Angle fan-out.** When you do not know where the answer lives, send subagents down different routes — news, forums, the company's own pages, social — each blind to the others. One angle finding nothing is information; four angles finding nothing is close to a verdict.

Launch independent subagents in a single message so they actually run in parallel, and hold the fan to what the task needs. Each one pays its own model and tool costs, so a fan of nine is roughly nine times the spend of one — and if each is running a billed `page-read` or `social-search` tier, count those too before you set the width.

The return contract is the whole game. A subagent cannot message you mid-run and you never see its working, so its final report is the only thing you get: say exactly what to return, in what shape, with source URLs. Anything you did not ask for is gone. And treat what comes back as a claim, not a fact — a subagent can be confidently wrong just as you can, which is why the verifier is a separate agent and not the same one marking its own homework.

Keep the writing in one place: you own the state note, subagents return findings. Parallel agents editing the same file collide, and the fix is not coordination, it is not doing it — have them return text, or write to one file each under a name you gave them.

If the same fan-out recurs, write the subagent's brief once as `/workspace/agent/.claude/agents/<name>.md` — that directory is loaded as project settings and survives container restarts, so the next fire of a recurring task gets the same specialist without you re-describing it.

## State: write it before you need it

Your turn can end at any point. Anything held only in this conversation is gone on the next wake, and a recurring task's next fire starts from nothing but its prompt and what you wrote.

Keep it minimal and current — the running answer, the sources with URLs, what you have ruled out and why, and how many attempts you have spent. Dead ends matter as much as findings: without them the next fire re-searches the same exhausted query and reports the same nothing. Update as you go, not at the end.

For a recurring series, `ncl tasks append-log --msg "..."` on each fire, and write the recurrence prompt so it stands alone: it must point at the state note, because the fire that reads it has never seen this conversation.

`--recurrence` refuses more than four fires a day — unless the task carries a `--script` gate, and that is the right answer for a tight watch rather than a limit to argue with. The script is bash, runs *before* you wake, and its last stdout line is `{"wakeAgent": <bool>, "data": {...}}`: `false` marks the fire handled at zero tokens, `true` wakes you with `data` attached. So a fifteen-minute watch costs almost nothing on the quiet fires, and you only think when there is something to think about. Keep `data` a summary, not a dump; persist any last-seen marker under the group workspace, since the script gets no memory either; test it with `bash -c` before scheduling. A script that errors repeatedly backs the series off and auto-pauses it after eight consecutive failures — `ncl tasks get <id>` shows `failed_runs` and the run log, and `ncl tasks resume` restarts it once fixed. Reach for `--dangerously-override-recurrence-limit` only after the analyst has explicitly accepted the token cost of an ungated frequent task.

## Stopping

Three exits, and you must have all three:

- **Done** — the done-condition's check passed. Say which check, so the analyst can disagree with the standard rather than guess at it.
- **Gave up** — you hit the attempt cap you set. Report the partial: what you have, what you could not get, what you tried. A partial with its gaps named is usable work. A partial presented as complete is worse than nothing, because it gets acted on.
- **Handed back** — the task turned out ambiguous, the answer needs judgement that is not yours, or the next step is irreversible or outward-facing. Send something outward once, at the end, on a human's word — never once per iteration.

Never loop without a cap. "Until it is good" has no last iteration.

**The default cap is two passes: the run, then one review pass over it.** Produce the work, run the check against it, and spend the second pass fixing what the check found. That is where nearly all of the value is — the first check is the one that catches the fabricated citation and the stale figure, and a third pass mostly relitigates wording at full cost. Set a higher cap when the task earns it (many items each needing their own verification, a source that keeps refusing, a numeric reconciliation that has not converged), and say in the report that you did and why. Set it lower only for the one-pass cases below.

Say which loop you ran when you report. Two sentences: how you checked, and where you stopped. That is the difference between a deliverable the analyst can trust and one they have to redo.

## When not to loop

- **One pass genuinely suffices** — a translation, a summary of a document you were handed, a single classification. Looping adds cost and drift, not accuracy.
- **Nothing is checkable** — "which of these names do you like best" is the analyst's call. Present options; do not iterate towards an imagined preference.
- **Each iteration has a cost that lands on someone else** — anything that sends, posts, files, or notifies. Draft in the loop, act once outside it.
- **Billed tools per iteration** — the paid tiers behind `social-search` and `page-read` charge per collection. Cache-aware reuse is free; a fifteen-round loop over fresh collections is not. Budget the calls when you set the cap.

## Failure modes

| Failure | Guard |
|---|---|
| Loops forever, or quietly stalls | Hard attempt cap, written down before the first attempt |
| Declares success it cannot support | A check that consults a source outside the draft |
| Repeats the same failed attempt | Carry the specific failure into the next prompt |
| Second fire redoes the first fire's work | State written before it is needed, dead ends included |
| Cost surprise | Count billed calls per iteration, and fan width, when you set the cap |
| A subagent's findings arrive unusable | State the return shape and demand source URLs in its prompt |
| Nobody can audit what happened | `append-log` per fire; sources with URLs in state |
| Too much autonomy too early | Report-only first, then act with approval, then unattended once its checks have caught something real |

## Worked example

> "Find every competitor that changed pricing this quarter, with what changed. I need it Thursday."

Written before searching: done-condition is *each of the nine competitors on the analyst's list has a verdict (changed / did not change / could not establish) with a dated source URL, and the three biggest have a second source*. Shape is plan-execute-replan across the nine, draft-and-verify within each. Cap of two verification attempts per competitor. State holds the nine rows, sources, and exhausted queries.

Fan out: nine subagents in one message, one per competitor, each told to run `web-search` and `news-search` for a pricing change, `page-read` the pricing page itself, read the date off the page rather than inferring it from the search snippet, and return exactly a verdict, a one-line change description, and dated source URLs. Where two sources disagree, the disagreement comes back in the row. You write the nine rows into state as they land; none of them touches the file.

Then the three biggest go to a verifier subagent apiece, prompted to refute the row rather than confirm it.

Two come back as *could not establish*. Those ship as *could not establish*, with the queries tried — not as *no change*, which is a claim nobody verified. The report says what the check was and that two rows are open, and asks whether Thursday wants a best guess on them or the gap left honest.

That is the whole discipline: the loop is only as good as its check, and the check is only useful if the report admits what it failed to prove.
