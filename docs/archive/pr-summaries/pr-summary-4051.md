## Summary

Closes #4051

Ships Apple container egress containment now, with measured limits: a per-launch
internal network, the shared #4046 CONNECT proxy attached to both that network
and the default one, proxy variables for the worker, per-control probe results,
and a startup report that says which mode is in force. The version-verified CLI
check is `worker/deno/lib/apple_container_capabilities.ts`; the lifecycle
(network create, proxy run, readiness, stale sweep, bounded recovery, teardown)
is `worker/deno/lib/apple_egress.ts`; the control results and mode wording are
`worker/deno/lib/egress_controls.ts` and
`worker/deno/lib/egress_control_probe.ts`. `docs/CONTAINMENT.md` and
`docs/THREAT-MODEL.md` record the delivered behaviour and the residual gaps.

Version bump: no `VERSION` change is made here; the merged commit records the
final version.

## Evidence

Security fix, original trigger: the Apple worker's outbound traffic was
unfiltered, and the only reported signal was a coarse `egressEnforced` boolean.
A probe that could not run, or advisory (proxy-only) routing, could therefore be
read as "egress blocked".

Test:
`worker/deno/tests/apple_egress_test.ts::a probe that cannot run is not a pass: the attempt regresses and nothing is returned`
(also
`worker/deno/tests/egress_controls_test.ts::directInternetV4 is never blocked by a probe that did not run`,
`worker/deno/tests/apple_egress_test.ts::auto with an indeterminate check fails closed and starts nothing`
and
`worker/deno/tests/egress_controls_test.ts::mode labels never claim a whole-mode enforcement, default-deny or completeness`).

Static reasoning: the original trigger is closed with no trivial bypass. A
control is reported `blocked` only when the negative control proved the probe
can see open networking, so a probe that errored, printed nothing or timed out
is `untested` and never counts as passed. In `internal-network` mode any
non-blocked direct-egress control is a regression: the attempt is torn down,
retried within the bound, and on exhaustion the launch is refused rather than
started on unrestricted networking
(`regression runs exactly 1 + recovery
attempts, tears down, persists refused, and returns nothing`).
An indeterminate CLI check in `auto` mode fails closed and starts nothing; only
an explicit `advisory` choice, or a CLI measured as unsupported, yields advisory
mode, which is labelled advisory, always lists the direct-egress gap, and never
uses the words enforced, complete or default-deny for the whole mode. No
equivalent bypass exists: the worker run refuses `--publish` and sensitive
mounts (`assertAppleRunContained`), and resources are scoped to names derived
from this worker's pid.

Residuals that this change records rather than closes: host gateway and LAN
reachability (apple/container#1320), DNS exposure, and the credential risks that
stay open with #3699.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Apple launch-plan, lifecycle and cleanup tests pass; CLI
  capabilities are version-verified — evidence:
  `worker/deno/tests/apple_egress_test.ts::auto with a capable CLI selects the internal network`
  and
  `worker/deno/tests/apple_egress_test.ts::the stale sweep removes dead-launcher networks and leaves live, foreign and own names alone`
  — reviewer: met
- **met** — Failures recover unattended without silently dropping configured
  protections — evidence:
  `worker/deno/tests/apple_egress_test.ts::regression runs exactly 1 + recovery attempts, tears down, persists refused, and returns nothing`
  — reviewer: met
- **met** — Per-control results distinguish proxy allowlist, direct internet,
  host and untested — evidence:
  `worker/deno/tests/egress_controls_test.ts::directInternetV4 is blocked only with a negative control proof`
  — reviewer: met
- **met** — Partial and advisory modes and residual gaps are never labelled
  fully enforced — evidence:
  `worker/deno/tests/egress_controls_test.ts::startup report never says complete or makes a default-deny claim`
  — reviewer: met
- **partial** — The repository quality gate passes — evidence: pending the
  worker's own gate run — reviewer: partial — reason: CI not yet verified —
  remaining: merge-verification-only

## Test Plan

- Added: `worker/deno/tests/apple_container_capabilities_test.ts` (version and
  help-flag parsing, e.g.
  `parseMacosVersion rejects anything that is not a dotted numeric version (Issue #4051)`),
  `worker/deno/tests/apple_egress_test.ts`,
  `worker/deno/tests/egress_controls_test.ts` and
  `worker/deno/tests/egress_control_probe_test.ts`.
- Not checked: a run on an actual Apple worker from this container; the live
  probes need one.
