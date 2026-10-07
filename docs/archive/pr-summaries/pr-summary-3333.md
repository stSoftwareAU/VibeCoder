# PR Summary — Issue #3333

## Summary

Closes #3333

`createGhIssueFetcher().getSubIssues` (the `check-parent-deps` command's
fetcher) caught every error from `fetchNativeSubIssueRefs` and returned `[]`,
so a rate limit, 5xx or auth failure was reported as "has no sub-issues — not
blocked". The catch is gone: a failed read now rejects, `checkParentBlocked`
returns `{ ok: false }`, and the command reports
`Error checking parent dependencies: …`.

## Spec

### Intent and Rationale

The Issue #3321 `IssueFetcher.getSubIssues` contract
(`worker/deno/lib/issue_dependencies.ts`) reserves `[]` for "genuinely no
sub-issues" and requires a lookup failure to reject. This fetcher broke that
contract, turning an unknown answer into a confident "not blocked".

### Essential Design Decisions

- **Remove the catch, don't translate it.** `checkParentBlocked` already
  turns a `getSubIssues` rejection into `{ ok: false }`, and the command
  already reports `{ ok: false }` as an error, so no new handling is needed.
- **`runCheckParentDeps` test seam.** The body of `execute` after argument
  validation moved, unchanged, into an exported
  `runCheckParentDeps(fetcher, repo, issueNumber)`. That lets a test drive a
  failed read through the command's own reporting. `execute` hard-wires
  `runGhCommand`, which a unit test cannot inject.

### Undiscoverable Facts

- `fetchNativeSubIssueRefs` (`worker/deno/lib/native_sub_issues.ts`) already
  rejects with `sub_issues lookup for … failed` on a `gh` error, empty output
  or unparseable output. The swallow was entirely in this command's fetcher.

## Evidence

Backend/CLI change only; no visual surface, so no screenshot.

- **Red on base:**
  - The new fetcher test failed against the unfixed fetcher with
    `AssertionError: Expected function to reject.`
    (`check_parent_dependencies_test.ts:95`).
  - The new command test, run with the seam in place but the catch kept,
    failed with `Values are not equal. - true + false` on `result.success`
    (line 260). On that run the command reported success ("not blocked").
- **Green after the fix:**
  `deno task test:unit tests/check_parent_dependencies_test.ts tests/issue_fetcher_sub_issues_test.ts tests/native_sub_issue_refs_test.ts < /dev/null`
  gave 30 parallel and 12 serial tests passed. `deno fmt`, `deno lint` and
  `deno check` were clean.
- **Gate:** `timeout 900 ./quality.sh < /dev/null` gave
  `Result: PASSED (with skipped checks)`. The only skip was
  `config integration: SKIPPED (deno or .config.json not available)`.
- **Docs sweep** — grep: `check-parent-deps`, `check_parent_dependencies`, `createGhIssueFetcher`, "returns empty on failure"; section: `README.md`, `docs/`, `prompts/`, `CODING-STANDARDS.md`, `DESIGN-PRINCIPLES.md` and `worker/deno/`; no updates needed — no doc says a failed sub-issues read returns `[]`, and every remaining hit is listed below as still true.
- **Docs sweep detail:** `docs/audits/security-sweep-1218-commands-cli.md:101,109` is a historical audit of the timeline-to-native move and says nothing about failure behaviour. `docs/audits/lib-sweep-coverage.json:1048` is a file list. `worker/deno/lib/command_args.ts:84,93` holds argument types. `worker/deno/tests/mod_test.ts:300` checks command registration. The `getSubIssues` comment in `worker/deno/commands/check_parent_dependencies.ts` now ends with an Issue #3333 paragraph saying a failed read rejects. Its earlier "`[]` when there are none" describes a successful empty read, so it is still true.
- **Cited issues:**
  - `#3333`: check-parent-deps reports a parent as having no sub-issues when
    the sub-issues read fails
  - `#3321`: Claim scan's parent/child gate fails open when the native
    sub-issues lookup errors, so a parent can be claimed before its children
  - `#3319`: Claim scan's checkParentBlocked reads only the first 30 native
    sub-issues and resolves each by number in the parent's repo
  - `#1218`: Security sweep chunk 13: worker/deno/commands/ CLI entry points
    (150 modules, ~26.7k lines)
  - The `#484`, `#630`, `#2470` and `#3218` references are in comments this
    diff does not touch.

## Test Plan

`worker/deno/tests/check_parent_dependencies_test.ts`:

- **Removed:** the test "createGhIssueFetcher - getSubIssues returns empty on
  failure". Its assertions, copied verbatim:
  - `throw new Error("API error");`
  - `const subs = await fetcher.getSubIssues("owner/repo", 42);`
  - `assertEquals(subs, []);`

  It pinned the swallow that Issue #3321's contract and Issue #3333 make
  wrong.
- **Replaced by:** "createGhIssueFetcher - getSubIssues rejects when the
  sub-issues read fails (Issue #3333)". The `gh` mock throws
  `HTTP 502: Bad Gateway`, and the test asserts a rejection matching
  `sub_issues lookup`.
- **New:** 'runCheckParentDeps - reports an error, not "not blocked", when
  the sub-issues read fails (Issue #3333)'. It asserts:
  - `success === false`;
  - the message includes `Error checking parent dependencies`;
  - the message does not include `no sub-issues`;
  - `data` is undefined.
- **Branch outcomes:** none added. The diff removes a branch (the catch), and
  `runCheckParentDeps` is a pure extraction of existing code.
- **Callers checked:** `getSubIssues` now rejects where it used to resolve
  `[]`. `createGhIssueFetcher` has one production caller,
  `checkParentDepsCommand.execute`, which hands the fetcher only to
  `checkParentBlocked`. That function catches the rejection and returns
  `{ ok: false }` (`worker/deno/lib/issue_dependencies.ts:474`, `:579`).
- **Call-site disclosure:** `execute` now passes
  `createGhIssueFetcher(runGhCommand)` to `runCheckParentDeps`. No test goes
  red if that delegation is reverted, because `runGhCommand` is hard-wired
  and cannot be injected. The existing missing-`repo` and missing-`issue`
  tests still cover `execute`'s validation path.
- **Fakes:** the mock `gh` functions stand in for `runGhCommand`
  (`worker/deno/lib/github.ts`). The property relied on is that a failed
  `gh` call rejects. `runGhCommand` rejects on a non-zero `gh` exit, which is
  the same error path `fetchNativeSubIssueRefs` already wraps.
- **Independent review:** `spec-reviewer` and `standards-reviewer` were not
  run. They are optional here because the issue has no formal Acceptance
  Criteria heading.

## Pre-PR Security Self-Check

- [x] Input validation: unchanged; `validateCheckParentDepsArgs` still runs
      first, and `fetchNativeSubIssueRefs` still validates the slug.
- [x] Secrets: none staged.
- [x] Injection surface: no new shell, SQL, filesystem or HTTP calls.
- [x] Error handling: this is a fail-loud fix. A failed read is now an error,
      not a false "not blocked".
- [x] Authorisation: N/A.

🌱 graft saved ~46,779 tokens
