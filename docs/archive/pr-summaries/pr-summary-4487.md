## Summary

The default-branch ruleset update no longer drops required checks the repository
owner added. `buildDefaultBranchRulesetUpdateBody` now writes the union of the
worker's contexts and the contexts already live, keeping each live check's
`integration_id`. A malformed live check refuses the update loudly instead of
being forgotten. Closes #4487.

Version bump: no `VERSION` change in this PR; the merged commit records the
final version.

## Spec

### Intent and Rationale

- The update PUT replaced `required_status_checks` with the worker's own list,
  so an owner-added secret scan or static-analysis check (and the
  `integration_id` pinning any check to its app) vanished on the next reconcile.
- The fix sits in the builder, which owns the written document.
  `planDefaultBranchRuleset` already passes current and added contexts, but it
  carries no `integration_id`, so only the builder can keep them.

### Essential Design Decisions

- Order: worker contexts first (each inheriting the live `integration_id` for
  the same context), then live-only checks in live order. Duplicates collapse,
  first entry wins.
- Strict policy is unchanged: `true` unless a merge queue is written. The
  builder already did this; tests now pin it.
- A malformed live check (non-object entry, non-string or empty `context`,
  present but non-integer `integration_id`, non-array `required_status_checks`)
  throws, and `planDefaultBranchRuleset` returns
  `Refusing to update ruleset <id> in <repo>: …` with no write. Dropping it
  silently would weaken the rule, which is what the issue forbids. A rule with
  no `parameters` or no `required_status_checks` key contributes nothing and
  does not throw.
- The update never removes a check; pruning one stays a deliberate human action
  (`docs/MERGE.md`). A reconcile can still delete the worker's whole ruleset on
  a direct-push branch (existing behaviour, unchanged), so the docs scope the
  claim to the update PUT.

### Undiscoverable Facts

- None.

## Evidence

Backend only; no UI files touched.

- `worker/deno/lib/repo_rulesets.ts`: `liveRequiredChecks`,
  `unionRequiredChecks`, and `buildDefaultBranchRulesetUpdateBody`.
- `worker/deno/lib/default_branch_ruleset.ts`: the update path catches the
  builder's error and returns the refusal; module doc updated.
- `docs/MERGE.md`: "The update never weakens the rules it rewrites" (read the
  whole section and the additive-convergence section above it).

Callers of the changed helper: the only production caller is
`planDefaultBranchRuleset` (`default_branch_ruleset.ts`), covered through
`ensureDefaultBranchRuleset` by the two new tests in
`worker/deno/tests/default_branch_ruleset_test.ts`. Existing callers' tests
(`default_branch_ruleset_test.ts`, `default_branch_ruleset_merge_queue_test.ts`,
`default_branch_ruleset_audit_test.ts`) still pass.

Related existing rules checked: `docs/MERGE.md` additive-convergence text
(already describes a union and human pruning; consistent), the Issue #1290 and
#3656 module-doc bullets (extended).

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — A test: a live ruleset requiring `gate` plus two owner-added checks,
  updated with contexts `["gate"]`, still requires all three, with their
  `integration_id`s. — evidence:
  `worker/deno/tests/repo_rulesets_test.ts::repo_rulesets - the update body keeps the live checks the worker does not name (Issue #4487)`,
  and through the caller
  `worker/deno/tests/default_branch_ruleset_test.ts::ruleset - the update keeps owner-added checks with their integration ids (Issue #4487)`
  — reviewer: met
- **met** — A test: live strict `true` with no merge queue stays strict. —
  evidence:
  `worker/deno/tests/repo_rulesets_test.ts::repo_rulesets - the update body keeps strict on when there is no merge queue (Issue #4487)`
  — reviewer: met — reason: pins existing behaviour; the reviewer noted it
  passes on base too
- **met** — A test: an empty live `bypass_actors` stays empty (no bypass is
  introduced). — evidence:
  `worker/deno/tests/repo_rulesets_test.ts::repo_rulesets - the update body writes no bypass actors when the live ruleset has none (Issue #4487)`
  — reviewer: met — reason: pins existing behaviour; the reviewer noted it
  passes on base too
- **unrequested** — a malformed live check refuses the update (builder throws,
  plan returns a refusal) — reviewer: unrequested — reason: added after the
  Standards review, so a malformed check is never silently dropped from the
  rewritten rule

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — absolute "never dropped … never a reconcile side effect"
  claims not backed by head code — evidence: `docs/MERGE.md:226` — reason: fixed
  in this diff (scoped to the update PUT; same in
  `worker/deno/lib/repo_rulesets.ts`)
- **violation** — no test through the helper's production caller — evidence:
  `worker/deno/lib/default_branch_ruleset.ts:518` — reason: fixed in this diff
  (two `ensureDefaultBranchRuleset` tests added)
- **violation** — new tests that pass without the change (strict, bypass) —
  evidence: `worker/deno/tests/repo_rulesets_test.ts:615` — reason: fixed in
  this diff (labelled as pins of existing behaviour in the Test Plan; they guard
  the new rewrite, which now spreads `rule.parameters`)
- **violation** — new branches without a test — evidence:
  `worker/deno/lib/repo_rulesets.ts:478` — reason: fixed in this diff
  (non-object rule, no `parameters`, duplicate live context, duplicate worker
  context and every throw have tests)
- **violation** — malformed live checks dropped silently — evidence:
  `worker/deno/lib/repo_rulesets.ts:486` — reason: fixed in this diff (throws;
  the plan refuses the update)
- **clean** — Australian English, no existing test edited or assertion removed,
  helpers private and used by production, doc comments and `docs/MERGE.md` agree

## Test Plan

- New in `worker/deno/tests/repo_rulesets_test.ts` (all end `(Issue #4487)`):
  union with integration ids; new worker context beside live checks; strict
  stays on with no queue; queue turns strict off and keeps live checks; empty
  live bypass stays empty (positive control carries one actor); six throw tests
  (non-string context, empty context, float and string `integration_id`,
  non-array, non-object entry), each with a positive control; lenient branches
  (null rule, no `parameters`); first live duplicate wins; repeated worker
  context written once.
- New in `worker/deno/tests/default_branch_ruleset_test.ts`: owner-added checks
  survive through `ensureDefaultBranchRuleset` with ids kept; a malformed live
  check gives `Refusing to update ruleset 42`, zero writes, and the legal-id
  control writes once.
- Red checks (union restored to `contexts.map(({ context }))`): the union tests,
  the queue test, the first-duplicate-wins test and the ensure-level union test
  go red (12 failed); the lenient-branch tests pin no-throw behaviour and stay
  green. With the old silent-drop behaviour the six throw tests and the
  ensure-level refusal test go red (7 failed). With the try/catch in
  `planDefaultBranchRuleset` reverted the refusal test goes red on the uncaught
  error. The strict-on and empty-bypass tests stay green without the change, by
  design: they pin behaviour the builder already had.
- No existing test was edited and no assertion removed.
- `deno task test:unit` over the four ruleset test files: 108 passed, 0 failed.
  `deno fmt --check`, `deno lint`, `deno check` on the touched files: clean.
- `./quality.sh` on the final head: Result: PASSED (with skipped checks);
  checkov and config integration were skipped by the gate.
  `deno task pr-summary-check`: 0 blocked, 0 not checked.
