## Summary

The containerised worker runs from a staged copy of `worker/deno` that has no
`prompts/` directory, so `loadTrustedCapabilityBundle()` could not find
`capability-security.json`. Every review-fix verification then failed as "not
checked". `capabilityBundlePath()` (replacing `capabilityBundleUrl()`) now
resolves the bundle through `getPromptsDir()`: `PROMPTS_DIR`, then
`VIBE_BASE_DIR`, then the module-relative path. A caller that names its prompts
directory gets the bundle from that directory instead, so `buildIssuePrompt`
reads it from the same `promptsDir` as its templates. Closes #4443.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- Same staged-copy mistake as #4302 (prompt templates); reusing `getPromptsDir`
  keeps one resolution rule and reads the bundle from the read-only checkout.

### Essential Design Decisions

- `capabilityBundleUrl(): URL` became `capabilityBundlePath(env): string`,
  because `getPromptsDir` returns a path. Its only other user was one test,
  updated here.
- `env` is an injected `EnvLookup` (default: process env), so tests never mutate
  the process environment.
- `capabilityBundlePath(env, promptsDir)` and
  `loadTrustedCapabilityBundle(env, promptsDir)` take an optional prompts
  directory that wins over the environment. `buildIssuePrompt` passes its own
  `promptsDir`, so a suite that names this checkout's prompts never follows the
  host's `PROMPTS_DIR` or `VIBE_BASE_DIR` (PR #4463 review; CODING-STANDARDS.md
  "Never let a unit test inherit the host's state").

### Undiscoverable Facts

- None.

## Evidence

Backend-only change; no UI files touched.

- `deno task test:unit` over
  `tests/capability_security_bundle_path_4443_test.ts`,
  `tests/capability_security_recovery_4417_test.ts`,
  `tests/capability_security_review_4366_test.ts` and
  `tests/capability_security_guidance_4365_test.ts`: 27 passed, 0 failed.
- Review fix: every test file that calls `buildIssuePrompt` or the capability
  bundle (53 files): 658 passed, 0 failed. `check:manifests` files: 847 passed.

## Test Plan

- Added `worker/deno/tests/capability_security_bundle_path_4443_test.ts`:
  `PROMPTS_DIR` supplies the bundle (`loaded`); `VIBE_BASE_DIR` supplies it via
  `<dir>/prompts`; an empty `PROMPTS_DIR` gives `unreadable` with "is missing".
- Red check: with `capabilityBundlePath` reverted to the module-relative-only
  form, all three new tests fail.
- Modified `worker/deno/tests/capability_security_recovery_4417_test.ts`:
  `shippedBundle()` names this checkout's prompts directory and an environment
  lookup that answers nothing; no assertion removed. Red check: with the
  `promptsDir` override removed and `PROMPTS_DIR=/nonexistent` in the shell,
  four of the 7 tests at head in that file fail (3 pass).
- Added to the 4443 test file: a named prompts directory wins over `PROMPTS_DIR`
  and `VIBE_BASE_DIR`; `buildIssuePrompt` with a temporary `promptsDir` whose
  bundle carries its own revision records that revision. Red check: with
  `prompt_builder.ts` calling `loadTrustedCapabilityBundle()` with no directory
  again, the `buildIssuePrompt` test fails.
- Callers of `loadTrustedCapabilityBundle`: `pre_pr_verifier.ts` calls it with
  no arguments and gets the default environment lookup, because it runs in the
  container's staged copy (the #4443 case). `prompt_builder.ts` passes its
  `promptsDir`. `capability_security_comparison.ts` and
  `capability_security_eval.ts` pass `<root>/prompts`, the tree they already
  read their guidelines and fixtures from.
  `.claude/skills/review-fleet-prs/scripts/gate.ts` defaults to the prompts
  directory of the checkout it runs from (its base behaviour), since the gate
  never runs from the staged copy (PR #4463 second review).
  `checkoutPromptsDir(moduleUrl)` decodes the percent-encoded URL pathname, so a
  checkout under `/Users/a b/` still reads the bundle (PR #4463 third review);
  `worker/deno/tests/review_fleet_prs_checkout_prompts_dir_4463_test.ts` (1 test
  at head) feeds it `%20` and non-ASCII escapes; red check: with
  `decodeURIComponent` removed it fails ("Values are not equal").
- Suites bound to this checkout's bundle (PR #4463 second review):
  `capability_security_review_4366_test.ts` (the gate's `loadCapabilityBundle`
  when no `bundle` is given, and `loadTrustedCapabilityBundle` in every verifier
  deps object spreading `defaultPrePrVerifierDeps`) and
  `pre_pr_verifier_3395_test.ts` (its deps builder). Red checks with
  `PROMPTS_DIR=/nonexistent` in the shell: without the 4366 and 3395 bindings
  and the gate default, 41 of 81 tests in those two files fail; with them, all
  pass. Without the comparison change and the gate default,
  `capability_security_comparison_4368_test.ts` and
  `review_fleet_prs_checklists_3594_test.ts` fail 18 of 36; with them, all pass.
- Passing at head (`deno test -A`, one file at a time, no `PROMPTS_DIR` set):
  `capability_security_recovery_4417_test.ts` (7 tests),
  `capability_security_bundle_path_4443_test.ts` (5 tests),
  `capability_security_review_4366_test.ts` (7 tests),
  `pre_pr_verifier_3395_test.ts` (74 tests),
  `capability_security_comparison_4368_test.ts` (9 tests),
  `review_fleet_prs_checklists_3594_test.ts` (27 tests) and
  `review_fleet_prs_checkout_prompts_dir_4463_test.ts` (1 test); 130 passed, 0
  failed in total. The earlier broader sweep over every file that uses the gate,
  the verifier deps, `buildIssuePrompt` or the capability modules is not
  restated: it predates the third-review test file, and was not re-run at head.
- `./quality.sh`: every stage passed except `deno tests`, which failed on two
  tests in `worker/deno/tests/completion_phase_repo_formatters_test.ts` ("an
  unformatted Rust change is formatted and committed…", "cargo fmt stages only
  the branch's .rs files…"). They fail identically without this change (checked
  with the change stashed), so they are a pre-existing fault in this
  environment.
