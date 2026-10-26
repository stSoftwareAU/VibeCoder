## Summary

Part of #4047

Docker and Podman now start the worker on an internal network and send its
outbound traffic through the egress proxy from #4046. The launch plan carries
the network and proxy commands, `run.sh` and `run.ps1` create the network,
start the proxy, then the worker, and remove both on exit. A shared helper
does the same for the containment suite and the tabletop runner. Apple
container launches are not put on that network and are not given proxy
environment variables. The live Docker containment step in
`.github/workflows/container-build.yml` passed in CI run `40268960461`
(15 tests, 47 steps); Docker is unavailable on this local host.

No version file is changed.

## Spec

### Intent and Rationale

- The worker must not have a route of its own. On Docker and Podman it is
  attached only to an internal network; the proxy is the only container on
  both that network and the outbound bridge.
- A failed network or proxy start exits non-zero. The launchers do not fall
  back to an open network.
- Apple container is a different runtime. This change does not claim to
  contain it; that is #4051.

### Essential Design Decisions

- `OCI_DIALECT` and `PODMAN_DIALECT` set `egressEnforced`. `APPLE_DIALECT`
  does not, and its launch plan gains no `--network` and no proxy URL.
- The proxy container uses `--cap-drop ALL`, `--security-opt
  no-new-privileges` and `--read-only`, with no mount and no published port.
  `FORBIDDEN_RUN_FLAGS` applies to its argv. It listens on `0.0.0.0:3128`
  inside the proxy network namespace so the worker can dial it.
- `NO_PROXY` is loopback only (`localhost,127.0.0.1,::1`). Both
  `HTTP_PROXY`/`HTTPS_PROXY` and the lowercase spellings are set on the
  worker. The proxy hostname is not in `NO_PROXY`.
- The worker image does not contain `worker/deno`, and a volume is forbidden,
  so the launchers pack that tree and attach it to the proxy's stdin. The
  proxy process is `worker/deno/egress_proxy_main.ts`.

### Undiscoverable Facts

- macOS `mktemp` only randomises a template that ends in `X`. A suffix after
  the `X`s makes every launch share one archive name.
- The worker capture FIFO is created only after sidecar startup succeeds.
  On macOS an incomplete-plan refusal left its reader blocked in `open`;
  the exit trap's TERM and wait did not finish. Starting the sidecar before
  opening the worker FIFO avoids that reader on every sidecar refusal.
