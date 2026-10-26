## Summary

Closes #3973. Part of #3653.

The `aws-cloudformation` bucket of the fleet best-practices audit (`checkCfnLint`
in `worker/deno/lib/linter_in_ci_check.ts`) now requires both cfn-lint and
Checkov in a repository's CI workflows. The finding names exactly which tool is
missing and gives a CI-step suggestion for each missing tool. Repositories
without CloudFormation templates are unchanged: the bucket picker only offers
`aws-cloudformation` when `markers.cloudFormationBytes` is positive
(`worker/deno/lib/best_practices_bucket_picker.ts:152`), and this diff does not
touch the picker. The audit only
reports; each repository adds its own gate, as the repository-isolation rule
requires.

## Spec

### Intent and Rationale

- A CloudFormation repository needs a linter (cfn-lint, for schema and
  intrinsic-function errors) and a policy scanner (Checkov, for insecure
  resource configuration) in CI. The audit should report whichever of the two
  is missing, not only cfn-lint.
- The bucket's existing contract is kept: the same `linter`, the same early
  return when no workflows load, and the same reporting shape.

### Essential Design Decisions

- Two separate `anyWorkflowMatches` checks, `/cfn-lint/i` and `/checkov/i`
  (`worker/deno/lib/linter_in_ci_check.ts:657-658`), so each missing tool is
  named on its own.
- `linter: "cfn-lint"` is kept, so the bucket's identity and
  `classifyMissingGates` behaviour are unchanged.
- `gates` stays undefined.
- `details` names the missing tools joined with " or "
  (`worker/deno/lib/linter_in_ci_check.ts:671`), and adds a CI-step suggestion
  for each missing tool (`:673-679` for cfn-lint, `:680-685` for Checkov).

### Undiscoverable Facts

- Workflow invocations are lowercased at load time
  (`worker/deno/lib/linter_in_ci_check.ts:231`), so case-insensitivity comes
  from that. The `i` flag is kept for readability but is redundant: dropping it
  left all tests green (see M5b in the Test Plan).

## Evidence

- Backend and CLI only, with no visual surface.
- `deno test -A tests/linter_in_ci_check_test.ts < /dev/null` in `worker/deno`:
  `ok | 46 passed | 0 failed (43ms)`.

Docs sweep: grep: `cfn-lint`, `checkov`, `aws-cloudformation` across README.md, docs/, DESIGN-PRINCIPLES.md, CODING-STANDARDS.md, prompts/; section: docs/BEST-PRACTICES-SCAN.md aws-cloudformation entry and bucket table, DESIGN-PRINCIPLES.md linter-in-CI list; siblings: `tflint`, `htmlhint`; updated: docs/BEST-PRACTICES-SCAN.md:461, docs/BEST-PRACTICES-SCAN.md:837, DESIGN-PRINCIPLES.md:1692

- `docs/archive/pr-summaries/pr-summary-721.md:20` — still true because it is a historical PR summary describing the change at that time
- `docs/audits/security-sweep-2180-linux-verification-host.md:359` — still true because it is a dated audit record
- `CONTRIBUTING.md:96`, `CONTRIBUTING.md:129`, `CONTRIBUTING.md:166`–`191` — still true because they describe VibeCoder's own `checkov.yml` workflow and `./quality.sh` checkov stage, not the fleet audit bucket
- `CODING-STANDARDS.md:1561`, `CODING-STANDARDS.md:1569` — still true because they list VibeCoder's own local and CI checks
- `docs/INTERNALS.md:119`, `docs/INTERNALS.md:150`–`162` — still true because they describe VibeCoder's own `checkov` quality stage
- `docs/REFERENCES.md:132` — still true because it lists tools VibeCoder itself runs
- `docs/audits/dependency-inventory.md:12`, `docs/audits/dependency-inventory.md:17` — still true because they inventory action pins used by `checkov.yml`
- `prompts/best_practices/buckets/terraform.md:65`, `prompts/best_practices/buckets/terraform.md:74` — still true because they advise Checkov for the terraform bucket, which this change does not touch

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — A repository with CloudFormation templates and only cfn-lint in CI gets a finding that names Checkov as missing. — evidence: `worker/deno/tests/linter_in_ci_check_test.ts::aws-cloudformation — only cfn-lint invoked in CI is not configured` — reviewer: met
- **met** — A repository with only Checkov gets a finding that names cfn-lint as missing. — evidence: `worker/deno/tests/linter_in_ci_check_test.ts::aws-cloudformation — only Checkov invoked in CI is not configured` — reviewer: met
- **met** — A repository with neither gets a finding that names both. — evidence: `worker/deno/tests/linter_in_ci_check_test.ts::aws-cloudformation — neither cfn-lint nor Checkov invoked in CI is not configured` — reviewer: met
- **met** — A repository with both passes the bucket. — evidence: `worker/deno/tests/linter_in_ci_check_test.ts::aws-cloudformation — cfn-lint and Checkov invoked in CI is configured` — reviewer: met
- **met** — The Checkov match is case-insensitive. — evidence: `worker/deno/tests/linter_in_ci_check_test.ts::aws-cloudformation — mixed-case CheckOV with cfn-lint invoked in CI is configured` — reviewer: met
- **met** — Repositories without CloudFormation templates are unaffected. — evidence: `worker/deno/lib/best_practices_bucket_picker.ts:152` offers the `aws-cloudformation` bucket only when `markers.cloudFormationBytes` is positive, and the diff does not touch that file; `worker/deno/tests/best_practices_bucket_picker_test.ts::pickBucket - single Rust repo picks rust, general or design only` shows a repository without CloudFormation marker bytes never gets the bucket — reviewer: met
- **partial** — Docs describe both requirements, and tests and `./quality.sh` pass. — evidence: `docs/BEST-PRACTICES-SCAN.md:461` and `:837` and `DESIGN-PRINCIPLES.md:1692` describe both tools; `worker/deno/tests/linter_in_ci_check_test.ts` passes (46 passed); every `./quality.sh` stage passed except deno tests (29499 passed, 5 failed) — reviewer: partial — reason: the 5 failing tests are outside this change and fail identically on base `origin/milestone/pre-push-gate-ci-parity`

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — reviewer: standards-reviewer. Violations: none.
  - Checked clean: Australian English; twinned copies (none found); branch
    outcomes; no source-text grep tests; no removed assertions; no drift pins;
    no silent failures; no workflow file change.
  - Optional, not acted on: the regex matches any substring of a step's
    `run` or `uses` string (`collectInvocations`,
    `worker/deno/lib/linter_in_ci_check.ts:276-291`), so a shell comment
    inside a `run:` block counts, as it already does for the cfn-lint check.
    YAML comments are not matched.

