# Post the held-issue gate comment from the scan and retire the stand-alone chain-root comment

## Summary

**This branch does not implement Issue #2535.** It carries a single added file —
`worker/deno/tests/find_oldest_issue_gate_comment_test.ts`, 437 lines — landed by
a WIP checkpoint commit. The production wiring the issue asks for was never
written:

- `worker/deno/lib/find_oldest_issue.ts` still imports and calls
  `postChainRootUnworkableComment` (lines 73 and 774) and never references
  `upsertHeldIssueGateComment`.
- `worker/deno/lib/held_issue_gate_comment.ts` exists from #2531, but no
  production module calls it — the only callers repo-wide are two test files.
- `worker/deno/lib/chain_root_comment.ts` is untouched; nothing was retired.
- `docs/INTERNALS.md` and `DESIGN-PRINCIPLES.md` are untouched —
  `docs/INTERNALS.md:2829` still reads "Reporting a chain root nobody can move".

The added tests are written against that absent implementation and fail: 3 of 5
fail, and the file also fails `deno lint` (5 unused bindings) and
`deno fmt --check`. This summary records that state rather than claiming the
criteria are closed. The issue should not be closed by this branch.

## Evidence

Backend-only change — there is no web interface to screenshot. The evidence is
the test run and the lint/format checks, all run on this HEAD from
`worker/deno/`.

- `deno test --allow-all tests/find_oldest_issue_gate_comment_test.ts` →
  **FAILED | 2 passed | 3 failed**, with
  `AssertionError: Values are not equal: Expected 1 POST, got 0` (line 238),
  `First scan should read thread once` actual `0` (line 308) and
  `First scan posts gate comment` actual `0` (line 363).
- `deno lint tests/find_oldest_issue_gate_comment_test.ts` → **5 problems**, all
  `no-unused-vars`: `assert` (13), `assertFalse` (15), `BOT` (25), `result`
  (228), `calls` (409).
- `deno fmt --check tests/find_oldest_issue_gate_comment_test.ts` →
  `error: Found 1 not formatted file in 1 file` (7 hunks).
- `deno check tests/find_oldest_issue_gate_comment_test.ts` → passes.
- `deno task check:manifests` → `ok | 672 passed | 0 failed`.
- `git diff --name-only b6fc8618..HEAD -- docs/INTERNALS.md DESIGN-PRINCIPLES.md`
  → no files; neither doc surface was changed.

`./quality.sh` was not run to completion: the targeted test and lint runs above
already fail, so the full gate cannot pass on this HEAD.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **missing** — after one scan, every held `top-priority` issue carries exactly
  one fleet `vibe-held-issue-gate` comment naming its gate, and a second scan
  with the same state makes no comment API write — evidence:
  `worker/deno/lib/find_oldest_issue.ts:73,774` (still the chain-root poster; no
  `upsertHeldIssueGateComment` call),
  `worker/deno/tests/find_oldest_issue_gate_comment_test.ts::findOldestIssue - posts one held-issue gate comment for blocked top-priority (Issue #2535)`
  — reviewer: missing — reason: no production code changed at all, so the POST
  assertion fails with "Expected 1 POST, got 0" and the 24 h cache test fails
  with 0 thread reads
- **missing** — when the gate moves the existing comment is edited, not
  re-posted, and any `vibe-chain-root-unworkable` comment is deleted — evidence:
  `worker/deno/tests/find_oldest_issue_gate_comment_test.ts::findOldestIssue - edits gate comment when gate changes, deletes legacy comment (Issue #2535)`
  — reviewer: missing — reason: the test fails at its first assertion (0 POSTs);
  no PATCH or DELETE path is reachable because nothing calls the upsert
- **partial** — a held `low-priority` issue gets no comment — evidence:
  `worker/deno/tests/find_oldest_issue_gate_comment_test.ts::findOldestIssue - does not post gate comment for held low-priority issue (Issue #2535)`
  — reviewer: partial — reason: the test passes, but vacuously — no tier gets a
  comment in this build, so it proves nothing about tier gating and would stay
  green if the gate were implemented incorrectly
- **missing** — `deno task test` and `./quality.sh` pass and the two doc surfaces
  are updated — evidence: the test, lint and fmt runs under **Evidence**;
  `docs/INTERNALS.md:2829` still carries the old heading — reviewer: missing —
  reason: 3 of 5 new tests fail, lint reports 5 unused bindings, `fmt --check`
  reports the file unformatted, and neither doc surface was touched
- **unrequested** — the branch's only commit is
  `290faa98 "WIP checkpoint: periodic agent progress snapshot (Issue #4170)"` —
  reviewer: unrequested — reason: a WIP checkpoint attributed to an unrelated
  issue; it is the vehicle the test file arrived on, not a completed change for
  #2535

No other unrequested changes: `git diff --stat b6fc8618..HEAD` is exactly the one
added test file, 437 insertions, 0 deletions.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — quality checks must all pass before a PR is raised
  (`CODING-STANDARDS.md:504`) — evidence:
  `worker/deno/tests/find_oldest_issue_gate_comment_test.ts:211`, `:278`, `:332`
  — reason: stands; 3 of 5 tests fail on this HEAD and nothing in the diff fixes
  them
