/**
 * Containment integration tests (Issue #4071, parent #4060).
 *
 * Every other container test asserts on *arguments*: what the launcher would
 * ask the runtime to do. These tests start the real container from a real
 * launch plan and ask the container itself what it can reach, so a launcher or
 * image change that makes a prohibited host path, a container-runtime control
 * socket, or the host home directory reachable fails here rather than on an
 * unattended host. Issue #3643 — an agent subprocess slipping past the `gh`
 * write allowlist — is why the boundary has to be enforced (and tested) at the
 * OS level rather than asserted by prompts or application policy.
 *
 * ## How the probe works
 *
 * 1. A throwaway *host* fixture is built under a temporary directory: a
 *    synthetic home carrying the material the container must never see
 *    (`Documents`, `Desktop`, `Pictures`, `.ssh`, `Library/Keychains`, and a
 *    canary file), the four intended mount sources, and a checkout.
 * 2. `buildContainerLaunchPlan` produces the real plan for that fixture — the
 *    same function `run.sh` and `run.ps1` drive.
 * 3. The plan's own `runArgs` are executed with only the *process* replaced
 *    (`--entrypoint bash`), so every mount and privilege flag under test is
 *    the one the launcher produced. The probe script reads its work list from
 *    a table inside the mounted checkout — nothing is interpolated into shell.
 * 4. Each table row comes back as one `id verdict detail` line and is asserted
 *    in its own test step, so a failure names exactly what became reachable.
 *
 * ## When it runs
 *
 * Real containers need a real runtime. The tests skip — loudly, naming the
 * reason — when no supported runtime answers its probe or the image is not
 * present locally. `.github/workflows/container-build.yml` sets
 * `VIBE_CONTAINMENT_REQUIRED=1`, which turns that skip into a failure, so the
 * suite cannot be silently skipped everywhere.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildContainerLaunchPlan,
  type ContainerLaunchPlan,
  containerTargetPaths,
  FORBIDDEN_RUN_FLAGS,
  resolveContainerLaunchHostPaths,
  SCRATCH_TMPFS_MOUNTS,
  scratchTmpfsMounts,
  SECRETS_MOUNT_PATH,
} from "../lib/container_launch.ts";
import {
  CONTAINER_RUNTIMES,
  type ContainerRuntimeDescriptor,
  ContainerRuntimeUnavailableError,
  detectContainerRuntime,
  UnsupportedHostPlatformError,
} from "../lib/container_runtime.ts";
import {
  type ContainerManifest,
  parseContainerManifest,
} from "../lib/container_manifest.ts";
import { resolveContainerImageReference } from "../lib/container_image_hash.ts";
import { activeAgentProvider } from "../lib/agent_provider.ts";
import { GH_CREDENTIAL_SUBDIR } from "../lib/credential_preflight.ts";

const REPO_ROOT = new URL(import.meta.url).pathname.replace(
  /\/worker\/deno\/tests\/[^/]+$/,
  "",
);

/** The repository's real manifest — the source of the in-container layout. */
const MANIFEST: ContainerManifest = parseContainerManifest(
  await Deno.readTextFile(`${REPO_ROOT}/container/tools.json`),
);

/** Longest a runtime invocation may take before it is treated as wedged. */
const RUN_TIMEOUT_MS = 90_000;

/** Longest a read-only runtime query may take. */
const QUERY_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Runtime invocation
// ---------------------------------------------------------------------------

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a container-runtime command with a bounded wait.
 *
 * @param executable - Runtime executable
 * @param args - Arguments to pass
 * @param timeoutMs - Wait before the invocation is abandoned
 * @returns Exit code and captured output
 */
