# PR Summary — Issue #3369

## Summary

Adds a Floci CI job that deploys VibeCoder's own CloudFormation template
(`infra/cloudformation/linux-verification-host.yaml`) against an emulator and
asserts `CREATE_COMPLETE`, so the template is exercised on every change instead
of only on a live AWS account.

- `infra/cloudformation/test-floci.sh` starts floci on demand, deploys every
  template with `--endpoint-url http://127.0.0.1:4566`, asserts the stack
  status via `describe-stacks`, and emits one `::warning::` per stubbed
  resource type.
- `.github/workflows/floci.yml` runs it with a `floci/floci` service pinned to
  the `container/tools.json` digest and the Docker socket mounted.
- `worker/deno/lib/floci_workflow_check.ts` plus
  `worker/deno/tests/issue_3369_floci_workflow_test.ts` keep the workflow's
  digest in step with `container/tools.json` and pin the job's load-bearing
  structure.

Closes #3369.

## Spec

### Intent and Rationale

#3346 asks every repo that ships CloudFormation to test it against an AWS
emulator in CI. VibeCoder has no AWS SDK calls, so only the template-deploy
path applies; per-service tests are not applicable.

### Essential Design Decisions

- **Skip locally, fail in CI.** With no Docker socket outside CI the script
  prints `SKIPPED (needs Docker): <template>` and exits 0 (the worker has no
  Docker). In CI (`CI=true`) a missing socket is `::error::` and exit 1, so CI
  can never go green by skipping.
- **Workflow check as a library.** The drift and structure checks live in
  `checkFlociWorkflow` so each invariant has a positive and a negative test
  (workflow-validator rule).
- **Tag plus digest.** The service image is `floci/floci:2.2.0@sha256:…`. The
  existing hardening test (`workflow_hardening_test.ts`) requires a tag beside
  every digest; the digest is still the one in `container/tools.json`.
- **Not added to `WORKFLOW_FILE_CHECKS`**, and path-filtered workflows stay out
  of `pr_check_contexts.ts` (a path-filtered check would block unrelated PRs).

### Undiscoverable Facts

- Floci stubs unsupported resource types only when
  `FLOCI_SERVICES_CLOUDFORMATION_ALLOW_STUB_UNSUPPORTED_RESOURCE_TYPES=true`;
  a stubbed resource's status reason contains "stubbed", which is what the
  script turns into a `::warning::`.
- The worker has neither the `aws` CLI nor a Docker socket, so the live deploy
  could not be run here. Verified instead: shellcheck, `bash -n`, actionlint,
  and a local run printing `SKIPPED (needs Docker): linux-verification-host.yaml`
  with exit 0.

## Evidence

Docs sweep — grep: `floci`, `emulatorConfigured`, `cloudformation`; section:
CONTAINER.md Floci row, EC2-LINUX-VERIFICATION.md CI wording; updated:
`docs/CONTAINER.md:100` (row now names the `floci.yml` job),
`docs/EC2-LINUX-VERIFICATION.md:115-119` (template is now emulator-tested in
CI; wording softened to say a live deploy is still the final proof);
`CONTRIBUTING.md:126-129` — still true because it describes the local quality
gate, which is unchanged; `docs/BEST-PRACTICES-SCAN.md:255-268` — still true
because the detector semantics are unchanged; `DESIGN-PRINCIPLES.md:1666` —
still true because it describes the emulator-in-CI principle this implements;
`docs/SUPPLY-CHAIN-GATE.md` — still true because the digest source
(`container/tools.json`) is unchanged. `docs/audits/dependency-inventory.md` is
regenerated (2 lines) because the workflow adds a pinned image reference.

Issues cited as provenance: #3367: (dependency, closed) the Floci image pin in
`container/tools.json`; #3369: Add a Floci CI job for VibeCoder's own
CloudFormation template.

```mermaid
flowchart LR
    T["infra/cloudformation/*.yaml"] --> S["test-floci.sh"]
    W["floci.yml job<br/>floci service + docker.sock"] --> S
    S -->|"aws cloudformation deploy<br/>--endpoint-url :4566"| F["floci 2.2.0"]
    F -->|describe-stacks| S
    S -->|CREATE_COMPLETE| P["PASS"]
    S -->|stubbed type| WN["::warning::"]
    D["container/tools.json digest"] -.agrees with.-> W
```

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **partial** — The Floci CI job is green on this PR and logs `CREATE_COMPLETE`
  for `linux-verification-host`. — evidence:
  `.github/workflows/floci.yml`, `infra/cloudformation/test-floci.sh`; needs
  the CI run on this PR — reviewer: partial
- **partial** — A deliberately broken template makes the job fail. — evidence:
  the script exits 1 on any non-`CREATE_COMPLETE` status
  (`infra/cloudformation/test-floci.sh`); not runnable without Docker here —
  reviewer: partial
- **met** — Stubbed resource types appear as `::warning::` annotations. —
  evidence: `infra/cloudformation/test-floci.sh` (one unique warning per type)
  — reviewer: met
- **met** — Running the script without Docker prints
  `SKIPPED (needs Docker):` and does not fail. — evidence: local run exit 0 —
  reviewer: met
