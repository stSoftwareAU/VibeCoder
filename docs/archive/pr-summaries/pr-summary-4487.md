## Summary

The default-branch ruleset update no longer drops required checks the repository
owner added. `buildDefaultBranchRulesetUpdateBody` now writes the union of the
worker's contexts and the contexts already live, keeping each live check's
  `integration_id`. Checks with the same context but different app IDs stay
separate; exact duplicate context/app pairs keep the first entry. Missing or
malformed live required-check data refuses the update before a write. Closes
#4487.

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

- Desired worker contexts come first. A context already live contributes all
  its live app-pinned checks; a new worker context is unpinned. Remaining live
  checks follow in live order. Exact duplicate `(context, integration_id)`
  pairs keep the first entry, while distinct app IDs remain separate.
- Strict policy is unchanged: `true` unless a merge queue is written. The
  builder already did this; tests now pin it.
- A missing live `rules` array, or a malformed required-check rule (missing
  parameters or its checks array, non-array checks, non-object entry,
  non-string or empty `context`, present non-null non-integer
  `integration_id`) throws, and `planDefaultBranchRuleset` returns
  `Refusing to update ruleset <id> in <repo>: …` with no write. Dropping it
  silently would weaken the rule, which is what the issue forbids. A valid
  rules array with no `required_status_checks` rule contributes no live checks.
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
- GitHub's [rules API schema](https://docs.github.com/en/rest/repos/rules) defines
  `integration_id` as the optional app that a required status check must
  originate from; preserving separate IDs therefore preserves distinct source
  requirements for a shared context.

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
  `worker/deno/tests/repo_rulesets_test.ts::repo_rulesets - the update body keeps the live checks the worker does not name (Issue #4487)`
  — reviewer: met
- **met** — A test: an empty live `bypass_actors` stays empty (no bypass is
  introduced). — evidence:
  `worker/deno/tests/repo_rulesets_test.ts::repo_rulesets - the update body keeps the live checks the worker does not name (Issue #4487)`
  — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — absolute "never dropped … never a reconcile side effect"
  claims not backed by head code — evidence: `docs/MERGE.md:226` — reason: fixed
  in this diff (scoped to the update PUT; same in
  `worker/deno/lib/repo_rulesets.ts`)
- **violation** — no test through the helper's production caller — evidence:
  `worker/deno/lib/default_branch_ruleset.ts:518` — reason: fixed in this diff
  (two `ensureDefaultBranchRuleset` tests added)
- **violation** — new branches without a test — evidence:
  `worker/deno/lib/repo_rulesets.ts:478` — reason: fixed in this diff
  (missing rules, missing `parameters`, missing checks, non-array checks,
  malformed entries and contexts, duplicate app-pair, distinct app IDs, and
  repeated worker contexts have tests)
- **violation** — malformed live checks dropped silently — evidence:
  `worker/deno/lib/repo_rulesets.ts:486` — reason: fixed in this diff (throws;
  the plan refuses the update)
- **clean** — Australian English, no existing test edited or assertion removed,
  helpers private and used by production, doc comments and `docs/MERGE.md` agree

## Test Plan

- New or expanded in `worker/deno/tests/repo_rulesets_test.ts`:
  union with integration ids; strict stays on with no queue and an empty live
  bypass list remains empty in that acceptance test; new worker context beside
  live checks; queue turns strict off and keeps both live app IDs; an
  unpinned live check stays unpinned; refusal tests for missing live rules,
  missing rule parameters, missing checks, non-array checks, malformed entries,
  malformed contexts and invalid app IDs, each with legal positive controls;
  distinct app IDs for one context remain separate; exact duplicates keep the
  first entry; repeated worker context is written once.
- New in `worker/deno/tests/default_branch_ruleset_test.ts`: owner-added checks
  survive through `ensureDefaultBranchRuleset` with both app IDs kept; a
  malformed live check gives `Refusing to update ruleset 42`, zero writes, and
  the legal-ID control writes once.
- Base reproduction: restored `worker/deno/lib/repo_rulesets.ts` from
  `origin/main`, then ran `deno task test:unit tests/repo_rulesets_test.ts` in
  `worker/deno`; expected red observed (16 failed, including the union and
  missing-field refusal cases). The final implementation passes the focused
  suite below.
- Caller reproduction: restored both changed production files from
  `origin/main`, then ran `deno task test:unit tests/default_branch_ruleset_test.ts`;
  expected red observed (2 failed, the caller-level union and refuse-without-
  write tests).
- The strict and empty-bypass assertions run successfully against base before
  the new union assertion fails; these acceptance behaviours were already
  present and are not claimed as changes introduced here.
- No existing test was edited and no assertion removed.
- `deno task test:unit tests/repo_rulesets_test.ts tests/default_branch_ruleset_test.ts tests/default_branch_ruleset_merge_queue_test.ts tests/default_branch_ruleset_audit_test.ts`: 110 passed, 0 failed.
- `deno fmt --check`, `deno lint`, and `deno check --frozen --lock=deno.lock` on the four touched TypeScript files: passed.
- `deno task test:unit tests/pr_maintenance_command_test.ts`: 24 passed, 0 failed; the previously failing case passed in isolation.
- First `timeout 900 ./quality.sh < /dev/null`: FAILED. The Deno parallel pass reported 31,120 passed, 1 failed, 5 ignored in 5m45s; failure: `pr-maintenance command - update-open-pr-branches takes no action on a behind-only PR behind a merge queue (Issue #4424)` — `expected a merge-queue rules read, got: ["api repos/org/repo --jq .default_branch"]`. Config integration and Checkov were skipped by the gate.
- Second `timeout 900 ./quality.sh < /dev/null`: timed out with exit 124 before the full Deno test phase completed.
- `deno task pr-summary-check --base main --issue-body-file /tmp/issue-4487-body.md --labels work-on ../../docs/archive/pr-summaries/pr-summary-4487.md`: passed, 0 blocked, 0 not checked.
