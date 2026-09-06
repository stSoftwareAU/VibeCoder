/**
 * Shared harness for the launcher tests (Issues #4065, #4066).
 *
 * `run.sh` and `run.ps1` are the containment boundary: whatever they hand the
 * container runtime is exactly what the worker can reach. Both are tested the
 * same way — replace the runtime executable with a recording stub on `PATH`,
 * run the real launcher, then assert on the invocation it constructed — so
 * the harness lives here rather than being restated per launcher, and the two
 * suites stay directly comparable.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { resolvePowerShell } from "../support/pwsh.ts";
import { pathStyleFor } from "../../lib/host_path_style.ts";
import { resolveLogDir } from "../../lib/log_dir.ts";

const FIXTURE_PATH = new URL(import.meta.url).pathname;

/** The repository checkout the launchers live in. */
export const REPO_ROOT = FIXTURE_PATH.replace(
  /\/worker\/deno\/tests\/fixtures\/[^/]+$/,
  "",
);

/**
 * A recording stand-in for the container runtime.
 *
 * Records each invocation's argument list, NUL-delimited, under
 * `$VIBE_STUB_RECORD/<sub-command>.args`, and answers each sub-command the
 * way the surrounding test needs.
 */
const RUNTIME_STUB = `#!/bin/bash
set -u
record_dir="\${VIBE_STUB_RECORD}"
mkdir -p "\${record_dir}"
sub="\${1:-none}"
# The volume-ownership init (Issue #4186) is also a \`run\`; record it under
# its own name so a test waiting for the worker's run cannot fire early on it.
if [[ "\${sub}" == "run" ]]; then
  for arg in "\$@"; do
    if [[ "\${arg}" == "--entrypoint" ]]; then
      sub="run-init"
      break
    fi
  done
fi
# Volume sub-commands are recorded per action (volume-inspect, volume-create).
if [[ "\${sub}" == "volume" ]]; then
  sub="volume-\${2:-none}"
fi
# The builder helper stop (Issue #4331) is recorded under its own name.
if [[ "\${sub}" == "builder" ]]; then
  sub="builder-\${2:-none}"
fi
# Image sub-commands: the presence check keeps the plain \`image\` record name,
# and the prune's own listing and removals (Issue #4162) are recorded under
# their own action names so they cannot overwrite it.
if [[ "\${sub}" == "image" || "\${sub}" == "images" ]]; then
  case "\${2:-none}" in
    list|ls|rm|delete|remove|prune) sub="image-\${2}" ;;
  esac
fi
# The TERM handler goes in BEFORE the invocation is recorded. A test waits for
# the .args file and then signals the launcher, so the record is the readiness
# signal: a trap installed later leaves a window where TERM takes its default
# disposition, the stub dies silently, and neither the marker nor the status
# the launcher reports ever appears.
sleep_pid=""
stderr_pid=""
on_term() {
  if [[ -n "\${sleep_pid}" ]]; then
    kill "\${sleep_pid}" 2>/dev/null || true
  fi
  # The repeating stderr writer (Issue #720) goes with the stub that started
  # it: an orphan still holding the launcher's pipe would stall the test.
  if [[ -n "\${stderr_pid}" ]]; then
    kill "\${stderr_pid}" 2>/dev/null || true
  fi
  # Only a \`run\` is the container the launcher forwards termination to; the
  # short-lived sub-commands have no marker to write.
  if [[ "\${sub}" == "run" ]]; then
    printf 'terminated' > "\${record_dir}/terminated"
  fi
  exit "\${STUB_RUN_SIGNAL_EXIT:-143}"
}
trap on_term TERM
printf '%s\\0' "\$@" > "\${record_dir}/\${sub}.args"
# Which step ran before which is behaviour too (Issue #492): the per-command
# .args files cannot answer it, so keep an ordered log beside them.
printf '%s\\n' "\${sub}" >> "\${record_dir}/order.log"
# Stall one sub-command (\`run\` unless \`STUB_READY_DELAY_SUB\` names another)
# between its readiness record and the work it gates (Issue #668). A CI runner
# carrying four shards deschedules this stub for exactly this long, so a test
# sets the stall to hold the stub inside that window on purpose and prove the
# record really does mean "ready to be signalled".
if [[ -n "\${STUB_READY_DELAY:-}" &&
  "\${sub}" == "\${STUB_READY_DELAY_SUB:-run}" ]]; then
  sleep "\${STUB_READY_DELAY}"
fi
case "\${sub}" in
  image-prune)
    # The store prune's dangling-layer pass (Issue #227): nothing to reclaim.
    printf 'Total reclaimed space: 0B\\n'
    exit "\${STUB_IMAGE_PRUNE_EXIT:-0}"
    ;;
  volume-ls|volume-list)
    # The store prune's volume listing (Issue #227): no throwaway volumes.
    printf '%s\\n' "\${STUB_VOLUME_LIST:-[]}"
    exit 0
    ;;
  image-list|image-ls)
    # Local image store for the prune. Empty by default, so a launch on a host
    # holding nothing but the current reference prunes nothing.
    printf '%s\\n' "\${STUB_IMAGE_LIST:-[]}"
    exit "\${STUB_IMAGE_LIST_EXIT:-0}"
    ;;
  image-rm|image-delete|image-remove)
    # One line per removal, so a test can read every reference the prune
    # removed rather than only the last one.
    printf '%s\\n' "\${*: -1}" >> "\${record_dir}/image-removed.lines"
    exit "\${STUB_IMAGE_REMOVE_EXIT:-0}"
    ;;
  version|system)
    exit "\${STUB_PROBE_EXIT:-0}"
    ;;
  image|images)
    exit "\${STUB_IMAGE_INSPECT_EXIT:-1}"
    ;;
  build)
    # Snapshot the Dockerfile the build was handed (Issue #4393): the
    # launcher writes a comment-stripped copy beside its plan file and
    # removes it on exit, so only the build itself can see it.
    prev=""
    for a in "\$@"; do
      if [[ "\${prev}" == "--file" ]]; then
        cp "\${a}" "\${record_dir}/build.containerfile" 2>/dev/null || true
      fi
      prev="\${a}"
    done
    # Count the builds (Issue #4441), so a test can tell a launch that
    # retried after a builder heal from one that built once, and can make the
    # retry behave differently from the first attempt.
    count=\$(( \$(cat "\${record_dir}/build.count" 2>/dev/null || echo 0) + 1 ))
    printf '%s' "\${count}" > "\${record_dir}/build.count"
    # Each build's own argument list (Issue #980): \`build.args\` holds only
    # the last one, and a launch that builds the operator's private layer
    # makes two invocations whose order is the behaviour under test.
    printf '%s\\0' "\$@" > "\${record_dir}/build-\${count}.args"
    if [[ -n "\${STUB_BUILD_STDERR:-}" ]]; then
      printf '%s\\n' "\${STUB_BUILD_STDERR}" >&2
    fi
    if [[ "\${count}" -ge 2 ]]; then
      exit "\${STUB_BUILD_RETRY_EXIT:-0}"
    fi
    exit "\${STUB_BUILD_EXIT:-0}"
    ;;
  stop)
    exit 0
    ;;
  kill)
    # The wedge the watchdog exists for: the runtime cannot reap its own
    # container, exactly as observed on host-23 (Issue #4173).
    exit "\${STUB_KILL_EXIT:-0}"
    ;;
  list|ps)
    # Container listing for the reaper. Empty by default, so a launch that
    # leaked nothing reaps nothing.
    printf '%s\\n' "\${STUB_LIST_JSON:-[]}"
    exit "\${STUB_LIST_EXIT:-0}"
    ;;
  volume-inspect)
    # Default "absent", so the create-then-init path is what tests exercise.
    exit "\${STUB_VOLUME_INSPECT_EXIT:-1}"
    ;;
  volume-delete|volume-rm|volume-remove)
    # One line per removal (Issue #478), so a test can see every volume the
    # launcher recreated rather than only the last one.
    printf '%s\\n' "\${*: -1}" >> "\${record_dir}/volume-removed.lines"
    exit "\${STUB_VOLUME_DELETE_EXIT:-0}"
    ;;
  volume-*)
    exit 0
    ;;
  run-init)
    # Count the init runs (Issue #478): a launcher that recreated a volume
    # must run the init again, or the fresh volume stays root-owned.
    count=\$(( \$(cat "\${record_dir}/run-init.count" 2>/dev/null || echo 0) + 1 ))
    printf '%s' "\${count}" > "\${record_dir}/run-init.count"
    # What container/volume-init.sh reports on stdout — the launcher parses
    # \`VOLUME_UNREPAIRABLE\` (#229) and \`VOLUME_TRIM_REFUSED\` (#478) from it.
    if [[ -n "\${STUB_INIT_STDOUT:-}" ]]; then
      printf '%b\\n' "\${STUB_INIT_STDOUT}"
    fi
    exit "\${STUB_INIT_EXIT:-0}"
    ;;
  run)
    # The mode of the container-stderr capture FIFO (Issue #1299), recorded
    # from inside the run: the launcher removes the FIFO on the way out, so
    # this is the only moment it exists to be inspected. GNU stat first, BSD
    # (macOS) stat second — the losing spelling prints its usage to stderr,
    # which is this stub's own capture pipe, so both are silenced.
    for fifo in "\${TMPDIR:-/tmp}"/vibe-run.*.err; do
      [[ -p "\${fifo}" ]] || continue
      mode="\$(stat -c '%a' "\${fifo}" 2>/dev/null ||
        stat -f '%Lp' "\${fifo}" 2>/dev/null || true)"
      printf '%s\\n' "\${mode}" >> "\${record_dir}/run-err-fifo.mode"
    done
    # What the runtime client says when it refuses to start the container
    # (Issue #711) — the "no such image", "invalid reference format" or
    # "permission denied" line that a container_start escalation exists to
    # quote. Written before \`STUB_RUN_SLEEP\` stalls the stub, so a test can
    # watch it reach the console while the container is still running, which is
    # what "streamed, not buffered until exit" means.
    if [[ -n "\${STUB_RUN_STDERR:-}" ]]; then
      printf '%s\\n' "\${STUB_RUN_STDERR}" >&2
    fi
    # A container that never stops writing (Issue #720). A launcher that only
    # looks at its watchdog deadline while the stream is idle would let this
    # one run past the deadline until it fell quiet, so the repeat is what
    # makes that regression visible. Bounded at 600 writes, so no writer can
    # outlive the test that started it - and \`|| break\` ends it the moment
    # the launcher's pipe is gone.
    if [[ -n "\${STUB_RUN_STDERR_REPEAT:-}" ]]; then
      for _ in \$(seq 1 600); do
        printf '%s\\n' "\${STUB_RUN_STDERR:-[stub] still running}" >&2 ||
          break
        sleep "\${STUB_RUN_STDERR_REPEAT}"
      done &
      stderr_pid=\$!
    fi
    if [[ -n "\${STUB_RUN_SLEEP:-}" ]]; then
      # Streams detached: when this stub is SIGKILLed (the watchdog path of
      # Issue #4173) the orphaned sleep must not hold the launcher's stdout
      # pipe open and stall the test reading it.
      # The TERM trap installed above kills this sleep on the way out: an
      # orphan holding the inherited stdout pipe open would stall the test
      # that spawned the launcher.
      sleep "\${STUB_RUN_SLEEP}" >/dev/null 2>&1 &
      sleep_pid=\$!
      wait "\${sleep_pid}"
    fi
    exit "\${STUB_RUN_EXIT:-0}"
    ;;
  builder-*)
    printf '%s\\0' "\$@" > "\${record_dir}/\${sub}.args"
    if [[ "\${sub}" == "builder-stop" ]]; then
      # Issue #492: the launcher classifies the stop failure by the text the
      # runtime prints, so the stub has to be able to print one.
      if [[ -n "\${STUB_BUILDER_STOP_STDERR:-}" ]]; then
        printf '%s\\n' "\${STUB_BUILDER_STOP_STDERR}" >&2
      fi
      exit "\${STUB_BUILDER_STOP_EXIT:-0}"
    fi
    # The step that leaves a usable builder behind — \`builder start\` on Apple
    # container, \`builder prune\` on Docker/Podman. A heal that cannot leave
    # one is what makes container-build-heal itself fail (Issue #1019), so the
    # stub has to be able to fail it, and to say why.
    if [[ "\${sub}" == "builder-start" || "\${sub}" == "builder-prune" ]]; then
      if [[ -n "\${STUB_BUILDER_HEAL_STDERR:-}" ]]; then
        printf '%s\\n' "\${STUB_BUILDER_HEAL_STDERR}" >&2
      fi
      exit "\${STUB_BUILDER_HEAL_EXIT:-0}"
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;

/**
 * The Deno sub-commands a launcher run is expected to make, recorded in order
 * (Issue #512) so a test can assert that one step ran before another — the
 * checkout update before the launch plan, say.
 */
const RECORDED_DENO_COMMANDS = [
  "upgrade",
  "run-mode",
  "worker-checkout-update",
  "release-notice",
  "container-launch-plan",
  "container-reap",
  "container-image-prune",
  "container-store-prune",
  "container-build-heal",
  "container-egress-probe",
  "container-restart-backoff",
  "run-entrypoint",
];

/**
 * A stand-in for Deno on the launcher's PATH (Issues #4148, #512).
 *
 * Every recognised sub-command is appended to `deno-order.log`, and all but
 * one are then answered by the real binary — the run-mode resolution and the
 * launch plan stay genuine.
 *
 * `worker-checkout-update` is **always** intercepted: it git-resets the
 * checkout it is pointed at, and the launcher points it at this very
 * repository, so really running it would discard the working tree the tests
 * are running from. `STUB_CHECKOUT_UPDATE_EXIT` makes it fail, which is how
 * the "a failed update still launches" behaviour is exercised.
 *
 * `release-notice` is always intercepted too (Issue #690): it would otherwise
 * reach GitHub for the newest release. `STUB_RELEASE_NOTICE_STDOUT` is the
 * notice the check found, and `STUB_RELEASE_NOTICE_EXIT` makes the check
 * fail — an unreachable GitHub, a `gh` failure or a timeout.
 * `STUB_RELEASE_NOTICE_STDERR` is what the failing check said about itself
 * (Issue #1020); `STUB_RELEASE_NOTICE_EXIT` of 124 is what `timeout` reports
 * when the launcher's own bound was what ended the check.
 *
 * With `full`, two more invocations are intercepted rather than performed:
 * `run-entrypoint`, which would start the whole worker on this host, and
 * `container-restart-backoff`, the outcome record (Issue #4148).
 *
 * @param full - Intercept the worker driver and the outcome recorder too
 * @returns The stub script source
 */
function denoStubSource(full: boolean): string {
  const extraIntercepts = full
    ? `
    run-entrypoint)
      # The TERM handler goes in BEFORE the invocation is recorded, for the
      # same reason as the runtime stub above (Issue #668): a test waits for
      # the record and then signals, so a trap installed after it leaves a
      # window where TERM takes its default disposition, the stub dies
      # silently, and the marker the test reads is never written.
      sleep_pid=""
      on_term() {
        if [[ -n "\${sleep_pid}" ]]; then
          # An orphaned sleep holding the inherited stdout pipe open would
          # stall the test that spawned the launcher.
          kill "\${sleep_pid}" 2>/dev/null || true
        fi
        printf 'terminated' > "\${record_dir}/entrypoint-terminated"
        exit "\${STUB_ENTRYPOINT_SIGNAL_EXIT:-143}"
      }
      trap on_term TERM
      printf '%s\\0' "\$@" > "\${record_dir}/run-entrypoint.args"
      if [[ -n "\${STUB_READY_DELAY:-}" ]]; then
        sleep "\${STUB_READY_DELAY}"
      fi
      if [[ -n "\${STUB_ENTRYPOINT_SLEEP:-}" ]]; then
        sleep "\${STUB_ENTRYPOINT_SLEEP}" &
        sleep_pid=\$!
        wait "\${sleep_pid}"
      fi
      exit "\${STUB_ENTRYPOINT_EXIT:-0}"
      ;;
    container-restart-backoff)
      printf '%s\\0' "\$@" > "\${record_dir}/container-restart-backoff.args"
      # Snapshot the log the recorder was handed (Issue #709). The launcher
      # deletes its build log on the way out, so copying it here is the only
      # way a test can prove the evidence was still alive when the outcome
      # was recorded — and what it said.
      prev=""
      for a in "\$@"; do
        if [[ "\${prev}" == "--launch-log" ]]; then
          cp "\${a}" "\${record_dir}/outcome-launch.log" 2>/dev/null || true
        fi
        prev="\${a}"
      done
      echo 60
      exit 0
      ;;`
    : "";

  return `#!/bin/bash
