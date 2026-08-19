#!/usr/bin/env python3
"""Preload a topic agent's workspace: plans/, outputs/, outputs/.verify/, and
deliverable templates under .templates/. Idempotent — existing files are
never touched. Run from /workspace/agent:

    python3 preload_workspace.py [report] [presentation|pptx] [infographic]

Pass the deliverable type(s) the charter names; no args creates folders only.
"""
import sys
from pathlib import Path

TEMPLATES = {
    "report": """# <Report title>

Date:
Plan: plans/<the plan this report executes>
Key result moved: KR<n> — <how the number moved>

## Summary
<three sentences a reader on a phone can act on>

## Findings
<one heading per finding, evidence inline, source URLs>

## Verification
<what the done-condition check was, and where its evidence lives under
outputs/.verify/>

## Open items
<what is unresolved, who owns it>
""",
    "presentation": """# <Deck title>

Format: .pptx via the `pptx` skill, or HTML via `frontend-slides` — the
charter's constraints decide. Build into outputs/, keep this outline here.
Key result moved: KR<n>

## Slide 1 — title
<title, date, who it is for>

## Slide 2..n — one finding per slide
<the takeaway IS the slide title; evidence and source URL on the slide>

## Final slide — next steps
<decisions needed, owners, dates>
""",
    "infographic": """# <Infographic title>

One page, one message. Build with `diagram-design` (export PNG to outputs/).
Key result moved: KR<n>

## Headline
<the single number or claim the page exists to show>

## Supporting points
<three to five data points, each with a source URL>

## Visual form
<what shape shows it: timeline, comparison, flow, map>
""",
    "html": """# <Page title>

One self-contained .html file in outputs/, built with `frontend-engineer`.
The user cannot open your filesystem: deliver it with `send_file`.
Key result moved: KR<n>

## Purpose
<what the reader does with this page: explore data, read findings, compare options>

## Sections
<one heading per section, the data or findings each shows, source URLs>

## Interactions
<what is clickable, filterable, or sortable — or "static" if nothing>

## Recurring? Build it data-driven, once
If this page is rebuilt on a cadence (a digest, dashboard, or standing report),
do NOT regenerate the HTML each cycle. Build the template ONCE: a fixed render
script plus a single `const DATA = {...}` object. Each cycle you edit only DATA;
the script draws every card/row/stat/heatmap cell from it, and counts, ordering
and filters are COMPUTED from DATA, never tallied by hand. Hand-writing each
item is what makes a build run for many minutes and trip the API request
timeout (~10 min per request); emitting a small data object does not.
""",
}
TEMPLATES["pptx"] = TEMPLATES["presentation"]

root = Path.cwd()
for d in ("plans", "outputs", "outputs/.verify", ".templates"):
    (root / d).mkdir(parents=True, exist_ok=True)

made, kept = [], []
for t in sys.argv[1:]:
    if t not in TEMPLATES:
        sys.exit(f"unknown template '{t}' — choose from: {', '.join(sorted(TEMPLATES))}")
    dest = root / ".templates" / f"{'presentation' if t == 'pptx' else t}.md"
    if dest.exists():
        kept.append(dest.name)
    else:
        dest.write_text(TEMPLATES[t])
        made.append(dest.name)

msg = f"workspace ready at {root}: plans/ outputs/ outputs/.verify/ .templates/"
if made:
    msg += f" — seeded {', '.join(made)}"
if kept:
    msg += f" — already present, untouched: {', '.join(kept)}"
print(msg)
