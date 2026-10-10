## Summary

The admin-only hand-off's prose signal now matches the scanner's full
suggested-fix sentence ("Repository admin action — the worker cannot change
repository settings."), not the bare fragment "the worker cannot change
repository settings". The matcher is built from the scanner's own constant,
which is now exported as `REPO_ADMIN_ACTION`. A spec that quotes the fragment
in prose or plain double quotes, as #3269 did, is no longer handed to a
human. Closes #3360.

## Spec

### Intent and Rationale

- Scanner-filed findings always carry the full sentence, so the fragment was a
  needlessly loose fallback that matched ordinary discussion of the scanner.
- Deriving the regex from `REPO_ADMIN_ACTION` means a change to the scanner's
  wording cannot silently break detection.

### Essential Design Decisions

- The matcher is `escapeRegExp(REPO_ADMIN_ACTION)` with each run of spaces
  replaced by `\s+`. A re-typed body that wraps the sentence across lines
  still matches, and the em dash and full stop must still be exact.
- #3295's `stripQuotedMarkdown` is unchanged and still runs before both
  signals.

### Undiscoverable Facts

- Before this change the constant was the private `ADMIN` in
  `repo_settings_scanner.ts`. The issue already called it `REPO_ADMIN_ACTION`,
  so it was renamed to that name and exported.

## Evidence

Backend-only change, verified by unit tests in
`worker/deno/tests/admin_only_finding_test.ts`.
`deno info lib/repo_settings_scanner.ts` shows no import cycle back into
`admin_only_finding.ts`.

**Docs sweep** — grep: `REPO_ADMIN_ACTION_PROSE`, `cannot change repository settings`, "admin-action prose", `isAdminOnlyRepoSettingsIssue`; section: `docs/GITHUB-ACTIONS-AUDIT-SCAN.md` (the SECURITY.md worker-fixable paragraph); updated: `docs/GITHUB-ACTIONS-AUDIT-SCAN.md`, doc comments in `worker/deno/lib/admin_only_finding.ts`; `worker/deno/lib/admin_only_finding.ts:37` — still true because a body that quotes the sentence in a code span is still stripped; `worker/deno/lib/repo_settings_scanner.ts:32` and `:446` — still true because the SECURITY.md fix text carries none of the sentence; `worker/deno/lib/admin_only_finding.ts:7-8` (module doc quoting the sentence) — still true because the scanner's fix text still opens with it

## Reproduction

- **symptom** — a body that quoted "the worker cannot change repository settings" in plain double quotes (#3269's acceptance criterion) was treated as admin-only and escalated `needs-human`
- **status** — `verified` — on the unfixed base matcher, the new fragment test failed, and so did the line-wrapped full-sentence case. Both pass after the fix. Putting the old fragment regex back turned the same two tests red again.
- **regression test** — `worker/deno/tests/admin_only_finding_test.ts::isAdminOnlyRepoSettingsIssue - the fragment without the scanner's lead-in is NOT admin-only (Issue #3360)`

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — A body that mentions the fragment in plain prose or double quotes, without the full sentence, is **not** admin-only. — evidence: `worker/deno/tests/admin_only_finding_test.ts::isAdminOnlyRepoSettingsIssue - the fragment without the scanner's lead-in is NOT admin-only (Issue #3360)` — reviewer: met
- **met** — A real scanner-filed body (marker plus the full sentence) **is** admin-only, and so is a body with only the full sentence. — evidence: `worker/deno/tests/admin_only_finding_test.ts::isAdminOnlyRepoSettingsIssue - the scanner's full sentence is admin-only, marker or not, even line-wrapped (Issue #3360)` — reviewer: met
- **met** — The prose matcher is derived from the scanner's constant, with no second copy of the text. — evidence: `worker/deno/lib/admin_only_finding.ts` (`REPO_ADMIN_ACTION_PROSE` built from the imported `REPO_ADMIN_ACTION`); `worker/deno/tests/admin_only_finding_test.ts::isAdminOnlyRepoSettingsIssue - matches the scanner's REPO_ADMIN_ACTION constant (Issue #3360)` — reviewer: met
- **unrequested** — linear-growth test for the new `\s+`-joined regex — reviewer: unrequested — reason: the standards require a hostile case for every new regex that runs on untrusted text
- **unrequested** — whitespace and line-wrap tolerance (`\s+`) in the matcher — reviewer: unrequested — reason: the fallback exists for re-typed bodies, and requiring the exact sentence would drop wrapped ones
- **unrequested** — wording update in `docs/GITHUB-ACTIONS-AUDIT-SCAN.md` — reviewer: unrequested — reason: the docs rule requires it, because the paragraph described the old "admin-action prose" signal

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — DRY (one copy of the sentence, matcher derived via `escapeRegExp`); no import cycle; every `${ADMIN}` call site renamed; new negative tests carry the forbidden fragment; the regex has no overlapping quantifiers and has hostile linear-growth cases; Australian English. Review-enforced rule checked: Check where you insert (the new imports and reworded doc comments sit directly above their items). No assertions removed from existing tests.

## Test Plan

- Added to `worker/deno/tests/admin_only_finding_test.ts`:
  - `isAdminOnlyRepoSettingsIssue - the fragment without the scanner's lead-in is NOT admin-only (Issue #3360)`
  - `isAdminOnlyRepoSettingsIssue - the scanner's full sentence is admin-only, marker or not, even line-wrapped (Issue #3360)`
  - `isAdminOnlyRepoSettingsIssue - matches the scanner's REPO_ADMIN_ACTION constant (Issue #3360)`
  - `isAdminOnlyRepoSettingsIssue - hostile whitespace and partial-sentence runs scale linearly (Issue #3360)`
- No assertions removed from existing tests.
- `deno task test:unit tests/admin_only_finding_test.ts tests/repo_settings_scanner_test.ts tests/issue_worker_test.ts tests/setup_repo_settings_audit_close_test.ts` passed on the head.
- `./quality.sh` passed on the head. `config integration` was skipped by the gate itself, as on every run in this environment.

**Branch outcomes:** none added. The change replaces one regex literal with a
derived regex and adds no condition. The two flips were still checked: the old
fragment regex turned the fragment test and the line-wrap test red, and
dropping the `\s+` replace turned the line-wrap test red.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
