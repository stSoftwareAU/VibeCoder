# Gate-Skip Drift Audit

This audit compares this repository's **local quality gate** with its **own
CI**, and files one issue when the gate skips a tool that CI installs and runs.
That drift is what let NEAT-AI-core PR 597 pass its local gate and fail in CI:
`quality.sh` printed `bats not installed — skipping` inside the Vibe Coder's
container while the pull request's CI ran all 394 BATS tests. Australian English
(behaviour, colour, organisation, analyse) is used in all human-readable output.

## Who performs this audit

**A native scanner does, before this issue exists.** No model turn is involved
and nothing in this body is work for a person or an agent to carry out: every
section below is an indicative description of what the scanner already did, and
the deliverable is the finding issue it filed. A worker that picks this issue up
should take no action on it — the audit **never** opens a pull request and
**never** edits a file. Each repository owns its own gate, and the fix rides a
normal `work-on` pipeline PR later. Repositories are **absolutely isolated**:
this audit only reports the drift and raises an issue.

## What the scanner checks

- **The gate script.** `quality.sh` is read for the shape
  `command -v <tool> … || echo "… not installed — skipping"` — in both its
  `if … then … else` and its `||` spelling. An `exit` disqualifies only the
  branch it sits in: a gate that runs the tool and exits on *its* failure still
  skips when the tool is absent, while an `exit` in the branch that carries the
  skip line means the gate stops rather than skipping, and is never reported.
- **The repository's own workflows.** `.github/workflows/*` are parsed for an
  install-and-run of that same tool: a `run:` step invoking it, or a `uses:`
  action that runs it (`codespell-project/actions-codespell`). A bare
  `<tool> --version` probe and a `setup-*` action are installs, not enforcement,
  so neither on its own makes a finding.
- **What the image already carries.** A tool pinned as a toolchain in
  `container/tools.json` whose `repos` list names this repository is dropped:
  the image carries it, so the gate no longer skips.

## Findings — one per repository

Every drifting tool found is reported on a single issue labelled
`gate-skip-drift` plus `severity:high`, naming each tool with **both lines**:
the `quality.sh` line that announces the skip, and the workflow line that
enforces it. The fix is one of two, and the issue says so: bake the tool into
the image (`container/tools.json`, naming this repository) so the gate runs it,
or make the gate fail loud instead of skipping.

## Fail-loud contract

The scanner **never returns a silent green on error**. A gate script that exists
but cannot be read, a container manifest that will not parse, or a workflow file
that cannot be read or parsed as YAML, surfaces as a loud failure on this
wrapper issue and replaces the count — an audit that could not complete is never
reconciled as "no findings". A repository with no `quality.sh`, or with no
workflows at all, produces no finding rather than a false one.

## In-code suppression

A drifting tool can be waived by adding a governed
`best-practice-ignore: BP-GATE-SKIP-<TOOL> — author=<github-login> expires=<YYYY-MM-DD> <reason>`
comment (the shared idle-task grammar) as a `#` comment on or immediately above
the skip line in `quality.sh`.

All three fields are mandatory. The suppression check honours a marker — and
drops the tool — **only** when `author=` is present and non-empty, `expires=` is
a real `YYYY-MM-DD` calendar date that is today or later, and non-empty reason
text follows. A marker missing any field, or carrying a malformed or past
expiry, **does not suppress**: the drift is reported as normal and the run
records `Rejected suppression: <file>:<line> <id> — <failed check>` rather than
silently obeying the marker. This is the rule the deterministic suppression
check applies, and every triage path that reads these markers applies the same
three-field check — so the paths cannot drift.

---

{{ATTRIBUTION_FOOTER}}