set -u
record_dir="\${VIBE_STUB_RECORD}"
mkdir -p "\${record_dir}"
for arg in "\$@"; do
  case "\${arg}" in
${
    RECORDED_DENO_COMMANDS.map((name) =>
      `    ${name}) printf '%s\\n' "${name}" >> "\${record_dir}/deno-order.log" ;;`
    ).join("\n")
  }
  esac
done
for arg in "\$@"; do
  case "\${arg}" in
    worker-checkout-update)
      # Never really git-reset this repository (Issue #512).
      printf '%s\\0' "\$@" > "\${record_dir}/worker-checkout-update.args"
      status="\${STUB_CHECKOUT_UPDATE_EXIT:-0}"
      if [[ "\${status}" -ne 0 ]]; then
        printf 'cannot update the worker checkout\\n' >&2
      fi
      exit "\${status}"
      ;;
    upgrade)
      # Never really rewrite this checkout's .config.json (Issue #691).
      printf '%s\\0' "\$@" > "\${record_dir}/upgrade.args"
      exit "\${STUB_UPGRADE_EXIT:-0}"
      ;;
    log-dir)
      # Issue #873: the launcher asks where the logs go rather than spelling
      # it, and refuses to launch if the answer is missing or empty. The
      # harness resolves the same directory through the real \`resolveLogDir\`
      # and hands it in, so the stub agrees with \`harness.logDir\` by
      # construction rather than by a second copy of the precedence rules.
      printf '%s\\n' "\${VIBE_STUB_LOG_DIR}"
      exit 0
      ;;
    container-egress-probe)
      # Never really start a probe container (Issue #997): the test decides
      # what the probe found, and writes the evidence the launcher hands to
      # its outcome recorder. Intercepted unconditionally, like the checkout
      # update above - a real probe here would run the runtime stub and its
      # \`run\` record would be mistaken for the worker's own.
      printf '%s\\0' "\$@" > "\${record_dir}/container-egress-probe.args"
      prev=""
      for a in "\$@"; do
        if [[ "\${prev}" == "--out" ]]; then
          printf '%b\\n' "\${STUB_EGRESS_EVIDENCE:-Container egress probe: reachable}" > "\${a}"
        fi
        prev="\${a}"
      done
      exit "\${STUB_EGRESS_EXIT:-0}"
      ;;
    release-notice)
      # Never really reach GitHub for the new-release check (Issue #690):
      # the test decides what the check found, and how it failed.
      printf '%s\\0' "\$@" > "\${record_dir}/release-notice.args"
      if [[ -n "\${STUB_RELEASE_NOTICE_STDOUT:-}" ]]; then
        printf '%s\\n' "\${STUB_RELEASE_NOTICE_STDOUT}"
      fi
      # The account of a failure goes to stderr, exactly as the real command's
      # does - a configuration error, an unresolvable GitHub, an uncaught
      # throw (Issue #1020).
      if [[ -n "\${STUB_RELEASE_NOTICE_STDERR:-}" ]]; then
        printf '%s\\n' "\${STUB_RELEASE_NOTICE_STDERR}" >&2
      fi
      exit "\${STUB_RELEASE_NOTICE_EXIT:-0}"
      ;;${extraIntercepts}
  esac
