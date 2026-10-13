# Auto-merge sweep honours the standing-violation hold

## Summary

The Priority 1.65 auto-merge sweep did not read PR labels. A PR held with
`standing-violation` (Issue #3382) could therefore be armed on a later cycle.
The sweep now honours the hold:

- **Labels come from the live read.** The per-PR `gh pr view` read in
  `pr_live_state.ts` adds `labels` to its fields
  (`PR_LIVE_STATE_JSON_FIELDS`). It is still one round trip.
  `PrLiveFields.labels` and `PrLiveStateReading.labels` carry the names. The
  per-author listing and the cross-repo prefetch are unchanged, so they cost
  nothing extra.
- **Held PRs are skipped.** `auto_merge_sweep.ts` checks for the label after
  the live read confirms the PR is open. It runs before the base-integrity
  check (#3433), any merge attempt and any branch update. A held PR is logged
  once per process, keyed `repo#N`, the same way drafts are (#1800).
- **An armed held PR is disarmed.** The sweep calls the existing
  `disarmAutoMerge` helper (`auto_merge_disarm.ts`), which runs
  `gh pr merge --disable-auto`. It does this on every sweep until the disarm
  succeeds. A successful disarm marks the sweep as mutated.

Only the sweep checks the label. The CI-fix pass (`pr_ci_processor.ts`) still
re-arms auto-merge after it pushes a fix, without reading the label. The
issue asks only for the sweep, and the docs now say so.

Labels are read live and never cached. No persisted shape changes, so no cache
key needs bumping.

`parsePrLiveFields` also loses a dead `typeof parsed !== "object"` branch. It
could never run, because the function already requires the text to start with
`{` before `JSON.parse`, so the parsed value is always an object.

Closes #3517.

## Acceptance Criteria

- met — give the sweep the PR's labels through the per-PR live read, weighing
  the listing cost; evidence: `PR_LIVE_STATE_JSON_FIELDS` ends `,labels`, and
  the listing field set is unchanged; reviewer: spec-reviewer
- met — skip any PR carrying `standing-violation`; evidence: test
  "standing-violation PR is not attempted while an unlabelled sibling still
  is"; reviewer: spec-reviewer
- met — log the hold once per process, as drafts are logged; evidence: test
  "hold is logged once per process, while an armed PR is disarmed on each
  sweep until it succeeds"; reviewer: spec-reviewer
- met — disarm an already-armed PR with `gh pr merge --disable-auto`;
  evidence: tests "armed standing-violation PR is disarmed once, never
  attempted, recorded or branch-updated" and "production ensureAutoMerge
  disarms an armed standing-violation PR"; reviewer: spec-reviewer
- met — a labelled PR is not armed and an unlabelled sibling still is;
  evidence: test "standing-violation PR is not attempted while an unlabelled
  sibling still is"; reviewer: spec-reviewer
- unrequested — the `autoMergeGhCommandFn` seam in
  `run_core_production_deps.ts`; reason: lets the wiring test assert the real
  disarm argv, and production still defaults to `runGhCommand`
- unrequested — the dead object check removed from `parsePrLiveFields`;
  reason: the branch was unreachable, as explained in the Summary

## Standards Review

The independent Standards reviewer found no violations and no optional
findings. It checked that every named test exists, that the `gh` stub is no
more permissive than `gh`, that no workflow changed, that removing the dead
branch is safe, that nothing persisted changed shape, and the spelling and
docs.

## Spec

### Intent and Rationale

Issue #3382 holds a PR with a standing Standards violation by labelling it
instead of arming auto-merge. Because the sweep could not see labels, it could
undo that hold. The sweep must treat the label as a hold, and it must disarm a
PR that is already armed. Otherwise auto-merge that was armed before the label
went on would still land the breach.

### Essential Design Decisions

- **Read labels from the live read, not the listing.** The issue flagged that
  the per-author listing's fields are shared with the cross-repo prefetch.
  The sweep already makes a live `gh pr view` read for each candidate, so
  adding `labels` there adds no API call. Being live, it also sees a label
  applied after the cached listing was taken.
- **Check before base-integrity.** A held PR must not trigger the #3433
  base-integrity path, which can write to the PR. The test "base integrity is
  not checked for a held PR" pins this order.
- **Retry the disarm, but log once.** The log is deduplicated per process to
  match drafts. The disarm is retried on each sweep, because a failed disarm
  leaves the PR armed. A failed disarm still never leads to a merge attempt.
- **Reuse `auto_merge_disarm.ts`.** The existing helper already owns the
  `--disable-auto` call and its error handling, so it is not duplicated.

### Undiscoverable Facts

- `gh pr view --json labels` returns `[{ id, name, description, color }]`.
  `parseLabelNames` keeps only the string `name` values and ignores malformed
  entries. A malformed field reads as "no labels" and never throws.
- `PrLiveStateReading.labels` is optional so the existing fakes that build
  readings by hand keep compiling. The production reader always sets it.

## Evidence

Backend change, so there is no web interface to screenshot.

`./quality.sh < /dev/null` passed (`Result: PASSED (with skipped checks)`).
`config integration` was skipped because no `.config.json` exists in the
worktree. Targeted run at head: `deno test -A tests/auto_merge_sweep_test.ts
tests/auto_merge_sweep_disarm_wiring_test.ts
tests/pr_branch_update_merged_midflight_test.ts tests/pr_live_state_test.ts`
gave 81 passed, 0 failed.

- **Docs sweep** — grep: "Known gap", `standing-violation`, `#3517`,
  `disable-auto`, `PR_LIVE_STATE_JSON_FIELDS`, `--json state,mergeable`,
  "draft"; section: the README `standing-violation` label row, the
  auto-merge sweep section of `docs/MERGE.md`, and the live-read paragraphs in
  `docs/INTERNALS.md` and `docs/workflows/merge-conflicts.md`; siblings:
  `reviewDecision`, `autoMergeRequest` (the existing live-read fields, each
  list now names `labels`); updated: `README.md`, `docs/INTERNALS.md`,
  `docs/MERGE.md`, `docs/workflows/issue-processing.md`,
  `docs/workflows/merge-conflicts.md`, `docs/workflows/pr-feedback.md`, and
  comments in `completion_phase.ts`, `standing_violation_routing.ts` and
  `worker_label_guard.ts`.

## Test Plan

Every test below lives under `worker/deno/tests/`. Each was red-checked by
removing or breaking the code it guards, confirming it failed, then restoring
the code (`git status` clean afterwards).

- `auto_merge_sweep_test.ts`:
  - "standing-violation PR is not attempted while an unlabelled sibling still
    is"
  - "armed standing-violation PR is disarmed once, never attempted, recorded
    or branch-updated"
  - "unarmed standing-violation PR is held without a disarm call"
  - "base integrity is not checked for a held PR"
  - "hold is logged once per process, while an armed PR is disarmed on each
    sweep until it succeeds"
  - "failed disarm still yields no merge attempt"
  - "the hold line says it is disarming only for an armed PR". It pins the
    `armedHold ? ", disarming auto-merge" : ""` ternary in the hold log line
    (`auto_merge_sweep.ts:294`).
- `auto_merge_sweep_disarm_wiring_test.ts`: "production ensureAutoMerge
  disarms an armed standing-violation PR". It asserts the argv
  `pr merge 42 --repo … --disable-auto`.
- `pr_branch_update_merged_midflight_test.ts`:
  - "parsePrLiveFields - reads label names from the gh labels shape"
  - "parsePrLiveFields - malformed labels are tolerated, keeping only valid
    names"
  - "makeGhPrStateFetcher - asks gh for state and mergeable, and returns the
    payload raw"
- `pr_live_state_test.ts`:
  - "readPrLiveState - an open PR surfaces its label names"
  - "readPrLiveState - the live read asks gh for labels (Issue #3517)". It
    compares `PR_LIVE_STATE_JSON_FIELDS` with the literal
    `state,mergeable,autoMergeRequest,mergeStateStatus,reviewDecision,labels`.

The existing exact-argv assertions in "readPrLiveState - an open PR reads as
open, with its mergeable verdict", "isPrLiveStateRead - recognises this read's
own argv, and nothing else" and "makeGhPrStateFetcher - asks gh for state and
mergeable, and returns the payload raw" still pin a literal field string. It
is now the six-field
`state,mergeable,autoMergeRequest,mergeStateStatus,reviewDecision,labels`, not
the production constant, so dropping any field fails a test.

Removed or rewritten assertions. #3517 adds `labels` to the live read's
`--json` fields and to every parsed reading (`PrLiveFields.labels`,
`PrLiveStateReading.labels`). Each old assertion below pinned the five-field
string or a reading shape without `labels`, so it is untrue at the head. Each
is re-asserted in the same test with `labels: []` added to the expected
reading, or with `,labels` appended to the literal field string:

- Removed from `worker/deno/tests/pr_branch_update_merged_midflight_test.ts`: `assertEquals( parsePrLiveFields('{"mergeable":"CONFLICTING","state":"OPEN"}'), { state: "OPEN", mergeable: "CONFLICTING", armed: false, behind: false, }, );` — #3517 adds `labels` to every parsed reading, so the old shape without it is untrue
- Removed from `worker/deno/tests/pr_branch_update_merged_midflight_test.ts`: `assertEquals(parsePrLiveFields('{"mergeable":"mergeable","state":"OPEN"}'), { state: "OPEN", mergeable: "MERGEABLE", armed: false, behind: false, });` — #3517 adds `labels` to every parsed reading, so the old shape without it is untrue
- Removed from `worker/deno/tests/pr_branch_update_merged_midflight_test.ts`: `assertEquals(parsePrLiveFields('{"mergeable":null,"state":"OPEN"}'), { state: "OPEN", mergeable: "UNKNOWN", armed: false, behind: false, });` — #3517 adds `labels` to every parsed reading, so the old shape without it is untrue
- Removed from `worker/deno/tests/pr_branch_update_merged_midflight_test.ts`: `assertEquals(parsePrLiveFields("CLOSED\n"), { state: "CLOSED", mergeable: "UNKNOWN", armed: false, behind: false, });` — #3517 adds `labels` to every parsed reading, so the old shape without it is untrue
- Removed from `worker/deno/tests/pr_branch_update_merged_midflight_test.ts`: `assertEquals(parsePrLiveFields("[]"), { state: "UNKNOWN", mergeable: "UNKNOWN", armed: false, behind: false, });` — #3517 adds `labels` to every parsed reading, so the old shape without it is untrue
- Removed from `worker/deno/tests/pr_branch_update_merged_midflight_test.ts`: `assertEquals( calls[0]!.includes( "state,mergeable,autoMergeRequest,mergeStateStatus,reviewDecision", ), true, );` — #3517 adds `labels` to the `--json` fields, so the five-field argv is untrue; the six-field literal is asserted in its place
- Removed from `worker/deno/tests/pr_live_state_test.ts`: `assertEquals(reading, { open: true, mergeable: "CONFLICTING", armed: false, behind: false, });` — #3517 adds `labels` to every open reading, so the old shape without it is untrue
- Removed from `worker/deno/tests/pr_live_state_test.ts`: `assertEquals(calls, [[ "pr", "view", "12", "--repo", "owner/repo", "--json", "state,mergeable,autoMergeRequest,mergeStateStatus,reviewDecision", ]]);` — #3517 adds `labels` to the `--json` fields, so the five-field argv is untrue; the six-field literal is asserted in its place
- Removed from `worker/deno/tests/pr_live_state_test.ts`: `assertEquals( await readPrLiveState( "owner/repo", 12, () => Promise.resolve('{"mergeable":"MERGEABLE","state":"OPEN"}'), ), { open: true, mergeable: "MERGEABLE", armed: false, behind: false, }, );` — #3517 adds `labels` to every open reading, so the old shape without it is untrue
- Removed from `worker/deno/tests/pr_live_state_test.ts`: `` assertEquals( await readPrLiveState("owner/repo", 12, () => Promise.resolve(raw)), { open: true, mergeable: "UNKNOWN", armed: false, behind: false, }, `raw payload ${raw} must read as an unknown mergeable`, ); `` — #3517 adds `labels` to every open reading, so the old shape without it is untrue
- Removed from `worker/deno/tests/pr_live_state_test.ts`: `assert( isPrLiveStateRead([ "pr", "view", "7", "--json", "state,mergeable,autoMergeRequest,mergeStateStatus,reviewDecision", ]), );` — #3517 adds `labels` to the `--json` fields, so the five-field argv is no longer this read's own argv; the six-field literal is asserted in its place
- Removed from `worker/deno/tests/pr_live_state_test.ts`: `assertEquals(reading, { open: true, mergeable: "MERGEABLE", armed: false, behind: false, });` — #3517 adds `labels` to every open reading, so the old shape without it is untrue
- Removed from `worker/deno/tests/pr_live_state_test.ts`: `assertEquals(reading, { open: true, mergeable: "MERGEABLE", armed: true, behind: true, });` — #3517 adds `labels` to every open reading, so the old shape without it is untrue
- Removed from `worker/deno/tests/pr_live_state_test.ts`: `assertEquals(reading, { open: true, mergeable: "MERGEABLE", armed: false, behind: true, });` — #3517 adds `labels` to every open reading, so the old shape without it is untrue
- Removed from `worker/deno/tests/pr_live_state_test.ts`: `assertEquals(blocked, { open: true, mergeable: "MERGEABLE", armed: true, behind: true, changesRequested: true, });` — #3517 adds `labels` to every open reading, so the old shape without it is untrue

Red-checks:

- Deleting the hold block failed 6 tests.
- Making the log guard always true failed "hold is logged once per process…".
- Replacing `armedHold &&` with `false &&` failed 3 tests.
- Dropping `mutated = true` failed "armed standing-violation PR is disarmed
  once…".
- Removing `,labels` from the fields failed 4 tests: the three exact-argv
  tests and "the live read asks gh for labels".
- Negating the `armedHold ?` ternary in the hold log line failed "the hold
  line says it is disarming only for an armed PR".
- Making `parseLabelNames` return `[]` failed 3 tests.
- Not passing labels through `readPrLiveState` failed 9 tests.
- Replacing the production `disarmAutoMerge` with a no-op failed the wiring
  test.

**Branch outcomes:**

- `worker/deno/lib/auto_merge_sweep.ts:286`, labelled PR is held → "unarmed
  standing-violation PR is held without a disarm call"; deleting the block
  went red.
- `worker/deno/lib/auto_merge_sweep.ts:286`, unlabelled PR proceeds →
  "standing-violation PR is not attempted while an unlabelled sibling still
  is"; this asserts the sibling is attempted.
- `worker/deno/lib/auto_merge_sweep.ts:289`, first sighting logs, repeat does
  not → "hold is logged once per process…"; forcing the guard true went red.
- `worker/deno/lib/auto_merge_sweep.ts:294`, armed hold says "disarming
  auto-merge", unarmed hold does not → "the hold line says it is disarming
  only for an armed PR"; negating the ternary went red.
- `worker/deno/lib/auto_merge_sweep.ts:299`, operand `armedHold` false (not
  armed) → "unarmed standing-violation PR is held without a disarm call";
  operand `armedHold` true → "armed standing-violation PR is disarmed once…";
  replacing it with `false` went red.
- `worker/deno/lib/auto_merge_sweep.ts:299`, operand disarm succeeds → marks
  mutated, "armed standing-violation PR is disarmed once…"; dropping
  `mutated = true` went red. Disarm fails → "failed disarm still yields no
  merge attempt".
- `worker/deno/lib/pr_branch_update.ts:203`, non-array `labels` →
  "parsePrLiveFields - malformed labels are tolerated…".
- `worker/deno/lib/pr_branch_update.ts:206`, non-object entry skipped →
  "parsePrLiveFields - malformed labels are tolerated…".
- `worker/deno/lib/pr_branch_update.ts:208`, string name kept →
  "parsePrLiveFields - reads label names from the gh labels shape"; returning
  `[]` went red.
