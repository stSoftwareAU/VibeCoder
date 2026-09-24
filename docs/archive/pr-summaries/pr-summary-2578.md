# GitHub Actions audit: CI cost and speed checks with a reserved share of the cap (Issue #2578)

## Summary

Closes #2578.

The weekly GitHub Actions audit never raised CI cost or speed on
GRQ-AutoTrader. The owner's direct question on 2026-09-24 turned up roughly
half the Actions spend, and cargo caching (#451), parallel deploy jobs (#453)
and reusing the Rust build (#531) had each been found by hand. The prompt had
three gaps: no checks for those levers, a 6-finding cap that security findings
fill first, and no way to see what a workflow costs.

This PR adds a compact **Cost and speed** group (checks 37–41), a read-only
run-time cost signal, and at least 2 of the 6 slots kept for the group, always
below `severity:high` security findings. A deterministic pre-pass feeds the
cheap-to-detect leads into the prompt as data for the agent to confirm or
reject. It files nothing itself.

**Operator step after merge:** the last acceptance criterion (raise the scan on
every monitored repo straight away with
`deno run -A worker/deno/mod.ts raise-single-idle-task` for
`github-actions-audit`, then link the filed findings on #2578) cannot happen
before merge. It is left for the operator.

## Changes

- `prompts/github_actions_audit/prompt.md` makes these changes:
  - It adds checks 37–41: runs only when relevant, duplicate or overlapping
    work, cached from previous runs, runs in parallel, and build once, deploy
    the artefact. Each check has a `BP-CI-COST-<check>-<12 hex>` stable id from
    `(check, sorted workflow paths)` and a no-false-positive note. The checks
    share one preamble for the cost signal, severity and the `Risk:` line.
  - Hard Constraint 2 allows `gh run list --workflow … --json …` (once per
    workflow) and the `timing` GET. It names the Actions writes as forbidden.
    Hard Constraint 7 now counts 41 checks.
  - The group is added to the "Sweep in severity-band order" medium and low
    bands. The group is swept even when the cap is otherwise full.
  - Phase 3 rule 6 keeps at least 2 of the 6 slots for cost findings. It also
    updates the severity guidance, the stable-id list, the Phase 4 body rules
    and the verification step.
  - It adds a `<cost_candidates>{{COST_CANDIDATES}}</cost_candidates>` input
    block.
- `worker/deno/lib/workflow_cost_scanner.ts` (new) is a pure pre-pass. It gives
  leads for 37 (no `paths:` and no change detection on push/pull_request) and
  39 (cargo without a cache, `setup-*` installing with no `cache:`, run-unique
  keys with no `restore-keys`, Docker with no `cache-from`). It also gives leads
  for 40 (one job that lints, tests and builds) and 41 (a deploy rebuilding
  what a push/PR workflow builds without downloading that run's artefact).
- `worker/deno/lib/idle_task_templates/github_actions_audit_template.ts` runs
  the pre-pass over the workflow files it already read and passes the rendered
  leads to the scan. A scanner failure is logged and leaves `(none)`.
- `worker/deno/lib/prompt_manager.ts` registers `COST_CANDIDATES` as an
  optional placeholder.
- `docs/GITHUB-ACTIONS-AUDIT-SCAN.md` gains a new "Cost and speed (#37–#41)"
  section. It covers the checks, the cost signal, severity, the reserved slots
  and the pre-pass. The doc also updates severity guidance, the id table and
  the cap section.
- `docs/audits/lib-sweep-coverage.json` and
  `docs/audits/security-sweep-2578-workflow-cost-scanner.md` hold the top-up
  sweep record for the new module.

The agent `gh` guard needed no code change. It already classifies both
cost-signal calls as reads, and rerun/cancel/delete/dispatch and a `POST` as
mutations. A new test pins both directions. The guard has one pre-existing gap:
it permits cwd-scoped Actions writes to the claimed repo, like every cwd write.
The prompt forbids them, but the guard does not refuse them per template.

## Acceptance Criteria

- **met**: the prompt carries checks 37–41, each with a stable id recipe,
  severity rules and a no-false-positive note, and the sweep band lists include
  them. Evidence: `github_actions_audit_cost_group_test.ts` (`cost group -
  checks 37–41 each carry a stable id…`, `sweep bands - every cost check is in
  a severity band`, `stable-id recipe list names the cost-group prefix`).
- **met**: Phase 3 keeps at least 2 of the 6 slots for cost findings, below
  `severity:high` security findings. Evidence: `Phase 3 - at least 2 of the 6
  slots are kept for the cost group, below severity:high`.
- **met**: read-only `gh run list` and the optional `timing` call are allowed
  by the hard constraints and the guard, with nothing that writes. Each cost
  finding states its duration, runs per week and saving, or "unmeasured".
  Evidence: `Hard Constraints - only the read-only cost-signal calls are
  added, nothing that writes`, `gh_guard_actions_cost_signal_2578_test.ts`
  (both directions), and `cost group - each finding states duration, runs per
  week and saving, or 'unmeasured'`.
- **met**: `docs/GITHUB-ACTIONS-AUDIT-SCAN.md` documents the group, the
  reserved slots and the cost signal. Evidence: `operator manual documents the
  group, the reserved slots and the cost signal`.
- **met**: the regression check passes. A fixture modelled on GRQ-AutoTrader's
  workflows before #451, #453 and #531 gives leads for 37, 39, 40 and 41, and
  the optimised repo gives none. Existing security-check tests are unchanged.
  Evidence: `workflow_cost_scanner_test.ts` (`GRQ-AutoTrader before
  #451/#453/#531 yields 37, 39, 40 and 41`, `the GRQ candidates cite the jobs
  the hand-filed fixes changed`, `a repo already caching, path-gating and
  running in parallel yields nothing`). The fixture was taken from
  GRQ-AutoTrader at `e8b506c1`, the parent of #451's merge. No existing test
  was modified apart from two additions to
  `github_actions_audit_template_test.ts`.
- **missing**: raising the scan on every monitored repo straight away and
  linking the findings here is an operator step. It can only run after merge,
  because the fleet runs the merged prompt.

## Test Plan

- `deno test --allow-all` on the 82 test files that reference the touched
  modules, prompt or docs: 1401 passed, 0 failed.
- `deno fmt`, `deno lint` and `deno check` on every changed `.ts` file.
- `npx markdownlint-cli2` on the changed Markdown.
