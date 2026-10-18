# Broker supervisor implementation checkpoint

**Issues #3698 and #3699; incomplete integration.** Neither ordinary launcher
selects this mode. R9 and R11 remain open. This checkpoint adds production
lifecycle building blocks after the
[separate-container boundary experiments](agent-egress-credential-isolation.md),
without treating local process fixtures as container or credential proof.

## Implemented boundary and lifecycle

`worker/deno/lib/broker_isolation_plan.ts` derives both container invocations
from the existing production runtime descriptor and launch plan. The worker
retains its work, approval and agent-state volumes, loses every provider/GitHub
credential mount, gains only a read-only socket-volume mount and uses
`--network none`. The trusted broker uses the base image, its fixed Deno service
entrypoint, read-only checkout and private session-volume mounts, and the same
socket volume writable. Neither role gains runtime-daemon access. Capabilities
remain dropped, no-new-privileges and the read-only root remain enabled, and
production tmpfs/seccomp/AppArmor behaviour is retained. The broker explicitly
uses a temporary Deno cache because it does not run the ordinary entrypoint.

Canonical path checks refuse original host configuration or credential sources
that overlap any worker host mount, including aliases via custom prompts. The
default original `.config.json` inside the checkout is therefore refused: merely
projecting a second copy into the config mount does not protect the original.
The eventual host bootstrap must supply a clean checkout and a separately staged
worker projection. Apple is refused explicitly until its transport and boundary
have runtime evidence.

`worker/deno/broker_service.ts` reads only a closed host session schema:
selected upstream values, repository scope, lease lifetime and explicit Claude
auth mode. It creates a revocable broker lease and writes only its opaque local
capability to the fresh shared socket volume. Readiness performs an
authenticated, denied route through that socket, with no upstream request. It
refuses stale metadata, revokes on expiry or termination, and never prints
configuration contents. There is no worker command, account-selection,
grant-renewal or arbitrary command-execution RPC.

`worker/deno/lib/broker_supervisor.ts` snapshots the plan before constructing
real process dependencies. It creates and verifies an individually labelled
socket volume, initialises the socket and worker volumes, starts the broker,
verifies container ownership and authenticated readiness, then attaches the
worker with inherited output. Broker loss, cancellation, readiness failure and
the host watchdog all prevent or terminate worker execution. A normal worker
exit keeps its exit code. Cleanup stops the broker first to revoke authority,
reaps both roles and failed initialisers, verifies ownership including stopped
containers, and removes only the session's socket volume after both roles are
gone. It never deletes the durable worker volumes. A foreign or unverifiable
resource causes an explicit cleanup failure. Removal of an owned stopped
container uses no force; the runtime must reject an active container. The
existing watchdog reaper remains the escalation path.

## Local evidence

The focused suite runs under the normal test permissions: read, write,
environment, process execution and `sys=hostname`, without network permission.
It exercises the real plan builder, session parser and supervisor. A POSIX
executable process fixture drives the production `Deno.Command` adapter and
existing reaper with actual child PIDs, attach output and exit status. It is
explicitly **not Docker**, and does not establish network isolation, mounted
permissions, native authentication or Apple support.

Test-first failures included exposed original host config, mutation of the
runtime executable after the first await, the read-only-root Deno-cache path,
and stopped foreign-container cleanup being incorrectly treated as complete. The
initial lifecycle checkpoint passed 16 focused tests. Twenty-four independent
mutations were rejected by assertions: worker network mode, socket access,
credential mounts, config/credential overlap, socket names and ownership,
scratch cache, plan snapshot, stopped-resource ownership, readiness
ownership/deadline, cleanup failure propagation, service/credential/repository
policy, lease bounds and explicit authentication mode. The private-volume
follow-up adds streamed-input, mode, stale-file, partial-setup, provisioner
cancellation and runtime-witness tests. Its 28 further independent mutations are
rejected by assertions; the combined focused suite now has 28 tests. The
volume-options snapshot regression first exposed caller mutation during
asynchronous path checks, then passed after snapshotting those options too. No
assertion that existed on main was removed.

