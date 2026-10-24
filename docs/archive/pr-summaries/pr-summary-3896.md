## Summary

Add canary fence coverage for all 37 exported prompt builders. The tests catch
untrusted inputs that escape a matched boundary, including a second copy outside
an otherwise valid fence. A completeness check rejects new builders without a
coverage row or a documented no-input exemption.

Closes #4203. Closes #4204. Closes #4205. Closes #4206. Closes #4207. Closes #4208.
Implements milestone #130, part of #3896.

## Spec

### Intent and Rationale

- Make the historic title-copy and closure-criteria leaks fail a shared,
  behavioural test instead of relying on reviewers to spot every interpolation.
- Establish coverage without changing production prompts. Existing leaks remain
  explicit repair work, rather than being silently accepted as safe.

### Essential Design Decisions

- Match whole-line BEGIN/END markers by validated boundary id. Every canary must
  survive rendering, and every occurrence must be inside a matched pair.
- Use distinct letters-and-digits canaries in reachable issue, repository,
  agent and tool inputs. Fixed worker instructions, generated commit hashes and
  operator-owned configuration are harmless fixture values.
- Known-leak rows require an open bug reference and an assertion failure. They
  fail once repaired until promoted; separate assertions retain protection for
  fields already fenced, including the historic title and closure fields.
- Discover exported builders through the existing source lexer. Comments and
  literal examples cannot invent coverage. All 37 builders have rows; the
  no-untrusted-input allowlist is empty. No new test task is needed.

### Undiscoverable Facts

- Fourteen existing fencing defects were reproduced across sixteen builder
  rows. Dedicated follow-up issue creation is pending connector authorisation;
  temporary parent references are draft scaffolding only and must be replaced
  before this PR is marked ready.
- The test-only helper and four row suites were implemented in parallel, then
  reviewed across ownership boundaries. That review added legal branch-name
  canaries and protected-field assertions to prevent existing leaks hiding new
  regressions.

## Evidence

- The row suites cover eight verifier/retry builders, eleven main/cache builders,
  ten processor builders and eight repair/diagnostic builders.
- Required hand mutations all failed their intended checks, then passed after
  restoration: copied pre-PR title, unfenced closure criteria, copied planning
  critique title, unfenced refinement feedback and unfenced summarisation input.
- Adding `buildDummyPrompt` produced `Missing fence coverage: buildDummyPrompt`.
  Renaming a real row to `buildNonexistentStalePrompt` produced a stale-entry
  failure and reported the uncovered real builder. Both mutations were reverted.
- All six focused suites passed: 65 tests, zero failures. The repository
  completeness family passed: 810 tests, zero failures, one ignored. Deno lint,
  formatting and Markdown lint passed. The full local quality gate is running;
  it is not yet a pass. That run skipped config integration, Checkov, Semgrep
  and the release-tag ruleset check on this host. No production file is changed by this PR.
- All 29 targeted shared-helper branch/operand flips made their named unit test
  fail. The helper was restored before the final typed test run; the facts file
  records each outcome and its discriminating test.

**Docs sweep** — grep: `knownLeakRow`, `fence_coverage_`; section: `docs/EXTENDING.md` (Running Tests), `SECURITY.md` (Delimiter Hardening); siblings: `buildPrePrVerifierPrompt`, `buildIssuePrompt`, `buildSingleInvocationPlanningPrompt`, `buildRepairPrompt` identify the four builder families whose row suites were inspected; updated: `docs/EXTENDING.md`, `SECURITY.md`. The new contributor instructions explain known-leak promotion; the security manual distinguishes a coverage baseline from repaired production prompts.

## Test Plan

- `worker/deno/tests/untrusted_fence_helper_test.ts` exercises valid single and
  nested fences, repeated canaries, dropped inputs, malformed ids, mismatched
  and unmatched markers, scrub-safe values, known-leak promotion and rendering
  errors. String fixtures reproduce the #3584 and #3890 failure shapes.
- `worker/deno/tests/fence_coverage_verifier_test.ts` renders eight real builders.
  Copying `issueTitle` outside its fence failed with `appears outside an untrusted
  fence`; removing the closure-entry wrapper failed on the first criterion with
  the same error. Both were green before and after the reverted mutation.
- `worker/deno/tests/fence_coverage_prompt_builder_test.ts` renders eleven real
  builders, including the cache miss and hit. Copying the planning-critique title
  outside its fence failed with `appears outside an untrusted fence`.
- `worker/deno/tests/fence_coverage_processors_test.ts` renders ten real builders.
  Moving refinement feedback beyond the outer END marker failed its row with
  `appears outside an untrusted fence`: zero passed, one failed.
- `worker/deno/tests/fence_coverage_repair_test.ts` renders eight real builders.
  Returning raw summarisation content in place of the fenced content failed its
  row with `appears outside an untrusted fence`: zero passed, one failed. Both
  refinement and summarisation passed again after restoration. Legal Git ref
  canaries also cover drift and rebase context.
- `worker/deno/tests/fence_coverage_completeness_test.ts` checks real repository
  coverage and negative fixtures for missing, stale and overlapping entries,
  empty scans, unreadable source, and comments/literals posing as exports.
- Twinned-rule search: existing `insideFence`, `outsideFences` and
  `onlyInsideFence` helpers remain unchanged, as #4203 explicitly requests.
  The four new row suites share one strict helper; no production rule changed.

<!-- vibe-branch-outcomes -->
<!-- /vibe-branch-outcomes -->

## Merge verification

Pending: dedicated bug references, completion of the full local quality gate,
required CI and code review. This draft must remain unmerged until every
known-leak row has its dedicated open bug reference. The summary check reports
zero gates blocked and four not checked; model-based and issue-aware checks are
not claimed as passes.
