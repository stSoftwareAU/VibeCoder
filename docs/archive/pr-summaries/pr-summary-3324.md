# PR Summary — Issue #3324

## Summary

Closes #3324

The first-run PR-summary claim check (#3257) could find a wrong sentence in
the PR summary and the PR still shipped with that sentence. This happened in
two ways:

- **Folded but not fixed (VibeCoder#3310).** The one in-run recovery turn got
  several gate notices joined by `---` into one block, fixed one of them, and
  left the claim.
- **Found only on the re-run (VibeCoder#3322).** The claim check flagged the
  sentence only after the recovery turn. That was the run's second block, so
  it went straight to `summary_incomplete` or failure.

This PR fixes both:

- **One numbered item per folded gate.** `foldInLateSummaryVerdicts` now
  returns the folded `sections` along with the combined comment.
  `buildSummaryRuleRetryPrompt` fences each section as its own
  `REQUIRED ITEM k of n`, says every item must be fixed, and asks the agent
  to name each item by number in its final message.
- **One summary-only correction turn.** On a later attempt where the claim
  check is the only gate still blocking, the completion phase marks the run
  `pending` for one correction turn (`summary_claim_correction.ts`) instead of
  reporting the block. That turn is a fresh agent invocation with `Bash` and
  every file-writing tool denied. It gets the gate comment and the current
  summary, fenced as untrusted data, and must reply with the whole corrected
  summary between `<!-- vibe-corrected-summary -->` markers. The worker writes
  that reply to the summary file, commits it, runs the quality gate again, and
  then runs completion again.
- **Wrong sentences cannot slip through on the re-run.** If a sentence the
  correction turn was shown as wrong is still in the summary,
  `carryForwardCorrectedClaims` adds it back as a finding. A flaky or failed
  model pass on the re-run cannot clear it. A sentence still wrong after the
  turn ships as `summary_incomplete`, or fails a no-PR run, exactly as before.

## Spec

### Intent and Rationale

The worker already holds the exact sentence and the reason it is wrong.
Fixing it is a bounded edit to a file the worker owns. What let it ship was
the order of the work: one recovery turn, spent before the claim surfaced, or
spent on a combined notice the agent only half-addressed.

### Essential Design Decisions

- **The worker writes the file, not the model.** The correction turn cannot
  edit anything (`SUMMARY_CLAIM_CORRECTION_DISALLOWED_TOOLS` =
  `CLOSURE_VERDICT_DISALLOWED_TOOLS` plus `Bash`; `Read`/`Grep`/`Glob` stay).
  So "edit only the summary file" is enforced by construction rather than by a
  post-hoc diff guard.
- **Completion is run again in full, not just the claim check.** The issue
  proposed re-running only the claim check. Running completion again re-checks
  every gate, so a rewrite cannot quietly break another summary rule.
- **At most once per run.** `shouldOfferClaimCorrection` offers the turn only
  after a recorded summary-rule block, and only while `summaryClaimCorrection`
  is unset. After the turn the state is `used`, so a new claim found on the
  next attempt goes through `reportSummaryRuleBlock` as before.
- **A `pending` deferral is not an infrastructure failure.**
  `runCompletionAttempt` returns early on `claimCorrectionPending`, so the
  #1550 infrastructure retry does not run `completionBody` again before the
  correction turn.
- **`isSummaryClaimPath` and `commitRecoveredSummary` are now exported.** The
  correction module reuses them: the first to refuse to write outside a
  recognised summary path, the second to commit the corrected file the same
  way the recovery turn does.

### Not done

- The issue's third bullet asked to check the #3316 run logs, to see whether
  the first-attempt claim check returned `notChecked` or simply missed the
  sentence. This branch does not record that investigation.

## Evidence

- `deno task test:unit tests/completion_phase_summary_claim_check_test.ts
  tests/summary_claim_correction_test.ts tests/summary_rule_gate_retry_test.ts`
  (from `worker/deno`): `ok | 45 passed | 0 failed`.
- Each new branch was flipped by hand and those three test files were run
  again (`deno test --no-check`). The results are listed under Branch outcomes
  below, and every flip was reverted.
- **Docs sweep** — grep: `recoverFromSummaryRuleBlock`, `buildSummaryRuleRetryPrompt`, `commitRecoveredSummary`, `isSummaryClaimPath`, `SummaryRuleRunVerdict`, `summaryRuleBlocks`, `summaryClaimCorrection`, `reportSummaryRuleBlock`, `foldInLateSummaryVerdicts`, "RETRY NOTICE", "Fix ONLY", "one recovery turn", "second block", `summary_incomplete`; section: `docs/workflows/issue-processing.md#-a-summary-that-describes-named-code-wrongly-blocks-the-pr-issue-3257`, `docs/workflows/issue-processing.md#-a-summary-shortfall-after-the-pr-is-not-a-failed-run`, `docs/workflows/issue-processing.md#-the-in-run-recovery-from-a-summary-rule-block`; updated: `docs/workflows/issue-processing.md`, `docs/INTERNALS.md`, `DESIGN-PRINCIPLES.md`
- **Docs sweep detail:**
  - The branch's own commits update the claim-check section, the outcome
    table, and the in-run recovery steps and second-block paragraph in
    `docs/workflows/issue-processing.md`. They also add the
    `summary_claim_correction.ts` row to `docs/INTERNALS.md`.
  - This summary commit fixes two places those commits missed:
    - The decision flowchart under "A summary shortfall after the PR is not
      a failed run" in `docs/workflows/issue-processing.md` still sent every
      second block straight to finalise/fail. It now has the claim-only
      correction-turn node.
    - `DESIGN-PRINCIPLES.md` said "A block that survives that turn — the run's
      second — finalises an existing PR as before". It now names the
      claim-only exception.
  - The other "second block" sentences in `docs/workflows/issue-processing.md`
    (docs sweep, removed assertions, placeholder and branch-outcomes gates)
    are about blocks that are not claim-only, so they stay true.
  - The `summary_claim_check.ts` row in `docs/INTERNALS.md` ("one recovery
    turn") describes that module, which is unchanged apart from one export.

## Test Plan

- Removed from `worker/deno/tests/completion_phase_summary_claim_check_test.ts` (test "completion - a wrong claim the recovery does not fix fails the run after one recovery turn"): `assertEquals(outcome.claudeCalls, 1, "only one recovery turn");` — the scenario's second attempt is now a claim-only block, and #3324 requires one summary-only correction turn there before the run fails. The run therefore now makes two Claude invocations, and the assertion is replaced with `assertEquals(outcome.claudeCalls, 2, "one recovery turn plus one correction turn")`. The run still ends in `failure` with no PR (`status` and `prCreateCalls` assertions unchanged).
- New in `worker/deno/tests/completion_phase_summary_claim_check_test.ts`:
  - "completion - a claim found only on the re-run is corrected by the one
    summary-only correction turn";
  - "completion - the correction turn finalises an existing PR normally when
    the claim clears";
  - "completion - a correction that leaves the sentence still blocks via the
    carried-forward finding (no PR)";
  - "completion - a correction that leaves the sentence blocks an existing PR
    as summary_incomplete via carry-forward";
  - "completion - the correction turn runs at most once per run".
  - "completion - a code diff with no Branch outcomes list AND a wrong claim
    folds into one comment, one recovery turn" now also asserts that the
    recovery prompt carries `REQUIRED ITEM 1 of 2` and `REQUIRED ITEM 2 of 2`,
    with the claim text after item 2's header.
- New file `worker/deno/tests/summary_claim_correction_test.ts` (18 tests):
  - `parseCorrectedSummary`: ok, missing OPEN, missing CLOSE, empty, oversize,
    nested OPEN;
  - `buildSummaryClaimCorrectionPrompt`: path named, both blocks fenced,
    forged delimiter scrubbed, three input guards;
  - `carryForwardCorrectedClaims`: added, no longer present, pending, none,
    no duplicate;
  - the disallowed-tools list.
- New in `worker/deno/tests/summary_rule_gate_retry_test.ts`:
  - "summary-rule retry - two folded sections render as two numbered
    REQUIRED ITEMs, each with its own text";
  - "summary-rule retry - a folded summary-claim-check section reaches the
    prompt as its own required item";
  - "summary-rule retry - no sections carries the whole comment as REQUIRED
    ITEM 1 of 1".

**Branch outcomes:**
- `worker/deno/lib/summary_claim_correction.ts:117` — offered (a summary-rule block already recorded, correction unset) — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a claim found only on the re-run is corrected by the one summary-only correction turn` — flipped to always-false, test went red
- `worker/deno/lib/summary_claim_correction.ts:117` — not offered (no block recorded yet, so the first block takes the recovery turn) — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a wrong claim about named code blocks; the recovery removes it and the PR is raised` — flipped to ignore the block count, test went red
- `worker/deno/lib/summary_claim_correction.ts:117` — not offered (correction already `used`) — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a correction that leaves the sentence blocks an existing PR as summary_incomplete via carry-forward` — flipped to offer again when `used`, test went red
- `worker/deno/lib/summary_claim_correction.ts:146` — error (non-positive issue number) — `worker/deno/tests/summary_claim_correction_test.ts::buildSummaryClaimCorrectionPrompt - throws for a non-positive issue number` — guard disabled, test went red
- `worker/deno/lib/summary_claim_correction.ts:151` — error (not a summary path) — `worker/deno/tests/summary_claim_correction_test.ts::buildSummaryClaimCorrectionPrompt - throws for a non-summary path` — guard disabled, test went red
- `worker/deno/lib/summary_claim_correction.ts:156` — error (blank gate comment) — `worker/deno/tests/summary_claim_correction_test.ts::buildSummaryClaimCorrectionPrompt - throws for a blank comment` — guard disabled, test went red
- `worker/deno/lib/summary_claim_correction.ts:162` — pinned boundary id used — `worker/deno/tests/summary_claim_correction_test.ts::buildSummaryClaimCorrectionPrompt - fences both the gate comment and the current summary content` — flipped to always mint, test went red
- `worker/deno/lib/summary_claim_correction.ts:222` — error (no OPEN marker) — `worker/deno/tests/summary_claim_correction_test.ts::parseCorrectedSummary - missing OPEN fails loud` — flipped to return ok, test went red
- `worker/deno/lib/summary_claim_correction.ts:232` — error (no CLOSE marker) — `worker/deno/tests/summary_claim_correction_test.ts::parseCorrectedSummary - missing CLOSE fails loud` — guard disabled, test went red
- `worker/deno/lib/summary_claim_correction.ts:241` — error (nested OPEN) — `worker/deno/tests/summary_claim_correction_test.ts::parseCorrectedSummary - a nested OPEN marker fails loud` — guard disabled, test went red
- `worker/deno/lib/summary_claim_correction.ts:250` — error (empty inner text) — `worker/deno/tests/summary_claim_correction_test.ts::parseCorrectedSummary - empty inner text fails loud` — guard disabled, test went red
- `worker/deno/lib/summary_claim_correction.ts:258` — error (over the size cap) — `worker/deno/tests/summary_claim_correction_test.ts::parseCorrectedSummary - oversize inner text fails loud` — guard disabled, test went red
- `worker/deno/lib/summary_claim_correction.ts:292` — unchanged (correction not `used`) — `worker/deno/tests/summary_claim_correction_test.ts::carryForwardCorrectedClaims - pending correction → unchanged` — flipped to act on `pending`, test went red
- `worker/deno/lib/summary_claim_correction.ts:299` — skipped (sentence no longer in the summary) — `worker/deno/tests/summary_claim_correction_test.ts::carryForwardCorrectedClaims - used + sentence no longer present → unchanged` — check removed, test went red
- `worker/deno/lib/summary_claim_correction.ts:301` — skipped (finding already present) — `worker/deno/tests/summary_claim_correction_test.ts::carryForwardCorrectedClaims - a finding already present is not duplicated` — check removed, test went red
- `worker/deno/lib/summary_claim_correction.ts:305` — carried (finding appended) — `worker/deno/tests/summary_claim_correction_test.ts::carryForwardCorrectedClaims - used + sentence still present → finding is added` — flipped to never carry, test went red
- `worker/deno/lib/summary_claim_correction.ts:328` — error (called with no pending correction; caller bug) — no test reaches it — flipped (throw removed), every test stayed green
- `worker/deno/lib/summary_claim_correction.ts:344` — recognised summary path, correction runs — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a claim found only on the re-run is corrected by the one summary-only correction turn` — guard inverted, test went red; the unrecognised-path skip itself is not reached by a test
- `worker/deno/lib/summary_claim_correction.ts:352` — error (summary unreadable, turn skipped) — no dedicated test — forcing a read failure turned `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a claim found only on the re-run is corrected by the one summary-only correction turn` red (it reaches the success side)
- `worker/deno/lib/summary_claim_correction.ts:387` — error (invocation failed, block stands) — no test reaches it — flipped, every test stayed green
- `worker/deno/lib/summary_claim_correction.ts:396` — error (reply unreadable, nothing written) — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a correction that leaves the sentence still blocks via the carried-forward finding (no PR)` — branch skipped, test went red
- `worker/deno/lib/summary_claim_correction.ts:401` — unchanged reply, nothing written — no test reaches it — flipped, every test stayed green
- `worker/deno/lib/summary_claim_correction.ts:408` — success (corrected summary written and committed) — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a claim found only on the re-run is corrected by the one summary-only correction turn` — write skipped, test went red
- `worker/deno/lib/summary_claim_correction.ts:412` — quality gate not `continue` after the write — no test reaches it — result ignored, every test stayed green
- `worker/deno/lib/summary_claim_correction.ts:413` — error (write failed) — no test reaches it — not flipped
- `worker/deno/lib/phases/completion_phase.ts:1028` — correction turn entered on a `pending` deferral — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a claim found only on the re-run is corrected by the one summary-only correction turn` — branch disabled, test went red
- `worker/deno/lib/phases/completion_phase.ts:1068` — stale `pending` cleared at the top of an attempt — no test reaches it — clearing removed, every test stayed green
- `worker/deno/lib/phases/completion_phase.ts:1099` — `pending` deferral skips the #1550 infrastructure retry — no test reaches it — condition removed, every test stayed green
- `worker/deno/lib/phases/completion_phase.ts:2578` — carry-forward applied to the claim-check result — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a correction that leaves the sentence still blocks via the carried-forward finding (no PR)` — bypassed, test went red
- `worker/deno/lib/phases/completion_phase.ts:2657` — a folded gate added as its own section — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a code diff with no Branch outcomes list AND a wrong claim folds into one comment, one recovery turn` — push removed, test went red
- `worker/deno/lib/phases/completion_phase.ts:2952` — claim-only later block deferred as `pending` — `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - a claim found only on the re-run is corrected by the one summary-only correction turn` — `summarySource !== null` inverted, test went red; the not-offered side (`reportSummaryRuleBlock`) is reached by `worker/deno/tests/completion_phase_summary_claim_check_test.ts::completion - the correction turn runs at most once per run`
- `worker/deno/lib/summary_rule_gate_retry.ts:158` — folded sections become the items — `worker/deno/tests/summary_rule_gate_retry_test.ts::summary-rule retry - two folded sections render as two numbered REQUIRED ITEMs, each with its own text` — flipped to ignore sections, test went red
- `worker/deno/lib/summary_rule_gate_retry.ts:158` — absent/empty sections, whole comment is item 1 of 1 — `worker/deno/tests/summary_rule_gate_retry_test.ts::summary-rule retry - no sections carries the whole comment as REQUIRED ITEM 1 of 1` — flipped to use the empty list, test went red
- `worker/deno/lib/summary_rule_gate_retry.ts:176` — multi-item and single-item intro wording — no test reaches the wording — inverted, every test stayed green

## Pre-PR Security Self-Check

- [x] Input validation: the corrected summary is parsed without a regex.
      `parseCorrectedSummary` takes the first OPEN and the last CLOSE marker,
      and rejects a nested OPEN, an empty body, and a body over
      `MAX_CORRECTED_SUMMARY_CHARS` (200,000).
- [x] Least privilege: the correction turn denies `Bash` and every
      file-writing tool. The worker writes only to `pending.summaryPath`, and
      only after `isSummaryClaimPath` accepts it.
- [x] Injection surface: the gate comment and the summary content are both
      fenced as untrusted data under one per-render nonce, with the
      boundary-integrity instruction and the tool-output-is-data rule.
      Each folded recovery item is fenced separately under the same nonce.
- [x] Secrets: none added or staged.
- [x] Gate strength: no finding is dropped. `carryForwardCorrectedClaims`
      only adds findings back, and a sentence still wrong after the turn
      blocks as it did before.