The executable
`tests/fixtures/broker_supervisor_runtime_probe.ts <image>
[docker|podman]` runs
the actual supervisor and stdin provisioner for normal exit, host cancellation
and broker loss. It asserts the broker's positive file hash, mode and UID
witness; the worker's denied broker route, absent private mount and credential
value, read-only socket, zero capabilities, no-new-privileges and seccomp; and
container/volume cleanup. Artifacts and release markers stay in worker tmpfs,
observed through fixed trusted host runtime calls. It makes no upstream request
and never uses real credentials. The local shell cannot run Docker/Podman, so
this newer fixture still awaits hosted execution.

Local evidence logs are retained in the implementation session as
`/private/tmp/m122-supervisor-*-red.log`,
`/private/tmp/m122-supervisor-mutations.json` and individual mutant logs. The
follow-up uses `/private/tmp/m122-provision-mutations.json` and
`/private/tmp/m122-private-volume-snapshot-red.log`. These temporary local paths
are evidence for the checkpoint, not durable CI artifacts. The final integrated
change still requires the repository quality gate and actual runtime acceptance.

## Remaining production acceptance criteria

1. Connect trusted account snapshots, account-pool selection/rotation, native
   provider transport, refresh and immutable account-bound grants. The temporary
   session schema supplies selected values; it does not yet perform account
   loading, subscription refresh or pool accounting.
2. Stage the explicit worker config projection, refuse unsupported host-only
   hooks/commands/extensions, and prevent the original config being readable
   through the checkout. Inspect legacy volume credential locations before
   reuse; provide an explicit migration path without deleting worktrees,
   transcripts or approval state silently.
3. Replace the worker entrypoint's credential staging and startup credential
   checks with local broker transport. Preserve provider-specific invocation,
   native account-mode semantics, state directories and cancellation. Existing
   workers would currently fail those checks without their removed mounts.
4. Enforce startup/read/write GitHub semantics and git smart-HTTP transport on
   the trusted side. Worker requests, role names and claimed repository scopes
   remain untrusted. Reserved labels, merge gates, branch writes and lifecycle
   actions need broker-owned policy; a locally readable capability must not
   become arbitrary host or unrestricted GitHub authority.
5. Connect both actual launchers and their signal/watchdog paths only after the
   above criteria are met. Preserve build/prune/disk checks and attached-command
   behaviour. Re-run full Docker and rootless Podman proof using this supervisor
   and fixed service, including denial controls, readiness, revocation, process
   cleanup and secret visibility. In particular, demonstrate private `0600`
   provisioned-volume configuration readability by the broker under rootless UID
   mapping; never make upstream credentials world-readable to make a probe pass.
6. Establish an Apple-supported broker transport and actual runtime proof on an
   eligible host, or continue refusing that launch path explicitly. Hosted macOS
   runner availability is not evidence of nested VM support.

The independent earlier Docker socket/network experiments remain useful
architecture evidence; they do not prove this newer supervisor integration or
resolve any of these remaining acceptance criteria.

## Hosted supervisor failure follow-up

The first hosted supervisor run,
[39100177993](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39100177993),
tested source `288fadd`. Docker reached the worker fixture, but its granular
Deno permissions refused the `/proc/self/status` witness. The fixture now uses
`--allow-all` inside the unchanged hardened container, as the earlier boundary
probe does. This removes an application permission barrier from a test intended
to exercise the container boundary; it does not relax the container's network,
capability, seccomp, root-filesystem or mount settings.

Rootless Podman stopped before starting the worker with a readiness failure. The
original error discarded the runtime's exit code and stderr meaning. The
supervisor now reports the failing phase, exit code, a fixed stderr category,
and a bounded runtime inspection of `Status`, `Running` and `ExitCode`. It never
prints raw stderr, container names, paths or the inspect `Error` field. Exit 125
still fails; this change does not infer authenticated readiness from a container
state or assume an unobserved startup race is retryable. A further hosted run
must establish the actual Podman cause before changing that decision.

The local focused suite passes 31 tests, including three new behavioural cases
for scoped diagnostics, malformed state, and the real local subprocess adapter.
Six independent mutations were killed by assertions after the tests first failed
against the original implementation. The source was restored before formatting,
lint and type checks. These local process tests establish diagnostic handling
and cleanup, not Docker or Podman containment acceptance.
