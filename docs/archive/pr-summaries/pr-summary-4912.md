## Summary

Rewrote the Performance Task Workflow and the documents that describe the
negative-result policy so in-container benchmark timings are indicative
evidence, never a gate: deterministic measures come first, a correct tested
change is raised even without a timing gain, and quiet-machine comparisons are
an `Owner step:` or belong to a dedicated benchmark environment. A negative
result (comment plus `negative-result` label, no PR) is recorded only when
deterministic evidence shows no help, and the worker hands it to a human
(#4911). Closes #4912.

Version bump: `VERSION` is not touched by this prose-only change.

## Spec

### Intent and Rationale

- Timings from a shared, parallel host are as unreliable as the wall-clock
  thresholds the guidelines already ban in unit tests, so they must not decide
  whether a PR is raised or an issue is set aside.
- This follows the owner's direction on #4874 (a benchmark run on a shared
  machine is next to useless and must not fail a build).

### Essential Design Decisions

- The `## Performance Task Workflow` heading is kept (pinned by
  `worker/deno/tests/coding_guidelines_layers_2574_test.ts`).
- The `### Benchmarks` section ("quiet machine only") is unchanged; step 2 now
  says timings are best taken on a quiet machine, so the two agree.
- The twin bullet in `CODING-STANDARDS.md` ("Do not reduce iteration counts")
  was reworded with the guidelines' bullet.
- `docs/AGENT-ACCOUNTABILITY.md` already reads "Negative-result record handed
  to a human for review" (landed with #4911), so it needed no change.
  `DESIGN-PRINCIPLES.md` already describes the hand-off, not an auto-close.

### Undiscoverable Facts

- Worker code comments (`negative_result_close.ts`, `handle_no_changes_phase.ts`)
  still say "benchmark run … no gain"; they are comments outside the listed
  scope and were left alone.

## Evidence

Prose-only change; no runtime surface. Related-rule check: grepped prompts and
standards for `negative-result`, `needs-human`, `benchmark`, `quiet machine`;
`prompts/issue/prompt.md` lines on the worker hand-off, the Human Escalation
section and `docs/USAGE.md` already agree with the new wording. The new rule
was applied to this diff: nothing in it says a PR needs a measured gain.

Acceptance grep, run on the head:

```text
$ grep -rniE "measurable improvement|should not be re-attempted|closes it as not planned|without before/after benchmark" prompts/ docs/ CODING-STANDARDS.md --exclude-dir=archive --exclude-dir=audits
(no output; exit 1)
```

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — The Performance Task Workflow states that benchmark timings never gate a build, a check or a PR, prefers deterministic measures, and sends quiet-machine timing comparisons to a human or a dedicated benchmark environment. — evidence: `prompts/coding_guidelines/prompt.md` — reviewer: met
- **met** — `grep -rniE "measurable improvement|should not be re-attempted|closes it as not planned|without before/after benchmark" prompts/ docs/ CODING-STANDARDS.md` (excluding `docs/archive/`) returns no policy statement that a PR needs a measured gain or that a no-gain issue is closed. — evidence: grep output above, empty — reviewer: met
- **met** — The prompt's description of what the worker does with a `negative-result` issue matches #4911 (left open, handed to a human). — evidence: `prompts/coding_guidelines/prompt.md` step 5 — reviewer: met
- **partial** — `worker/deno/tests/negative_result_lesson_docs_test.ts` and `worker/deno/tests/coding_guidelines_layers_2574_test.ts` retain their structural coverage; `./quality.sh` (including markdownlint and cspell) passes. — evidence: both tests pass; the gate's markdownlint, mermaid and semgrep stages passed — reviewer: partial — reason: the full `./quality.sh` did not finish inside the container (it timed out after the semgrep and release-tag stages); the worker re-runs it before the PR. No cspell config exists in this repository.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — step 2 told agents to take container timings while `### Benchmarks` says quiet machine only — evidence: `prompts/coding_guidelines/prompt.md:842` — reason: fixed in this diff (step 2 now says timings are best taken on a quiet machine and container timings are indicative only)
- **violation** — twin bullet in `CODING-STANDARDS.md` still said "include the results in the PR summary" — evidence: `CODING-STANDARDS.md:1375` — reason: fixed in this diff
- **clean** — Australian English, no hidden paths, no issue numbers newly cited, doc-drift test assertions unchanged, no contradiction with Human Escalation or the issue prompt's hand-off rules

## Test Plan

- `deno task test:unit` over `worker/deno/tests/negative_result_lesson_docs_test.ts`, `worker/deno/tests/coding_guidelines_layers_2574_test.ts`, `worker/deno/tests/coding_guidelines_twin_drift_test.ts`: passed (22 passed, 0 failed) on the final head.
- 40 test files that read the edited docs and prompts: 31 passed, 0 failed.
- Only the doc comment of `worker/deno/tests/negative_result_lesson_docs_test.ts` changed; no assertion was removed or edited.
- `./quality.sh`: markdownlint, mermaid, semgrep passed; the run did not complete in the container, so the rest is not verified here.
<!-- vibe-quality-gate-skipped reason="full gate did not complete inside the container within budget; targeted tests and the gate's lint stages passed" -->

Related rules checked: Unit Tests vs Benchmarks, `### Benchmarks`, Human Escalation, the issue prompt's no-hand-back exception.
