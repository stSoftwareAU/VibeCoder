## Summary

`ownDiffUnchanged` (review-fleet-prs gate) now keeps a sent-back Dependabot PR
`awaiting-fix` when Dependabot re-cuts it (a `diverged` compare with an
identical own diff), instead of starting a full re-review that ends in the same
send-back. Any other force-push still gets a fresh review. Closes #4723.

## Spec

### Intent and Rationale

- Dependabot never merges the base into its PRs; it force-pushes a fresh commit
  with the same change, so `compare/{since}...{head}` is `diverged` and the
  ancestry check refused it every time.
- The ancestry check stays for fleet PRs: a force-push can itself be the fix
  (VibeCoder#3772, a squash with an identical tree that fixed a commit-message
  finding).

### Essential Design Decisions

- The exception needs all of: `kind === "dependabot"`, compare status
  `diverged`, a complete `base...head` commit list where every author login is
  `dependabot[bot]` (a null author fails), known non-empty findings that each
  (unwrapping structured earlier-review gaps) name a file in the sent-back own
  diff, and the strict
  path for every file (`normalisePatch` equality including context, no version
  exception, no file dropped or added; head-only files, the 300-file cap and
  duplicate names are refused as before).
- Findings that name a non-file (commit message, history, metadata) or are
  missing/empty force a fresh review. The check is structural (the finding's
  `file` must be in the own diff), not a wording guess, and fails towards a
  review.
- `kind` is a new optional last parameter of `ownDiffUnchanged`, passed from the
  gate loop (its only production caller). The held/`awaiting-owner` path passes
  no findings, so the exception never applies to it.
- It cannot approve anything: `awaiting-fix` only applies while the latest
  review requests changes.

### Undiscoverable Facts

- None.

## Evidence

Backend/CLI only. Tests (all in
`worker/deno/tests/review_fleet_prs_gate_2675_test.ts`, six new "Issue #4723"
tests) pass: `deno task test:unit tests/review_fleet_prs_gate_2675_test.ts` → 60
passed, 0 failed; the 13 other importers of `gate.ts` → 187 passed, 0 failed.

Docs updated: `.claude/skills/review-fleet-prs/SKILL.md` (rule 8) and
`.claude/skills/review-fleet-prs/references/edge-cases.md` ("Version-only
re-bumps"). Grepped both for `force-push`, `ancestor`, `ahead`, `diverged`; no
other sentence became false.

## Test Plan

Second review follow-up: export `isEarlierGap` from the gap builder and use it
to accept structured wrappers only when their original finding is content.
The regression builds real records with `earlierFindingGaps`: a content gap
alone or alongside a plain finding stays `awaiting-fix`; a commit-message gap
or text-only gap gets a fresh review. The new test failed before the fix
(null instead of `awaiting-fix`). No existing assertion was removed.
All 80 tests across the gate, pass-level wiring and earlier-findings suites
pass, alongside targeted formatting, lint and type checking.

Review follow-up: added a pass-level regression in
`worker/deno/tests/review_fleet_prs_upkeep_failure_2891_test.ts` with an
`app/dependabot` PR, a changes-requested record at X naming `a.ts`, a
diverged X-to-head comparison, only Dependabot-authored base-to-head commits,
and identical patches. It asserts one `awaiting-fix` skip and no ready PRs;
the same fixture with a fleet author is ready for review. Removing `kind`
from the production `pass` call makes this test fail (0 skips instead of 1);
restoring it passes. No production behaviour changed in this follow-up.

Follow-up validation: both relevant suites pass (66 tests), as do
`check:manifests` (847 tests), formatting, lint, type checking, Markdown lint
and the summary checks available without issue metadata. The full local gate
reaches a Deno 2.9.5 macOS runtime panic in its parallel unit pass:
`pledge test permissions called before restoring previous pledge`.
All other runnable gate stages pass. Semgrep and Checkov lack their local
binaries/images; config integration lacks its configuration. The PR's CI and
the required checks on PR #4715, which produced the current base, are green.

Covered: Dependabot diverged + identical patch → `awaiting-fix`; one
non-Dependabot or null-author commit → review; fleet/omitted kind with diverged
head → review (VibeCoder#3772 case); differing patch, version-only difference,
or dropped file → review; undefined/empty findings, a finding on a non-file, or
a non-file `earlier` → review (with a positive control naming `a.ts`);
context-only change in an unnamed file → review (strict path).

Red checks (each break reverted afterwards):

- drop `kind === "dependabot"` → the fleet-diverged test red
- drop the author check → the commit-author test red
- drop the findings content check → the content-findings test red
- make the file loop non-strict → the strict-path and whole-patch tests red

`./quality.sh`: all stages pass except `deno tests`, which has 3 failures in
files this change does not touch, caused by the sandbox:
`fleet_pr_babysitter_test.ts` (cannot load `jsr.io/@std/crypto`),
`merge_fallback_issue_test.ts` (label creation through gh) and
`milestone_resolution_gate_test.ts` (untrusted `/tmp` account). The serial pass
did not run because of them. CI runs the same checks.
