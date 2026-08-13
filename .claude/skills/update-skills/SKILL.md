---
name: update-skills
description: Re-apply your installed skills to pull their latest code from upstream. Use when updating channels or providers, or when asking whether a re-apply will discard a local fix — it surfaces local edits to skill-owned files before overwriting them.
---

# About

Each skill is a self-installing additive unit: its folder under `.claude/skills/<name>/` carries its own apply steps (`SKILL.md`), and channel/provider skills fetch their code files from a long-lived upstream branch (`channels`, `providers`) with `git fetch "$REMOTE" <branch>` + `git show "$REMOTE"/<branch>:path > path`, where `$REMOTE` comes from `resolve_channels_remote` (`setup/lib/channels-remote.sh`) rather than a hardcoded `origin` — the branches live on the canonical repo, which is `upstream` in a fork and absent entirely from a clone of a fork. Every apply is idempotent and safe to re-run.

Updating a skill means **re-running its own apply**. The apply re-fetches the latest files from upstream and overwrites the copied-in code, so newer versions land additively.

Run `/update-skills` in Claude Code.

## How it works

**Preflight**: checks for a clean working tree and the upstream remote.

**Detection**: reads the channel and provider barrels to list which skills have copied code into your tree, and lists the operational/utility skills present under `.claude/skills/`.

**Local edits**: finds commits of your own touching each skill's files, so the selection can show what a re-apply would discard.

**Selection**: presents the installed skills and lets you pick which to re-apply.

**Re-apply**: invokes each selected skill's own apply (e.g. `/add-slack`), which fetches its latest files. Then validates with build + test.

---

# Goal
Help users pull the latest skill code from upstream by re-applying their installed skills, without losing local customizations and without merging any branch.

# Operating principles
- Never proceed with a dirty working tree.
- Re-apply each skill through its own idempotent apply step — re-applying overwrites that skill's code files, local edits to them included (Step 1.5 surfaces those); credentials, wiring, and DB state are untouched.
- Keep token usage low: detect installed skills with `git` and barrel reads; let each skill's apply do its own fetching.

# Step 0: Preflight

Run:
- `git status --porcelain`

If output is non-empty:
- Tell the user to commit or stash first, then stop.

Check remotes:
- `git remote -v`

The skill branches live on the canonical repo, which is `origin` only for a direct clone of it — in a fork it is `upstream`, and in a clone of a fork no remote has it yet. Resolve the remote instead of assuming, then fetch the branches that carry skill code:

```bash
source setup/lib/channels-remote.sh && REMOTE=$(resolve_channels_remote)
git fetch "$REMOTE" channels providers --prune
```

`resolve_channels_remote` picks the remote pointing at the canonical repo, and adds `upstream` (`https://github.com/nanocoai/nanoclaw.git`) if none is configured. If it resolves to something the user does not expect, confirm before continuing.

# Step 1: Detect installed skills

**Channels** — read `src/channels/index.ts` and collect each `import './<name>.js';` line, excluding `cli`. Each `<name>` maps to the `/add-<name>` skill.

**Providers** — read `src/providers/index.ts` the same way; each imported provider maps to its `/add-<name>` skill.

**Operational and utility skills** — list the folders under `.claude/skills/`. These copy no code into the tree, so "re-applying" them just re-reads their instructions; only include them if the user specifically wants to re-run a workflow.

Build the candidate list from the channels and providers actually wired into the barrels — those are the skills whose copied code can be refreshed from upstream.

# Step 1.5: Detect local edits to skill-owned files

Re-applying overwrites a skill's code files from the branch, discarding any local edit to them. Detect those edits now so Step 2 can price them into the choice.