- `run.ps1` starts the proxy client with `Start-Process -NoNewWindow`. With
  no output redirect the client inherits the launcher's stdout and stderr,
  so on Linux, where the plan enforces egress, a terminated launcher left
  its reader waiting out the proxy's lifetime: `run.ps1 - waits for the
  container and reports a termination as failure` hung until the
  `validate (container)` and `validate (no-runtime)` jobs were cancelled.
  The client's output now goes to files beside the packed source, removed
  on exit; the proxy log still comes from `<runtime> logs`.
- The proxy client is not `--rm`. The exit path appends `<runtime> logs
  <proxy>` to `egress-proxy.log` before removing the container.
- Docker is not installed on the local host. CI executes the containment
  suite against Docker with `VIBE_CONTAINMENT_REQUIRED=1`, using
  `startEgressSidecar` to start the proxy.

## Evidence

Manual section read: CODING-STANDARDS.md, "PR Summary and Evidence".

Docs updated for the boundary this change enforces are in the #4050 summary:
`docs/THREAT-MODEL.md`, `docs/CONTAINMENT.md`,
`docs/security/agent-containment-gap-analysis.md` and `SECURITY.md`. No UI
change, so there is no screenshot.

`./quality.sh` was not run. `deno fmt` and `deno lint` were run on the touched
Deno files. Docker and Podman were not available (`command -v` found neither).

PR #4392 CI repairs reproduce the strict-check failure for an absent fixture
path and the Linux runtime-parity failure for per-worker egress names. The
fixture now validates its path. Parity normalises only network and proxy
names derived from the same worker; wrong worker names, changed proxy ports,
privileged flags and writable mounts remain visible. The focused Bash
refusal test also reproduced the FIFO hang above before the ordering fix;
all six focused Bash and PowerShell egress tests then passed. Bash syntax,
ShellCheck, touched-file formatting and lint, and 845 manifest tests passed
(one existing manifest test ignored).

The green Container Build job in CI run `40266549950` reported
`IMAGE_CHANGED=false` and skipped the build. It is not live containment
proof. The image-change filter omitted launch-plan and egress inputs, so
it now selects both launchers, the runtime and launch-plan modules, egress
modules, the live containment suite and the filter itself. A real-git
regression failed with `image=false` before this fix; all 13 filter/probe
path tests pass afterwards, including unrelated worker and docs changes
that still skip the build. The normal required PR workflow will run its
existing live Docker step. Job `121397472900` in CI run `40268960461`
built the image, passed 335 in-image checks, and passed 15 live containment
tests (47 steps) with `VIBE_CONTAINMENT_REQUIRED=1` on head `98caf4b3d`.

The next CI stage exposed an existing sweep-ledger ancestry error:
`top-up-4047.json` recorded a milestone-only merge commit. The supported
`deno task lib-sweep-record` command recalculated its `sweptAt` from
`git merge-base origin/main HEAD` (`1a51ee04a`), retaining the claimed status
and the same three paths. `sweep-drift --default-branch origin/main`
reproduced the failure before the repair and passed afterwards.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — a Docker or Podman plan contains no `--network bridge` on the
  worker; the worker runs on the internal network with both proxy spellings;
  the proxy argv carries `--cap-drop ALL`, `no-new-privileges` and
  `--read-only`, with no `--volume`, no `--publish` and no forbidden flag; an
  Apple plan has no `--network` and no proxy URL — evidence:
  `worker/deno/tests/container_launch_test.ts` (107 tests in that file plus
  `run_worker_test.ts` passed) — reviewer: met
- **met** — both launchers remove a stale same-named network, create the
  network before the proxy and the proxy before the worker, capture proxy
  logs, remove both resources on exit, and refuse a plan that is missing a
  network or proxy key — evidence:
  `worker/deno/tests/run_sh_launcher_test.ts` (3 passed),
  `worker/deno/tests/run_ps1_launcher_test.ts` (3 passed) and
  `worker/deno/tests/launcher_parity_test.ts` (25 passed) — reviewer: met
- **met** — the Docker containment step in
  `.github/workflows/container-build.yml` passes with the suite starting the
  sidecar through `startEgressSidecar` — evidence: CI run `40268960461`,
  job `121397472900`, 15 passed tests with 47 steps and no failures on head
  `98caf4b3d`; `VIBE_CONTAINMENT_REQUIRED=1` prevents an unavailable runtime
  from silently skipping the suite — reviewer: met
- **missing** — the complete repository quality gate passes — reason:
  `./quality.sh` was not run. The focused tests, manifest suite, touched-file
  formatting and lint, Bash syntax and ShellCheck in the Test Plan pass;
  these do not constitute the complete gate — reviewer: missing

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English; tests do not mutate `Deno.env` or change
  directory; no `Deno.env.toObject()` spread; `worker/deno/deno.json` is not
  bumped; an unknown launch-plan key is still a hard launcher error because
  both launchers gained the new keys
- **clean** — `container_egress_probe.ts` is not attached to the internal
  network; this diff does not edit it

## Merge verification

- Required CI, including the Docker containment step, and the routine code
  review are pending until observed.

## Test Plan

- `worker/deno/tests/container_launch_test.ts` and
  `worker/deno/tests/run_worker_test.ts`: 107 passed
  (`--allow-read --allow-env --allow-write`).
- `worker/deno/tests/run_sh_launcher_test.ts --filter "Issue #4047"`: 3
  passed. `worker/deno/tests/run_ps1_launcher_test.ts --filter "Issue #4047"`:
  3 passed. `worker/deno/tests/launcher_parity_test.ts`: 25 passed
  (`--allow-all`).
- `worker/deno/tests/egress_sidecar_test.ts` and
  `worker/deno/tests/egress_proxy_env_test.ts` passed in the focused batch
  (144 passed, 0 failed, including docs, self-check, mod, backoff and
  launcher-marker tests).
- Full `run_sh_launcher_test.ts`, `run_ps1_launcher_test.ts` and
  `launcher_parity_test.ts`: 178 passed in 8m35s after the CI repairs.
- `sweep-drift --default-branch origin/main`: passed after repairing the
  recorded slice ancestry with `lib-sweep-record`.
- `deno task check:manifests`: 845 passed, one ignored. The new parity
  regression failed before the own-worker name normalisation and passed
  afterwards, including five cases that must remain unequal.
- `deno check tests/fixtures/egress_plan_mutator.ts`:
  strict fixture path typing passes after reproducing both TS2345 errors.
- `bash -n` and ShellCheck on `run.sh` and the changed image filter: passed.
  `actionlint .github/workflows/container-build.yml`: passed.
- `container_image_change_filter_test.ts` and
  `container_build_probe_paths_test.ts`: 13 passed. The live-containment path
  regression failed before the filter fix and passed afterwards.
- CI run `40268960461`, job `121397472900`: Docker image build passed,
  335 in-image checks passed, and 15 live containment tests (47 steps)
  passed with `VIBE_CONTAINMENT_REQUIRED=1`.
- `run_ps1_launcher_test.ts --filter "waits for the container and reports a
  termination"` on Linux with PowerShell 7.6.0: hung past five minutes
  before the redirect, 1 passed in 9s afterwards.
- Not run locally: `./quality.sh` and Docker (unavailable on this host).
