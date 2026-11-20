# PR Summary — Issue #5110

## Summary

PR #5276 (merged) moved VibeCoder's CloudFormation CI to the official AWS
Emulator. This PR covers what #5110 still needed:

- **A fresh worker container runs the reference command as `agent`.** The
  required `container` check in `.github/workflows/container-build.yml` now
  starts a fresh container from the image it has just built and runs
  `infra/cloudformation/test-aws-emulator.sh` there as `agent`, using
  `docker run --rm --user agent`, with `infra/cloudformation` mounted read-only
  and the script as the entrypoint. Its exit status fails the check. The step
  runs whenever that job builds the image: on a pull request with an
  image-affecting change, on the weekly schedule, or on a manual run. This PR
  changes `container-build.yml`, so its own CI runs the step.
- **The container step has a validator.** `checkContainerBuildRunsAwsEmulator`
  in `worker/deno/lib/aws_emulator_workflow_check.ts` (`[container-agent-run]`)
  requires a step in job `container` that is only `set -euo pipefail` plus one
  `docker run`. It parses that `docker run` positionally and fails closed:
  - the image must be `${IMAGE}`, and only `< /dev/null` may follow it;
  - only `--rm`, `--user`, `--volume` and `--entrypoint` are allowed, so
    `--env BASH_ENV=…` and `--mount` fail;
  - the last `--user` must be `agent`;
  - there must be exactly one `--volume`. It must be
    `${GITHUB_WORKSPACE}/infra/cloudformation:D:ro`, with D an absolute path
    that has no `.` or `..` segment, and the last `--entrypoint` must be exactly
    `D/test-aws-emulator.sh`. A second volume cannot shadow the script;
  - `${IMAGE}` must name the image the job just built. The step must set no
    `env:`. The job and workflow `env:` must not set `BASH_ENV`, `ENV`, `PATH`,
    `DOCKER_HOST`, `DOCKER_CONTEXT` or `DOCKER_CONFIG`. The job must set
    `env.IMAGE`, and `env.IMAGE_CHANGED` exactly
    `${{ needs.changes.outputs.image }}`. An earlier step without its own
    `env.IMAGE` must run `docker build -t "${IMAGE}"`. No step in the job may
    name `GITHUB_ENV` or `GITHUB_PATH`. No step between the build and the agent
    run may build, tag, pull, load, import or commit an image while naming
    `IMAGE` or the job's literal tag;
  - the job and the step must not set `continue-on-error`; the job must have no
    `if:`, and the step's `if:` must be absent or `env.IMAGE_CHANGED == 'true'`;
  - the effective shell must run the body.