Collect each skill's owned paths from its own copy steps — read `.claude/skills/add-<name>/SKILL.md` and take every destination path it writes. A channel owns several: `/add-telegram` writes `src/channels/telegram.ts`, `src/channels/telegram-pairing.ts`, `src/channels/telegram-markdown-sanitize.ts`, their tests, and an append to `setup/index.ts`. A provider spans `src/providers/<name>.ts` and `container/agent-runner/src/providers/<name>.ts`. Some channels also own a container skill under `container/skills/`.

For each skill, list local commits touching those paths:

- `git log --oneline "$REMOTE"/channels..HEAD -- <the skill's paths>`
- For a provider, use `"$REMOTE"/providers..HEAD` instead.

Read the range as "on HEAD, absent from the branch". Diffing against the branch tip instead would report every upstream advance as a local edit — that advance is the reason to run this skill at all, so the warning would fire on every skill every time and train the user to skip real updates.

Expect one commit per skill with no local edits: the apply that installed it. Judge by commit message; anything beyond the install commit is a local edit.

For each skill with local edits, record the commit count and subjects for Step 2. Show the diff on request with `git diff origin/<branch>..HEAD -- <paths>`.

When a skill has local edits, tell the user where the change belongs: on the `channels`/`providers` branch (upstream via PR, or their own fork of it). Re-applying discards it; skipping keeps it and leaves that skill on older code. If the edit needs a hook that trunk doesn't expose, the hook belongs in trunk — `src/channels/chat-sdk-bridge.ts` and its siblings — with the adapter calling into it.

# Step 2: Present results

If no channel or provider skills are installed:
- Tell the user there are no code-carrying skills to update. List any operational skills present for reference.
- Stop here.

If installed channel/provider skills are found:
- Show the list (e.g. `slack`, `discord`, `opencode`).
- Use AskUserQuestion with `multiSelect: true` to let the user pick which skills to re-apply.
  - One option per installed channel/provider (e.g. "Re-apply Slack (/add-slack)").
  - Where Step 1.5 found local edits, say so in that option's description — "2 local commits to these files will be discarded" — so the cost is visible at the moment of choosing rather than as a separate gate.
  - Add an option: "Skip — don't update any skills now".
- If the user selects Skip, stop here.

# Step 3: Re-apply each selected skill

For each selected skill (process one at a time):

1. Tell the user which skill is being re-applied.
2. Invoke the corresponding `/add-<name>` skill using the Skill tool.
   - Its apply runs its own pre-flight, fetches the latest files from upstream (`git fetch "$REMOTE" <branch>` + `git show "$REMOTE"/<branch>:path > path`), overwrites the copied-in code, and installs any pinned dependency.
   - Re-applying is additive across skills but wholesale within one: it refreshes that skill's own files from the branch, overwriting local edits to them (Step 1.5). The barrel import line is left in place if already present, and `.env` credentials and DB wiring are untouched.
3. If a skill's apply reports a problem (a missing upstream file, a failing dependency install), record it and continue with the remaining skills.

# Step 4: Validation

After all selected skills are re-applied:
- `pnpm run build`
- `pnpm test` (do not fail the flow if tests are not configured)
- If the re-apply changed any files under `container/` (`git diff --name-only -- container/` is non-empty), rebuild the agent image so new sessions pick up the new code: `./container/build.sh`. Skill code that lives in the container (e.g. a provider's runtime) keeps running the old image until this is done — the rebuild is what makes the fix live, not the file copy. If nothing under `container/` changed (e.g. only a channel adapter was re-applied), skip it.

Each channel/provider skill copies in its own registration test; those run as part of `pnpm test` and assert the barrel still registers the adapter against the freshly fetched code.

If build fails:
- Show the error.
- Only fix issues clearly caused by the refreshed code (missing imports, type mismatches).
- Do not refactor unrelated code.
- If unclear, ask the user.

# Step 5: Summary

Show:
- Skills re-applied (list)
- Skills skipped or that reported problems (if any)
- New HEAD: `git rev-parse --short HEAD`

If the service is running, remind the user to restart it to pick up the refreshed code.
