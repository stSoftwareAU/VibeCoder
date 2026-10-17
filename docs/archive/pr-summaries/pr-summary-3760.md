## Summary

A push made outside the worker (by hand, from a laptop, or from an interactive Claude Code session) no longer leaves the live PR description on the old summary. A new deferrable dispatch slot, Priority 1.64 **Reconcile PR Body Digests** (`worker/deno/lib/pr_body_reconcile.ts`), runs each cycle over the repos due that cycle (`pollRepos`). It lists the open fleet-authored PRs. For each body that carries both the worker marker and the `vibe-pr-summary sha256` digest marker, it reads `pr-summary-<N>.md` (or the legacy `docs/pr-summary-<N>.md`) and `pr-summary-<N>.facts.json` at `headRefOid` through the contents API, with no checkout, and compares the digest. A listing entry that carries no body (a prefetched maintenance entry) is read live with `gh pr view --json body,headRefOid`. Only a mismatch rebuilds the body: the pass checks the head out into a disposable shallow clone and runs the existing `runPrBodySync` there, so every carry-over rule and the head/ancestry guard apply unchanged. Steady state is silent: a match makes no edit and logs nothing, and it is memoised per head and digest, pruned once the PR is no longer listed. Legacy bodies with no digest marker are skipped. A read failure is logged with its cause and the body is left alone. Closes #3760.

## Evidence

Backend-only change; verified by unit and wiring tests.

- The contents read is `gh api repos/{repo}/contents/<path>?ref=<head> -H "Accept: application/vnd.github.raw"`. A missing file answers `gh: Not Found (HTTP 404)` (the shape `isNotFound` matches), and every other failure is reported as a read failure. `worker/deno/tests/pr_body_reconcile_test.ts::headSummaryDigest - reads the summary and facts as raw content at the ref and returns a digest result` pins the argv.
- The rebuild runs the real `syncPrBodyFromSummary` against a real git checkout in `worker/deno/tests/pr_body_reconcile_test.ts::reconcile - end to end: mismatch rebuilds through the real sync with the new digest`, which asserts exactly one `gh pr edit` whose body carries the new digest marker.
- The production wiring in `worker/deno/lib/run_core_production_deps.ts` is driven through the `_setGhSpawnRunner` seam by `worker/deno/tests/pr_body_reconcile_wiring_test.ts`: one test asserts the digest read goes to the configured repo at the listed head, the other that a failing `gh` listing is logged and the slot still resolves ok.
- `worker/deno/tests/run_core_test.ts` has one new member, `"Reconcile PR Body Digests"`, in `DEFERRABLE_HANDLER_NAMES`. Its stub deps wire `reconcilePrBodyDigests`, and the test title now reads "exactly five handlers carry budgetTier deferrable (Issue #2449, #3760)".
- `issueNumberFromMarker` in `worker/deno/lib/pr_body_sync.ts` is now exported for the pass. Its behaviour is unchanged.
- `checkedGit` in `worker/deno/lib/pr_body_reconcile.ts` is exported so its `Result` shape can be pinned directly.
- Branch history: WIP snapshot a7c648e2 captured a hand-applied mutation (the digest-match check removed) mid-experiment, and 20081ea0 restored it. History was not rewritten; the head has the check, and the reconcile suite passes there.
- Follow-up note: a listing entry with no body costs one `gh pr view` per scan, because the memo is keyed on head and digest and that digest is only known once the body is read. This cost applies only to prefetched maintenance entries. It is not changed here.

**Docs sweep** — grep: `syncPrBodyFromSummary`, `runPrBodySync`, "re-sync", "only after the worker's own", "Exactly four", "Four rungs", "maintenance lane", "every monitored repo"; section: `docs/workflows/pr-feedback.md` (the PR-body re-sync paragraph, now followed by **Priority 1.64 — Reconcile PR Body Digests**); siblings: "Blocking PR Stall Repair" / `1.63`, "Auto-Merge" / `1.65`, "Close Issues for Merged PRs", "Recover Assigned with Closed PRs", "Failure-Detection Repair Resume" (the priority ladders and the deferrable-handler list gained a member); updated: `docs/workflows/pr-feedback.md`, `docs/workflows/README.md`, `docs/workflows/issue-processing.md` (who logs a failed fix-run-gap sync now includes the 1.64 pass), `docs/USAGE.md`, `docs/OVERVIEW.md`, `docs/INTERNALS.md`, `docs/GH-API-OPTIMISATION.md`, `docs/audits/lib-sweep-coverage/top-up-3760.json` (claims the new module for the sweep ledger); `docs/workflows/ci-fix.md:78` — still true because it describes only the post-push re-sync, which is unchanged; `docs/USAGE.md:902` — still true because the 1.64 pass is not one of the agent-backed passes the maintenance lane runs; `docs/OVERVIEW.md:252`, `docs/INTERNALS.md:729`, `docs/workflows/issue-processing.md:210` — still true because their "every monitored repo" wording is about idle scans and claimable work, not this pass