async function runRuntime(
  executable: string,
  args: string[],
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<CommandResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const output = await new Deno.Command(executable, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).output();
    const decoder = new TextDecoder();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `\`${executable} ${args.join(" ")}\` did not finish within ${
          timeoutMs / 1000
        }s`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Runtime + image resolution (the skip decision)
// ---------------------------------------------------------------------------

/** Everything a containment run needs. */
interface ContainmentContext {
  descriptor: ContainerRuntimeDescriptor;
  image: string;
}

/** Either a usable context or the reason there is none. */
type ContainmentResolution =
  | { ready: true; context: ContainmentContext }
  | { ready: false; reason: string };

/** True when CI demands these tests actually run. */
function containmentRequired(): boolean {
  const flag = Deno.env.get("VIBE_CONTAINMENT_REQUIRED")?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

/**
 * Resolve the runtime and image, or the reason the tests cannot run.
 *
 * The image is never built here: building is minutes of work that belongs to
 * the launcher and to CI, not to a unit-test run.
 */
async function resolveContainment(): Promise<ContainmentResolution> {
  let descriptor: ContainerRuntimeDescriptor;
  try {
    descriptor = await detectContainerRuntime();
  } catch (error) {
    if (
      error instanceof ContainerRuntimeUnavailableError ||
      error instanceof UnsupportedHostPlatformError
    ) {
      return {
        ready: false,
        reason: `no supported container runtime is available on this host ` +
          `(${error.message.split("\n")[0]})`,
      };
    }
    throw error;
  }

  const image = Deno.env.get("VIBE_CONTAINMENT_IMAGE")?.trim() ||
    await resolveContainerImageReference(REPO_ROOT);
  const inspect = await runRuntime(
    descriptor.executable,
    [...descriptor.dialect.imageInspectArgs, image],
    QUERY_TIMEOUT_MS,
  );
  if (inspect.code !== 0) {
    return {
      ready: false,
      reason: `the container image ${image} is not present for ` +
        `${descriptor.displayName} — build it with ./run.sh, or set ` +
        `VIBE_CONTAINMENT_IMAGE to an image that is`,
    };
  }

  return { ready: true, context: { descriptor, image } };
}

const RESOLUTION = await resolveContainment();

if (!RESOLUTION.ready && !containmentRequired()) {
  console.log(
    `container containment tests skipped: ${RESOLUTION.reason}. ` +
      `They run for real in .github/workflows/container-build.yml, where ` +
      `VIBE_CONTAINMENT_REQUIRED=1 turns this skip into a failure.`,
  );
}

// ---------------------------------------------------------------------------
// The in-container probe
// ---------------------------------------------------------------------------

/** What a single table row asks the container to check. */
type ProbeKind = "absent" | "socket" | "rw" | "ro-file" | "ro-dir" | "canary";

/** One row of the probe table. */
interface Probe {
  kind: ProbeKind;
  /** Stable identifier, used as the assertion's name. */
  id: string;
  /** Path (or, for a canary, the file name) to probe. */
  target: string;
  /** What the probe proves, quoted in the failure message. */
  why: string;
}

/** What the container reported for one probe. */
interface ProbeResult {
  verdict: string;
  detail: string;
}

/**
 * The probe script, run inside the container.
 *
 * Deliberately free of `${...}` expansion so it survives being carried in a
 * TypeScript template literal unescaped, and free of interpolation so no
 * fixture path is ever spliced into shell — the work list arrives as a
 * tab-separated table inside the mounted checkout.
 */
const PROBE_SCRIPT = `#!/bin/bash
set -u

if [ "$#" -ne 1 ]; then
  echo "usage: containment-probe.sh <probe-table>" >&2
  exit 1
fi

table="$1"

if [ ! -r "$table" ]; then
  echo "containment probe table missing or unreadable at $table" >&2
  exit 1
fi

report() {
  printf '%s\\t%s\\t%s\\n' "$1" "$2" "$3"
}

# Absent, or present but unreadable, both count as contained; a readable
# path is the regression these tests exist to catch.
probe_absent() {
  id="$1"
  path="$2"
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    report "$id" absent "$path"
  elif [ -d "$path" ]; then
    if ls -A -- "$path" > /dev/null 2>&1; then
      report "$id" readable "$path"
    else
      report "$id" unreadable "$path"
    fi
  elif head -c 1 -- "$path" > /dev/null 2>&1; then
    report "$id" readable "$path"
  else
    report "$id" unreadable "$path"
  fi
}

# A runtime control socket may not be present at all: its mere existence is
# an escape route the moment its permissions change.
probe_socket() {
  if [ -e "$2" ] || [ -L "$2" ]; then
    report "$1" present "$2"
  else
    report "$1" absent "$2"
  fi
}

probe_rw() {
  id="$1"
  path="$2"
  if [ ! -d "$path" ]; then
    report "$id" missing "$path"
    return
  fi
  file="$path/containment-probe-$id.txt"
  if ( printf '%s\\n' "$id" > "$file" ) 2>/dev/null &&
    [ "$(cat -- "$file" 2>/dev/null)" = "$id" ]; then
    report "$id" writable "$file"
  else
    report "$id" not-writable "$path"
  fi
}

probe_ro_file() {
  id="$1"
  path="$2"
  if [ ! -f "$path" ]; then
    report "$id" missing "$path"
    return
  fi
  if ! first="$(head -n 1 -- "$path" 2>/dev/null)"; then
    report "$id" unreadable "$path"
    return
  fi
  if ( printf '\\n' >> "$path" ) 2>/dev/null; then
    report "$id" writable "$first"
  else
    report "$id" readable-immutable "$first"
  fi
}

probe_ro_dir() {
  id="$1"
  path="$2"
  if [ ! -d "$path" ]; then
    report "$id" missing "$path"
    return
  fi
  if ! entries="$(ls -A -- "$path" 2>/dev/null)"; then
    report "$id" unreadable "$path"
    return
  fi
  entries="$(printf '%s' "$entries" | tr '\\n' ',')"
  probe="$path/containment-write-probe"
  if ( : > "$probe" ) 2>/dev/null; then
    rm -f -- "$probe" 2>/dev/null
    report "$id" writable "$entries"
  else
    report "$id" readable-immutable "$entries"
  fi
}

# The image filesystem is searched with -xdev; the mounts are searched
# explicitly, so a canary carried in by any of them is still found. Both
# searches are bounded, and a search that runs out of time is reported as
# such rather than passing for the want of an answer (Issue #3234).
probe_canary() {
  id="$1"
  name="$2"
  hit="$(timeout 45 find / -xdev -name "$name" -print -quit 2>/dev/null)"
  if [ "$?" -eq 124 ]; then
    report "$id" search-timed-out /
    return
  fi
  if [ -z "$hit" ]; then
    hit="$(timeout 20 find /workspace /home /tmp -name "$name" -print -quit 2>/dev/null)"
    if [ "$?" -eq 124 ]; then
      report "$id" search-timed-out "the mounted paths"
      return
    fi
  fi
  if [ -n "$hit" ]; then
    report "$id" found "$hit"
  else
    report "$id" not-found "$name"
  fi
}

status=0
while IFS=$'\\t' read -r kind id target; do
  case "$kind" in
    "") continue ;;
    absent) probe_absent "$id" "$target" ;;
    socket) probe_socket "$id" "$target" ;;
    rw) probe_rw "$id" "$target" ;;
    ro-file) probe_ro_file "$id" "$target" ;;
    ro-dir) probe_ro_dir "$id" "$target" ;;
    canary) probe_canary "$id" "$target" ;;
    *)
      echo "unknown containment probe kind: $kind" >&2
      status=1
      ;;
  esac
done < "$table"

exit "$status"
`;

// ---------------------------------------------------------------------------
// The host fixture
// ---------------------------------------------------------------------------

/** The throwaway host layout a containment run is driven from. */
interface HostFixture {
  root: string;
  home: string;
  checkout: string;
  workDir: string;
  logDir: string;
  configFile: string;
  credentialDir: string;
  /** Basename of the canary planted in the synthetic host home. */
  canaryName: string;
  /** Full host path of that canary. */
  canaryPath: string;
  /** Canary planted beside the fixture, outside the synthetic home. */
  rootCanaryPath: string;
  /** Token carried by the read-only configuration file. */
  configToken: string;
  /** Per-run throwaway volume names (Issue #4186), removed on teardown. */
  volumeNames: string[];
  plan: ContainerLaunchPlan;
}

/** The operator's custom prompt template the fixture plants (Issue #850). */
const CUSTOM_PROMPT_PROBE_FILE = "containment-probe-prompt.md";

/** Create a directory every user can traverse (the container runs as uid 1000). */
async function makeSharedDir(path: string, mode = 0o755): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
  await Deno.chmod(path, mode);
}

/**
 * Build the throwaway host layout and the launch plan that exposes it.
 *
 * The synthetic home means no operator file is ever mounted, written to, or
 * probed for real, while the plan under test is byte-for-byte the one the
 * launcher builds for a genuine home.
 */
async function buildHostFixture(
  context: ContainmentContext,
  token: string,
): Promise<HostFixture> {
  const root = await Deno.makeTempDir({ prefix: "vibe-containment-" });
  await Deno.chmod(root, 0o755);

  const home = `${root}/home`;
  const checkout = `${root}/checkout`;
  const provider = activeAgentProvider();

  // Host material the container must never see.
  for (const directory of ["Documents", "Desktop", "Pictures", ".ssh"]) {
    await makeSharedDir(`${home}/${directory}`);
  }
  await makeSharedDir(`${home}/Library/Keychains`);
  await Deno.writeTextFile(`${home}/.ssh/id_rsa`, "PRIVATE KEY FIXTURE\n");
  await Deno.writeTextFile(
    `${home}/Library/Keychains/login.keychain-db`,
    "KEYCHAIN FIXTURE\n",
  );

  const canaryName = `vibe-host-home-canary-${token}.txt`;
  const canaryPath = `${home}/Documents/${canaryName}`;
  await Deno.writeTextFile(canaryPath, `canary ${token}\n`);

  const rootCanaryPath = `${root}/vibe-host-root-canary-${token}.txt`;
  await Deno.writeTextFile(rootCanaryPath, `canary ${token}\n`);

  // The intended mounts. World-writable read/write sources and world-writable
  // read-only sources, so a mode assertion can only be answered by the mount
  // flag rather than by host ownership (the container user is uid 1000, the
  // CI runner is not).
  const workDir = `${home}/auto-issue-work`;
  const logDir = `${home}/logs`;
  await makeSharedDir(workDir, 0o777);
  await makeSharedDir(logDir, 0o777);

  const credentialDir = `${home}/.vibe-coder/credentials`;
  await makeSharedDir(credentialDir);
  for (const subdir of [GH_CREDENTIAL_SUBDIR, provider.credentials.subdir]) {
    await makeSharedDir(`${credentialDir}/${subdir}`, 0o777);
    await Deno.writeTextFile(
      `${credentialDir}/${subdir}/${token}.credential`,
      `credential fixture ${token}\n`,
    );
  }

  // World-writable, and with a `.git` of its own: the checkout mount is
  // read-only (Issue #514), and only the mount flag — never host ownership —
  // may be what makes the container's write probe fail.
  await makeSharedDir(checkout, 0o777);
  await makeSharedDir(`${checkout}/.git`, 0o777);
  await Deno.writeTextFile(`${checkout}/.git/HEAD`, "ref: refs/heads/main\n");
  await Deno.chmod(`${checkout}/.git/HEAD`, 0o666);
  const configToken = `config-${token}`;
  const configFile = `${checkout}/.config.json`;
  await Deno.writeTextFile(
    configFile,
    `{"containment_probe": "${configToken}"}\n`,
  );
  await Deno.chmod(configFile, 0o666);

  const hostPaths = resolveContainerLaunchHostPaths(
    checkout,
    (name) => (name === "HOME" ? home : undefined),
  );

  // The launcher stages the config into its own read-only directory (Apple
  // container cannot mount a single file) — mirror that here so the mounted
  // stage dir carries the probe token the config assertions read.
  await makeSharedDir(hostPaths.configStageDir, 0o777);
  await Deno.copyFile(configFile, `${hostPaths.configStageDir}/.config.json`);
  await Deno.chmod(`${hostPaths.configStageDir}/.config.json`, 0o666);

  // Per-run throwaway volumes (Issue #4186): the real fixed names belong to
  // the production worker on this host — a test must never write into, or
  // delete, its clones and approval snapshots.
  const volumes = {
    work: `vibe-test-work-${token}`,
    approvalState: `vibe-test-approval-${token}`,
  };

  // An operator's custom prompt directory (Issue #850): world-writable on the
  // host, so only the mount flag can make the write probe inside the container
  // fail. Outside the synthetic home, which the allowlist would refuse.
  const customPromptDir = `${root}/custom-prompts`;
  await makeSharedDir(customPromptDir, 0o777);
  const customPromptFile = `${customPromptDir}/${CUSTOM_PROMPT_PROBE_FILE}`;
  await Deno.writeTextFile(customPromptFile, `custom prompt ${token}\n`);
  await Deno.chmod(customPromptFile, 0o666);

  const plan = buildContainerLaunchPlan({
    descriptor: context.descriptor,
    manifest: MANIFEST,
    image: context.image,
    containerName: `vibe-containment-${token}`,
    watchdogSeconds: 11_400,
    hostPaths,
    volumes,
    customPromptPaths: [customPromptFile],
  });

  // The volume lifecycle, exactly as run.sh performs it: create what is
  // absent, then the root ownership init. Without the init the work-directory
  // rw probe would fail on a root-owned volume, so a launcher change that
  // drops the init fails here too.
  for (const name of plan.volumes) {
    const created = await runRuntime(
      context.descriptor.executable,
      ["volume", "create", name],
      QUERY_TIMEOUT_MS,
    );
    if (created.code !== 0) {
      throw new Error(
        `Could not create the throwaway volume ${name}: ${created.stderr}`,
      );
    }
  }
  const initialised = await runRuntime(
    context.descriptor.executable,
    plan.initArgs,
  );
  if (initialised.code !== 0) {
    throw new Error(
      `The volume-ownership init failed (exit ${initialised.code}):\n` +
        initialised.stderr,
    );
  }

  return {
    root,
    home,
    checkout,
    workDir: hostPaths.workDir,
    logDir: hostPaths.logDir,
    configFile: hostPaths.configFile,
    credentialDir: hostPaths.credentialDir,
    canaryName,
    canaryPath,
    rootCanaryPath,
    configToken,
    volumeNames: plan.volumes,
    plan,
  };
}

// ---------------------------------------------------------------------------
// The probe table
// ---------------------------------------------------------------------------

/** Prohibited host locations, each probed under its own identifier. */
function prohibitedProbes(fixture: HostFixture): Probe[] {
  const containerHome = `/home/${MANIFEST.user.name}`;
  const operatorHome = Deno.env.get("HOME")?.trim();
  const probes: Probe[] = [];

  const add = (id: string, target: string, why: string) =>
    probes.push({ kind: "absent", id, target, why });

  // The synthetic host home the launch plan was built from.
  add("host-home", fixture.home, "the host home directory is not mounted");
  add("host-documents", `${fixture.home}/Documents`, "~/Documents");
  add("host-desktop", `${fixture.home}/Desktop`, "~/Desktop");
  add("host-pictures", `${fixture.home}/Pictures`, "~/Pictures");
  add("host-ssh", `${fixture.home}/.ssh`, "the operator's ~/.ssh");
  add("host-library", `${fixture.home}/Library`, "the macOS ~/Library");
  add(
    "host-keychain",
    `${fixture.home}/Library/Keychains`,
    "macOS Keychain material",
  );

  // The same locations as the container's own HOME spells them: a home
  // mounted onto /home/vibe would show up here rather than above.
  add("container-home-documents", `${containerHome}/Documents`, "~/Documents");
  add("container-home-desktop", `${containerHome}/Desktop`, "~/Desktop");
  add("container-home-pictures", `${containerHome}/Pictures`, "~/Pictures");
  add("container-home-ssh", `${containerHome}/.ssh`, "the operator's ~/.ssh");
  add("container-home-library", `${containerHome}/Library`, "the ~/Library");

  // The host root filesystem outside the mounted paths.
  add("host-fixture-root", fixture.root, "the host path above the mounts");
  add(
    "host-checkout-path",
    fixture.checkout,
    "the checkout at its host path (it is mounted at /workspace only)",
  );
  add(
    "host-root-canary",
    fixture.rootCanaryPath,
    "a host file beside the fixture, outside every mount",
  );

  if (operatorHome && operatorHome !== fixture.home) {
    add("operator-home", operatorHome, "the real operator home directory");
    add("operator-ssh", `${operatorHome}/.ssh`, "the real operator's ~/.ssh");
    add(
      "operator-library",
      `${operatorHome}/Library`,
      "the real operator's ~/Library",
    );
  }

  return probes;
}

/** Container-runtime control sockets, each probed under its own identifier. */
function socketProbes(): Probe[] {
  const operatorHome = Deno.env.get("HOME")?.trim();
  const runtimeDir = Deno.env.get("XDG_RUNTIME_DIR")?.trim();
  const probes: Probe[] = [
    ["docker-socket-var-run", "/var/run/docker.sock", "the Docker socket"],
    ["docker-socket-run", "/run/docker.sock", "the Docker socket"],
    ["podman-socket-run", "/run/podman/podman.sock", "the Podman socket"],
    [
      "podman-socket-var-run",
      "/var/run/podman/podman.sock",
      "the Podman socket",
    ],
    [
      "podman-socket-user",
      `/run/user/${MANIFEST.user.uid}/podman/podman.sock`,
      "the rootless Podman socket",
    ],
    [
      "apple-container-socket-var-run",
      "/var/run/container.sock",
      "the Apple container control socket",
    ],
    [
      "apple-container-socket-run",
      "/run/container.sock",
      "the Apple container control socket",
    ],
  ].map(([id, target, why]) => ({
    kind: "socket" as const,
    id: id!,
    target: target!,
    why: why!,
  }));

  if (operatorHome) {
    probes.push({
      kind: "socket",
      id: "apple-container-control-socket",
      target:
        `${operatorHome}/Library/Application Support/com.apple.container/container.sock`,
      why: "the Apple container control socket in the operator's Library",
    });
  }
  if (runtimeDir) {
    probes.push({
      kind: "socket",
      id: "podman-socket-xdg",
      target: `${runtimeDir}/podman/podman.sock`,
      why: "the Podman socket under XDG_RUNTIME_DIR",
    });
  }
  return probes;
}

/** The four intended mounts, and the canary search. */
function mountProbes(fixture: HostFixture): Probe[] {
  const targets = containerTargetPaths(MANIFEST);
  const provider = activeAgentProvider();
  return [
    {
      kind: "rw",
      id: "work-directory",
      target: targets.work,
      why: "the work directory is mounted read/write",
    },
    {
      kind: "rw",
      id: "log-directory",
      target: targets.logs,
      why: "the log directory is mounted read/write",
    },
    {
      // Issue #514: the worker never modifies the code it is running, so the
      // checkout crosses the boundary read-only.
      kind: "ro-dir",
      id: "worker-checkout",
      target: targets.base,
      why: "the worker checkout is mounted read-only",
    },
    {
      // `.git` explicitly: a writable `.git` is enough to rewrite the tree
      // the next cycle checks out, even when the working files are not.
      kind: "ro-dir",
      id: "worker-checkout-git",
      target: `${targets.base}/.git`,
      why: "the checkout's .git is mounted read-only",
    },
    {
      kind: "ro-file",
      id: "config-file",
      // The staged copy inside the read-only config directory mount — the
      // file CONFIG_PATH points the worker at.
      target: `${targets.config}/.config.json`,
      why: "the staged .config.json is mounted read-only",
    },
    {
      kind: "ro-dir",
      id: "gh-credentials",
      target: `${targets.credentials}/${GH_CREDENTIAL_SUBDIR}`,
      why: "the gh credential directory is mounted read-only",
    },
    {
      kind: "ro-dir",
      id: "provider-credentials",
      target: `${targets.credentials}/${provider.credentials.subdir}`,
      why: `the ${provider.id} credential directory is mounted read-only`,
    },
    {
      // Issue #850: the operator's own prompt template crosses the boundary
      // read-only — a write to it from inside the container must fail.
      kind: "ro-file",
      id: "custom-prompt-file",
      target: `${targets.customPrompts}/1/${CUSTOM_PROMPT_PROBE_FILE}`,
      why: "the operator's custom prompt file is mounted read-only",
    },
    {
      kind: "ro-dir",
      id: "custom-prompt-directory",
      target: `${targets.customPrompts}/1`,
      why: "the operator's custom prompt directory is mounted read-only",
    },
    {
      kind: "canary",
      id: "host-home-canary",
      target: fixture.canaryName,
      why: "a canary in the host home is not visible from inside",
    },
  ];
}

/**
 * The read-only root filesystem and the writable exceptions it keeps
 * (Issue #516).
 *
 * Empty for a runtime whose plan carries no `--read-only` (Apple `container`),
 * so the suite asserts what this plan actually asked the runtime for rather
 * than a property the runtime was never given.
 *
 * `${HOME}` is the discriminating probe: the image ships it owned by the
 * worker's own account, so it is writable on a writable root and immutable
 * only because the root filesystem is.
 */
function readOnlyRootProbes(plan: ContainerLaunchPlan): Probe[] {
  if (!plan.runArgs.includes("--read-only")) return [];
  const containerHome = `/home/${MANIFEST.user.name}`;
  return [
    {
      kind: "ro-dir",
      id: "read-only-root-home",
      target: containerHome,
      why: "the container HOME is on the image layer, which is read-only",
    },
    {
      kind: "ro-dir",
      id: "read-only-root-usr-local-bin",
      target: "/usr/local/bin",
      why: "no binary may be planted on the image's PATH",
    },
    {
      kind: "rw",
      id: "scratch-tmp",
      target: "/tmp",
      why: "/tmp is the scratch tmpfs the read-only root depends on",
    },
    {
      kind: "rw",
      id: "scratch-var-tmp",
      target: "/var/tmp",
      why: "/var/tmp is the second scratch tmpfs",
    },
    {
      kind: "rw",
      id: "secrets-mount",
      target: SECRETS_MOUNT_PATH,
      why:
        `${SECRETS_MOUNT_PATH} is the credentials tmpfs, separate from the ` +
        `agents' scratch (Issue #570)`,
    },
  ];
}

/**
 * Render the probe table.
 *
 * @throws When an identifier or path carries a tab or newline, which the
 *   table's framing could not represent (Issue #3234 — fail loud rather than
 *   silently probing a truncated path).
 */
function renderProbeTable(probes: Probe[]): string {
  const seen = new Set<string>();
  return probes.map((probe) => {
    for (const value of [probe.kind, probe.id, probe.target]) {
      if (/[\t\n\r]/.test(value)) {
        throw new Error(
          `Containment probe ${probe.id} carries a tab or newline in ` +
            `${JSON.stringify(value)} — the probe table cannot frame it.`,
        );
      }
    }
    if (seen.has(probe.id)) {
      throw new Error(`Duplicate containment probe id: ${probe.id}`);
    }
    seen.add(probe.id);
    return `${probe.kind}\t${probe.id}\t${probe.target}`;
  }).join("\n") + "\n";
}

/** Parse the container's report into one result per probe identifier. */
function parseProbeReport(stdout: string): Map<string, ProbeResult> {
  const results = new Map<string, ProbeResult>();
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [id, verdict, ...rest] = line.split("\t");
    if (!id || !verdict) {
      throw new Error(`Malformed containment report line: ${line}`);
    }
    results.set(id, { verdict, detail: rest.join("\t") });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Running the plan
// ---------------------------------------------------------------------------

/**
 * The plan's run arguments with only the *process* replaced.
 *
 * Every mount, network, capability and namespace flag stays exactly as the
 * launcher produced it; the entrypoint is overridden so the probe runs
 * instead of the worker itself.
 */
function runArgsWithProbe(
  plan: ContainerLaunchPlan,
  containerName: string,
  extraFlags: string[],
  command: string[],
): string[] {
  const args = [...plan.runArgs];
  const image = args.pop();
  if (image !== plan.image) {
    throw new Error(
      `Expected the launch plan's last run argument to be the image ` +
        `${plan.image}, got ${JSON.stringify(image)}.`,
    );
  }
  const nameIndex = args.indexOf("--name");
  if (nameIndex < 0) {
    throw new Error("The launch plan does not name the container.");
  }
  args[nameIndex + 1] = containerName;
  return [...args, ...extraFlags, "--entrypoint", "bash", image, ...command];
}

/** Published-port evidence found anywhere in an inspect document. */
function findPublishedPorts(document: unknown): string[] {
  const findings: string[] = [];

  const isPublished = (value: unknown): boolean => {
    if (value === null || value === undefined) return false;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed !== "" && trimmed !== "0";
    }
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") {
      return Object.keys(value as Record<string, unknown>).length > 0;
    }
    return true;
  };

  const walk = (node: unknown, trail: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${trail}[${index}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        const next = `${trail}.${key}`;
        if (/port/i.test(key) && isPublished(child)) {
          findings.push(`${next} = ${JSON.stringify(child)}`);
        }
        walk(child, next);
      }
    }
  };

  walk(document, "$");
  return findings;
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "container containment - the launcher-produced container is contained",
  // Skipped, with the reason printed above, when no runtime or image is
  // available locally; CI sets VIBE_CONTAINMENT_REQUIRED so the skip becomes
  // a failure there instead.
  ignore: !RESOLUTION.ready && !containmentRequired(),
  sanitizeResources: false,
  async fn(t) {
    if (!RESOLUTION.ready) {
      throw new Error(
        `VIBE_CONTAINMENT_REQUIRED is set but the containment tests cannot ` +
          `run: ${RESOLUTION.reason}.`,
      );
    }
    const context = RESOLUTION.context;
    const token = crypto.randomUUID().slice(0, 8);
    const fixture = await buildHostFixture(context, token);

    try {
      const probes = [
        ...prohibitedProbes(fixture),
        ...socketProbes(),
        ...mountProbes(fixture),
        ...readOnlyRootProbes(fixture.plan),
      ];
      await Deno.writeTextFile(
        `${fixture.checkout}/containment-probes.tsv`,
        renderProbeTable(probes),
      );
      const scriptPath = `${fixture.checkout}/containment-probe.sh`;
      await Deno.writeTextFile(scriptPath, PROBE_SCRIPT);
      await Deno.chmod(scriptPath, 0o755);

      const probeRun = await runRuntime(
        context.descriptor.executable,
        runArgsWithProbe(
          fixture.plan,
          `${fixture.plan.containerName}-probe`,
          [],
          [
            "/workspace/containment-probe.sh",
            "/workspace/containment-probes.tsv",
          ],
        ),
      );
      assertEquals(
        probeRun.code,
        0,
        `The in-container probe failed (exit ${probeRun.code}):\n` +
          `${probeRun.stderr}\n${probeRun.stdout}`,
      );
      const report = parseProbeReport(probeRun.stdout);

      for (const probe of probes) {
        const label = probe.kind === "socket"
          ? `runtime socket: ${probe.target}`
          : probe.kind === "absent"
          ? `prohibited: ${probe.target}`
          : probe.kind === "canary"
          ? `host-home canary: ${probe.target}`
          : `mount: ${probe.target}`;

        await t.step(label, () => {
          const result = report.get(probe.id);
          assert(
            result !== undefined,
            `The container reported nothing for probe ${probe.id} ` +
              `(${probe.target}). Full report:\n${probeRun.stdout}`,
          );
          const seen = `${result.verdict} (${result.detail})`;

          switch (probe.kind) {
            case "absent":
              assert(
                result.verdict === "absent" || result.verdict === "unreadable",
                `${probe.target} is reachable from inside the container — ` +
                  `${probe.why} must not be: ${seen}`,
              );
              break;
            case "socket":
              assertEquals(
                result.verdict,
                "absent",
                `${probe.target} exists inside the container — ${probe.why} ` +
                  `would let the worker escape its own containment: ${seen}`,
              );
              break;
            case "rw":
              assertEquals(
                result.verdict,
                "writable",
                `${probe.why}, but the container reported: ${seen}`,
              );
              break;
            case "ro-file":
            case "ro-dir":
              assertEquals(
                result.verdict,
                "readable-immutable",
                `${probe.why}, but the container reported: ${seen}`,
              );
              break;
            case "canary":
              assertEquals(
                result.verdict,
                "not-found",
                `The host-home canary ${probe.target} was found inside the ` +
                  `container at ${result.detail} — the host home is exposed.`,
              );
              break;
          }
        });
      }

      await t.step("the canary really exists on the host", async () => {
        // Without this the canary search above could pass vacuously.
        const canary = await Deno.readTextFile(fixture.canaryPath);
        assert(
          canary.includes(token),
          `The host-home canary at ${fixture.canaryPath} is missing its token.`,
        );
      });

      await t.step("the read-only mounts expose the host's own files", () => {
        assertEquals(
          report.get("config-file")?.detail,
          `{"containment_probe": "${fixture.configToken}"}`,
          "The container read something other than the host .config.json.",
        );
        for (const id of ["gh-credentials", "provider-credentials"]) {
          const entries = report.get(id)?.detail ?? "";
          assert(
            entries.includes(`${token}.credential`),
            `The ${id} mount did not expose the host credential file ` +
              `(entries: ${entries}).`,
          );
        }
      });

      await t.step(
        "the read/write host mount lands in the host directory",
        async () => {
          const written = await Deno.readTextFile(
            `${fixture.logDir}/containment-probe-log-directory.txt`,
          );
          assertEquals(
            written.trim(),
            "log-directory",
            `What the container wrote did not appear in ${fixture.logDir}.`,
          );
        },
      );

      await t.step(
        "the work directory lives on the volume: durable, and never on the host",
        async () => {
          // No host copy (Issue #4186): what the probe wrote into the work
          // dir must NOT appear in the host's work directory — the
          // workspace's only home is the named volume.
          let hostCopyExists = true;
          try {
            await Deno.stat(
              `${fixture.workDir}/containment-probe-work-directory.txt`,
            );
          } catch {
            hostCopyExists = false;
          }
          assertEquals(
            hostCopyExists,
            false,
            `The work-directory write leaked into the host at ` +
              `${fixture.workDir} — the workspace must live on the ` +
              `named volume only.`,
          );

          // Durable across containers: a second container on the same plan
          // sees the first one's write. This is the property that makes an
          // image upgrade cheap — clones survive the container that made
          // them.
          const reread = await runRuntime(
            context.descriptor.executable,
            runArgsWithProbe(
              fixture.plan,
              `${fixture.plan.containerName}-durability`,
              [],
              [
                "-c",
                `cat "${containerTargetPaths(MANIFEST).work}` +
                `/containment-probe-work-directory.txt"`,
              ],
            ),
          );
          assertEquals(
            reread.code,
            0,
            `A second container could not reopen the volume:\n` +
              reread.stderr,
          );
          assertEquals(
            reread.stdout.trim(),
            "work-directory",
            "The work-directory write did not survive into a new container.",
          );
        },
      );

      await t.step(
        "the running container publishes no inbound ports",
        async () => {
          const name = `${fixture.plan.containerName}-ports`;
          const started = await runRuntime(
            context.descriptor.executable,
            runArgsWithProbe(fixture.plan, name, ["--detach"], [
              "-c",
              "sleep 45",
            ]),
          );
          assertEquals(
            started.code,
            0,
            `Could not start the container to inspect it:\n${started.stderr}`,
          );

          try {
            const inspected = await runRuntime(
              context.descriptor.executable,
              ["inspect", name],
              QUERY_TIMEOUT_MS,
            );
            assertEquals(
              inspected.code,
              0,
              `\`${context.descriptor.executable} inspect ${name}\` failed:\n` +
                inspected.stderr,
            );
            const document = JSON.parse(inspected.stdout);
            // Guard against a vacuous pass: an empty document would report no
            // ports for the trivial reason that it describes nothing.
            assert(
              inspected.stdout.includes(name),
              `The runtime's inspect output does not describe ${name}:\n` +
                inspected.stdout.slice(0, 500),
            );
            const published = findPublishedPorts(document);
            assertEquals(
              published,
              [],
              `The running container publishes inbound ports, as the ` +
                `runtime reports them: ${published.join(", ")}`,
            );
          } finally {
            const removed = await runRuntime(
              context.descriptor.executable,
              ["rm", "--force", name],
              QUERY_TIMEOUT_MS,
            );
            if (removed.code !== 0) {
              console.warn(
                `Could not remove the containment probe container ${name} ` +
                  `(exit ${removed.code}): ${removed.stderr.trim()}`,
              );
            }
          }
        },
      );
    } finally {
      for (const name of fixture.volumeNames) {
        const removed = await runRuntime(
          context.descriptor.executable,
          ["volume", "rm", name],
          QUERY_TIMEOUT_MS,
        );
        if (removed.code !== 0) {
          console.warn(
            `Could not remove the throwaway volume ${name} ` +
              `(exit ${removed.code}): ${removed.stderr.trim()}`,
          );
        }
      }
      await Deno.remove(fixture.root, { recursive: true });
    }
  },
});

