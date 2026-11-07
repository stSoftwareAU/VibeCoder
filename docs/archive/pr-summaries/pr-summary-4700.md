## Summary

The `## Analysis` and `## Already Complete` close comments no longer end their
first sentence with `(Issue #4298)` / `(Issue #241)`. Both are posted on the
issue in the target repository, where GitHub resolves a bare `#N` against that
repo. The provenance moved into code comments beside each string. Closes #4700.

Version bump: `VERSION` is not changed by this PR.

## Spec

### Intent and Rationale

- A close comment is posted in the target repo, so a VibeCoder number links to
  an unrelated issue there. The #4641 fix covered failure reasons, not these two
  close comments.

### Essential Design Decisions

- Only the two posted strings change. The logger messages and code comments that
  cite #4298 / #241 are never posted, so they keep their provenance.
- The tests check only the worker-written text before `<details>`: the agent's
  quoted analysis and the cited evidence may legitimately hold the target repo's
  own numbers.

### Undiscoverable Facts

None.

## Evidence

Backend only; no UI. Changed: `worker/deno/lib/phases/handle_no_changes_phase.ts`
(two template literals). No manual quotes either sentence (grepped `docs/`
outside `archive/` and the READMEs for `closed as completed (Issue` and
`handed to a human (Issue`: no hits).

## Test Plan

- Added to `worker/deno/tests/handle_no_changes_phase_test.ts`: "analysis-only
  close comment carries no VibeCoder issue number (Issue #4700)" and
  "already-complete close comment carries no VibeCoder issue number (Issue
  #4700)". Each drives `workOnIssueHandleNoChanges` and asserts the worker-written
  head of the posted close comment has no `#<digits>`.
- Red checks: restoring ` (Issue #4298)` turns the analysis-only test red
  (`[ "#4298" ]` vs `[]`); restoring ` (Issue #241)` turns the already-complete
  test red (`[ "#241" ]` vs `[]`).
- No existing assertion was removed or edited.
- Run: `deno task test:unit tests/handle_no_changes_phase_test.ts` — 33 passed,
  0 failed. `deno fmt --check` and `deno lint` clean on both changed files.
- `./quality.sh < /dev/null` on the final code head: exit 0, "Result: PASSED
  (with skipped checks)" — deno tests, lint, type check, fmt, markdownlint,
  mermaid, semgrep and the release-tag ruleset passed; config integration and
  checkov were skipped by the gate itself.
