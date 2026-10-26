## Summary

Closes #4051

Apple workers now use the shared allowlist proxy, with an internal network
where the measured CLI supports it. Startup measures each control inside the
actual worker before claims, compares direct probes with an isolated open
network negative control, and records accepted host/DNS/IPv6 gaps honestly.
An explicit advisory mode retains proxy routing without claiming direct
network isolation. Failed setup never silently downgrades the chosen mode.

## Spec

### Intent and Rationale

The owner's revised direction accepts useful partial Apple containment now.
The implementation does not wait for Docker/Podman evidence or perfect Apple
host isolation. It reuses #4045/#4046 policy and proxy, #4047 lifecycle and
#4048 startup/restart handling. Credential isolation remains open in #3699.

### Essential Design Decisions

- Apple CLI and macOS versions and actual network help are measured. Apple
  uses `network create --internal`, repeated `run --network`, `network
  delete`, and an inspected proxy IPv4 address, not Docker network-connect
  commands or bare-name DNS.
- The proxy has no mounts or published ports. Source arrives on stdin;
  excluding the test tree keeps it inside the small scratch filesystem.
  Internal mode promises a working proxy and demonstrated direct IPv4
  blocking. Observed direct IPv6/hostname escapes also fail it. Host/LAN
  reachability is an accepted gap; unavailable IPv6/DNS coverage is unknown.
  Advisory mode still requires the allowlist proxy. A failed intended
  configuration cannot turn into unrestricted fallback networking.
- Unique resource names and successful-creation journals scope cleanup.
  Journals live in private host-only `~/.vibe-apple-egress`, with canonical
  mount-overlap and symlink checks; worker-writable logs hold no cleanup
  authority. Runtime writes, reads and shutdown have hard-kill/reap bounds.
  Stale cleanup requires both the original launcher and supervisor to be
  dead. Setup gets three attempts; worker failures use exit 90 and the
  existing restart backoff.
- Apple evidence is required to be written before claims. The legacy
  whole-policy verdict stays `not_enforced`, `passed=false`; the detailed
  record can separately say `proxyAllowlist=enforced`.

### Undiscoverable Facts

Measured Apple CLI 1.2.2 limits container IDs to 63 characters and does not
resolve bare container names on custom networks. Its default `/dev/shm`
cannot hold the complete worker test tree. All three affected the real
probe and are addressed in the launch path.

## Evidence

Manual section read: CODING-STANDARDS.md, "PR Summary and Evidence".

Automated disposable host run, 26 October 2026: Apple CLI 1.2.2, macOS 27.0.1,
existing worker image `vibe-coder:343ff0df947e`, no production credentials,
no credential or repository mounts, and no agent workload in the negative
control. The worker and manager both exited zero; all created containers
and networks were removed.

| Control | Actual worker | Negative control | Recorded result |
| --- | --- | --- | --- |
| Allowed/denied CONNECT | GitHub allowed; example.com denied | Not applicable | Proxy allowlist enforced |
| Public IPv4 literal | Refused | Connected | Blocked |
| Public IPv6 literal | Refused | Refused | Unknown; usable IPv6 unavailable |
| Public hostname | DNS unavailable | Connected | Unknown |
| Controlled host/LAN endpoint | Correct random banner received | Same banner received | Reachable; accepted gap |
| External DNS | Unavailable | Resolved | Unknown; no DNS-filter claim |

GitHub API/web, Anthropic, OpenAI and npm CONNECT probes succeeded. Real
unauthenticated HTTPS requests returned HTTP responses, `git ls-remote`
returned the public repository HEAD, and `npm view is-number version`
returned `7.0.0` through the proxy. No authenticated provider inference was
attempted, and this evidence does not claim an authenticated provider job.
The same worker checks run on each production start; these host observations
are never substituted for unavailable probes on another host.

A second disposable run explicitly selected advisory mode. The proxy
allowlist passed while direct IPv4, hostname, host/LAN and DNS were recorded
as reachable, and IPv6 as unknown. Worker and supervisor exited zero and
cleaned up their resources; the whole-policy verdict remained `not_enforced`.

The final internal rerun after review fixes again passed CONNECT, HTTPS,
Git and npm checks and exited zero. Its IPv6 negative control connected,
so that run correctly recorded IPv6 blocked instead of reusing the earlier
unknown result. An intervening client smoke timed out and recorded failed
extra CONNECT probes; those observations were not upgraded to success.