// ---------------------------------------------------------------------------
// The harness itself — asserted everywhere, runtime or no runtime
// ---------------------------------------------------------------------------

/** A plan built from fixed host paths, for the pure harness assertions. */
function samplePlan(): ContainerLaunchPlan {
  const candidate = CONTAINER_RUNTIMES.docker;
  return buildContainerLaunchPlan({
    descriptor: {
      platform: "linux",
      kind: "docker",
      executable: candidate.executable,
      displayName: candidate.displayName,
      dialect: candidate.dialect,
      probed: ["docker"],
    },
    manifest: MANIFEST,
    image: "vibe-coder:0123456789ab",
    containerName: "vibe-containment-sample",
    watchdogSeconds: 11_400,
    hostPaths: {
      homeDir: "/home/operator",
      baseDir: "/opt/VibeCoder",
      workDir: "/home/operator/auto-issue-work",
      logDir: "/home/operator/logs",
      configFile: "/opt/VibeCoder/.config.json",
      configStageDir: "/home/operator/.vibe-coder/run-config",
      credentialDir: "/home/operator/.vibe-coder/credentials",
    },
  });
}

Deno.test("containment harness - probes the plan's own container, only swapping the process", () => {
  const plan = samplePlan();
  const args = runArgsWithProbe(plan, "vibe-containment-probe", [], [
    "/workspace/containment-probe.sh",
    "/workspace/containment-probes.tsv",
  ]);

  // Every mount and privilege flag survives untouched: the probe must observe
  // the container the launcher would really start.
  for (let i = 0; i < plan.runArgs.length - 1; i++) {
    const argument = plan.runArgs[i]!;
    if (argument === plan.containerName) continue;
    assertEquals(
      args[i],
      argument,
      `Argument ${i} was altered by the probe harness.`,
    );
  }
  for (const flag of FORBIDDEN_RUN_FLAGS) {
    assert(
      !args.includes(flag),
      `The probe harness introduced the forbidden flag ${flag}.`,
    );
  }

  const nameIndex = args.indexOf("--name");
  assertEquals(args[nameIndex + 1], "vibe-containment-probe");

  const imageIndex = args.indexOf(plan.image);
  assertEquals(args[imageIndex - 2], "--entrypoint");
  assertEquals(args[imageIndex - 1], "bash");
  assertEquals(args.slice(imageIndex + 1), [
    "/workspace/containment-probe.sh",
    "/workspace/containment-probes.tsv",
  ]);
});

