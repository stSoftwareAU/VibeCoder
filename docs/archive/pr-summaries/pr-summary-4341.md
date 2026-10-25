## Summary

The Semgrep workflow no longer passes `SEMGREP_APP_TOKEN` to `semgrep ci --config p/default`. `semgrep ci` exits fatally when a token is combined with an explicit `--config`, so any repo that set the secret would have had a failing Semgrep check on every PR. The scan stays a plain `p/default` scan, the same ruleset the local gate stage (`worker/deno/lib/semgrep_check.ts`) runs. Closes #4341.

Changed:

- `worker/deno/lib/workflow_definitions.ts`: the `semgrep` template (pushed to fleet repos by workflow-sync) drops the `env:` block and records why.
- `.github/workflows/semgrep.yml`: drops the token env, the `workflow_call` secret declaration and `environment: scanning-secrets` (added in #4404 only to gate this secret).
- `.github/workflows/quality.yml`: the `semgrep` job no longer passes the secret through.
- `worker/deno/lib/pinned_actions.ts`: the `SEMGREP_IMAGE_DIGEST` doc comment no longer claims a secret is in scope.
- `worker/deno/tests/semgrep_token_config_4341_test.ts`: new regression test.

## Spec

### Intent and Rationale

- The issue's preferred option was taken: dropping the token leaves no secret in scope, so the check cannot be broken by a repo owner adding the secret.
- The alternative (run without `--config` when a token is set) would need conditional shell and a second ruleset source; not needed for the stated goal.

### Essential Design Decisions

- `environment: scanning-secrets` was removed from the Semgrep job only. `gitleaks.yml` still uses it for `GITLEAKS_LICENSE`, so the environment itself stays.
- No new drift scanner was added. Existing repos pick up the change through workflow-sync when it next compares against the template. I did not verify that path end to end.

### Undiscoverable Facts

- The `semgrep ci` refusal is in semgrep v1.173.0 `cli/src/semgrep/commands/ci.py` (quoted in the issue). I did not re-read that source in this run; the repo's image pin is 1.182.1.

## Evidence

Backend/CI-config change, no UI. Evidence is the new test and the full gate.

- `env -u VIBE_IMAGE_AGENT_PROVIDERS ./quality.sh < /dev/null` on the final tree: `Result: PASSED (with skipped checks)`. `config integration` and `checkov` were skipped by the gate. `semgrep`, `workflow hygiene`, `deno tests`, `deno lint`, `deno type check` and `deno fmt` passed.
- Targeted run of the new test plus 7 neighbouring workflow tests: `ok | 71 passed | 0 failed`.

## Test Plan

- Added `worker/deno/tests/semgrep_token_config_4341_test.ts` (5 tests): a detector for `semgrep ci --config` with the token in step, job or top-level env (negative controls, including the `--config`-less alternative mode, which is not reported); the `semgrep` template from `WORKFLOW_SPECS` is token-free and still runs `semgrep ci --config p/default`; no workflow in `.github/workflows` has the combination; `semgrep.yml` has no `environment` and `quality.yml`'s `semgrep` job has no `secrets`.
- Red check: with the `SEMGREP_APP_TOKEN` env block restored in `semgrep.yml` and in the template, the template test and the repo-workflows test failed (`FAILED | 3 passed | 2 failed`); both were restored.
- No existing test was edited, so no assertion was removed.
- Twinned copies: the template and `.github/workflows/semgrep.yml` are the two copies of the rule; the new test checks both. `quality.yml` was the third place, also checked.
- Docs: grepped `prompts/`, `docs/` (not the archive), `README.md`, `CODING-STANDARDS.md`, `DESIGN-PRINCIPLES.md` and `worker/deno/lib` for `SEMGREP_APP_TOKEN` and `scanning-secrets`. Remaining hits are gitleaks-related (`prompts/workflow_setup/prompt.md`, `workflow_definitions.ts`) or a historical run record (`docs/pre-pr-ci-audit.md`).
- The new file names the issue only in its name and comments, which cite #4341; `gh issue view 4341` confirms that title.

## Not done or not checked

- A repo-side `SEMGREP_APP_TOKEN` secret, if already set on any fleet repo, is not removed by this change; it is simply unused.
- No scanner was added to flag existing fleet copies of the old template.
- The `checkov` and `config integration` gate stages were skipped by the gate itself on this host.
