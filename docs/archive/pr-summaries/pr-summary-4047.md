## Summary

Part of #4047

Docker and Podman now start the worker on an internal network and send its
outbound traffic through the egress proxy from #4046. The launch plan carries
the network and proxy commands, `run.sh` and `run.ps1` create the network,
start the proxy, then the worker, and remove both on exit. A shared helper
does the same for the containment suite and the tabletop runner. Apple
container launches are not put on that network and are not given proxy
environment variables. The live Docker containment step in
`.github/workflows/container-build.yml` was not run on this host.

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
- The capture FIFO is opened for read before the worker starts. An early
  refusal never opens the write end, so `tee` blocks in `open` and bash waits
  for that job after the exit trap. The trap kills `tee` first.
- The proxy client is not `--rm`. The exit path appends `<runtime> logs
  <proxy>` to `egress-proxy.log` before removing the container.
- Docker is not installed on the host that produced this branch, so the
  containment workflow was not executed. The suite calls
  `startEgressSidecar`.

## Evidence

Manual section read: CODING-STANDARDS.md, "PR Summary and Evidence".

Docs updated for the boundary this change enforces are in the #4050 summary:
`docs/THREAT-MODEL.md`, `docs/CONTAINMENT.md`,
`docs/security/agent-containment-gap-analysis.md` and `SECURITY.md`. No UI
change, so there is no screenshot.

`./quality.sh` was not run. `deno fmt` and `deno lint` were run on the touched
Deno files. Docker and Podman were not available (`command -v` found neither).

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
  `worker/deno/tests/launcher_parity_test.ts` (24 passed) — reviewer: met
- **missing** — the Docker containment step in
  `.github/workflows/container-build.yml` still passes — reason: Docker is
  not installed here, so that step was not run. The suite starts the sidecar
  through `startEgressSidecar`
  (`worker/deno/tests/container_containment_test.ts`); that call was not
  executed against a live runtime — reviewer: missing
- **met** — focused tests, `deno fmt` and `deno lint` on the touched files —
  evidence: the runs named in the Test Plan. `./quality.sh` was not run —
  reviewer: met

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
  3 passed. `worker/deno/tests/launcher_parity_test.ts`: 24 passed
  (`--allow-all`).
- `worker/deno/tests/egress_sidecar_test.ts` and
  `worker/deno/tests/egress_proxy_env_test.ts` passed in the focused batch
  (144 passed, 0 failed, including docs, self-check, mod, backoff and
  launcher-marker tests).
- Not run: `./quality.sh`; the Docker job in
  `.github/workflows/container-build.yml`.
