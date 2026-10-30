## Summary

The egress self-check now waits for the proxy's listener before it probes,
writes every probe attempt to the launch log, and names the failing probe and
what it saw on the failure marker, for example
`[EGRESS-SELFCHECK-FAILED] proxy_unavailable proxyAllowed=failed (refused ×3)`.
Closes #4493.

Version bump: no `VERSION` change in this PR; the merged commit records the
final version.

## Spec

### Intent and Rationale

- The failed launch gave `proxyAllowlist=failed` and nothing else: the
  per-attempt lines went to `console.warn`, outside the worker's logger, and the
  marker carried no cause. The 5 s failure also means the attempts ended fast (a
  refusal or an unexpected answer), not on three 5 s timeouts.
- Each probe now keeps a short `observed` token (`refused`, `timeout`,
  `closed without an answer`, or the first line of an unexpected answer such as
  `HTTP/1.1 502 Bad Gateway`). The allowed probe counts them (`refused ×3`).

### Essential Design Decisions

- The listener wait is a plain TCP dial that closes at once with no bytes
  (`lib/egress_proxy.ts` `serveClient` treats that as a closed connection and
  logs nothing). It polls every 250 ms for up to 30 s, retrying only a refusal
  or a timeout. A permission error or unusable proxy URL returns `listening`, so
  the CONNECT probe still reports `not_checked`.
- `runEgressProbes` waits once, before the denied probe, because the denied
  probe is not retried. If nothing listens it returns
  `proxyDenied: not_checked`, `proxyAllowed: failed` and spends no attempts.
- `probeProxyAllowed` keeps its signature and does not wait; it now returns
  `failed` (not `through`) when no attempt connected, which `runEgressProbes`
  already treated the same way.
- Markers for probes without `observed` detail are byte-for-byte unchanged.
  `run.sh` and `run.ps1` key on exit status 90 and echo the marker constant
  only, so the appended text is safe.

### Undiscoverable Facts

- I could not reproduce the GRQ-23 launch. The issue does not say what the proxy
  answered, so the cause of that failure is still unknown; this change makes the
  next one visible.

## Evidence

Backend only; no UI files touched.

- `worker/deno/lib/egress_selfcheck.ts`: `probeProxyConnectDetailed`,
  `waitForProxyListener`, `probeProxyAllowedDetailed`, `describeProbeFailures`,
  `runEgressProbes` options, and the marker and `diagnostics` on the decision.
- `worker/deno/lib/run_worker.ts` (Step 4.56): each `diagnostics` line is logged
  as `[run-worker] ...` before the failure exit. `commands/egress_selfcheck.ts`
  prints them on stderr.
- `docs/CONTAINMENT.md`: paragraph after the Apple probe description (read the
  whole self-check passage; line 392 `proxyAllowlist=enforced` is still true).
- Callers of the changed helpers: `probeProxyConnect` (also used by
  `apple_egress_controls.ts` `appleAllowedPaths`, unchanged behaviour: it is a
  wrapper), `probeProxyAllowed` (only `runEgressProbes` before; now only tests),
  `checkEgressPolicy` (`run_worker.ts`, `commands/egress_selfcheck.ts`; both
  pass `diagnostics` through).
- Fakes: the stub proxy in the scenarios file stands in for
  `lib/egress_proxy.ts`; the property relied on is that a connect-then-close
  with no bytes is ignored, read from `serveClient`.

## Reproduction

- **symptom** — the egress self-check failed in about 5 s with only
  `proxyAllowlist=failed`; the retry attempts were absent from the launch log.
- **status** — `partial` — the missing log lines, missing cause on the marker
  and the closed-port burn are reproduced with loopback stubs; the actual Apple
  proxy answer on GRQ-23 was not.
- **reason** — the launch needs the Apple container runtime and its proxy
  container. Against the base `lib/egress_selfcheck.ts` the new scenarios file
  fails at load (no `probeProxyAllowedDetailed` export), so the new tests are
  red on base.
- **regression test** —
  `worker/deno/tests/support/egress_allowed_probe_retry_scenarios.ts::an allowlisted CONNECT waits for a late listener and spends no attempts (Issue #4493)`

## Test Plan

- `worker/deno/tests/support/egress_allowed_probe_retry_scenarios.ts` (run under
  `--allow-net=127.0.0.1` by
  `worker/deno/tests/egress_allowed_probe_retry_test.ts`, which lists the nine
  new names): late listener (injected sleep binds the stub on the third check,
  no attempt lines); nothing ever listens (failed, no attempts, log line); 502
  every time (`HTTP/1.1 502 Bad Gateway ×3`); refused ×3; `runEgressProbes` with
  a live proxy gives the enforced set; `runEgressProbes` with a proxy that never
  listens; `runEgressProbes` with a proxy that binds late (injected sleep binds
  the stub on the third check; `proxyAllowed` is `succeeded`, the verdict is
  `enforced`, and `diagnostics` is absent), which covers the wait production
  actually runs.
- `worker/deno/tests/egress_selfcheck_test.ts`: marker with `observed`
  (`proxyAllowed=failed (refused ×3)`), unchanged marker without it (control),
  Apple marker, diagnostics carried, `describeProbeFailures` cases (including a
  failed denied probe with no denied detail). `Deno.connect` is replaced in four
  tests to pin the dialled host and port, the `observed` token (first line,
  control characters stripped, 80-character cap, `closed without an answer`),
  and that only a `TimeoutError` is a timeout (a thrown `null`, `undefined`,
  string or other-named error is not). The port check in `proxyEndpoint` is now
  `port < 1` only: `new URL` rejects ports above 65535 and keeps digits only, so
  the old `isInteger` and `> 65535` operands were dead.
- `worker/deno/tests/run_worker_test.ts`: diagnostics reach `deps.log` before a
  failing exit; none are logged without them.
- Red checks (one break at a time, then restored): marker drops `proxyAllowed` →
  3 red; decision drops diagnostics → 1; `run_worker` skips the log loop → 1;
  `waitForProxyListener` never waits → 3; `observed` without counts → 2; refused
  labelled `timeout` → 1; Apple branch drops details → 1; `runEgressProbes`
  skips the wait → 1; `runEgressProbes` ignores the `directTcp` seam → 2; the
  `probeProxyAllowed` wrapper waiting for the listener → 2 (the original
  scenarios).
- Mutation follow-up: each listed mutant on `egress_selfcheck.ts` lines 165,
  361, 366, 367, 384, 407 and 410 was applied by hand and turned a test red;
  `runEgressProbes` waiting with `timeoutMs: 0` now turns the late-listener
  scenario red. Line 383 was dead code and was simplified.
- Not red-checked: the `egress-selfcheck` command's stderr printing.
- No assertion was removed from an existing test; only the `@std/assert` import
  line in `egress_selfcheck_test.ts` gained a name.
- `deno task test:unit` over `egress_allowed_probe_retry_test.ts`,
  `egress_selfcheck_test.ts`, `run_worker_test.ts`: 69 passed, 0 failed.
  `deno fmt --check`, `deno lint` and `deno check` on the touched files: clean.
- `./quality.sh` on the final head: deno lint, type check and fmt passed; deno
  tests reported 31119 passed and 1 failed:
  `worker/deno/tests/pr_maintenance_command_test.ts` "update-open-pr-branches
  takes no action on a behind-only PR behind a merge queue (Issue #4424)". That
  test does not touch the egress code and fails the same way (23 passed, 1
  failed) on base commit `7635984b` in a clean checkout, so it is not caused by
  this change and is left as is. The gate's overall result is therefore FAILED
  for that one pre-existing test.
