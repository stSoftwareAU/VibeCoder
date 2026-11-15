## Summary

Reviewer rounds stopped at Astra with exit 127 because a Claude-only worker
image contained no Codex executable. They never reached Opus despite remaining
Claude quota. Build and select a reviewer image containing Claude and Codex,
permit both providers through egress, and skip an absent Codex executable so
Opus can run. Try the Claude pool afresh for Opus before paid DeepSeek overflow.
Closes #5164.

## Spec

### Intent and Rationale

Use the best available model with quota: Fable across the available Claude
subscriptions, Astra, Opus across the available Claude subscriptions, then
DeepSeek. A Fable-specific model cap is not exhaustion of the whole Claude
subscription. An unavailable Codex executable must not strand remaining Opus
quota. Actual review/task failures still stop the round.

### Essential Design Decisions

- `container-launch-plan --review-round` adds Claude and Codex to the installed
  image provider set. That set determines the image tag, build arguments,
  private extension base and egress. Credential mounts retain the configured
  worker set; installing Codex does not expose its worker credentials.
- Build a missing review image with the existing pinned base/extension build
  plans, bounded to 30 minutes per build, and check it exists afterwards.
  Existing images are reused. The shell requests this mode before any round.
- Classify a real Codex spawn `NotFound` as unavailable, separately from quota
  exhaustion. This permits Opus and DeepSeek fallback. Other spawn failures
  and ordinary non-quota CLI failures remain terminal.
- Scope refused Claude labels to the model being tried. Reuse the same pool
  runner for Fable and Opus, so Fable refusals cannot exclude Opus candidates.
- The real Apple container build reproduced an empty directory copy for the
  Deno seed. Use the glob COPY form already used for provider/toolchain
  fragments, preserving all three seed files and the frozen lock check.

### Undiscoverable Facts

The host's logs show Fable-specific refusals while the Claude pool reports
16–17% weekly quota remaining. The next attempt logs
`cannot run codex: Failed to spawn 'codex': entity not found` and ends the
round. The reviewer has its own Codex login, separate from worker credentials.
DeepSeek requires its separately provisioned credential; the code does not
invent a key or reuse another vendor's credential.

## Evidence

Backend/container changes only, with no UI changes.

- Before the fix, three focused regressions failed: missing Codex did not
  reach Opus; the real missing executable had no unavailable classification;
  the review plan selected the Claude-only image. An additional failing test
  reproduced the failure to try another Claude subscription on Opus.
- Targeted review, wiring, launch-plan, container-launch and runner suites
  pass. Their commands/results are recorded in the PR description.
- The full local gate passed type checking, lint, formatting, Markdown,
  Mermaid, completeness and source checks. Its test stage hit a Deno 2.9.5
  runtime panic: `pledge test permissions called before restoring previous
  pledge`. Full-suite success is not claimed. Semgrep, Checkov and gitleaks
  are unavailable locally; CI remains authoritative for those scans.
- Runtime image build and service verification are recorded in the PR body.

## Test Plan

- `container_launch_plan_command_test.ts`: drive the real plan builder with
  a Claude-only configuration; require a different image containing both
  CLIs, Astra egress, and unchanged credential mounts. Exercise preparation
  ordering, cached reuse and a failed build's cause.
- `review_round_test.ts`: exercise an actual missing executable, missing
  Codex followed by successful Opus, and another Claude subscription's Opus
  success before DeepSeek. Existing ordinary-failure tests still block
  fallback and retain Codex environment isolation.
- `review_round_wiring_test.ts`: extend the real three-subscription credential
  fixture through quota refusal on all three Opus candidates before DeepSeek.
  The prior expectation of one Opus attempt is obsolete under the owner policy.
- `review_fleet_prs_runner_test.ts`: assert that the runner requests the
  review-specific plan and reports a missing prepared image; retain claim
  release, escalation, token isolation and scheduling coverage.
- The Apple COPY change is verified through the observed failed image build
  and its corrected rebuild, rather than a test that greps Containerfile text.
- Updated all copies of the fallback contract: design principles, model guide,
  configuration, skill and unattended guide. The command and shared launch
  builder still derive build arguments from the same provider-value helper.
