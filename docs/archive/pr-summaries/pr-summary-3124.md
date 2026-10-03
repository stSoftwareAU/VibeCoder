# PR Summary — Issue #3124

## Summary

Fleet PRs left an ALL-CAPS token ending in `_PLACEHOLDER` where the
quality-gate result belonged, so the summary read as "the gate was run" when
no result was ever reported. This change closes that gap three ways: the
issue and pr_feedback prompts now require a result line written only after the
command ran on the final head, stating the real outcome or plainly saying the
gate was not run; `CODING-STANDARDS.md` treats an unresolved placeholder as an
unreported result and a blocking self-review finding; and the worker refuses
such a token before PR creation and before posting a PR reply, with one
recovery turn like the other summary gates. The one archived summary that
carried the token now says "result not recorded". Closes #3124.

## Spec

### Intent and Rationale

- A placeholder is a fill-in-later promise; when the fill-in never happens the reader cannot tell it apart from a reported result. Prompt rules prevent it, the standard makes it a review finding, and the worker gate catches what slips through.
- The gate pattern is the issue's regex, `\b[A-Z][A-Z0-9_]*_PLACEHOLDER\b`, matched only outside fenced blocks and inline code spans, so a summary may still quote the token when describing it. A span may wrap onto the next line of the same paragraph; a blank line ends the paragraph, so the span does not cross it. An opening run of N backticks closes at the next run of exactly N, and a run with no closer is literal text.

### Essential Design Decisions

