# PR Summary — Issue #3295

Closes #3295

## Summary

Before this change, the admin-only hand-off fired on any issue that quoted the
`<!-- BP-REPO-... -->` finding marker, or the scanner's admin-action sentence,
inside a code span, a code fence or a blockquote. Now
`worker/deno/lib/admin_only_finding.ts` runs the body through a private
`stripQuotedMarkdown` step before matching. That step drops fenced code blocks
(` ``` ` or `~~~`, closed by a fence of the same character that is at least as
long), `>` blockquote lines and inline code spans. Real scanner bodies, with a
raw HTML-comment marker and plain-prose text, still match.

**`parseRepoSettingsFindingId` gets the same stripping.** The issue allowed this
if the quoted-text false positive applies there too, and it does. Setup's
close-out (`repo_settings_audit_close.ts`, Issue #2629) reads the finding id
through this parser. Without the stripping, an issue that only quotes a finding
id in code would be treated as that finding's issue and could be closed.

## Spec

### Intent and Rationale

The hand-off should fire only on issues the repo-settings scanner filed. Text
that an issue *quotes* (code spans, fences and blockquotes) is how humans
discuss the marker. It is not the scanner speaking.

### Essential Design Decisions

- I used one private helper for both detectors, so they cannot disagree about
  what counts as quoted text.
- The stripping is line-based and linear. Code spans are matched within one
  line only. This is marked `// SIMPLE-ON-PURPOSE:` with its upgrade condition.
- An unclosed fence runs to the end of the body. This follows CommonMark, and it
  fails safe: the result is "not admin-only".

### Undiscoverable Facts

The scanner writes the marker as a raw HTML comment and the prose as plain
text, never inside code (`repo_settings_scanner.ts:85`). So stripping quoted
markdown cannot hide a genuine finding.

## Evidence

- **Narrowed shared helper.** Both functions now reject bodies they used to
  accept. Callers checked:
  - `worker/deno/lib/issue_worker.ts:463`: `isAdminOnlyRepoSettingsIssue(ctx.issueBody)`
  - `worker/deno/setup/repo_settings_audit_close.ts:343`: `parseRepoSettingsFindingId(issue.body)`

  Both receive scanner-format bodies, which the test
  `worker/deno/tests/admin_only_finding_test.ts::isAdminOnlyRepoSettingsIssue - a scanner-format body is still admin-only with only the marker or only the prose (Issue #3295)`
  shows still match. That includes a body with a fenced block before the
  "Suggested fix" text, and CRLF line endings.
- **Hostile regex cases.** The test `worker/deno/tests/admin_only_finding_test.ts::isAdminOnlyRepoSettingsIssue - hostile backtick and fence runs scale linearly (Issue #3295)`
  uses `assertLinearGrowth` to cover long backtick runs and repeated fence
  openers. The file is registered in `WALL_CLOCK_TEST_FILES`
  (`worker/deno/lib/parallel_unsafe_test_manifest.ts`).
- Applied the rule to the PR's own diff: nothing found.

**Docs sweep** — grep: `isAdminOnlyRepoSettingsIssue`, `parseRepoSettingsFindingId`, `admin_only_finding`, `BP-REPO`, `admin-only`, "cannot change repository settings", "finding-id marker", `WALL_CLOCK_TEST_FILES`; section: `docs/GITHUB-ACTIONS-AUDIT-SCAN.md#native-repository-settings-pre-filer` (the scanner whose bodies the detector reads) and `docs/SETUP.md` step 3 "Audit issues" (the close-out that reads `parseRepoSettingsFindingId`), both read through and still true; updated: none — no manual documents the admin-only hand-off itself (it lives only in the `issue_worker.ts:454-461` comment), and every hit below was read in its sentence and is still true

Hits left in place:

- `docs/GITHUB-ACTIONS-AUDIT-SCAN.md:1083-1085`: still true. The fix text still says a repository admin must act, and the scanner still writes it as plain prose.
- `docs/SETUP.md:420-421`: still true. Fleet-filed `BP-REPO-*` audit issues carry the raw marker, so they are still closed.
- `docs/audits/security-sweep-2629-repo-settings-audit-close.md:31`: still true, because the id still comes only from the marker regex.
- `docs/audits/security-sweep-2757-lib-delta-12d-12f.md:160`: still true, because the regex is still linear.
- `docs/audits/security-sweep-2839-top-up-delta.md:347`: still true, because the id still goes through `parseRepoSettingsFindingId`.
- `worker/deno/lib/issue_worker.ts:454-461`: still true, because the issue is still recognised from its body.
- `worker/deno/setup/repo_settings_audit_close.ts:35-37`: still true, because the marker is still parsed by the one parser.
- `docs/EXTENDING.md:571`, `docs/SUPPLY-CHAIN-DETECTION-SCAN.md:196` and the `prompts/*/prompt.md` "finding-id marker in" hits: still true, because they describe idle-task dedup markers, which is a different subject.
- `docs/SECURITY-SCAN.md:475`: still true, because it is about `SEC-*` dedup ids, not `BP-REPO-*` markers.

## Reproduction

- **symptom** — An issue that mentions the BP-REPO marker or the admin-action
  sentence only in backticks, a code fence or a blockquote is classed as
  admin-only and handed off. `parseRepoSettingsFindingId` also returns an id
  for it.
- **status** — `verified` — the regression test was observed failing against
  the unfixed code and passing after the fix
- **regression test** — `worker/deno/tests/admin_only_finding_test.ts::isAdminOnlyRepoSettingsIssue - the marker only inside an inline code span is NOT admin-only (Issue #3295)`.
  These tests also fail on base `8ce8da11` and pass after the fix:
  - `isAdminOnlyRepoSettingsIssue - the marker only inside a fenced code block or blockquote is NOT admin-only (Issue #3295)`
  - `isAdminOnlyRepoSettingsIssue - the admin-action prose only inside backticks, a code fence or a blockquote is NOT admin-only (Issue #3295)`
  - `parseRepoSettingsFindingId - a marker only quoted in code yields null, so setup's close-out ignores it (Issue #3295)`

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — A body that mentions the marker only inside backticks is not admin-only — evidence: `worker/deno/tests/admin_only_finding_test.ts::isAdminOnlyRepoSettingsIssue - the marker only inside an inline code span is NOT admin-only (Issue #3295)` — reviewer: met
- **met** — A body that quotes the admin-action phrase only inside backticks or a code fence is not admin-only — evidence: `worker/deno/tests/admin_only_finding_test.ts::isAdminOnlyRepoSettingsIssue - the admin-action prose only inside backticks, a code fence or a blockquote is NOT admin-only (Issue #3295)` — reviewer: met
- **met** — A real scanner-format body (raw marker comment plus plain-text prose) is still admin-only, with only the marker and with only the prose — evidence: `worker/deno/tests/admin_only_finding_test.ts::isAdminOnlyRepoSettingsIssue - a scanner-format body is still admin-only with only the marker or only the prose (Issue #3295)` — reviewer: met
- **met** — Failure detection: new cases in `worker/deno/tests/admin_only_finding_test.ts` — evidence: `worker/deno/tests/admin_only_finding_test.ts` — reviewer: met
- **met** — The same quoted-text false positive applies to `parseRepoSettingsFindingId`, so it gets the same stripping — evidence: `worker/deno/tests/admin_only_finding_test.ts::parseRepoSettingsFindingId - a marker only quoted in code yields null, so setup's close-out ignores it (Issue #3295)` — reviewer: met
- **unrequested** — Linear-growth test for hostile backtick and fence runs, plus its `WALL_CLOCK_TEST_FILES` registration — reviewer: unrequested — reason: CODING-STANDARDS requires one hostile case per regex that runs on untrusted text
- **unrequested** — `// SIMPLE-ON-PURPOSE:` comment on single-line code-span matching — reviewer: unrequested — reason: the KISS rule requires every deliberate corner cut to be marked with its upgrade condition

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — regex on untrusted text (hostile case per pattern, linear growth), SIMPLE-ON-PURPOSE format, narrowed shared helper (callers checked: `issue_worker.ts:463`, `repo_settings_audit_close.ts:343`), TDD and test quality (no source-text grep tests), Australian English

## Test Plan

- [x] `timeout 900 ./quality.sh < /dev/null` at `83f0ca38`: `Result: PASSED (with skipped checks)`
- [x] `deno test -A tests/admin_only_finding_test.ts`: 14 passed, 0 failed
- [x] Red on base `8ce8da11`: the tests at lines 64, 75, 87 and 197 fail. The
  tests at lines 99 (scanner-format) and 116 (growth) pass on base, as
  expected. They pin existing behaviour against regression.

Branch outcomes:

- `worker/deno/lib/admin_only_finding.ts:97`. Outcome: the marker is matched
  against stripped text. Flip: match the raw body. Tests that go red: the
  inline-span marker test, the fence/blockquote marker test and the
  `parseRepoSettingsFindingId` quoted-marker test.
- `worker/deno/lib/admin_only_finding.ts:118`. Outcome: the prose is matched
  against stripped text. Flip: match the raw body. Test that goes red: the
  quoted admin-action prose test.
- `worker/deno/lib/admin_only_finding.ts:69`. Outcome: blockquote lines are
  dropped. Flip: keep them. Tests that go red: the blockquote cases in the
  fence/blockquote marker test and the quoted prose test.
- `worker/deno/lib/admin_only_finding.ts:49-57`. Outcome: a matching closer
  ends the fence. Flip: never close it. Test that goes red: the scanner-format
  body test, through its `proseOnly` body only. There the admin-action prose
  follows the closed ` ```text ` fence. The `markerOnly` bodies start with the
  marker, before the fence, so they would still match.
- `worker/deno/lib/admin_only_finding.ts:61-67`. Outcome: a fence opener
  starts a dropped region. This is reached by the fenced cases in the
  fence/blockquote marker test and the quoted prose test.
- `worker/deno/lib/admin_only_finding.ts:78`. Outcome: the `(?!`)` lookahead
  only affects how runs of backticks pair up. Removing it leaves the suite
  green. No behaviour the issue asks for depends on it.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