Deno.test("containment harness - refuses a plan whose last argument is not the image", () => {
  const plan = samplePlan();
  const tampered: ContainerLaunchPlan = {
    ...plan,
    runArgs: [...plan.runArgs, "--unexpected"],
  };
  assertThrows(
    () => runArgsWithProbe(tampered, "vibe-containment-probe", [], ["true"]),
    Error,
    "last run argument to be the image",
  );
});

Deno.test("containment harness - reads published ports out of an inspect document", () => {
  // Shaped like `docker inspect` / `podman inspect` for a container started
  // with no published ports.
  const contained = [{
    Name: "/vibe-containment-sample",
    Config: { ExposedPorts: null },
    HostConfig: { PortBindings: {}, PublishAllPorts: false },
    NetworkSettings: { Ports: {}, Networks: { bridge: {} } },
  }];
  assertEquals(findPublishedPorts(contained), []);

  const published = [{
    Name: "/vibe-containment-sample",
    HostConfig: {
      PortBindings: { "8080/tcp": [{ HostIp: "", HostPort: "8080" }] },
      PublishAllPorts: true,
    },
    NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "8080" }] } },
  }];
  const findings = findPublishedPorts(published);
  assert(
    findings.some((finding) => finding.includes("PortBindings")),
    `Published port bindings were not reported: ${findings.join(", ")}`,
  );
  assert(
    findings.some((finding) => finding.includes("PublishAllPorts")),
    `--publish-all was not reported: ${findings.join(", ")}`,
  );
});

