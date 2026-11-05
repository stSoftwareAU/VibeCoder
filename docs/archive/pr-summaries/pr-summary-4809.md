## Summary

The fast-failure tally recorded `setup after 26s: Aborting` for #4658, so the
diagnostic issue gave no hint why setup failed. `diagnosticErrorLine` kept the
last line of a multiline Git refusal, and Git ends a refused checkout or merge
with the generic `Aborting`. The recorded detail now keeps the refusal itself
(`error: Your local changes to the following files would be overwritten by
checkout:`).
Closes #4809.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- The tally issue is a symptom report; the actionable defect is that its comment
  dropped the cause. Fixing the line selection makes the next failure
  diagnosable.
- Chosen over special-casing checkout text: the existing uninformative-line list
  already skips git's trailers, so the advice lines join it; the indented path
  lines are dropped by a separate filter (see Essential Design Decisions).

### Essential Design Decisions

- Tab-indented lines (git's list of affected paths) are dropped after the whole
  message is redacted and before the 20-line window is cut, so a refusal
  listing any number of paths keeps its `would be overwritten` cause line (PR
  #4816 review round 2). The setup path joins refusals with `; `, gluing
  `Aborting` onto the next command's line, so `Aborting; ` is split back onto
  its own line first. If every line is a path line, the true last line is
  kept. Git's advice under a refusal
  (`Please commit your changes or stash them before you switch
  branches|merge.`
  for tracked edits,
  `Please move or remove them before you
  switch branches|merge.` for untracked
  files) is skipped only when an informative line exists; otherwise the true
  last line is kept, as before.
- Lines are matched on their trimmed form but only `trimEnd` is applied before
  the tab test, so the indentation is still visible to it; the chosen line is
  trimmed and redacted again before it is bounded.

### Undiscoverable Facts

- The underlying cause of the #4658 setup abort (a local change blocking a
  checkout) is not reproduced here; this PR only restores the diagnostic text.

## Evidence

Command: `git checkout -B feature other` in a repository with a local edit to a
file that differs on `other` prints, on stderr,
`error: Your local changes to the following files would be overwritten by checkout:`,
a tab-indented path,
`Please commit your changes or stash them before you switch branches.` and
`Aborting`. The untracked-file refusal (`git checkout -B feature other` with an
untracked `newfile.txt` that `other` tracks, git 2.47.3) prints
`error: The following untracked working tree files would be overwritten by checkout:`,
a tab-indented path, `Please move or remove them before you switch branches.`
and `Aborting`. The code depends on those shapes; the checkout tests build them
with the real `git`.

## Reproduction

- **symptom** — a fast-failure comment read `setup after 26s: Aborting`, with no
  cause
- **status** — `verified` — the new tests fail against the base
  `repo_fast_failure_tracker.ts` (49 passed, 4 failed) and pass with the fix
  (the file now has 53 tests, all passing)
- **regression test** —
  `worker/deno/tests/repo_fast_failure_tracker_test.ts::diagnosticErrorLine - Git checkout's Aborting trailer preserves its cause`

## Test Plan

- `worker/deno/tests/repo_fast_failure_tracker_test.ts`: added
  `diagnosticErrorLine - Git checkout's Aborting trailer preserves its cause`
  (real git),
  `diagnosticErrorLine - a checkout refused over untracked files keeps its cause`
  (real git) and
  `diagnosticErrorLine - a refused merge keeps its cause, not the advice and Aborting`
  and (round 2)
  `diagnosticErrorLine - a refusal listing more paths than the window keeps its cause (PR #4816 review)`
  (real git, 30 tracked files edited locally, raw stderr and the
  `createFeatureBranchFromBase`-wrapped form; red check against the head before
  this round's fix: `Expected actual: "Aborting" to contain: "would be
  overwritten by checkout"`).
  Red check: base production file restored, all four new tests fail (49
  passed, 4 failed); with only the `move or remove them` alternative removed, the
  untracked-file test fails
  (`Expected actual: "Please move or remove them
  before you switch branches." to contain: "untracked working tree files would
  be overwritten"`)
  and the other three pass (52 passed, 1 failed).
- `deno task test:unit tests/repo_fast_failure_tracker_test.ts`: 53 passed, 0
  failed.
- Existing `diagnosticErrorLine` tests (last non-empty line, multi-line secret
  redaction, length bound) pass unchanged.
- Docs: `docs/CONFIGURATION.md` fast-failure paragraph now says the detail skips
  generic trailing lines such as `Aborting`, git's `Please commit your changes
  or stash them…` / `Please move or remove them…` advice and the indented path
  list.

- `./quality.sh`: every stage passed except `deno tests`, which failed only
  `worker/deno/tests/completion_phase_repo_formatters_test.ts` (lines 480 and
  567, Rust formatter). Neither this change nor its dependencies touch that
  file; I did not compare against `main`.

Not done: the cause of the #4658 abort itself is not investigated. After PR
#4816 review rounds 1 and 2 the full `./quality.sh` was not re-run (targeted tests,
formatter and linter only). `deno task pr-summary-check` ran on the final
summary: 0 gates blocked, 3 not checked (no issue body or labels supplied).
