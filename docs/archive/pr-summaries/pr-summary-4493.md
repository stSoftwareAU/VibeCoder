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
- The listener wait lives only in `runEgressProbes`. `probeProxyAllowedDetailed`
  and `probeProxyAllowed` never wait (PR #4531 review: a second wait there had
  no production caller). `probeProxyAllowed` keeps its signature and now returns
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
  `worker/deno/tests/support/egress_allowed_probe_retry_scenarios.ts::runEgressProbes with a proxy that starts listening 2 s late still passes (Issue #4493)`

## Test Plan

- `worker/deno/tests/support/egress_allowed_probe_retry_scenarios.ts` (run under
  `--allow-net=127.0.0.1` by `egress_allowed_probe_retry_test.ts` in the same
  tests directory, which lists the eight names): 502 every time
  (`HTTP/1.1 502 Bad Gateway ×3`); refused ×3; `runEgressProbes` with a live
  proxy gives the enforced set; `runEgressProbes` with a proxy that never
  listens (`listenTimeoutMs` 1500 against `timeoutMs` 1000, so the 1500 ms
  message only reads right when the listener budget is the one used);
  `runEgressProbes` with a proxy that binds 2 s late (a fake clock that each
  injected sleep advances binds the stub once it reaches 2000 ms, default
  listener budget, `timeoutMs` 1000; `proxyAllowed` is `succeeded`, the verdict
  is `enforced`, and `diagnostics` is absent), which covers the wait production
  actually runs and is the regression test.
- `worker/deno/tests/egress_selfcheck_test.ts`: marker with `observed`
  (`proxyAllowed=failed (refused ×3)`), unchanged marker without it (control),
  Apple marker, diagnostics carried, `describeProbeFailures` cases (including a
  failed denied probe with no denied detail). `Deno.connect` is replaced in five
  tests (three for `probeProxyConnectDetailed`, two for `waitForProxyListener`)
  to pin the dialled host and port, the `observed` token (first line, control
  characters stripped, 80-character cap, `closed without an answer`), and that
  only a `TimeoutError` is a timeout (a thrown `null`, `undefined`, string or
  other-named error is not). `waitForProxyListener` is pinned two ways: with a
  deadline of 0 the last dial error is reported (and an unrelated error ends the
  wait as `listening`), and with a positive budget and a clock the injected
  sleep advances, a first dial that throws `TimeoutError` is retried and the
  second dial's success gives `listening: true` after exactly two dials and one
  250 ms pause. The port check in `proxyEndpoint` is now `port < 1` only:
  `new URL` rejects ports above 65535 and keeps digits only, so the old
  `isInteger` and `> 65535` operands were dead.
- `worker/deno/tests/run_worker_test.ts`: diagnostics reach `deps.log` before a
  failing exit; none are logged without them.
- Red checks (one break at a time, then restored): marker drops `proxyAllowed` →
  3 red; decision drops diagnostics → 1; `run_worker` skips the log loop → 1;
  `waitForProxyListener` never waits → 3; `observed` without counts → 2; refused
  labelled `timeout` → 1; Apple branch drops details → 1; `runEgressProbes`
  skips the wait → 1; `runEgressProbes` ignores the `directTcp` seam → 2.
- Second PR #4531 review: the `probeProxyAllowedDetailed` listener wait and its
  `listenTimeoutMs`, `now` and `waitForListener` options were removed, with the
  two scenario tests that only exercised them (and their names in
  `egress_allowed_probe_retry_test.ts`); the earlier `probeProxyAllowedDetailed`
  listener-budget red check and the "wrapper waiting for the listener" red check
  no longer apply. Red check for the retry test: `waitForProxyListener`
  returning `listening: false` on a timeout instead of retrying turns
  `a timed-out dial is retried until the proxy accepts` red (1 failed, 24
  passed), then restored.
- PR #4531 earlier review red checks (production broken one way at a time, then
  restored): `runEgressProbes` reading `timeoutMs` as the listener budget → 2
  red (the 2 s late-listener test and the never-listens test).
  `EGRESS_PROXY_LISTEN_TIMEOUT_MS` set to 1_000 and `probeProxyAllowedDetailed`
  reading `timeoutMs` as the listener budget were also red on that earlier head,
  with a `probeProxyAllowedDetailed` late-listener test that the second review
  deleted; neither is restated here, because `EGRESS_PROXY_LISTEN_TIMEOUT_MS` is
  now read only by `runEgressProbes` and `probeProxyAllowedDetailed` no longer
  has a listener budget.
- Mutation follow-up: each listed mutant on `egress_selfcheck.ts` lines 165,
  361, 366, 367, 384, 407 and 410 was applied by hand and turned a test red;
  `runEgressProbes` waiting with `timeoutMs: 0` now turns the late-listener
  scenario red. Line 383 was dead code and was simplified.
- Review-fix mutation follow-up: `lateBindingClock` in the scenarios file is a
  test helper. A new test,
  `lateBindingClock binds exactly once, when the clock
  reaches the bind time`,
  kills dropping `!bound` (line 175) and `bound = true` → `false` (line 176):
  each turned the retry test red; each mutant was applied by hand and restored.
  Deleting `now: time.now` from the `runEgressProbes` call in the 2 s
  late-listener test (scenarios file, line 313) was not re-checked on the final
  head.
- Not red-checked: the `egress-selfcheck` command's stderr printing.
- No assertion was removed from an existing test; only the `@std/assert` import
  line in `egress_selfcheck_test.ts` gained a name.
- `deno task test:unit` at the head, each file run on its own:
  `worker/deno/tests/egress_allowed_probe_retry_test.ts` (8 tests at head),
  `worker/deno/tests/egress_selfcheck_test.ts` (25 tests at head),
  `worker/deno/tests/run_worker_test.ts` (37 tests at head); all pass.
  `deno fmt --check`, `deno lint` and `deno check` on the touched files: clean.
- `./quality.sh` on an earlier head (before the review-fix pushes that rewrote
  the late-listener scenarios and added the `lateBindingClock` test; it was not
  re-run on the final head, which also removed the listener wait from
  `probeProxyAllowedDetailed` in `egress_selfcheck.ts`): deno lint, type check
  and fmt passed; deno tests reported 31119 passed and 1 failed:
  `worker/deno/tests/pr_maintenance_command_test.ts` "update-open-pr-branches
  takes no action on a behind-only PR behind a merge queue (Issue #4424)". That
  test does not touch the egress code and fails the same way (23 passed, 1
  failed) on base commit `7635984b` in a clean checkout, so it is not caused by
  this change and is left as is. The gate's overall result is therefore FAILED
  for that one pre-existing test.