Deno.test("containment harness - the probe table round-trips and refuses unframeable paths", () => {
  const probes: Probe[] = [
    {
      kind: "absent",
      id: "host-documents",
      target: "/home/operator/Documents",
      why: "~/Documents",
    },
    {
      kind: "socket",
      id: "docker-socket",
      target: "/var/run/docker.sock",
      why: "the Docker socket",
    },
  ];
  assertEquals(
    renderProbeTable(probes),
    "absent\thost-documents\t/home/operator/Documents\n" +
      "socket\tdocker-socket\t/var/run/docker.sock\n",
  );

  const report = parseProbeReport(
    "host-documents\tabsent\t/home/operator/Documents\n" +
      "docker-socket\tabsent\t/var/run/docker.sock\n",
  );
  assertEquals(report.get("host-documents")?.verdict, "absent");
  assertEquals(
    report.get("docker-socket")?.detail,
    "/var/run/docker.sock",
  );

  assertThrows(
    () =>
      renderProbeTable([{
        kind: "absent",
        id: "tabbed",
        target: "/home/operator/od\td",
        why: "a path the table cannot frame",
      }]),
    Error,
    "cannot frame it",
  );
  assertThrows(
    () => renderProbeTable([probes[0]!, probes[0]!]),
    Error,
    "Duplicate containment probe id",
  );
});

