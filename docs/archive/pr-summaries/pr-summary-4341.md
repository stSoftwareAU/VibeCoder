## Summary

The Semgrep workflow no longer passes `SEMGREP_APP_TOKEN` to
`semgrep ci --config p/default`. `semgrep ci` exits fatally when a token is
combined with an explicit `--config`, so any repo that set the secret would have
had a failing Semgrep check on every PR. The scan stays a plain `p/default`
scan, the same ruleset the local gate stage (`worker/deno/lib/semgrep_check.ts`)
runs. Closes #4341.

Changed:

- `worker/deno/lib/workflow_definitions.ts`: the `semgrep` template (pushed to
  fleet repos by workflow-sync) drops the `env:` block and records why.
- `.github/workflows/semgrep.yml`: drops the token env, the `workflow_call`
  secret declaration and `environment: scanning-secrets` (added in #4404 only to
  gate this secret).
- `.github/workflows/quality.yml`: the `semgrep` job no longer passes the secret
  through.
- `worker/deno/lib/pinned_actions.ts`: the `SEMGREP_IMAGE_DIGEST` doc comment no
  longer claims a secret is in scope.
- `worker/deno/tests/semgrep_token_config_4341_test.ts`: new regression test;
  it decides token-free by calling `scanSemgrepTokenDrift`, with no detector of
  its own.
- `worker/deno/lib/workflow_file_checks.ts`: new `semgrep-token-config` entry in
  `WORKFLOW_FILE_CHECKS` (after `gitleaks-drift`), so the pre-PR
  changed-workflow gate, the workflow-sync issue bodies and the template
  conformance test hold workflows to it. Mirrored in the check list in
  `prompts/issue/prompt.md` and the counts in `docs/EXTENDING.md`.
- `worker/deno/lib/semgrep_token_drift_scanner.ts` (new), wired into the
  `github-actions-audit` template in
  `worker/deno/lib/idle_task_templates/github_actions_audit_template.ts` (step
  5h2b): flags existing fleet copies of the old template, which the
  presence-only `semgrep` spec leaves "covered". It files
  `BP-SEMGREP-TOKEN-CONFIG-<basename>` (`severity:medium`) for any workflow that
  runs `semgrep ci --config` with `SEMGREP_APP_TOKEN` in step, job or top-level
  `env`. Documented in `docs/GITHUB-ACTIONS-AUDIT-SCAN.md`.
- `worker/deno/tests/semgrep_token_drift_scanner_test.ts`: tests for it.
- `worker/deno/tests/github_actions_audit_template_test.ts`: two `runTask`
  tests for step 5h2b (files the finding; skips one already open).

## Spec

### Intent and Rationale

- The issue's preferred option was taken: dropping the token leaves no secret in
  scope, so the check cannot be broken by a repo owner adding the secret.
- The alternative (run without `--config` when a token is set) would need
  conditional shell and a second ruleset source; not needed for the stated goal.

### Essential Design Decisions

- `environment: scanning-secrets` was removed from the Semgrep job only.
  `gitleaks.yml` still uses it for `GITLEAKS_LICENSE`, so the environment itself
  stays.