- The completion gate runs through `reportSummaryRuleBlock`, the same chokepoint as the docs-sweep gate, so it keeps the degraded-delivery guard (#2562/#3092) and the single `recoverFromSummaryRuleBlock` turn.
- Because a second summary block in one run fails the run, the placeholder verdict is folded into every earlier gate's block (`foldInDocsSweep`) and into the docs-sweep block, so one recovery turn hears about every problem.
- Replies get one agent re-run (`retryReplyPlaceholdersOnce`) in `pr_feedback_processor.ts` before the comment is marked processed. `readPrResponseMessage` is the fail-loud backstop for all four reply consumers: it logs at error level and replaces any surviving token with `[result not reported]`.
- New lib module `result_placeholder_gate.ts`, registered in `docs/audits/lib-sweep-coverage.json` as a top-up slice so `lib_sweep_coverage_test` (#1609) stays green.

### Undiscoverable Facts

- The PR-reply chokepoint feeds four consumers (PR feedback, CI fix, merge-conflict agent, milestone conflict ladder), but only PR feedback has an agent session to re-run cheaply, so the recovery turn is pr_feedback-only and the others rely on the backstop.
- The three "WIP checkpoint" commits on the branch come from the worker's periodic progress snapshot, not from a hand-authored change; they are left as pushed.

## Evidence

```mermaid
flowchart TD
    S[PR summary] --> G1[Earlier summary gates]
    G1 -- block --> F[Fold in docs-sweep + placeholder verdicts]
    G1 -- pass --> DS[Docs-sweep gate]
    DS -- block --> F2[Fold in placeholder verdict]
    DS -- pass --> PG[Result-placeholder gate]
    PG -- block --> R[reportSummaryRuleBlock<br/>degraded-delivery guard + one recovery turn]
    F --> R
    F2 --> R
    PG -- pass --> PR[Create / finalise PR]
    M[.pr_response_message] --> RT[pr_feedback: retryReplyPlaceholdersOnce]
    RT --> C[readPrResponseMessage backstop<br/>error log + "[result not reported]"]
    M --> C
    C --> PRC[Public PR comment]
```

**Docs sweep** — grep: `docs sweep`, `docs-sweep`, `Docs-sweep`, `summary_rule`, `summaryRuleBlock`, `recoverFromSummaryRuleBlock`, `reproduction status`, `pr_response_message`, `readPrResponseMessage`, and the placeholder regex; section: `docs/workflows/issue-processing.md` (the summary-gate entries, now "five summary gates", plus the new "🚫 A leftover placeholder token blocks the summary" section); updated: `docs/workflows/issue-processing.md`, `docs/CONFIGURATION.md`, `docs/INTERNALS.md`, `docs/audits/lib-sweep-coverage.json`, `CODING-STANDARDS.md`, `prompts/issue/prompt.md`, `prompts/pr_feedback/prompt.md`, `docs/archive/pr-summaries/pr-summary-2967.md`. Reviewed and left unchanged: `SECURITY.md`, `docs/PROMPTS.md`, `docs/workflows/pr-feedback.md`, `docs/workflows/merge-conflicts.md`.

**Related existing rules checked**: the issue prompt's "Quality check loop"
skip-note rule, the **Proactive Validation** rule, the `CODING-STANDARDS.md`
skip-note rule for an unrun gate, **A named test must exist** (#3058), the
Acceptance Criteria skeleton's "met — ./quality.sh passes" example, and the
pr_feedback prompt's skip note. All agree with the new rule: each already asks
for a stated outcome or a plain skip note, and the new sentence in **A named
test must exist** extends that rule to an unresolved placeholder.

**Guards kept and excluded**:

- Kept: the degraded-run delivery guard and the single recovery turn, by
  routing the completion gate through `reportSummaryRuleBlock` and folding its
  verdict into earlier blocks.
- Kept: secret redaction and marker neutralisation in `readPrResponseMessage`
  run before the placeholder scan.
- Kept: the PR-feedback timeout checks run before the reply recovery turn,
  which sits ahead of `markCommentProcessed`.
- Excluded: the reply recovery turn for CI fix, merge-conflict and milestone
  ladder replies, which have no cheap agent re-run; the chokepoint backstop
  covers them instead. A failed reply retry is logged at error level and not
  fatal, because the backstop still stops the token from being posted.

**Red without the guard** (each guard removed on purpose, test run, guard
restored):

- Fold removed from the docs-sweep block:
  `worker/deno/tests/completion_phase_result_placeholder_test.ts` failed with
  an AssertionError expecting the block to contain the placeholder verdict.
- Backstop removed from `readPrResponseMessage`:
  `worker/deno/tests/pr_branch_preparation_test.ts` went 18 passed / 1 failed.
- Retry call removed from `pr_feedback_processor.ts`:
  `worker/deno/tests/pr_feedback_processor_result_placeholder_test.ts` went
  1 passed / 1 failed.

**Quality gate**: full `./quality.sh < /dev/null` passed on the final code
head (exit 0, "Result: PASSED (with skipped checks)"); config integration was
skipped because no `.config.json` exists locally. Deno tests: parallel passed
in 5m43s, serial in 1m27s.

## Test Plan

- `worker/deno/tests/result_placeholder_gate_test.ts`: detection, code-span
  and fence exemption, replacement, comment and retry-prompt builders, and
  every `retryReplyPlaceholdersOnce` outcome. Caps:
  `findResultPlaceholders - names at most ten distinct tokens` (eleven names
  return the first ten) and `findResultPlaceholders - a token only past the
  scan cap is not reported` (a token that begins only after 200,000
  characters is omitted). Fences:
  `findResultPlaceholders - a list-item fence is code, and replace leaves it unchanged`
  and `findResultPlaceholders - a longer fence is not closed by a shorter one inside it`.
  Wrapped spans:
  `findResultPlaceholders - a bare token after a wrapped code span is reported`
  (replace changes only that token) and
  `findResultPlaceholders - a backtick-quoted token after a wrapped span is not reported`
  (`replaceResultPlaceholders` returns the input byte-identical).
- `worker/deno/tests/completion_phase_result_placeholder_test.ts`: a
  placeholder alone blocks PR creation through the one recovery turn; folded
  into the docs-sweep block; folded into an earlier gate
  (`completion - a bare token folds into the reproduction gate's one block
  (Issue #3124)`, whose reason and comment both name the token, and
  `completion - a recovery fixing the reproduction block and the placeholder
  raises the PR once (Issue #3124)`, one recovery invocation); a clean
  summary passes.
- `worker/deno/tests/pr_branch_preparation_test.ts`: the reply backstop
  replaces the token and logs at error level; a token inside code survives.
- `worker/deno/tests/pr_feedback_processor_result_placeholder_test.ts`: the
  reply recovery turn runs once and a clean reply skips it.
- `git grep -nE` with the issue's regex over `docs/archive/pr-summaries`
  prints nothing.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
