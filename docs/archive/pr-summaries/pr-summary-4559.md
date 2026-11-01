## Summary

The egress self-check's CONNECT probe now reads the proxy's whole answer instead
of one `conn.read`. The real proxy sends the 403 head and the `[EGRESS_DENIED]`
body in two writes, so a first read could return the head alone and the probe
reported `through` for a refusal, which made the launch exit 90 with
`unenforced` (Docker/Podman) or `proxyAllowlist=failed` (Apple). Closes #4559.

Version bump: no `VERSION` change in this diff; the merged commit records the
final version.

## Spec

### Intent and Rationale

- TCP has no message boundaries, so the probe must read to the end of the
  response head and the body that head announces before it classifies. The fix
  is on the reader (the issue's primary suggestion); `refuse` is left alone,
  since other clients also read it and a single write would only narrow the
  window.

### Essential Design Decisions

- `readAnswer` stops at the first of: head end plus the `Content-Length` body (a
  missing or malformed value counts as no body, so a `200` is complete at its
  head), EOF, the 2048-byte cap, or the probe timer. Data gathered before the
  timer fires is still classified.
- An answer with no `\r\n\r\n` (non-HTTP garbage on an open socket) now waits
  for the probe timer rather than returning after one read; it is still
  `through`.
- `Content-Length` is parsed with a linear scan, no regex, because the answer is
  untrusted.

### Undiscoverable Facts

- `deno task test:unit` grants no `--allow-net`, so the real-proxy tests run the
  proxy and probe in a `deno eval` child with `--allow-net=127.0.0.1`, as
  `worker/deno/tests/egress_proxy_test.ts` does.

## Evidence

Backend only, no UI. Code: `worker/deno/lib/egress_selfcheck.ts` (`readAnswer`,
`answerComplete`, `contentLength`, `indexOfHeadEnd`, and the
`probeProxyConnectDetailed` call). Docs: `docs/CONTAINMENT.md` (start-up
self-check paragraph). Callers of `probeProxyConnectDetailed`:
`probeProxyConnect` (used by `appleAllowedPaths` in `apple_egress_controls.ts`),
`probeProxyAllowedDetailed` and `runEgressProbes`; all take the new behaviour
through the one function.

The fake in the new split-read tests is a connection that returns the head and
body on separate reads; the production implementation it stands in for is
`refuse` in `worker/deno/lib/egress_proxy.ts`, which writes them with two
`writeAll` calls. Two tests run the real `startEgressProxy` over loopback.

## Test Plan

New tests in `worker/deno/tests/egress_selfcheck_test.ts`:

- `a 403 whose head and body arrive in separate reads is denied` (Issue #4559)
- `a head split inside its blank line or inside the marker is still denied`
- `a 403 with no body is not denied, after EOF or when the body never arrives`
- `a 200 is succeeded at its head, without a second read`
- `an answer longer than the byte cap is cut at the cap`
- `a Content-Length that is not plain digits announces no body, so a 200 stays complete at its head`
  (mutation check: kills the dropped all-digits test on
  `egress_selfcheck.ts:419`)
- `the real proxy's refusal of a host off the allowlist is denied over loopback`
- `the real proxy's 200 to an allowlisted host is succeeded over loopback`

Red check: with the original `lib/egress_selfcheck.ts` restored and the new
tests kept, 3 of the 32 tests in the file failed (the two split-read tests and
the byte-cap test); with the fix, all pass. The two real-proxy tests and the
`200` test pass on the original code too: over loopback the head and body
usually arrive together, so they pin the contract against the production proxy
but do not reproduce the split. The split is reproduced by the chunked fake.

No assertion was removed or changed in an existing test.

Results: `deno task test:unit` over
`worker/deno/tests/egress_selfcheck_test.ts`,
`worker/deno/tests/egress_proxy_command_test.ts` and
`worker/deno/tests/launcher_egress_selfcheck_test.ts`: 55 passed, 0 failed.
`./quality.sh < /dev/null`: every stage passed except `deno tests` (31406
passed, 2 failed); the two failures are the Rust-formatter tests in
`worker/deno/tests/completion_phase_repo_formatters_test.ts` (no rustup
toolchain on this host; that file alone fails 2 of 8 here and does not touch
this change; not run on the base branch). `config integration` and `checkov`
were skipped for local prerequisites, and the serial pass did not run because
the parallel pass failed.

Mutation check (`lib/egress_selfcheck.ts` `contentLength`): the dropped
all-digits operand is now killed by the non-digit `Content-Length` test (`abc`,
`1e3`, `0x10`, ...); with the operand replaced by `true` that test fails. The
dropped `value.length > 0` operand was an equivalent mutant: an empty value gave
`Number("") === 0`, the same as no header, so the operand was dead and has been
removed from the code. The mutation run stopped at 11 of 20 mutants (300 s
budget); the remaining nine were not tested.