## Test Plan

- Edited fixtures:
  - `worker/deno/tests/linter_in_ci_check_test.ts:463`, old name
    "aws-cloudformation — cfn-lint invoked in CI is configured", now
    "aws-cloudformation — cfn-lint and Checkov invoked in CI is configured".
    - Removed from: the fixture had only a cfn-lint step.
    - Required by: "When both are present the bucket passes"
    - Replaced by: the renamed test, whose fixture adds a `checkov` step.
  - `worker/deno/tests/linter_in_ci_check_test.ts:1196`, "github-actions / cfn /
    terraform #2177 — gates field stays undefined": the fixture gained a
    `checkov` step.
    - Required by: "When both are present the bucket passes"
    - Replaced by: the same test with both steps; it still asserts `gates`
      undefined and configured.
- Red-check table (each mutation applied alone, then restored):

  | Mutation | Applied to | Red tests |
  | --- | --- | --- |
  | M1 | lib:657 `hasCfnLint` forced to true | only-Checkov; neither |
  | M2 | lib:658 `hasCheckov` forced to true | only-cfn-lint; neither |
  | M3 | lib:659 `if (hasCfnLint)` (drops the hasCheckov operand) | only-cfn-lint |
  | M4 | lib:659 `if (hasCheckov)` (drops the hasCfnLint operand) | only-Checkov |
  | M5a | regex `/CheckOV/` without lowercasing the match | both-invoked; mixed-case; #2177 |
  | M5b | `i` flag dropped from both regexes | all green (redundant: invocations are lowercased) |
  | M6 | lib:669 deleted | only-Checkov; neither |
  | M7 | lib:670 deleted | only-cfn-lint; neither |
  | M8 | checkov step removed from the 463 fixture | both-invoked |
  | M9 | checkov step removed from the #2177 fixture | #2177 |
  | M10 | base lib with the new tests | only-cfn-lint; neither |
  | A | lib:673 `if (false)` | only-Checkov |
  | B | lib:673 `if (true)` | only-cfn-lint |
  | C | lib:680 `if (false)` | only-cfn-lint |
  | D | lib:680 `if (true)` | only-Checkov |

- Command: `deno task test:unit tests/linter_in_ci_check_test.ts` gives 46 passed.
- [ ] `./quality.sh < /dev/null` exits 1. Every stage passes except deno tests:
  29499 passed and 5 failed. The same 5 fail on base
  `origin/milestone/pre-push-gate-ci-parity` (`deno test -A` on the three files
  in a clean base worktree: 20 passed, 5 failed):
  - `worker/deno/tests/claude_runner_provider_fallback_4034_test.ts:123` and
    `:149`, and `worker/deno/tests/external_orchestration_3642_config_test.ts:101`
    fail because this container image does not install the `codex` provider
    ("The running container image did not install the \"codex\" coding-agent
    provider. Installed: claude.").
  - `worker/deno/tests/completion_phase_repo_formatters_test.ts:480` and `:567`
    fail with "formatter should commit the Rust fix". The cause was not
    diagnosed.

<!-- vibe-branch-outcomes -->

## Not done / risks

- `./quality.sh` is red on 5 deno tests that fail the same way on base (see
  Test Plan). This PR does not fix them.
- No new test covers repositories without CloudFormation templates. AC6 rests
  on the bucket picker (`worker/deno/lib/best_practices_bucket_picker.ts:152`)
  being unchanged and on its existing tests.
- Root docs are not fmt-gated, so the wrapped line at
  `DESIGN-PRINCIPLES.md:1692` was left as it is.
- The regex matches a shell comment inside a step's `run:` block too, because
  it searches the whole `run` string. The existing cfn-lint check already
  behaves this way. YAML comments are not matched.