- **Syntax-only shells are refused (PR #5276 review).**
  `checkAwsEmulatorWorkflow` now checks the test step's effective shell: the
  step's `shell:`, else the job's, else the workflow's `defaults.run.shell`. The
  shell must be unset, or `bash`/`sh` (bare, `/bin/` or `/usr/bin/`; another
  path such as `/tmp/f/bash` is refused) with only `--noprofile`, `--norc`,
  `-e`/`-u`/`-x`/`-o <name>` options and an optional `{0}`. Before this change,
  `bash -n {0}`, `bash -o noexec {0}`, `bash -c true {0}` and `true {0}` all
  passed without running the deploy.

Part of #5110.

## Spec

### Intent and Rationale

- No container runtime exists on the worker host. The only place a fresh worker
  container can run the command is the CI job that already builds the image, so
  the run lives there rather than in a new workflow (issue Scope 8: reuse
  current CI mechanisms).
- The validator allowlists shells and `docker run` arguments rather than
  blocklisting them. A new evasion form then fails closed instead of passing.

### Essential Design Decisions

- The agent run is gated on `IMAGE_CHANGED`, the job's existing image gate. A PR
  that changes only the templates or the script is still covered on every PR by
  `aws-emulator.yml`, on the runner.
- The container mount is read-only. The script reads templates from its own
  directory and writes only under `mktemp` and `aws-emulator-run`'s private HOME
  (`infra/cloudformation/test-aws-emulator.sh:39`, `:101`;
  `container/aws-emulator-run.sh:302`).
- `defaultShell` is exported from `worker/deno/lib/aws_emulator_in_ci_check.ts`
  and reused, not copied.

### Undiscoverable Facts

- PR #5276's CI run (job 136009596629) shows the runner path working: 22
  assertions passed, one named gap (`AWS::EC2::Instance` `MetadataOptions`),
  `ParameterNotFound` as the negative case, and cleanup asserted.
- On PR #5276, `container-build / container` passed in 4 s without building,
  because that PR had no image-affecting change. The new step has therefore not
  run anywhere until this PR's CI.
- The fleet reviewer's comment on #5110 reported the `bash -n {0}` gap and
  attributed it to this issue.

## Evidence

Backend and CI only. No UI file is touched.

```mermaid
flowchart LR
    B["container-build.yml<br/>builds vibe-coder:ci"] --> A["docker run --rm --user agent<br/>infra/cloudformation:ro"]
    A --> S["test-aws-emulator.sh"]
    S --> R["aws-emulator-run<br/>(private emulator)"]
    R --> X{"exit status"}
    X -->|non-zero| F["container check fails"]
    X -->|0| P["container check passes"]
    V["checkContainerBuildRunsAwsEmulator"] -.validates.-> A
```

- `cd worker/deno && deno task test:unit tests/issue_5110_aws_emulator_workflow_test.ts tests/aws_emulator_in_ci_check_test.ts < /dev/null`:
  268 passed, 0 failed.
- A corpus run over every `.github/workflows/*.yml` at the head:
  - `checkContainerBuildRunsAwsEmulator` returns `[]` only for
    `container-build.yml`;
  - `checkAwsEmulatorWorkflow` returns `[]` only for `aws-emulator.yml`;
  - every other workflow gets findings from both;
  - false positives 0, false negatives 0.
- Issue numbers cited: #5110 (CI: migrate VibeCoder's AWS tests to AWS Emulator
  and record real coverage gaps); #5276 (the earlier, merged PR for this issue).

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **partial** — A fresh worker container runs the reference command as `agent`,
  and CI runs the same applicable integration checks. — evidence:
  `.github/workflows/container-build.yml` ("Run the AWS Emulator reference
  command as agent in a fresh container"), held by
  `worker/deno/tests/issue_5110_aws_emulator_workflow_test.ts::real container-build.yml runs the reference command as agent`;
  `aws-emulator.yml` ran in PR #5276's CI — reviewer: partial — reason: the
  container step has never run (this host has no docker or podman), so the
  `agent` user, the `:ro` mount and the run itself are unproven until this PR's
  `container` check
- **partial** — Evidence includes the pinned release, actual test commands,
  successful data assertions, a supported negative API result and cleanup. —
  evidence: PR #5276 CI job 136009596629 (runner path: 22 assertions,
  `ParameterNotFound`, cleanup asserted); aws-emulator 1.0.385 pinned in
  `container/tools.json` — reviewer: partial — reason: no output exists yet from
  the fresh-container run, which comes from this PR's `container` check
- **partial** — Focused tests prove startup/test failures propagate and missing
  required execution cannot become a green check. — evidence:
  `worker/deno/tests/issue_5110_aws_emulator_workflow_test.ts` (shell refusals
  at step, job and workflow level; `(container-agent-run) refuses …` for the
  verifier's step `env: IMAGE` and shadowing-volume cases, step and inherited
  `BASH_ENV`/`DOCKER_HOST`, `GITHUB_ENV`/`GITHUB_PATH`, a constant
  `IMAGE_CHANGED`, `/tmp/f/bash`, `!`, `|| true`, `if:`, `continue-on-error` and
  a removed step) — reviewer: partial — reason: the text check still accepts the
  runner-side edits listed under "Not done or not checked". These are a script
  rewrite, an unrecognised retag, an indirect env-file write, a replaced docker
  or context, and a constant `changes` output
