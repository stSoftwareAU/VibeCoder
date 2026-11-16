## Summary

Reviewer rounds stopped at Astra with exit 127 because a Claude-only worker
image contained no Codex executable. They never reached Opus despite remaining
Claude quota. Build and select a reviewer image containing Claude and Codex,
permit both providers through egress, and skip an absent Codex executable so
Opus can run. Try the Claude pool afresh for Opus before paid DeepSeek overflow.
Closes #5164.
Part of #5081.

#5081 is the owner-authored subscription-first policy.

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
  CLIs, Astra egress (`chatgpt.com` must be an exact entry in the parsed
  `VIBE_EGRESS_ALLOW_HOSTS` list, matched as a whole entry, never as a
  substring), and unchanged credential mounts. Image preparation runs against
  a stateful runtime fake that models image presence and the base-before-
  extension build prerequisite. It asserts the resulting image state: a missing
  image is built and present, a cached image triggers no build, a failed build
  surfaces its stderr, and a build that leaves the image absent fails as
  "still missing". No assertion inspects the order of runner calls.
- `review_round_test.ts`: a provider fake decides each attempt from the model
  and credential requested (per-model, per-subscription Claude quota; Codex
  missing, out of quota or usable) and the tests assert the exit status and the
  persisted review-run record. Cases: missing Codex followed by successful
  Opus; missing Codex with no Opus quota reaching DeepSeek; an ordinary Fable
  failure ending the round before any fallback; Opus finding the one
  subscription with quota after earlier subscriptions refuse it; and a real
  missing executable classified unavailable by `runCodexCli`. Existing tests
  keep Codex environment isolation and the usage-limit-only fallback rules.
- `review_round_wiring_test.ts`: extend the real three-subscription credential
  fixture through quota refusal on all three Opus candidates before DeepSeek.
- `review_fleet_prs_runner_test.ts`: assert that the runner requests the
  review-specific plan and reports a missing prepared image; retain claim
  release, escalation, token isolation and scheduling coverage.
- The Apple COPY change is verified through the observed failed image build
  and its corrected rebuild, rather than a test that greps Containerfile text.
- Updated all copies of the fallback contract: design principles, model guide,
  configuration, skill and unattended guide. The command and shared launch
  builder still derive build arguments from the same provider-value helper.

## CI repair: provider-neutral launcher

The existing `agent_provider_test.ts` architecture regression failed because
`container_launch_plan.ts` named and selected specific providers. Move the
review-image provider union to `reviewImageAgentProviders` in the existing
`agent_provider.ts` abstraction. The launcher now consumes those descriptors,
and its build diagnostic names the review image without hard-coded providers.
The configured credential-mount set and installed review fallback set retain
exactly the same behaviour. No tests or assertions were removed or weakened.

Validation:

- Reproduced the existing architecture test failure before the refactor.
- Provider, command launch-plan, container-launch, review-round, wiring and
  runner suites at the current head: 244 passed, 0 failed.
- Changed modules passed type checking, formatting, lint and diff checks.
- Direct JSR downloads are unavailable to Deno in this environment. The tests
  used a temporary import map to the locked published dependencies downloaded
  through curl; repository imports, dependency versions and lockfile remain
  unchanged. Full local quality is not claimed; hosted CI remains authoritative.
- Merged current `main` without conflicts, preserving incoming changes.

## Test changes against the base

- `review_round_wiring_test.ts` (production-wiring fixture): the base expected
  Opus to be attempted once on one subscription before DeepSeek, and the
  fixture refused Opus only on the third subscription. That behaviour is
  obsolete under the governing requirement in the body of owner-authored
  #5081: "DeepSeek is used only when every subscription is out of quota."
  A Fable-specific cap therefore cannot exclude an otherwise eligible Opus
  subscription before paid DeepSeek. The fixture now refuses Opus on every
  provisioned subscription and the persisted attempt record expects three Opus
  attempts before DeepSeek. Remaining behaviour: Fable rotation, Astra
  isolation and DeepSeek completion assertions are unchanged. Covering path:
  `worker/deno/tests/review_round_wiring_test.ts` (the edited production-
  wiring test), plus `worker/deno/tests/review_round_test.ts::Opus tries other
  Claude subscriptions before paid DeepSeek (Issue #5164)`.
- `review_fleet_prs_runner_test.ts`: a diagnostic string rename; failure and
  escalation behaviour are unchanged.

## Review follow-up verification

- Rechecked the stateful image and model/credential-driven provider fakes.
- Command launch-plan, review-round and production-wiring suites: 56 passed, 0
  failed on the repaired tests in `adc739f3`.
- Linked the owner-authored policy separately from the bot-generated incident
  and quoted its requirement verbatim for the changed Opus expectation.

## Final review corrections

- The cached image fixture now provides a read-only image store: preparation
  must succeed with the retained image despite builds being unavailable. The
  runner-call counter and its assertion are removed.
- Only provider-2 has Opus quota; provider-3, selected after Fable exhaustion,
  refuses Opus. Successful completion now requires actual Opus rotation.
- The governing issue uses the standalone `Part of #5081.` syntax accepted by
  the policy parser; the exact requirement quote remains unchanged.
- Verified the rotation regression fails when Opus rotation is disabled: it
  completes on DeepSeek instead of Opus. Restored production unchanged.
- All 56 command launch-plan, review-round and wiring tests pass with the
  corrected fixtures; changed test files pass formatting and lint checks.