- **met** — The digest-agreement test passes; actionlint and shellcheck are
  green. — evidence:
  `worker/deno/tests/issue_3369_floci_workflow_test.ts::floci digest in workflow matches container/tools.json (drift test)`
  — reviewer: met
- **partial** — After merge the #3366/#3346 detector reports
  `emulatorConfigured: true` for VibeCoder. — evidence: the workflow runs a
  `floci/floci` image, which `isFlociImage` accepts; confirmed only after merge
  — reviewer: partial
- **unrequested** — Extra structural checks (permissions, checkout
  `persist-credentials: false`, `milestone/*` branch, stub env) in
  `checkFlociWorkflow`. — reviewer: unrequested — reason: required by the
  workflow-validator rule (each load-bearing workflow property gets a
  validator invariant) and the repo's workflow hygiene conventions.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — material findings from the review were fixed: image reference
  moved to tag+digest (hardening test), new lib module claimed by a sweep slice
  (`docs/audits/lib-sweep-coverage/top-up-3369.json`), manifest entry added,
  shellcheck SC2329 on the trap function disabled with a comment, command-position
  matching so an echoed or commented `test-floci.sh` does not satisfy the check.

## Test Plan

- `deno task test:unit` over the five targeted test files (with
  `--allow-write` for the supply-chain gate test): 124 passed, 0 failed.
- `deno task check:manifests`, `deno fmt --check`, `deno lint`, `actionlint`,
  `shellcheck`, `bash -n`: pass.
- Full `./quality.sh` on the final tree: `Result: PASSED (with skipped checks)`;
  the only skip is config integration ("deno or .config.json not available").
- An earlier gate run failed on three items (bare-digest image rejected by the
  hardening test; `floci_workflow_check.ts` claimed by no sweep slice; manifest
  entry) — all fixed above.
- Related rules checked: workflow hygiene (`set -euo pipefail`, SHA-pin
  comments, `persist-credentials: false`, `milestone/*` branch), workflow
  hardening (tag beside digest), lib sweep ledger, integration test manifest.
  The "workflow behaviour change extends the validator" rule was applied to
  this PR's own diff: every new workflow invariant has a positive and a
  negative test; nothing else flagged.
- Callers/entry points: the script is called only from `floci.yml`; the check
  module only from the new test.

**Branch outcomes:**

- `worker/deno/lib/floci_workflow_check.ts:52` — missing `images[]` throws.
  Test: `worker/deno/tests/issue_3369_floci_workflow_test.ts::flociImageDigest throws on missing images[]`.
  Flipped (return empty): went red.
- `worker/deno/lib/floci_workflow_check.ts:58` — no Floci entry throws. Test:
  `…::flociImageDigest throws on a missing Floci entry`. Flipped: went red.
- `worker/deno/lib/floci_workflow_check.ts:62` — malformed digest throws.
  Test: `…::flociImageDigest throws on a malformed digest`. Flipped: went red.
- `worker/deno/lib/floci_workflow_check.ts:99` — non-object input. Test:
  `…::reports non-object input without throwing`. Flipped: went red.
- `worker/deno/lib/floci_workflow_check.ts:125-150` — image digest drift, bare
  digest, bare tag, wrong repo. Tests: the four `(a) refuses …` cases.
  Flipped: went red.
- `worker/deno/lib/floci_workflow_check.ts:157` — stub env not `"true"`. Test:
  `…::refuses a floci service without the stub env`. Flipped: went red.
- `worker/deno/lib/floci_workflow_check.ts:168` — missing docker.sock volume /
  first step not the socket assertion. Tests: `(b) refuses a missing docker.sock
  volume`, `(c) refuses a first step without the socket assertion`, `(c)
  refuses an echo that merely names the socket`. Flipped: went red.
- `worker/deno/lib/floci_workflow_check.ts:180` — no step runs the script.
  Tests: `(d) refuses a workflow that never runs test-floci.sh`, commented-out
  and echoed variants; accepting variants in `(d) accepts bash/sh and bare-path
  invocations`. Flipped: went red.
- `worker/deno/lib/floci_workflow_check.ts:196` — trigger paths missing. Test:
  `…::(e) refuses missing trigger paths`; `accepts the YAML 1.1 \`true\` key
  for \`on\``. Flipped: went red.
- `worker/deno/lib/floci_workflow_check.ts:205` — `milestone/*` missing. Test:
  `…::refuses a pull_request trigger without milestone/*`. Flipped: went red.
- `worker/deno/lib/floci_workflow_check.ts:211` — permissions. Test:
  `…::refuses permissions other than contents: read`. Flipped: went red.
- Checkout without `persist-credentials: false`. Test:
  `…::refuses checkout without persist-credentials: false`. Flipped: went red.
- `infra/cloudformation/test-floci.sh` branches (Docker gate skip/error, `aws`
  missing, non-`CREATE_COMPLETE`, stub warning): `exempt (untestable): needs
  Docker and the aws CLI, neither of which the worker has; the skip path was
  run locally and the rest are exercised by the CI job itself`.