## Test Plan

- No assertion was removed from an existing test. `worker/deno/tests/run_core_test.ts` gains one member in `DEFERRABLE_HANDLER_NAMES`, a stub for the new dep, and a title naming #3760. The other three test files are new.
- `worker/deno/tests/pr_body_reconcile_test.ts`, 38 tests, covering:
  - a digest match left untouched, and the memo;
  - a mismatch rebuilt exactly once, both stubbed and end to end;
  - the quiet skips: legacy body, no worker marker, invalid SHA, non-fleet author, author absent;
  - a bodyless listing entry read through `gh pr view`, plus that read failing, a reply that is not JSON, a reply with no string body, and a reply with a non-string `headRefOid`;
  - read and checkout failures;
  - the facts-file and summary candidates;
  - memo pruning;
  - `headSummaryDigest`, `checkedGit` and `disposableHeadCheckout`;
  - a cleanup failure;
  - an unexpected throw for one PR.
  
  `deno test -A tests/pr_body_reconcile_test.ts`: 38 passed.
- `worker/deno/tests/pr_body_reconcile_dispatch_test.ts`, 4 passed: the slot's priority, tier and order; the handler invoked once; a no-op when unwired; the error propagated. `worker/deno/tests/pr_body_reconcile_wiring_test.ts`: 2 passed. `worker/deno/tests/run_core_test.ts`: 77 passed.
- Issue-required cases each went red without their guard:
  - `reconcile - digest matches the head summary: silent, no edit, memo set`;
  - `reconcile - mismatch: one checkout at the head, one sync at its path, cleaned up`;
  - `reconcile - legacy body with no digest marker: skipped, no contents call, no log`;
  - `reconcile - contents read failure: warn with the cause, no checkout, no edit, not memoised`.
- Red checks on the `gh pr view` reply tests:
  - `reconcile - a gh pr view reply that is not JSON is a read failure: warn with the cause, no contents read, no rebuild`: the parse guard was removed and the test went red.
  - `reconcile - a gh pr view reply with no string body is a read failure: warn, no contents read, no rebuild`: the string check was dropped and the test went red.
  - `reconcile - a gh pr view reply whose headRefOid is not a string is skipped silently, no contents read`: the type check was dropped and the test went red.
- Red checks on the compound conditions, one operand at a time:
  - `worker/deno/lib/pr_body_reconcile.ts:393` (`login && !isFleetAuthor(…)`):
    - Forcing `login` true turned `reconcile - a listing entry with no author is still reconciled` red.
    - Dropping the `isFleetAuthor` operand turned `reconcile - non-fleet author: skipped, no contents call, no log` red.
  - `worker/deno/lib/pr_body_reconcile.ts:443` (`head.kind === "no-summary" || head.digest === recordedDigest`):
    - Dropping the `no-summary` operand turned `reconcile - no summary at either path: quiet, memoised, no checkout` red.
    - Dropping the digest operand turned `reconcile - digest matches the head summary: silent, no edit, memo set` red.
- Mutation check:
  - Each reported surviving mutant in `worker/deno/lib/pr_body_reconcile.ts` was applied by hand, one at a time. Each one turned at least one test in `worker/deno/tests/pr_body_reconcile_test.ts` red.
  - `worker/deno/lib/run_core_production_deps.ts` is covered through the production wiring by `worker/deno/tests/pr_body_reconcile_wiring_test.ts::Issue #3760: production reconcile resolves ok when the gh listing fails`. No line is exempt.
- Slow test: the pre-existing test "an unavailable tier adapts in place" takes 2m43s on base and between 214s and 4m48s on this branch, across runs. It is not touched by this change.
- Applied the rules to this PR's own diff:
  - Every named test path is checked with `git ls-files`.
  - The facts file names only tests at the head.
  - No new member lacks a production reader: `reconcilePrBodyDigests` is set in `worker/deno/lib/run_core_production_deps.ts`, `checkedGit` is called by `disposableHeadCheckout`, and `issueNumberFromMarker` is read by the pass.
  - Nothing else found.
- The branch outcomes are recorded in the facts file `docs/archive/pr-summaries/pr-summary-3760.facts.json`, using the marker form.

<!-- vibe-branch-outcomes -->