Security fix, original trigger: Apple startup previously skipped all egress
probes when `VIBE_EGRESS_ENFORCED=false`, so a configured but broken proxy
could proceed to claims with no demonstrated control. Regression test
`worker/deno/tests/apple_egress_startup_test.ts::Apple startup refuses a broken configured proxy before claims`
fails against the base production self-check at `777b72ff0` with the actual
assertion that the probe never ran; it passes against this implementation.
The original trigger is closed because an explicit Apple mode runs the real
probes and exits 90 when its configured proxy is failed or untested before
any claim. It does not claim that Apple's residual host access is fixed.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — useful Apple containment independently of other runtimes —
  evidence: actual disposable launch and per-control results above — reviewer: met
- **met** — Apple argv, lifecycle, ownership and bounded recovery — evidence:
  `apple_egress_controls_test.ts` and real launch/cleanup — reviewer: met
- **met** — actual-worker checks before claims and durable honest reporting —
  evidence: `run_worker_test.ts` exercises the real decision and checks its
  log, with a broken proxy refusing the loop — reviewer: met
- **met** — allowed provider/GitHub/package network paths — evidence: real
  CONNECT, HTTPS, Git and npm checks; authenticated inference not attempted —
  reviewer: met
- **met** — partial/advisory gaps documented without whole-policy enforcement
  claims — evidence: CONTAINMENT, THREAT-MODEL, SECURITY and docs tests — reviewer: met
- **met** — unattended bounded recovery retains selected protections —
  evidence: three-attempt recovery test and existing exit-90 backoff — reviewer: met
- **met** — independent security/correctness review — evidence: review fixes
  and canonical rerun, 11 passed, 0 failed — reviewer: met
- **pending** — repository quality gate — reason: CI not yet verified —
  remaining: merge-verification-only — reviewer: pending

## Merge verification

Independent security/correctness review is clear after fixing the host-only
ownership boundary and bounded pipe shutdown. Required CI and the final full
local quality run are pending; all focused checks below have passed.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — one allowlist and proxy, shared subprocess bounds and lifecycle,
  no new dependency, no credential mounts, no broad runtime cleanup.
- **clean** — runtime and self-check data are observations; unknown results
  are never upgraded to blocked or passed.
- **clean** — existing assertions are retained except the exact Apple
  no-network/no-proxy expectations replaced by issue-required containment.

## Test Plan

- Security discrimination: the named startup regression failed against base
  production code and passed on the fix; no compile error counted as red.
- Apple controls: negative-control matching, unknown probes, accepted gaps,
  explicit-mode refusal, actual CLI argv, address resolution, owned cleanup,
  dead-process ownership and bounded recovery. The review follow-up exercises
  journal symlinks and mounted aliases, continued cleanup after command
  exceptions, and a real child ignoring SIGTERM with blocked stdin.
- Existing shared launch, runtime, proxy environment, self-check, startup,
  restart, launcher-marker, tabletop and docs suites.
- Focused launch/control tests: 118 passed. Startup/docs follow-up: 65 passed.
  After integration and independent review fixes, 126 launcher/control tests
  passed, followed by all 11 Apple tests including inherited-pipe deadlines.
  Manifest checks: 845 passed, one ignored. The first full quality run passed
  static, manifest, formatting, lint, Markdown and Semgrep checks and 30,273
  unit tests. It exposed seven launcher failures from the parser omitting its
  existing builder tokens; the parser now round-trips those tokens. The two
  separate base fixture type errors are repaired by the #4392 follow-up.
- Existing Apple `--network`/proxy absence assertions changed because #4051
  explicitly requires them. The non-enforcement boolean, privilege, mount,
  forbidden-flag and Docker/Podman assertions remain.
- Existing docs assertions saying Apple is absent from the proxy now require
  measured partial containment. Other network-path and open-credential-risk
  assertions remain. Those new phrases are absent from the base sections.
- Twinned shared lifecycle callers: run.sh, run.ps1, shared sidecar helper,
  tabletop and containment probes. Proxy source packing excludes tests on all
  three packing paths. Apple endpoint resolution applies to both direct
  launch-plan callers as well as the production supervisor.
