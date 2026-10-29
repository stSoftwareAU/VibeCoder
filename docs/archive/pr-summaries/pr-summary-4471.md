## Summary

The CI-fix audit prompt no longer exempts whichever fixed release the agent
lands on from the 24h quarantine. The advisory-clearing bump now goes to the
newest release outside the window that clears the advisory; the zero age
applies only when every clearing release is still inside the window. Closes
#4471.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- The old paragraph said "applied regardless of the fixed version's publish
  age", so an agent bumping `parquet` to `60.1` (7 hours old) was within the
  prompt although `60.0` already cleared the same advisories
  (NEAT-AI-Discovery#2456). The reason it gave ("rather than waiting the window
  out") only holds when no aged release clears the advisory.
- Only the prompt, its docs paragraph and the test pin change; no worker code
  runs an age check on this path.

### Essential Design Decisions

- The agent is told to look up the publish date of each clearing release before
  choosing, using the same lookups the prompt already names for other moved
  versions.
- The `.pr_response_message` reply names the version and its age when the
  exemption is used, so a reviewer can see it was the all-in-window case.
- #4450 (#4437) has already landed on the base; its limit on the crates a parent
  bump pulls in is kept unchanged.

### Undiscoverable Facts

- The evidence (release dates of arrow-rs 60.0.0 and 60.1.0) comes from the
  issue; it was not re-observed here.

## Evidence

Backend/prompt only, no UI. From `worker/deno`, `deno task test:unit
tests/ci_fix_prompt_v4_test.ts`: 11 passed, 0 failed. `deno fmt --check` and
`deno lint` on the test file exit 0.

Sections read: `prompts/ci_fix/prompt.md` "Dependency audit failures" (the
paragraph above and the "Any other bump" paragraph that follows) and
`docs/security-advisory-triage.md` "The CI-fix agent applies the same
publish-age bypass automatically" through "Documentation outcome". Related
existing rules checked: "Any other bump you make in the same run keeps the 24h
floor" (agrees: unchanged), and the #4437 parent-bump limit (agrees). The
archived `pr-summary-1847.md` still quotes the old wording and is left as a
historical record.

## Test Plan

- `worker/deno/tests/ci_fix_prompt_v4_test.ts`:
  - Edited `ci_fix - an advisory-clearing bump is exempt from the publish-age
    floor (Issue #1847)`. Removed from
    `worker/deno/tests/ci_fix_prompt_v4_test.ts`: the pin
    `"applied regardless of the fixed version's publish age"`. Replaced by:
    `goes to the newest release outside the 24h window that clears the advisory`
    and `only when every release that clears the advisory is still inside the
    window is the fix applied regardless of its publish age`. Required by:
    "the exemption is limited to the case its own reason describes" (issue
    body). Every other assertion in that test is kept.
  - Added `ci_fix - the advisory-clearing bump takes an aged fixed release over
    a newer in-window one (Issue #4471)`.
- Red check: restoring the base `prompts/ci_fix/prompt.md` with the new tests
  kept turned both the edited and the new test red (9 passed, 2 failed);
  restored afterwards.
- No callers: the prompt is rendered by the existing `renderAuditFailure`
  helper only.
