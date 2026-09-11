## Summary

A check the base-branch deferral (#1880) parked on an issue now stays parked
**on every host** until that issue closes. `findFailedCiChecks` reads the pull
request's own fleet-authored `vibe-ci-fix-deferred` markers and skips the check
each one names while its `depends-on` issue is still open, so a new push with
the same failure posts nothing and no agent runs. Other failing checks on the
same pull request are scanned as usual, and the moment the blocker closes the
deferred check is returned again — #1880's loop guard then refuses a silent
second deferral. Closes #1881.

What changed:

- **`worker/deno/lib/ci_fix_pr_markers.ts`** — `findOpenDeferrals()` fetches the
  PR's comments (`fetchIssueCommentPages`, bounded), collects the fleet's
  deferral markers with the scan's own fleet login set, and reads each distinct
  blocker's state once (`gh issue view N --repo owner/repo`, so a blocker in
  another repository resolves). `parseBlockerRef()` / `isBlockerOpen()` are the
  shared `owner/repo#N` parser and state read; `pr_ci_processor.ts`'s
  `_blockerStillOpen` now uses them instead of its own copy.
- **`worker/deno/lib/pr_maintenance.ts`** — `findFailedCiChecks` calls
  `findOpenDeferrals` once per PR that still has a non-aggregator failure (a
  green or aggregator-only PR costs no comment fetch), drops the named checks,
  and logs one `skipReason` `ci-fix-deferred` line per PR naming each check and
  its blocker.
- **The fail direction is towards scanning.** A comment thread that cannot be
  read, an issue state that cannot be read, a marker authored outside the fleet,
  an unresolved fleet identity, or a reference that is not `owner/repo#N` each
  leave the check *undeferred* and are logged as errors — a suppressed real
  failure is the one outcome nobody would notice.
- **Docs** — `docs/INTERNALS.md` `find_failed_ci_checks()` gains the step;
  `docs/workflows/ci-fix.md` § Retry behaviour gains "Deferred checks are not
  rescanned (Issue #1881)".

## Tests

`worker/deno/tests/pr_maintenance_ci_deferral_test.ts`:

- fleet deferral for `Project Validation` + open issue ⇒ not returned, while a
  differently named failing check on the same PR is; the skip is logged once.
- issue closed ⇒ the check is returned, nothing skipped.
- cross-repo `other/core#7` ⇒ the state read carries `--repo other/core`.
- marker by a non-fleet author ⇒ ignored, check returned.
- comment fetch error / blocker state error ⇒ check returned, one error logged.
- green PR ⇒ no comment fetch at all.
- `findOpenDeferrals` reads each blocker once and lists each check once; an
  empty fleet set defers nothing; `parseBlockerRef` accepts only `owner/repo#N`.
