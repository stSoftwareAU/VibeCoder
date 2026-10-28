## Summary

The containerised worker runs from a staged copy of `worker/deno` that has no
`prompts/` directory, so `loadTrustedCapabilityBundle()` could not find
`capability-security.json`. Every review-fix verification then failed as "not
checked". `capabilityBundlePath()` (replacing `capabilityBundleUrl()`) now
resolves the bundle through `getPromptsDir()`: `PROMPTS_DIR`, then
`VIBE_BASE_DIR`, then the module-relative path. Closes #4443.

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

### Undiscoverable Facts

- None.

## Evidence

Backend-only change; no UI files touched.

- `deno task test:unit` over
  `tests/capability_security_bundle_path_4443_test.ts`,
  `tests/capability_security_recovery_4417_test.ts`,
  `tests/capability_security_review_4366_test.ts` and
  `tests/capability_security_guidance_4365_test.ts`: 27 passed, 0 failed.

## Test Plan

- Added `worker/deno/tests/capability_security_bundle_path_4443_test.ts`:
  `PROMPTS_DIR` supplies the bundle (`loaded`); `VIBE_BASE_DIR` supplies it via
  `<dir>/prompts`; an empty `PROMPTS_DIR` gives `unreadable` with "is missing".
- Red check: with `capabilityBundlePath` reverted to the module-relative-only
  form, all three new tests fail.
- Modified `worker/deno/tests/capability_security_recovery_4417_test.ts`:
  renamed import and call only; no assertion removed.
- Callers of `loadTrustedCapabilityBundle` (`pre_pr_verifier.ts`,
  `prompt_builder.ts`, `capability_security_comparison.ts`,
  `capability_security_eval.ts`) call it with no arguments and get the default
  environment lookup.
- `./quality.sh`: every stage passed except `deno tests`, which failed on two
  tests in `worker/deno/tests/completion_phase_repo_formatters_test.ts` ("an
  unformatted Rust change is formatted and committed…", "cargo fmt stages only
  the branch's .rs files…"). They fail identically without this change (checked
  with the change stashed), so they are a pre-existing fault in this
  environment.