done
for arg in "\$@"; do
  case "\${arg}" in
    container-image-prune)
      # Recorded, not intercepted: the prune still really runs against the
      # runtime stub, and a test can also read the arguments it was given -
      # which is how the plan's whole image dependency chain reaching
      # \`--keep\` is proven on both launchers (Issue #1059).
      printf '%s\\0' "\$@" > "\${record_dir}/container-image-prune.args"
      ;;
  esac
done
exec "\${VIBE_REAL_DENO}" "\$@"
`;
}

/** Deno's module cache, so the launcher's `--frozen` run stays offline. */
async function resolveDenoDir(): Promise<string> {
  const configured = Deno.env.get("DENO_DIR");
  if (configured) return configured;
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const info = JSON.parse(new TextDecoder().decode(output.stdout));
  return info.denoDir as string;
}

const DENO_DIR = await resolveDenoDir();
const DENO_BIN_DIR = Deno.execPath().replace(/\/[^/]+$/, "");

/** A host layout the launcher can legitimately expose, plus its stubs. */
export interface Harness {
  tmpDir: string;
  recordDir: string;
  env: Record<string, string>;
  /**
   * The host log directory the launcher will resolve for this harness — the
   * platform's own default under the fake HOME (Issue #873), asserted here
   * rather than spelled, so the expectation follows the resolver.
   */
  logDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Create a host layout the launcher can legitimately expose.
 *
 * @param extraEnv - Stub behaviour overrides (`STUB_RUN_EXIT`, …)
 * @param options - Set `credentials: false` to omit the credential directory;
 *   set `denoStub: true` to intercept the worker-driver and outcome-recording
 *   invocations instead of really performing them (Issue #4148)
 * @returns The harness, including the environment the launcher is run with
 */
export async function setupHarness(
  extraEnv: Record<string, string> = {},
  options: { credentials?: boolean; denoStub?: boolean } = {},
): Promise<Harness> {
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe_launcher_test_" });
  const home = `${tmpDir}/home`;
  const workDir = `${tmpDir}/work`;
  const credentialDir = `${tmpDir}/credentials`;
  const recordDir = `${tmpDir}/record`;
  const stubDir = `${tmpDir}/bin`;

  await Deno.mkdir(home, { recursive: true });
  await Deno.mkdir(recordDir, { recursive: true });
  await Deno.mkdir(stubDir, { recursive: true });

  if (options.credentials !== false) {
    await Deno.mkdir(`${credentialDir}/gh`, { recursive: true });
    await Deno.mkdir(`${credentialDir}/claude`, { recursive: true });
    await Deno.writeTextFile(
      `${credentialDir}/gh/hosts.yml`,
      "github.com:\n  oauth_token: test\n",
    );
    await Deno.writeTextFile(
      `${credentialDir}/claude/provider.env`,
      "ANTHROPIC_API_KEY=test\n",
    );
  }

  await Deno.writeTextFile(
    `${tmpDir}/config.json`,
    JSON.stringify({ repos: ["org/repo1"] }),
  );

  // Every runtime a supported platform probes resolves to the same stub, so
  // the test behaves identically on macOS (Apple container) and Linux
  // (Docker/Podman) hosts.
  for (const name of ["container", "docker", "podman"]) {
    const path = `${stubDir}/${name}`;
    await Deno.writeTextFile(path, RUNTIME_STUB);
    await Deno.chmod(path, 0o755);
  }

  // Always installed: the checkout update must never really run against this
  // repository (Issue #512). `denoStub` widens the same stub to the worker
  // driver and the outcome recorder.
  await Deno.writeTextFile(
    `${stubDir}/deno`,
    denoStubSource(options.denoStub === true),
  );
  await Deno.chmod(`${stubDir}/deno`, 0o755);

  const env: Record<string, string> = {
    PATH: `${stubDir}:${DENO_BIN_DIR}:${Deno.env.get("PATH") ?? ""}`,
    HOME: home,
    DENO_DIR,
    WORK_DIR: workDir,
    CONFIG_PATH: `${tmpDir}/config.json`,
    VIBE_CREDENTIAL_DIR: credentialDir,
    VIBE_STUB_RECORD: recordDir,
    VIBE_REAL_DENO: Deno.execPath(),
    ...extraEnv,
  };

  // What the `log-dir` stub answers (Issue #873). Resolved from the finished
  // environment — after `extraEnv`, so a test that overrides `LOG_DIR` moves
  // the stub's answer with it — and through the real `resolveLogDir`, so the
  // launcher and `harness.logDir` below cannot disagree. A second copy of the
  // precedence rules inside the shell stub would be a third place to keep in
  // step with `lib/log_dir.ts`.
  env.VIBE_STUB_LOG_DIR = resolveLogDir(
    home,
    (name) => env[name],
    pathStyleFor(home),
  );

  return {
    tmpDir,
    recordDir,
    env,
    // The launcher is run with `clearEnv`, so this reads exactly the
    // environment it will see — an override in `extraEnv` included.
    logDir: resolveLogDir(home, (name) => env[name], pathStyleFor(home)),
    cleanup: async () => {
      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch { /* best-effort */ }
    },
  };
}

/**
 * Path to one of the harness's stub executables (Issue #668).
 *
 * The stubs are normally reached through the launcher's `PATH`; a test that
 * asserts on a stub's own behaviour — that its readiness record really does
 * mean "ready to be signalled" — runs it directly instead.
 *
 * @param harness - The harness holding the stubs
 * @param name - Stub executable (`container`, `docker`, `podman`, `deno`)
 * @returns The absolute path to that stub
 */
export function stubPath(harness: Harness, name: string): string {
  return `${harness.tmpDir}/bin/${name}`;
}

/**
 * The argument list a recorded invocation carried.
 *
 * @param harness - The harness the launcher ran under
 * @param subCommand - Runtime sub-command (`run`, `build`, …)
 * @returns The recorded arguments, or null when it was never invoked
 */
export async function recorded(
  harness: Harness,
  subCommand: string,
): Promise<string[] | null> {
  try {
    const text = await Deno.readTextFile(
      `${harness.recordDir}/${subCommand}.args`,
    );
    return text.split("\0").filter((arg) => arg !== "");
  } catch {
    return null;
  }
}

/**
 * The log the launcher handed its outcome recorder (Issue #709).
 *
 * `--launch-log` is what turns an `image_build` escalation from "the image
 * could not be built" into the build's own diagnostics, so the content — not
 * merely the flag — is the behaviour worth asserting.
 *
 * @param harness - The harness the launcher ran under
 * @returns The log's contents, or null when none was handed over
 */
export async function recordedLaunchLog(
  harness: Harness,
): Promise<string | null> {
  try {
    return await Deno.readTextFile(`${harness.recordDir}/outcome-launch.log`);
  } catch {
    return null;
  }
}

/**
 * The phase marker the launcher last wrote (Issues #4072, #997).
 *
 * The marker is how a failure is attributed — `container_egress` and
 * `image_build` are the same exit status with completely different operator
 * actions — so a test asserting on attribution reads it here.
 *
 * @param harness - The harness the launcher ran under
 * @returns The marker's contents, or null when none was written
 */
export async function launchPhaseMarker(
  harness: Harness,
): Promise<string | null> {
  try {
    const text = await Deno.readTextFile(
      `${harness.tmpDir}/home/.vibe-coder/last-launch-phase`,
    );
    return text.trim();
  } catch {
    return null;
  }
}

/**
 * Runtime sub-commands in the order the launcher invoked them (Issue #492).
 *
 * @param harness - Launcher harness to read from
 * @returns One entry per runtime invocation, oldest first
 */
export async function invocationOrder(harness: Harness): Promise<string[]> {
  try {
    const raw = await Deno.readTextFile(`${harness.recordDir}/order.log`);
    return raw.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Deno sub-commands in the order the launcher invoked them (Issue #512).
 *
 * @param harness - Launcher harness to read from
 * @returns One entry per recognised Deno invocation, oldest first
 */
export async function denoInvocationOrder(
  harness: Harness,
): Promise<string[]> {
  try {
    const raw = await Deno.readTextFile(`${harness.recordDir}/deno-order.log`);
    return raw.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * True when the launcher healed the runtime's builder (Issue #4441).
 *
 * Apple container restarts its builder VM (`builder stop` + `builder start`);
 * Docker and Podman prune the build cache (`builder prune -f`). Either is the
 * heal for the runtime the launch plan chose on this host, so a launcher test
 * asserting on the heal passes on macOS and Linux alike.
 *
 * @param harness - The harness the launcher ran under
 * @returns True when a builder restart or prune was recorded
 */
export async function builderHealed(harness: Harness): Promise<boolean> {
  return await recorded(harness, "builder-start") !== null ||
    await recorded(harness, "builder-prune") !== null;
}

/**
 * Image references the launcher's prune removed (Issue #4162).
 *
 * @param harness - The harness the launcher ran under
 * @returns The references removed, in the order they were removed
 */
export async function removedImages(harness: Harness): Promise<string[]> {
  try {
    const text = await Deno.readTextFile(
      `${harness.recordDir}/image-removed.lines`,
    );
    return text.split("\n").map((line) => line.trim()).filter((line) =>
      line !== ""
    );
  } catch {
    return [];
  }
}

/**
 * Permission bits of the container-stderr capture FIFO (Issue #1299).
 *
 * The FIFO carries every byte the runtime client writes to stderr, and a
 * second reader on it both discloses that stream and consumes bytes the
 * capture never sees — so its mode is behaviour, not housekeeping. Recorded
 * by the runtime stub while the run is in flight, because the launcher
 * removes the FIFO on the way out.
 *
 * Point the launcher at a private `TMPDIR` before calling this: the stub
 * globs that directory, so a shared `/tmp` would also report FIFOs belonging
 * to other runs.
 *
 * @param harness - The harness the launcher ran under
 * @returns One octal mode per capture FIFO seen, e.g. `["600"]`
 */
export async function runErrFifoModes(harness: Harness): Promise<string[]> {
  try {
    const text = await Deno.readTextFile(
      `${harness.recordDir}/run-err-fifo.mode`,
    );
    return text.split("\n").map((line) => line.trim()).filter((line) =>
      line !== ""
    );
  } catch {
    return [];
  }
}

/**
 * Named volumes the launcher deleted (Issues #229, #478).
 *
 * @param harness - The harness the launcher ran under
 * @returns The volume names removed, in the order they were removed
 */
export async function removedVolumes(harness: Harness): Promise<string[]> {
  try {
    const text = await Deno.readTextFile(
      `${harness.recordDir}/volume-removed.lines`,
    );
    return text.split("\n").map((line) => line.trim()).filter((line) =>
      line !== ""
    );
  } catch {
    return [];
  }
}

/**
 * How many times the launcher ran the volume init (Issue #478).
 *
 * @param harness - The harness the launcher ran under
 * @returns The init count, or 0 when the init never ran
 */
export async function initCount(harness: Harness): Promise<number> {
  try {
    const text = await Deno.readTextFile(`${harness.recordDir}/run-init.count`);
    return Number(text.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * How many image builds the launcher ran (Issue #4441).
 *
 * @param harness - The harness the launcher ran under
 * @returns The build count, or 0 when no build was attempted
 */
export async function buildCount(harness: Harness): Promise<number> {
  try {
    const text = await Deno.readTextFile(`${harness.recordDir}/build.count`);
    return Number(text.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Declare a private container extension for a harness (Issue #980).
 *
 * Writes the operator's extension directory — outside the harness home, as the
 * containment rule requires — and rewrites the deployment's `.config.json` to
 * declare it. Shared by both launcher suites so `run.sh` and `run.ps1` are
 * exercised against exactly the same deployment.
 *
 * @param harness - The harness to configure
 * @param options - Containerfile text (defaults to a conforming layer) and an
 *   optional `start` script path relative to the extension directory
 * @returns The extension directory the declaration names
 */
export async function declareContainerExtension(
  harness: Harness,
  options: { containerfile?: string; start?: string } = {},
): Promise<string> {
  const directory = `${harness.tmpDir}/extension`;
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    `${directory}/Containerfile`,
    options.containerfile ??
      "ARG VIBE_BASE_IMAGE\nFROM ${VIBE_BASE_IMAGE}\nRUN true\n",
  );
  if (options.start) {
    await Deno.writeTextFile(
      `${directory}/${options.start}`,
      "#!/bin/bash\nexit 0\n",
    );
  }
  await Deno.writeTextFile(
    `${harness.tmpDir}/config.json`,
    JSON.stringify({
      repos: ["org/repo1"],
      container_extension: {
        path: directory,
        ...(options.start ? { start: options.start } : {}),
      },
    }),
  );
  return directory;
}

/**
 * One build's own argument list (Issue #980).
 *
 * A deployment that configures a `container_extension` is built twice — the
 * standard image, then the operator's layer `FROM` it — and the order is the
 * behaviour under test, which the last-one-wins `build.args` cannot show.
 *
 * @param harness - The harness the launcher ran under
 * @param ordinal - Which build, 1-based in invocation order
 * @returns The recorded arguments, or null when that build never ran
 */
export function recordedBuild(
  harness: Harness,
  ordinal: number,
): Promise<string[] | null> {
  return recorded(harness, `build-${ordinal}`);
}

/**
 * The lines the launcher appended to the worker's host log (Issue #4441).
 *
 * @param harness - The harness the launcher ran under
 * @returns The `run_core.log` contents, or an empty string when there is none
 */
export async function runCoreLog(harness: Harness): Promise<string> {
  try {
    return await Deno.readTextFile(`${harness.logDir}/run_core.log`);
  } catch {
    return "";
  }
}

/**
 * Where the launcher preserves a failed build's own output (Issue #1019).
 *
 * Derived from `harness.logDir` rather than spelled out, so it follows the
 * launcher wherever the log directory resolves to. It was written as
 * `<tmp>/home/logs` back when `$HOME/logs` was the only answer; once Issue
 * #873 moved the default onto the platform's own location, run.sh preserved
 * logs where it was told to and this helper went on reading the old path,
 * reporting every kept log as missing.
 *
 * @param harness - The harness the launcher ran under
 * @returns The preserved build-failure log directory
 */
export function buildFailureLogDir(harness: Harness): string {
  return `${harness.logDir}/build-failures`;
}

/**
 * The preserved build-failure logs, oldest first (Issue #1019).
 *
 * The filenames lead with a UTC stamp, so their lexical order is also their
 * chronological order — which is what the launcher's own retention pass
 * relies on when it drops the oldest.
 *
 * @param harness - The harness the launcher ran under
 * @returns The file names, oldest first, or an empty list when none was kept
 */
export async function buildFailureLogs(harness: Harness): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(buildFailureLogDir(harness))) {
      if (entry.isFile) names.push(entry.name);
    }
  } catch {
    return [];
  }
  return names.sort();
}

/**
 * Mount values (`src:dst[:ro]`) in a recorded invocation.
 *
 * @param args - A recorded argument list
 * @returns The mount values, in the order they were passed
 */
export function mountValues(args: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--volume" || args[i] === "--mount") {
      values.push(args[i + 1] ?? "");
    }
  }
  return values;
}

/** How one launcher is invoked on this host. */
export interface LauncherInvocation {
  /** Display name used in test names and failure messages. */
  name: string;
  /** Interpreter to run. */
  command: string;
  /** Arguments that make the interpreter run the launcher. */
  args: string[];
}

/** `run.sh`, run through bash. */
export const BASH_LAUNCHER: LauncherInvocation = {
  name: "run.sh",
  command: "bash",
  args: [`${REPO_ROOT}/run.sh`],
};

/**
 * The PowerShell executable, or null when this host has none.
 *
 * Only `pwsh`: `run.ps1` is PowerShell 7 script, so falling back to Windows
 * PowerShell 5.1 under the name `powershell` would run it and fail, which
 * reads as a launcher bug rather than a host without the interpreter.
 */
export const PWSH: string | null = await resolvePowerShell(["pwsh"]);

/** `run.ps1`, run through PowerShell — null when PowerShell is absent. */
export const POWERSHELL_LAUNCHER: LauncherInvocation | null = PWSH
  ? {
    name: "run.ps1",
    command: PWSH,
    args: ["-NoProfile", "-NonInteractive", "-File", `${REPO_ROOT}/run.ps1`],
  }
  : null;

/** What a launcher run reported. */
export interface LaunchOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Start a launcher under the harness.
 *
 * @param harness - The harness providing the environment and stubs
 * @param launcher - Which launcher to run
 * @returns The running child process
 */
export function spawnLauncher(
  harness: Harness,
  launcher: LauncherInvocation,
): Deno.ChildProcess {
  return new Deno.Command(launcher.command, {
    args: launcher.args,
    cwd: REPO_ROOT,
    env: harness.env,
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

/**
 * Run a launcher to completion under the harness.
 *
 * @param harness - The harness providing the environment and stubs
 * @param launcher - Which launcher to run
 * @returns Its exit status and output
 */
export async function runLauncher(
  harness: Harness,
  launcher: LauncherInvocation,
): Promise<LaunchOutcome> {
  const output = await spawnLauncher(harness, launcher).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/**
 * Wait until the stub has recorded a sub-command, or give up.
 *
 * @param harness - The harness the launcher ran under
 * @param subCommand - Runtime sub-command to wait for
 * @param timeoutMs - How long to wait before giving up
 * @returns True when the sub-command was recorded in time
 */
export async function waitForRecord(
  harness: Harness,
  subCommand: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await recorded(harness, subCommand)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
