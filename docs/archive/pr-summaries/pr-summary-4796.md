## Summary

Clarified both fast-check lists to run `deno fmt` from `worker/deno` and
hand-wrap Markdown elsewhere. Moved CONTRIBUTING's formatter scope and
markdownlint guidance beside its fast-check instruction, preserving the Issue
#1503 explanation that whole-document formatting buries small edits. Closes
#4796.

Version bump: none.

## Spec

### Intent and Rationale

- The two fast-check lists named `deno fmt` without its scope, while
  CONTRIBUTING stated the scope separately. Putting the scope in each list
  prevents whole-document Markdown reflows from obscuring small changes.

### Essential Design Decisions

- `deno fmt` remains scoped to `worker/deno/**`; Markdown outside it is
  hand-wrapped and checked by markdownlint's structural rules.
- This is a wording-only change. Formatter code, CI and quality gates are
  unchanged.

### Undiscoverable Facts

- Issue #1503 documents the large-diff risk: Deno's Markdown formatter rewraps
  paragraphs to its own width, burying small edits in whole-document formatting.

## Evidence

Documentation-only wording clarification; no UI or runtime behaviour changed.

## Test Plan

- `markdownlint-cli2 CODING-STANDARDS.md CONTRIBUTING.md` — passed (0 issues;
  the configured lint also covered 246 Markdown files).
- `git diff --check` — passed.
- `deno task pr-summary-check --base origin/main --issue-body-file /tmp/issue-body-4796.md --labels work-on,idle-task ../../docs/archive/pr-summaries/pr-summary-4796.md`
  from `worker/deno` — passed; 0 blocked and 0 not checked.
- `timeout 180 ./quality.sh < /dev/null` — timed out with exit 124 after 180
  seconds; its last reported check was `release-tag ruleset: PASSED`. The
  remaining quality checks were not confirmed.
- No tests were added for this prose clarification.