- **met** — Every existing template is accounted for as exercised or as a
  specific unsupported case with alternative validation; no unsupported/stubbed
  resource is reported as proven. — evidence:
  `infra/cloudformation/test-aws-emulator.sh` (`KNOWN_GAPS`, from PR #5276) —
  reviewer: met
- **met** — Any retained Floci test names the exact gap and removal/recheck
  condition. — evidence: no Floci test is retained (removed in PR #5276) —
  reviewer: met
- **met** — Existing branch/PR coverage, least-privilege permissions and
  required checks remain intact. CI actually runs the new command rather than
  merely installing the emulator. — evidence:
  `.github/workflows/aws-emulator.yml` in PR #5276's CI, which ran the command;
  the new step adds no permission — reviewer: met
- **partial** — Required local/CI checks pass; no automatic mutation or fuzzing
  campaign is added. — evidence: focused tests pass (268); no campaign added —
  reviewer: partial — reason: CI has not run on this head, and `./quality.sh`
  was not re-run after f774d97b9 (the worker re-runs the gate)
- **unrequested** — `defaultShell` is exported from
  `worker/deno/lib/aws_emulator_in_ci_check.ts` — reviewer: unrequested —
  reason: it is reused by the effective-shell check rather than copied

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Writing a gate over text: `bash -c true {0}` passed the shell
  check — evidence: `worker/deno/lib/aws_emulator_workflow_check.ts:189` —
  reason: fixed in this diff (allowlist `shellRunsBody`, with tests)
- **violation** — Writing a gate over text: one matching segment was enough, so
  a `set +e` line passed — evidence:
  `worker/deno/lib/aws_emulator_workflow_check.ts:394` — reason: fixed in this
  diff (`stepIsAgentRun` requires only `set -euo pipefail` and the one
  `docker run`)
- **violation** — Workflow behaviour change extends the validator: the image,
  the last `--user` and the `:ro` mount were not checked — evidence:
  `worker/deno/lib/aws_emulator_workflow_check.ts:364` — reason: fixed in this
  diff (positional parse, with tests)
- **violation** — Evasion table both ways: commented-out, `\`-wrapped,
  `--user=agent`, `set +e`, different-image, `bash -c` and `echo` look-alike
  cases had no test — evidence:
  `worker/deno/tests/issue_5110_aws_emulator_workflow_test.ts:529` — reason:
  fixed in this diff
- **violation** — Evasion table both ways: a step-level `IMAGE` override and a
  second volume shadowing the entrypoint passed `[container-agent-run]` (pre-PR
  verifier) — evidence: `worker/deno/lib/aws_emulator_workflow_check.ts:400` —
  reason: fixed in this diff (`volumeHoldsEntrypoint`, `stepOverridesImage`,
  `segmentBuildsImage`, `stepMayRetagImage`, with refusal tests)
- **clean** — These areas were checked and comply:
  - both checks read parsed YAML, and full-line comments and `\` continuations
    are handled;
  - a step with `|`, `;` or `&` fails closed;
  - `!` and `|| true` are refused;
  - the shell precedence (step, then job, then workflow) matches GitHub;
  - the `continue-on-error` and `if:` tests;
  - `mutate` became `mutateText` and keeps the exactly-once anchor check.

  Review-only rules checked: the evasion table, no source-grep tests, no
  test-only members, and Australian English.

## Test Plan

- Added to `worker/deno/tests/issue_5110_aws_emulator_workflow_test.ts`:
  - the effective-shell refusals and controls for `aws-emulator.yml`;
  - the real `container-build.yml` positive case;
  - the `[container-agent-run]` refusal table and its controls (`-u agent`,
    `--user=agent`, a `\` re-wrap, the `--volume=`/`--entrypoint=` forms, a
    mount at another absolute directory);
  - the pre-PR verifier's evasions, each refused: a step-level `env: IMAGE`
    override, an expression `env:`, no job `env.IMAGE`, a build step with its
    own `IMAGE` or another tag, and a later step that retags `${IMAGE}` or
    `vibe-coder:ci` or writes `GITHUB_ENV`. Also a second volume shadowing the
    entrypoint's directory (both the verifier's `/x:ro` form and an added
    volume), an entrypoint outside the mount or reached through `..`, another
    source directory, a `:ro,z` mode, `--mount` and `--env BASH_ENV`;
  - the spec reviewer's evasions, each refused: step `env:` `BASH_ENV` or
    `DOCKER_HOST`, an earlier step writing `GITHUB_PATH`, a pre-build step
    writing `GITHUB_ENV`, a constant job `IMAGE_CHANGED`, and
    `shell: /tmp/f/bash {0}`, and a job-level `BASH_ENV` or workflow-level
    `DOCKER_HOST`. A `/bin/bash -e {0}` control is accepted;
  - the job-level refusals;
  - the removed-step case;
  - the malformed-input case.
- No existing assertion was removed or changed. `mutate` now delegates to
  `mutateText(base, ...)` and keeps the exactly-once anchor check.
- A red run against base was not observed. The new container tests import a
  function that base lacks, so the file cannot load there. The fleet reviewer
  showed by direct call that base `checkAwsEmulatorWorkflow` returns `[]` for a
  `bash -n {0}` test step.
- `./quality.sh` was not re-run after the validator fixes (97d2b19dc, f774d97b9
  and the inherited-env commit); the worker re-runs the gate.
- `./quality.sh < /dev/null` on f10167677:
  `Result: PASSED (with skipped
  checks)`; `config integration` and `checkov`
  were skipped by the gate itself. An earlier run on 8005e1c03 failed one test,
  `worker/deno/tests/pr_summary_ci_workflow_3768_test.ts`, on this host's
  offline npm cache ("Failed caching npm package 'commonmark@0.31.2' ... dns
  error"); it passed after that cache was seeded, with no code change.
- Twinned-rule search: `checkAwsEmulatorWorkflow` and the fleet detector
  `workflowRunsAwsEmulator` both judge shells. The detector keeps its own
  `shellIsNoexec` blocklist and is unchanged.

## Not done or not checked

- The new container step has not run yet. Its first run is this PR's `container`
  check.
- `checkContainerBuildRunsAwsEmulator` checks workflow text and cannot see every
  runner-side edit. The spec reviewer showed it still accepts the following, and
  no test refuses them:
  - an earlier step that overwrites `infra/cloudformation/test-aws-emulator.sh`
    on the runner;
  - a retag with a docker global flag first
    (`docker --log-level error tag busybox "${IMAGE}"`);
  - a retag whose literal tag is split by quotes (`vibe-coder:c''i`);
  - a retag by another tool (`skopeo copy`);
  - a retag inside the build step after `docker build`, or one through a command
    variable (`d=docker; $d tag …`);
  - an indirect `GITHUB_ENV`/`GITHUB_PATH` write (`"${!v}"`, or the runner's
    `_runner_file_commands` files);
  - an earlier step that replaces `/usr/bin/docker` or switches the docker
    context;
  - a `changes` job whose `outputs.image` is a constant `'false'`, or a
    `container` job without `needs: changes`.
- The agent run is gated on `IMAGE_CHANGED`, and `infra/cloudformation/**` is
  not an image path. A PR that changes only the script or the templates gets the
  runner path (`aws-emulator.yml`) and no fresh-container run.
- On this host, the push gate's `DENO_DIR=/opt/deno-seed` lacks `commonmark`'s
  npm packages and is read-only, so the worker's pre-push gate blocks with
  "Failed caching npm package 'mdurl@1.0.1'". This is a worker environment
  fault, not a fault in this change.

## Review follow-up

The agent verification step must invoke `docker run` directly. The workflow
checker now requires `docker` as its first word. Two additional regression
cases cover a help-only wrapper and an inline Docker daemon override.
The unmodified container build workflow remains the passing control.