- **violation** — TDD stops at step 1: a failing test is written and never made
  to pass (`CODING-STANDARDS.md:95`) — evidence:
  `worker/deno/tests/find_oldest_issue_gate_comment_test.ts:1` — reason: stands;
  `upsertHeldIssueGateComment` (`worker/deno/lib/held_issue_gate_comment.ts:213`)
  has no production caller, so these are aspirational tests for unwritten code
- **violation** — every test must exercise real code and assert on real side
  effects; the two passing tests pass vacuously — evidence:
  `worker/deno/tests/find_oldest_issue_gate_comment_test.ts:247` and `:399` —
  reason: stands; `:247` asserts zero posts against a feature that never posts,
  and `:399` injects a throw on a comment read that is never reached (the
  sibling failure at `:308` measured 0 reads) and never asserts a warning was
  emitted — its captured `output` array is discarded at every call site
- **violation** — fake the external service, do not assert the request
  (`CODING-STANDARDS.md:172`) — evidence:
  `worker/deno/tests/find_oldest_issue_gate_comment_test.ts:104` — reason:
  stands; the mock never adds a posted comment to the thread a later read
  returns, so the assertions are on the argv the worker built and on verb counts.
  `worker/deno/tests/held_issue_gate_comment_test.ts` already carries a thread
  fake for this module, so the hand-rolled third mock also breaks DRY
  (`CODING-STANDARDS.md:40`)
- **violation** — dead and unused code, Boy Scout Rule
  (`CODING-STANDARDS.md:41`) — evidence:
  `worker/deno/tests/find_oldest_issue_gate_comment_test.ts:13,15,25,228,409` —
  reason: stands; `deno lint` reports 5 `no-unused-vars`
- **violation** — `deno fmt --check` fails (`CODING-STANDARDS.md:466`) —
  evidence:
  `worker/deno/tests/find_oldest_issue_gate_comment_test.ts:339,368,373,394,405,418,435`
  — reason: stands; 7 unformatted hunks
- **violation** — dead mock surface / over-engineering
  (`CODING-STANDARDS.md:44`) — evidence:
  `worker/deno/tests/find_oldest_issue_gate_comment_test.ts:126` — reason:
  stands; the `issue view`, `pr list`, `/milestones`, PATCH, DELETE and GET
  branches are never reached, `RepoFixture.milestones` is never populated, and
  two recorded endpoint strings carry a literal escaped `\${N}` that is not a
  template substitution
- **violation** — reference the issue number in the commit message
  (`CODING-STANDARDS.md:696`) — evidence: commit `290faa98` — reason: stands on
  that commit; it names Issue #4170 while the work is #2535. This summary commit
  references #2535
- **violation** — a PR summary is owed (`CODING-STANDARDS.md:701`) — evidence:
  `docs/archive/pr-summaries/pr-summary-2535.md` — reason: fixed here; the file
  did not exist before this commit
- **clean** — `deno check` passes; Australian English throughout, with no
  American spellings; test-manifest registration is correct
  (`deno task check:manifests` → 672 passed) and the file is rightly not marked
  integration, parallel-unsafe or benchmark; `makeConfig` names its own `workDir`
  rather than inheriting the host's (`CODING-STANDARDS.md:214`); no sleeps, no
  wall-clock budgets, no ratio assertions, no real subprocesses; no
  grep-the-source tests — the file imports and calls the real `findOldestIssue`

## Test Plan

Added `worker/deno/tests/find_oldest_issue_gate_comment_test.ts` with five cases:

- `findOldestIssue - posts one held-issue gate comment for blocked top-priority` — **fails**
- `findOldestIssue - does not post gate comment for held low-priority issue` — passes vacuously
- `findOldestIssue - skips thread read when gate unchanged within 24h (cache)` — **fails**
- `findOldestIssue - edits gate comment when gate changes, deletes legacy comment` — **fails**
- `findOldestIssue - warns on upsert failure, continues scanning` — passes, but its failure path is unreachable

## Outstanding Work

To close #2535, the implementation the tests were written against still has to
be built:

1. Call `upsertHeldIssueGateComment` from the scan in
   `worker/deno/lib/find_oldest_issue.ts` for each held `top-priority` /
   `work-on` candidate, building the `pr-open`, `milestone-wait` or `dependency`
   gate from the fields #2534 records.
2. Add the process-local `Map<issueKey, { key, checkedAt }>` that skips the
   thread read when the gate key is unchanged and was confirmed within 24 h.
3. Delete fleet-authored `vibe-chain-root-unworkable` comments on a `posted` or
   `edited` result, and retire `postChainRootUnworkableComment`,
   `buildChainRootUnworkableComment` and `CHAIN_ROOT_COMMENT_WINDOW_MS` from
   `worker/deno/lib/chain_root_comment.ts` once no caller remains.
4. Rewrite the `docs/INTERNALS.md` and `DESIGN-PRINCIPLES.md` chain-root
   sections as "Naming the gate on a held issue".
5. Fix the added test file so it passes lint and fmt, reuse the existing thread
   fake in `worker/deno/tests/held_issue_gate_comment_test.ts`, and make the
   low-priority and upsert-failure cases assert non-vacuously.