- Existing fleet repos that hold the old template are handled by a drift
  scanner, modelled on `gitleaks_drift_scanner.ts`, not by workflow-sync: the
  `semgrep` spec only detects presence, so the audit reports the copy and the
  fix rides a normal per-repo worker PR (Issue #3239 isolation). I did not run the audit end to end
  against a live fleet repo; `runTask` tests drive step 5h2b through the `gh`
  stub.

### Undiscoverable Facts

- The `semgrep ci` refusal is in semgrep v1.173.0
  `cli/src/semgrep/commands/ci.py` (quoted in the issue). I did not re-read that
  source in this run; the repo's image pin is 1.182.1.

## Evidence

Backend/CI-config change, no UI. Evidence is the new test and the full gate.

- `env -u VIBE_IMAGE_AGENT_PROVIDERS ./quality.sh < /dev/null` on the final
  tree: `Result: PASSED (with skipped checks)`. `config integration` and
  `checkov` were skipped by the gate. `semgrep`, `workflow hygiene`,
  `deno tests`, `deno lint`, `deno type check` and `deno fmt` passed.
- Targeted run of the two semgrep test files plus the workflow-file-check,
  conformance, changed-workflow-gate, issue-prompt, workflow-sync and
  audit-template tests (head after PR #4348 review): `ok | 203 passed | 0 failed`.
  The full gate was not re-run after the review fixes.

## Test Plan

- Added `worker/deno/tests/semgrep_token_config_4341_test.ts` (3 tests at head),
  all calling the production `scanSemgrepTokenDrift`: the `semgrep` template
  from `WORKFLOW_SPECS` is token-free and still runs
  `semgrep ci --config p/default`; no workflow in `.github/workflows` has the
  combination; `semgrep.yml` has no `environment` and `quality.yml`'s `semgrep`
  job has no `secrets`. Detection cases (step, job and top-level env, the
  `--config`-less mode) live in the scanner's own test file.
- Added `worker/deno/tests/semgrep_token_drift_scanner_test.ts` (6 tests): token
  in step, job and top-level `env` is flagged; line cited; the current `semgrep`
  template is clean; token without `--config` is not drift; non-workflow and
  unparseable files yield nothing; suppressed and known-open ids are skipped.
  Red check: dropping the top-level `env` branch failed the step/job/top-level
  test; restored.
- Added to `worker/deno/tests/github_actions_audit_template_test.ts` (2 `runTask`
  tests): an old-template copy yields exactly one created issue with
  `<!-- finding-id: BP-SEMGREP-TOKEN-CONFIG-semgrep -->`, the audit and
  `severity:medium` labels, and the id in `runScanFn`'s known-open list; a
  finding already open files nothing. Red check: passing `[]` instead of
  `files` to `scanSemgrepTokenDrift` in step 5h2b failed the first test.
  Dropping `seenIds.add` there stays green: the known-open list handed to
  `runScanFn` is built from `preFiled`, and no later pre-filer reads the id.
- Table wiring: `semgrep-token-config` added to `EXPECTED_CHECK_IDS`
  (conformance test), `VIOLATIONS` (`workflow_file_checks_test.ts`) and `SEEDED`
  (`changed_workflow_gate_test.ts`). Red checks: making the entry return `[]`
  failed its `VIOLATIONS` test and the gate-seeded test (`57 passed | 2 failed`);
  deleting the entry failed the conformance id-list test.
- Red check: with `semgrep  ci --config p/default` (two spaces) and the token
  env restored in `semgrep.yml`, the repo-workflows and `semgrep.yml` tests
  failed (`FAILED | 1 passed | 2 failed`); restored.
- No existing test was edited, so no assertion was removed.
- Twinned copies: the template and `.github/workflows/semgrep.yml` are the two
  copies of the rule; the new test checks both. `quality.yml` was the third
  place, also checked. The audit-check lists are the other twin:
  `WORKFLOW_FILE_CHECKS` (now carries the check), the check list in
  `prompts/issue/prompt.md` (updated; `issue_prompt_workflow_files_test.ts`
  asserts it), and the counts in `docs/EXTENDING.md` and the conformance test
  header (updated).
- Docs: grepped `prompts/`, `docs/` (not the archive), `README.md`,
  `CODING-STANDARDS.md`, `DESIGN-PRINCIPLES.md` and `worker/deno/lib` for
  `SEMGREP_APP_TOKEN` and `scanning-secrets`. Remaining hits are
  gitleaks-related (`prompts/workflow_setup/prompt.md`,
  `workflow_definitions.ts`) or a historical run record
  (`docs/pre-pr-ci-audit.md`).
- The new file names the issue only in its name and comments, which cite #4341;
  `gh issue view 4341` confirms that title.

## Not done or not checked

- A repo-side `SEMGREP_APP_TOKEN` secret, if already set on any fleet repo, is
  not removed by this change; it is simply unused.
- The `checkov` and `config integration` gate stages were skipped by the gate
  itself on this host.
