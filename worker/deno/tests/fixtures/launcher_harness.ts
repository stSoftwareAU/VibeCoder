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
printf '%s\\0' "\$@" > "\${record_dir}/\${sub}.args"
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
  volume-*)
    exit 0
    ;;
  run-init)
    # Issue #478: the init reports machine-readable volume verdicts on stdout
    # (\`VOLUME_UNREPAIRABLE\`, \`VOLUME_TRIM_REFUSED\`); tests drive them here.
    # The same verdict is returned on every init in a test, which is what a
    # runtime that cannot discard actually does.
    if [[ -n "\${STUB_INIT_STDOUT:-}" ]]; then
      printf '%s\\n' "\${STUB_INIT_STDOUT}"
    fi
    exit "\${STUB_INIT_EXIT:-0}"
    ;;
  run)
    if [[ -n "\${STUB_RUN_SLEEP:-}" ]]; then
      # Streams detached: when this stub is SIGKILLed (the watchdog path of
      # Issue #4173) the orphaned sleep must not hold the launcher's stdout
      # pipe open and stall the test reading it.
      sleep "\${STUB_RUN_SLEEP}" >/dev/null 2>&1 &
      sleep_pid=\$!
      # Kill the sleep on the way out: an orphan holding the inherited
      # stdout pipe open would stall the test that spawned the launcher.
      trap 'kill "\${sleep_pid}" 2>/dev/null; printf "terminated" > "\${record_dir}/terminated"; exit "\${STUB_RUN_SIGNAL_EXIT:-143}"' TERM
      wait "\${sleep_pid}"
    fi
    exit "\${STUB_RUN_EXIT:-0}"
    ;;
  builder-*)
    printf '%s\\0' "\$@" > "\${record_dir}/\${sub}.args"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;

/**
 * A partial stand-in for Deno on the launcher's PATH (Issue #4148).
 *
 * Everything the launcher asks Deno is answered by the real binary — the
 * run-mode resolution and the launch plan stay genuine — except the two
 * invocations a test must not actually perform: `run-entrypoint`, which would
 * start the whole worker on this host, and `container-restart-backoff`, the
 * outcome record. Both are recorded instead, so a test can assert the launcher
 * made them.
 */
const DENO_STUB = `#!/bin/bash
set -u
record_dir="\${VIBE_STUB_RECORD}"
mkdir -p "\${record_dir}"
for arg in "\$@"; do
  case "\${arg}" in
    run-entrypoint)
      printf '%s\\0' "\$@" > "\${record_dir}/run-entrypoint.args"
      if [[ -n "\${STUB_ENTRYPOINT_SLEEP:-}" ]]; then
        sleep "\${STUB_ENTRYPOINT_SLEEP}" &
        sleep_pid=\$!
        # Kill the sleep on the way out: an orphan holding the inherited
        # stdout pipe open would stall the test that spawned the launcher.
        trap 'kill "\${sleep_pid}" 2>/dev/null; printf "terminated" > "\${record_dir}/entrypoint-terminated"; exit "\${STUB_ENTRYPOINT_SIGNAL_EXIT:-143}"' TERM
        wait "\${sleep_pid}"
      fi
      exit "\${STUB_ENTRYPOINT_EXIT:-0}"
      ;;
    container-restart-backoff)
      printf '%s\\0' "\$@" > "\${record_dir}/container-restart-backoff.args"
      echo 60
      exit 0
      ;;
  esac
done
exec "\${VIBE_REAL_DENO}" "\$@"
`;

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

  if (options.denoStub) {
    await Deno.writeTextFile(`${stubDir}/deno`, DENO_STUB);
    await Deno.chmod(`${stubDir}/deno`, 0o755);
  }

  return {
    tmpDir,
    recordDir,
    env: {
      PATH: `${stubDir}:${DENO_BIN_DIR}:${Deno.env.get("PATH") ?? ""}`,
      HOME: home,
      DENO_DIR,
      WORK_DIR: workDir,
      CONFIG_PATH: `${tmpDir}/config.json`,
      VIBE_CREDENTIAL_DIR: credentialDir,
      VIBE_STUB_RECORD: recordDir,
      VIBE_REAL_DENO: Deno.execPath(),
      ...extraEnv,
    },
    cleanup: async () => {
      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch { /* best-effort */ }
    },
  };
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
 * The lines the launcher appended to the worker's host log (Issue #4441).
 *
 * @param harness - The harness the launcher ran under
 * @returns The `run_core.log` contents, or an empty string when there is none
 */
export async function runCoreLog(harness: Harness): Promise<string> {
  try {
    return await Deno.readTextFile(
      `${harness.tmpDir}/home/logs/run_core.log`,
    );
  } catch {
    return "";
  }
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

/** Resolve PowerShell, which is not installed on every developer host. */
async function resolvePowerShell(): Promise<string | null> {
  for (const candidate of [Deno.env.get("VIBE_PWSH"), "pwsh"]) {
    if (!candidate) continue;
    try {
      const output = await new Deno.Command(candidate, {
        args: ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
        stdout: "null",
        stderr: "null",
      }).output();
      if (output.success) return candidate;
    } catch { /* not installed — try the next candidate */ }
  }
  return null;
}

/** The PowerShell executable, or null when this host has none. */
export const PWSH: string | null = await resolvePowerShell();

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