Deno.test("containment harness - every prohibited location and socket is probed separately", () => {
  const fixture = {
    root: "/tmp/vibe-containment-fixture",
    home: "/tmp/vibe-containment-fixture/home",
    checkout: "/tmp/vibe-containment-fixture/checkout",
    rootCanaryPath: "/tmp/vibe-containment-fixture/canary.txt",
  } as HostFixture;

  const targets = prohibitedProbes(fixture).map((probe) => probe.target);
  for (
    const required of [
      `${fixture.home}/Documents`,
      `${fixture.home}/Desktop`,
      `${fixture.home}/Pictures`,
      `${fixture.home}/.ssh`,
      `${fixture.home}/Library`,
      `${fixture.home}/Library/Keychains`,
      fixture.home,
      fixture.root,
      fixture.rootCanaryPath,
    ]
  ) {
    assert(
      targets.includes(required),
      `${required} has no containment probe of its own.`,
    );
  }

  const sockets = socketProbes().map((probe) => probe.target);
  for (
    const required of [
      "/var/run/docker.sock",
      "/run/podman/podman.sock",
      "/var/run/container.sock",
    ]
  ) {
    assert(
      sockets.includes(required),
      `${required} has no containment probe of its own.`,
    );
  }
  assert(
    socketProbes().every((probe) => probe.kind === "socket"),
    "A runtime socket must be probed for absence, not merely readability.",
  );
});

