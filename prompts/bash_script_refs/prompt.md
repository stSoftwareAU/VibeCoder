# Bash Script-Reference Scan
**Who acts on this issue.** A native scanner performs this check — it has
already run by the time you read this. Nothing on this page asks you to run
it, and no model is invoked at any point. This body records *what the scanner
looks for*, *what it filed*, and *what a human does next*. The only section
addressed to a reader is
[What a human does next](#what-a-human-does-next); every other section
describes behaviour the scanner and its issue filer already implement in code.

## Why this scan exists

The scanner statically resolves every `source` / `.` / `fleet_source_or_fail` /
`bash …` reference in the repository's shell scripts and reports any whose
target is **not a regular file on disk**. This is the layer-2 companion to the
`bash -n` syntax check (layer 1): `bash -n` proves the syntax is valid, but a
`source`d helper is only resolved at *first execution* — so a helper that was
deleted or renamed in a PR passes `bash -n`, then fails at runtime with exit
127. That exact failure took down FLEET's Discovery loop and went undetected for
weeks. Australian English (behaviour, colour, organisation, analyse) is used in
all human-readable output.

The check is **deterministic and native** — no LLM judgement is involved. It is
also **issue-only**: the deliverable is a set of GitHub findings issues. The
scan **never** opens a pull request or edits a file — the fix flows through the
normal `work-on` pipeline after a human confirms intent.

## What the scanner does

- Walks every `*.sh` file in the repo (skipping `.git`, `node_modules`, and
  other build/vendor directories), extracting **string-literal** references
  from `source "…"`, `. "…"`, `fleet_source_or_fail "…"`, `bash …/foo.sh`, and
  `./foo.sh` invocations.
- Resolves repo path conventions — `${SCRIPT_DIR}` (the script's own
  directory), `${REPO_DIR}` (the repo root), and the ambiguous `${BASE_DIR}` /
  `${SHARED_DIR}` and plain relative paths (tried against the script's own
  directory, every ancestor up to the repo root, and the repo root itself) —
  and honours `# shellcheck source=repo/relative/path` annotations, which are
  authoritative when present.
- Reports a reference **only when no interpretation resolves to a regular
  file** — keeping the false-positive rate at zero on a known-good tree.

## Known limitations (documented, not silent)

- **Dynamic references are skipped**, not flagged: command substitution
  (`source "$(dirname "$0")/x.sh"`), unknown/runtime-only variables
  (`${__FLEET_*}`), globs, absolute paths, and any reference preceded by a
  same-line `cd` cannot be resolved statically.
- **Test harnesses are excluded at v1** (`test_*` basenames and anything
  under a `test/` or `tests/` directory) so the rules can stabilise before
  the exclusion is relaxed.

## Worked examples — the reported / not-reported boundary

The whole value of the scan sits in one boundary: which references resolve,
which are reported, and which are skipped as dynamic. These examples show that
boundary, including the near-misses.

<examples>
<example name="script-dir-missing-target">
<source_line>worker/run.sh:42 — source "${SCRIPT_DIR}/lib/helpers.sh"</source_line>
<paths_tried>worker/lib/helpers.sh</paths_tried>
<on_disk>none</on_disk>
<verdict>REPORTED — `${SCRIPT_DIR}` is unambiguous (the script's own
directory), the single candidate does not exist, so this is an exit-127 break
waiting to happen.</verdict>
</example>

<example name="ambiguous-root-resolves-via-ancestor">
<source_line>worker/stages/build.sh:8 — source "${SHARED_DIR}/logging.sh"</source_line>
<paths_tried>worker/stages/logging.sh, worker/logging.sh, logging.sh</paths_tried>
<on_disk>worker/logging.sh</on_disk>
<verdict>NOT REPORTED — an ambiguous root is tried against the script's
directory, every ancestor, and the repo root; one interpretation resolves, so
the reference is sound. The near-miss to the example above: same shape, but
the ancestor candidate exists.</verdict>
</example>

<example name="dynamic-command-substitution">
<source_line>worker/run.sh:11 — source "$(dirname "$0")/x.sh"</source_line>
<paths_tried>none — command substitution cannot be resolved statically</paths_tried>
<on_disk>unknown</on_disk>
<verdict>SKIPPED, NOT REPORTED — counted as a documented dynamic skip, never
silently reconciled as "checked and clean".</verdict>
</example>

<example name="shellcheck-annotation-resolves">
<source_line>worker/stages/deploy.sh:3 — # shellcheck source=worker/shared/stage_fail_marker.sh
worker/stages/deploy.sh:4 — source "${__FLEET_SHARED}/stage_fail_marker.sh"</source_line>
<paths_tried>worker/stages/worker/shared/stage_fail_marker.sh, worker/shared/stage_fail_marker.sh</paths_tried>
<on_disk>worker/shared/stage_fail_marker.sh</on_disk>
<verdict>NOT REPORTED — `${__FLEET_SHARED}` alone would be a dynamic skip, but
the `# shellcheck source=` annotation supplies an authoritative candidate that
resolves. Had that annotated path been missing, the reference would be
REPORTED rather than skipped.</verdict>
</example>
</examples>

## Fail-loud contract

The scanner **never returns a silent green on error**. A directory-walk or
file-read failure surfaces as a loud failure and is reported on this wrapper
issue — a scan that cannot complete is never reconciled as "no findings".

## Findings — prevention first

Each missing target is filed as its own deduped issue labelled
`bash-missing-script` (a silent production failure → high severity), keyed on
the missing path so the same target is never double-filed. The filer builds
every finding body in code; the sections below are a description of that
contract, not instructions to a reader:

1. **Primary — fix + guard.** The body names the stale reference and its
   likely fix (correct the path, restore the helper, or delete the dead
   `source` line) under `## Fix (do this first)`, and recommends wiring a
   **repo-local layer-2 CI guard** under
   `## Prevent recurrence (repo-local layer-2 CI guard)` so this regression
   class cannot recur. Reference pattern: FLEET
   `test/unit/worker/WorkerSourcePathsExist.ts` (a dispatcher-scoped static
   guard that asserts every sourced path exists) plus
   `worker/shared/stage_fail_marker.sh`'s `fleet_source_or_fail` fail-loud
   wrapper.
2. **Secondary (fallback only).** If intent is unclear, the labelled finding
   lets a human resolve it. Detection-only is the fallback, never the goal.
3. **Evidence.** `## Referenced from` lists every reference site as
   `file:line`, and `## Paths tried (none exist)` lists every candidate the
   resolver tried.

### How many issues one run may file

**There is no per-run ceiling, by design.** Every LLM-driven sibling scan caps
a run at six findings because a model must choose which candidates are worth
reporting; this scan makes no judgement — a reported path either exists on disk
or it does not. Each missing path is an independent runtime break with its own
fix, so truncating the set would leave known exit-127 faults unfiled. The
bounds that do apply are:

- **Dedup per missing path** — a target that already has an open
  `bash-missing-script` issue is never filed twice.
- **One wrapper at a time** — no new scan is filed while a wrapper issue is
  still open.
- **Weekly cadence** — at most one run per repo per week
  (`cooldownHours: 168`).

A repo carrying thirty stale `source` lines therefore receives thirty issues on
its first scan and none on the next. That is expected, not a runaway.

## What a human does next

This is the only work this page asks of a reader:

1. Triage the filed `bash-missing-script` issues — each carries its own fix
   and prevention advice.
2. Close this wrapper issue once triaged. Closing it releases the next weekly
   scan.
3. If the scan reported a fail-loud error instead of findings, fix the cause of
   the walk/read failure — the scan is not "clean", it did not complete.

---

{{ATTRIBUTION_FOOTER}}
