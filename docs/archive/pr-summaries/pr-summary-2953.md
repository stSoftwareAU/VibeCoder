## Summary

- `worker/deno/lib/host_fault.ts`: `detectHostFault` gains `CLONE_CORRUPT_PATTERNS`,
  three new regexes that recognise a bad `.git/config` line, "not in a git
  directory", and "ignoring broken ref" as `clone-corrupt`, alongside the
  existing broken-ref/bad-object checks.
- `describeHostFault`'s `clone-corrupt` wording now reads "a corrupt git clone
  on the worker host (broken ref, unreadable object, corrupt .git/config or
  lost git directory)" so the rendered failure comment matches the widened
  detection.
- `worker/deno/tests/host_fault_test.ts` and `host_fault_release_test.ts` add
  regression coverage for the four verbatim strings, the negative cases
  (ordinary deno test failures, merge conflicts, a bad config line in
  `~/.gitconfig`), and a legacy unmarked failure record carrying a bad
  `.git/config` line being released.
- `docs/INTERNALS.md` and `docs/TROUBLESHOOTING.md` updated to describe the
  widened `clone-corrupt` kind.

Closes #2953.

## Evidence

```text
RED (before the fix):
FAILED | 41 passed | 5 failed
  host fault - detects clone-corrupt from a bad .git/config line (Issue #2953)
    Actual: null / Expected: "clone-corrupt"
  host fault - detects clone-corrupt from a lost git directory (Issue #2953)
    Actual: null / Expected: "clone-corrupt"
  host fault - detects clone-corrupt from an ignoring-broken-ref ellipsis (Issue #2953)
    Actual: null / Expected: "clone-corrupt"
  host fault - a bad .git/config line still matches with a different line number (Issue #2953)
    Actual: null / Expected: "clone-corrupt"
  classifyFailureRecord (via releaseHostFaultFailureLabels) - a legacy unmarked bad .git/config record is released (Issue #2953)
    released: [] / expected: [200]

GREEN (after the fix):
deno test tests/host_fault_test.ts tests/host_fault_release_test.ts
ok | 46 passed | 0 failed

Quality gate: `./quality.sh < /dev/null` → `Result: PASSED (with skipped checks)`
(exit 0; deno tests, lint, type check, fmt, markdownlint, mermaid, semgrep all
PASSED; config integration SKIPPED).
```

## Reproduction

- **Symptom** — about 52 first-attempt failures over 14 days from a damaged
  clone kept their issues at `failed-once` instead of releasing, because
  `detectHostFault` returned `null` for `fatal: bad config line 1 in file
  .git/config`, `fatal: not in a git directory`, and `warning: ignoring broken
  ref …`.
- **Status** — `verified` — reproduced with `deno eval` against the pre-fix
  tree: those three strings returned `null`, while `fatal: bad object
  refs/heads/…` already returned `clone-corrupt`.
- **Regression tests** — `worker/deno/tests/host_fault_test.ts`: "host fault -
  detects clone-corrupt from a bad .git/config line (Issue #2953)", "host
  fault - detects clone-corrupt from a lost git directory (Issue #2953)",
  "host fault - detects clone-corrupt from an ignoring-broken-ref ellipsis
  (Issue #2953)", "host fault - a bad .git/config line still matches with a
  different line number (Issue #2953)"; plus
  `worker/deno/tests/host_fault_release_test.ts`: "classifyFailureRecord (via
  releaseHostFaultFailureLabels) - a legacy unmarked bad .git/config record is
  released (Issue #2953)".

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- `detectHostFault` returns `clone-corrupt` for the four verbatim strings —
  reviewer: met — evidence: `host_fault.ts` `CLONE_CORRUPT_PATTERNS` plus the
  matching `host_fault_test.ts` tests.
- Still `null` for ordinary code failures (a deno test failure line, a merge
  conflict) — reviewer: met — evidence: the two `null` tests plus the
  `~/.gitconfig` negative test.
- A `classifyFailureRecord` test (a legacy unmarked failed-once comment with a
  bad config line is released) — reviewer: met — evidence:
  `host_fault_release_test.ts` exercises this via
  `releaseHostFaultFailureLabels`, since `classifyFailureRecord` is
  module-private; `host_fault_release.ts` itself is unchanged.
- `describeHostFault` wording and the docs table updates — reviewer:
  unrequested — reason: keeps the rendered description and docs true for the
  widened kind (docs-change rule).

The extra `ignoring broken ref` pattern was needed because the verbatim
criterion string names no `refs/heads` or `refs/remotes` ref, so the existing
`brokenRefsIn` check missed it.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

No violations. Clean: TDD with real-code tests, positive and negative
coverage, unit (in-process) classification, a KISS regex list placed alongside
the existing patterns, Australian English, docs updated alongside the
behaviour change, and no hidden or secret files.

## Test Plan

- [x] RED/GREEN targeted tests:
      `deno test tests/host_fault_test.ts tests/host_fault_release_test.ts`
- [x] `deno fmt`, `deno lint`, `deno check`
- [x] Docs updated (`docs/INTERNALS.md`, `docs/TROUBLESHOOTING.md`)
- [x] Spec and standards reviewers
- [x] `./quality.sh`