Deno.test("containment harness - the worker checkout and its .git are probed read-only (Issue #514)", () => {
  // Runs without a container runtime, so the probe table itself is guarded
  // even where the live containment run is skipped: a future edit that drops
  // these probes cannot make the read-only checkout untested by accident.
  const targets = containerTargetPaths(MANIFEST);
  const probes = mountProbes({ canaryName: "canary.txt" } as HostFixture);

  for (const target of [targets.base, `${targets.base}/.git`]) {
    const probe = probes.find((candidate) => candidate.target === target);
    assert(probe, `${target} has no containment probe of its own.`);
    assertEquals(
      probe.kind,
      "ro-dir",
      `${target} must be probed read-only — the worker never modifies the ` +
        `code it is running.`,
    );
  }
});

Deno.test("containment harness - the operator's custom prompt mount is probed read-only (Issue #850)", () => {
  // Runs without a container runtime, so the probe itself is guarded even
  // where the live run is skipped: the read-only guarantee for an operator's
  // own template cannot become untested by accident.
  const targets = containerTargetPaths(MANIFEST);
  const probes = mountProbes({ canaryName: "canary.txt" } as HostFixture);

  const file = probes.find((candidate) =>
    candidate.target ===
      `${targets.customPrompts}/1/${CUSTOM_PROMPT_PROBE_FILE}`
  );
  assert(file, "the mounted custom prompt file has no containment probe.");
  assertEquals(file.kind, "ro-file");

  const directory = probes.find((candidate) =>
    candidate.target === `${targets.customPrompts}/1`
  );
  assert(directory, "the mounted custom prompt directory has no probe.");
  assertEquals(directory.kind, "ro-dir");
});

