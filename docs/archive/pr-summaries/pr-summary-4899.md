## Summary

Removed "a babysitter push with no local gate" from the fleet-route "What to
fix" sentence in `worker/deno/lib/shift_left_failures.ts`. Auto-filed shift-left
issues no longer tell agents to add a repository check to babysitter pushes,
which could only run repository code on the babysitter host. Closes #4899.

## Spec

### Intent and Rationale

- The example led agents to host-side checks that #4800 and #4895 were sent back
  for; removal only, as the issue asks.

### Essential Design Decisions

- No behaviour, gate or prose rule is added; only the example is dropped.

### Undiscoverable Facts

- None.

## Evidence

Backend-only template text change.
`deno task test:unit tests/shift_left_failures_test.ts` passes (24 passed). No
test pinned the old sentence; the new test below was seen to fail with the
removed text restored.

## Test Plan

- Added `worker/deno/tests/shift_left_failures_test.ts`: "a VibeCoder issue does
  not point agents at a babysitter push with no local gate" (red with the text
  restored, green with the fix).
- Docs grep for `babysitter push with no local gate` outside `docs/archive`
  found only the edited line; no doc to update.
