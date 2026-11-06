## Summary

The macOS babysitter now validates repairs in its credential-denying sandbox and
CI runs the existing Chromium containment integration on a native macOS runner.
If a typed runner-capability failure occurs after the agent reports ready, the
runner saves a bounded, secret-scanned patch for the unchanged PR head; a later
eligible pass reapplies it and must pass validation before commit or push.
Ordinary gate failures remain repair failures. Linux keeps agent-side
validation. Part of #4674 while the native macOS run is pending. Version bump:
`VERSION` is unchanged by this PR.

## Spec

### Intent and Rationale

- Continue the platform-specific runner from #4716 so Chromium checks run
  outside Codex's browser-restricting profile without weakening the #4593
  credential boundary.
- Preserve ready but unvalidated edits across a capability retry, while keeping
  #4625's validation result contract and #4656's retry state as the existing
  owners.

### Essential Design Decisions

- Checkpoints are versioned, keyed by repository, PR, failure identity and
  unchanged head; patches over 2 MiB or containing a detectable secret are
  refused. A checkpoint is progress only, never validated completion.
- A `BabysitterValidationError` of kind `unavailable` takes the capability retry
  path and consumes no substantive attempt. A failed gate remains a code failure
  even when its output mentions Chromium or sandboxing.
- Branch locks, head checks, secret scanning, commit validation and publication
  guards remain in the runner path.
- The workflow aggregate requires both repository validation and the macOS
  browser job to report success; skipped jobs fail closed.
- The full local quality run exposed the existing Bash reclaim-harness file
  above the one-second unit-report threshold (3.19s for two tests).
  `MEASURED_SLOW_UNIT_TEST_FILES` records that measured exception while keeping
  both assertions in the required test gate.

### Undiscoverable Facts

- This worker host is Linux. The browser integration's only local attempt
  stopped at its explicit `Deno.build.os === "darwin"` guard; it did not
  exercise macOS sandbox behaviour.
- The first native runner attempt passed the external Keychain CLI probe but
  failed when directly looking up `com.apple.securityd` through bootstrap; that
  direct positive control is unavailable on this GitHub runner. The test now
  uses the successful external `security list-keychains` command as its positive
  control and checks the same command is denied inside the profile.
- The repository's existing browser integration now supplies unsandboxed
  positive controls for the credential files, symlink targets, Keychains,
  `securityd`, unrelated Mach lookup, process environment, and `.git` write
  probes.

## Evidence

The macOS job runs `deno task test:browser` with the installed Chrome binary.
The integration checks rendered DOM and generated screenshot output, plus
credential, Mach service, process, IPC, terminal, signalling and `.git` write
containment. Its successful native run remains required before this issue is
complete.

```mermaid
sequenceDiagram
    participant A as Repair agent
    participant R as Babysitter runner
    participant Q as Isolated quality gate
    participant G as GitHub
    A->>R: Ready repair and working tree
    R->>Q: Validate in credential-denying sandbox
    alt Gate passes
        Q-->>R: Success
        R->>R: Stage and commit under existing guards
        R->>G: Recheck head and publish
    else Ordinary gate failure
        Q-->>R: Bounded diagnostics
        R->>A: One repair pass
        A-->>R: Updated repair
        R->>Q: Revalidate
    else Typed capability failure after ready
        Q-->>R: Unavailable
        R->>R: Save scanned patch for unchanged head
        R-->>G: No push, persist capability retry
        G-->>R: Later eligible pass
        R->>R: Reapply patch and validate again
    end
```

### Deno regression avoided

- The browser integration is a Deno task using the repository's pinned Deno
  toolchain; no Node package manager or dependency was added.

## Acceptance Criteria

- **missing** — “This issue owns macOS browser execution and automated evidence
  that the credential boundary remains intact.” — reason: the automated native
  macOS job has not yet completed successfully.

## Test Plan

- `worker/deno/tests/fleet_babysitter_repair_test.ts` — 20 passed. Removing
  checkpoint persistence made the capability-loss resumption test fail; removing
  successful-revalidation cleanup left a checkpoint and made it fail.
  Reclassifying the ordinary gate output
  `Chromium sandbox denied by an ordinary test assertion` as capability made its
  code-failure assertion fail.
- `worker/deno/tests/babysitter_retry_state_test.ts` — 11 passed. Removing
  terminal retry-state cleanup made the merged-PR checkpoint-clear assertion
  fail. The checkpoint round-trip checks exact-head loading and wrong-head
  absence; detectable-secret input is refused.
- `worker/deno/tests/fleet_babysitter_validation_test.ts` — 37 passed.
- `worker/deno/tests/fleet_babysitter_browser_workflow_test.ts` — 3 passed.
  Positive workflow check plus negative cases for missing/skippable browser
  execution, skipped aggregate, tolerated failure, conditional gate skip and
  missing `needs` result wiring; the real `gate.sh` rejects skipped and failed
  jobs and accepts two successes.
- `worker/deno/tests/fleet_pr_babysitter_test.ts` — 120 passed on the final
  prompt code. CI, review and conflict prompts are checked for Darwin and Linux;
  Linux names unavailable checks for CI and does not direct checks to a runner
  it does not use. Changing the Linux prompt replacement target so that the
  runner instruction leaked made `Linux failed CI prompt keeps local validation`
  fail (119 passed, 1 failed).
- `worker/deno/tests/unit_test_time_budget_test.ts` — 23 passed after adding the
  measured slow-suite exemption; the test proves the two Bash reclaim cases
  remain in the required unit gate and do not trigger a timing failure.
- `worker/deno/tests/pwsh_suites_in_the_gate_test.ts` — included in the passing
  manifest/unit run. Its manifest assertion now compares the PowerShell subset
  of the general in-gate script list, retaining exact coverage of each `run.ps1`
  suite while allowing the #4674 validator suite.
- Modified assertion in `worker/deno/tests/pwsh_suites_in_the_gate_test.ts`:
  `assertEquals([...IN_GATE_SCRIPT_SUITES.keys()].sort(), await runPs1Suites())`.
  - Obsolete: `IN_GATE_SCRIPT_SUITES` now also carries the required #4674
    workflow-validator suite; the test still verifies the complete PowerShell
    subset.
  - Replaced by:
    `assertEquals([...IN_GATE_SCRIPT_SUITES.keys()].filter((file) => psSuites.includes(file)).sort(), psSuites)`.
  - Still covered by:
    `worker/deno/tests/pwsh_suites_in_the_gate_test.ts::pwsh suites - the manifest names exactly those suites`
    and
    `worker/deno/tests/integration_test_manifest_test.ts::integration manifest - every in-gate exception is still claimed`.
- `deno task check:manifests` — 847 passed, 0 failed, 1 ignored. The workflow
  validator is classified as an in-gate script suite so the skipped/failure
  outcomes are checked before push.
- `./quality.sh < /dev/null` — passed with `config integration` and `checkov`
  skipped because they were unavailable. The subsequent final additions to
  `unit_test_time_budget_test.ts` and the prompt mutation check were run
  separately with the targeted unit commands above.
- Targeted Deno lint and frozen type checks passed for the changed runner,
  validation integration and tests.
- `deno task test:browser` — attempted locally; failed at the platform guard
  with actual `linux`, expected `darwin`, before any macOS containment
  assertions ran. Native run 42149859357 then failed at the direct `securityd`
  bootstrap positive control after its Keychain CLI control passed; the updated
  native workflow is pending and is not claimed as passed.
- No `deno.lock` change. Updated `SECURITY.md`, threat-model control C37 and the
  fleet babysitter manual to describe checkpoint recovery and the macOS CI
  evidence path.