Deno.test("containment harness - the read-only root and its writable exceptions are probed (Issue #516)", () => {
  // Also runs without a container runtime, so the probe set is guarded even
  // where the live run is skipped.
  const probes = readOnlyRootProbes(samplePlan());
  const containerHome = `/home/${MANIFEST.user.name}`;

  const home = probes.find((probe) => probe.target === containerHome);
  assert(home, `${containerHome} has no read-only root probe.`);
  assertEquals(
    home.kind,
    "ro-dir",
    "the container HOME is on the image layer and must be immutable",
  );
  // Every declared scratch mount is probed writable — a read-only root with
  // no writable scratch is a container that cannot run.
  for (const mount of SCRATCH_TMPFS_MOUNTS) {
    const path = mount.split(":")[0]!;
    const probe = probes.find((candidate) => candidate.target === path);
    assert(probe, `The scratch tmpfs ${path} has no containment probe.`);
    assertEquals(probe.kind, "rw", `${path} must be probed writable.`);
  }

  // A runtime whose plan carries no --read-only is not asserted against a
  // property it was never given (Apple container takes neither the flag nor
  // a tmpfs).
  const writableRoot: ContainerLaunchPlan = {
    ...samplePlan(),
    runArgs: samplePlan().runArgs.filter((arg) => arg !== "--read-only"),
  };
  assertEquals(readOnlyRootProbes(writableRoot), []);
});

// ---------------------------------------------------------------------------
// The operator's private layer (Issue #980, parent #933)
// ---------------------------------------------------------------------------

/** The sample plan, extended with an operator layer (Issue #980). */
function sampleExtensionPlan(): ContainerLaunchPlan {
  const candidate = CONTAINER_RUNTIMES.docker;
  return buildContainerLaunchPlan({
    descriptor: {
      platform: "linux",
      kind: "docker",
      executable: candidate.executable,
      displayName: candidate.displayName,
      dialect: candidate.dialect,
      probed: ["docker"],
    },
    manifest: MANIFEST,
    image: "vibe-coder:0123456789ab",
    containerName: "vibe-containment-sample",
    watchdogSeconds: 11_400,
    hostPaths: {
      homeDir: "/home/operator",
      baseDir: "/opt/VibeCoder",
      workDir: "/home/operator/auto-issue-work",
      logDir: "/home/operator/logs",
      configFile: "/opt/VibeCoder/.config.json",
      configStageDir: "/home/operator/.vibe-coder/run-config",
      credentialDir: "/home/operator/.vibe-coder/credentials",
    },
    containerExtension: {
      spec: {
        path: "/srv/vibe-extension",
        containerfile: "Containerfile",
        start: "start.sh",
      },
      image: "vibe-coder:fedcba987654",
      containerfileText: "ARG VIBE_BASE_IMAGE\nFROM ${VIBE_BASE_IMAGE}\n",
    },
  });
}

Deno.test("containment - the extension build exposes no host path and publishes no port (Issue #980)", () => {
  const plan = sampleExtensionPlan();

  for (const flag of FORBIDDEN_RUN_FLAGS) {
    assert(
      !plan.extensionBuildArgs.includes(flag),
      `The extension build carries the forbidden flag ${flag}.`,
    );
  }
  for (const flag of ["--volume", "--mount", "-v", "--publish", "-p"]) {
    assert(
      !plan.extensionBuildArgs.includes(flag),
      `The extension build carries a host mount or published port (${flag}).`,
    );
  }
  assert(
    !plan.extensionBuildArgs.some((arg) =>
      arg === "host" || arg.endsWith("=host")
    ),
    "The extension build asks for host namespace or network access.",
  );

  // The build context is the extension directory alone: no other host path
  // reaches the build, and neither does the worker's own checkout.
  assertEquals(
    plan.extensionBuildArgs.filter((arg) => arg.startsWith("/")),
    ["/srv/vibe-extension/Containerfile", "/srv/vibe-extension"],
  );
});

Deno.test("containment - the extension tag still runs read-only with its scratch (Issue #980)", () => {
  const plan = sampleExtensionPlan();

  assertEquals(plan.runArgs.at(-1), "vibe-coder:fedcba987654");
  assert(
    plan.runArgs.includes("--read-only"),
    "the layered image runs on an immutable root filesystem, like the base",
  );
  for (const mount of scratchTmpfsMounts(MANIFEST.user)) {
    assert(
      plan.runArgs.includes(mount),
      `The layered image runs without its scratch tmpfs ${mount}.`,
    );
  }
  // The layer changes what the image contains, never what the container may
  // reach: the mount set is the base plan's, unchanged.
  assertEquals(plan.mounts, samplePlan().mounts);
});
