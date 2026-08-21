/**
 * The Vibe Coder container launch plan (Issue #4065, parent #4060).
 *
 * `run.sh` (and, from Issue #4066, `run.ps1`) is a thin trusted host-side
 * launcher: it asks this module what to run and then runs exactly that. Every
 * containment decision — which host paths are exposed, which are read-only,
 * which privilege flags are passed — is made here, in one auditable place,
 * rather than restated in shell and PowerShell where the two could drift.
 *
 * ## The mount set
 *
 * The container sees four host paths, two named volumes, and nothing else:
 *
 * | Source                     | In container                       | Mode |
 * | -------------------------- | ---------------------------------- | ---- |
 * | the worker checkout        | `/workspace`                       | rw   |
 * | volume `vibe-work`         | `/home/vibe/auto-issue-work`       | rw   |
 * | volume `vibe-approval-state`| `…/auto-issue-work-approval-state`| rw   |
 * | the worker log directory   | `/home/vibe/logs`                  | rw   |
 * | staged `.config.json` dir  | `/home/vibe/.vibe-coder/run-config`| ro   |
 * | the `gh` credential dir    | `…/credentials/gh`                 | ro   |
 * | each enabled provider's dir| `…/credentials/<provider>`         | ro   |
 *
 * The first is the worker's own code, not host data: the image ships only the
 * entrypoint, so without the checkout at the manifest `workdir` there is no
 * driver to run and no way for the bootstrap to self-update. The rest are the
 * persistent state Issue #4060 enumerates. Their in-container paths are
 * deliberately the ones the worker resolves for itself from `HOME`, so no
 * environment plumbing is needed to point it at them.
 *
 * The work directory and its approval-state sibling ride runtime-managed
 * **named volumes** rather than host mounts (Issue #4186): per-file metadata
 * through a host mount is 50–75× slower than a guest-owned filesystem —
 * `git add` + commit of 2,000 files measured 16,092 ms via virtiofs against
 * 163 ms on a named volume — and git/cargo/deno/npm churn is made of exactly
 * that case. The volumes are keyed by fixed names, independent of both the
 * per-run container name and the image tag, so clones, agent transcripts,
 * session stores and tamper snapshots survive every cycle *and* every image
 * upgrade, while the host keeps no browsable copy of the worker's
 * repositories at all — less cross-contamination between machine and
 * container. A fresh volume is root-owned, so the plan carries a one-shot
 * `initArgs` run (root, `--entrypoint chown`) the launchers execute before
 * the worker; it is idempotent and re-run every launch.
 *
 * Only the *enabled* providers' credential sub-directories are exposed
 * (Issues #4067, #4108): the sub-directory names come from the provider
 * descriptors, so a provider that is not enabled for this run has no mount at
 * all — its secret cannot be read from inside the container — and enabling one
 * needs no edit to the mount construction here.
 *
 * ## What it refuses
 *
 * Building a plan throws — loudly, per Issue #3234 — rather than emitting a
 * broadened one when a mount source is the host home directory (or an
 * ancestor of it), a container-runtime control socket, a relative path, or a
 * path carrying characters that would break the launcher's framing. The
 * finished argument list is re-checked for privilege-broadening flags before
 * it is returned, so a future edit cannot quietly add one.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import {
  buildMountArguments,
  type ContainerMount,
  type ContainerRuntimeDescriptor,
} from "./container_runtime.ts";
import type { ContainerManifest } from "./container_manifest.ts";
import {
  DEFAULT_CREDENTIAL_DIR_SUFFIX,
  GH_CREDENTIAL_SUBDIR,
} from "./credential_preflight.ts";
import {
  type AgentProviderDescriptor,
  enabledAgentProviders,
} from "./agent_provider.ts";
import { resolveContentApprovalStateDir } from "./content_approval_state_dir.ts";

/**
 * Named volume holding the worker's work directory (Issue #4186): repo
 * clones, build churn, agent transcripts and session stores. Fixed name —
 * never derived from the per-run container name or the image tag — so the
 * content survives every cycle and every image upgrade.
 */
export const WORK_VOLUME_NAME = "vibe-work";

/**
 * Named volume holding the content-approval tamper snapshots (Issue #3717).
 * Mounted at the work dir's sibling path, exactly where the worker resolves
 * the store, so snapshots survive a container kill instead of resolving onto
 * the container's disposable root filesystem (the bug found designing
 * Issue #4186).
 */
export const APPROVAL_STATE_VOLUME_NAME = "vibe-approval-state";

/** Volume names every supported runtime accepts, and no shell can misread. */
const VOLUME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Host paths the launcher exposes to the container. */
export interface ContainerLaunchHostPaths {
  /** Host home directory — never mounted; used to refuse a wholesale mount. */
  homeDir: string;
  /** The worker checkout (the repository `run.sh` lives in). */
  baseDir: string;
  /** Workspace for Vibe-managed repositories (`$WORK_DIR`). */
  workDir: string;
  /** Worker log directory. */
  logDir: string;
  /** Worker configuration file the launcher stages before mounting. */
  configFile: string;
  /**
   * Host directory holding the staged copy of the configuration file,
   * exposed read-only. A directory rather than the file itself because
   * Apple container cannot mount a single file — a file mount silently
   * empties the container's other volumes (verified on 1.2.2), which
   * presented as "worker driver not found at /workspace/...".
   */
  configStageDir: string;
  /** Dedicated Vibe credential directory, exposed read-only. */
  credentialDir: string;
}

/** Everything the plan is built from. */
export interface ContainerLaunchInputs {
  /** The resolved container runtime (Issue #4063). */
  descriptor: ContainerRuntimeDescriptor;
  /** The parsed `container/tools.json` (Issue #4061). */
  manifest: ContainerManifest;
  /** Content-derived image reference (Issue #4062). */
  image: string;
  /** Name the container is started under, so it can be stopped by name. */
  containerName: string;
  /**
   * Seconds the launcher waits on the runtime client before treating the
   * container as wedged and reaping it (Issue #4173).
   *
   * Carried in the plan rather than computed in shell, so both launchers wait
   * under the same deadline and neither invents one of its own. Resolved by
   * {@link resolveWatchdogSeconds}.
   */
  watchdogSeconds: number;
  /** Resolved host paths. */
  hostPaths: ContainerLaunchHostPaths;
  /**
   * Path of the Containerfile the build reads (Issue #4393). The launcher
   * passes a comment-stripped copy it wrote beside the plan file, so the
   * committed `container/Containerfile` can carry its comments past Apple
   * container's 16 KB cap. Absent → the committed file, as before.
   */
  containerfile?: string;
  /**
   * The coding-agent providers whose credentials are exposed (Issues #4067,
   * #4108). Defaults to the enabled set, which is the active provider alone
   * unless a deployment enables more.
   */
  agentProviders?: readonly AgentProviderDescriptor[];
  /**
   * The host's own short hostname, passed into the container as
   * VIBE_HOST_ID so fleet telemetry (private-repo-6) names the real machine
   * rather than the ephemeral container hostname. Optional: absent means
   * the worker falls back to its own hostname (native-mode behaviour).
   */
  hostId?: string;
  /**
   * The host filesystem's free/total bytes at launch (Issue #226), passed in
   * as VIBE_HOST_DISK_AVAIL_BYTES / VIBE_HOST_DISK_TOTAL_BYTES so the worker
   * can gate new claims on the *host's* disk rather than the virtual work
   * volume's. Optional: absent means the worker reads df itself, which in
   * container mode sees only the volume image.
   */
  hostDisk?: { availableBytes: number; totalBytes: number };
  /**
   * VM sizing for the worker container. Optional: absent falls back to the
   * built-in floor (8g / 6 cpus) — never to the runtime's 1 GiB default,
   * which memory-stalled real work (the agent CLI plus a cargo-build
   * quality gate) to multi-hour timeouts and wedged VMs, observed live.
   */
  resources?: ContainerResources;
  /**
   * Named-volume overrides, for test isolation only (Issue #4186): the
   * containment integration tests create per-run throwaway volumes so they
   * never touch — or delete — a production host's `vibe-work` state. The
   * launchers never set this; production always uses the fixed names, which
   * is what makes the content durable. Names are validated the same way as
   * the defaults, so the override cannot smuggle in a host path.
   */
  volumes?: { work: string; approvalState: string };
}

/**
 * Default number of host cores kept back from the VM (Issue #4272; made
 * configurable by Issue #4301 via `VIBE_CONTAINER_CPU_RESERVE`).
 */
export const DEFAULT_CPU_RESERVE = 4;

/** VM sizing passed to `container run` (every dialect takes both flags). */
export interface ContainerResources {
  /** `--memory` value, e.g. `12g`. */
  memory?: string;
  /** `--cpus` value, e.g. `8`. */
  cpus?: string;
}

/**
 * Resolve the VM size for this host (Issue #4162 family; observed live).
 *
 * Operator env overrides win verbatim (`VIBE_CONTAINER_MEMORY`,
 * `VIBE_CONTAINER_CPUS`). Otherwise the sizing is deliberately generous —
 * the containment boundary is the mount set, not the VM's appetite: the
 * host's RAM minus an 8 GiB reserve (8g floor, no cap — Issue #4229), and cores-2 with a floor of
 * 4. Unreadable host info falls back to the floor.
 */
export function resolveContainerResources(options: {
  env: (name: string) => string | undefined;
  totalMemoryBytes?: number;
  cpuCount?: number;
}): { memory: string; cpus?: string } {
  const envMemory = options.env("VIBE_CONTAINER_MEMORY")?.trim();
  const envCpus = options.env("VIBE_CONTAINER_CPUS")?.trim();

  let memory = "8g";
  if (options.totalMemoryBytes && options.totalMemoryBytes > 0) {
    const totalGb = Math.floor(options.totalMemoryBytes / 1024 ** 3);
    // Everything minus an 8 GiB host reserve (Issue #4229). Half-the-host
    // was a conservative default the operator's philosophy forbids, and on
    // the shared 24 GiB laptop its 12 GiB VM OOM-killed the agent plus the
    // quality gate three sessions running. The reserve keeps the host OS
    // (and a desktop session on a shared machine) breathing; a dedicated
    // host stops leaving half its RAM idle. Floor of 8g, but never above
    // the host's own total on a tiny machine; VIBE_CONTAINER_MEMORY wins.
    const generousGb = totalGb - 8;
    memory = `${Math.max(Math.min(8, totalGb), generousGb)}g`;
  }
  // CPUs must NEVER exceed the host's count — Docker hard-rejects the run
  // ("range of CPUs is from 0.01 to 2.00") rather than clamping. cores-4
  // with a floor of 4, capped at the host's cores (Issue #4272): cores-2
  // oversubscribed a shared host — the 8-vCPU VM on the 10-core laptop
  // stalled wholesale whenever host load burst (IDE work, builds), and the
  // guest's agent session was SIGKILLed by heartbeat machinery even 105 s
  // into light activity, while an idle host let a session run 70 minutes.
  // Four spare cores keep the VM schedulable through interactive bursts; a
  // dedicated host can push higher via VIBE_CONTAINER_CPUS. undefined when
  // the count is unknown so the runtime keeps its own default.
  // The reserve is configurable (Issue #4301): the shared-laptop finding
  // above is real, but a dedicated fleet host has no interactive bursts
  // to defend against and should hand the VM every core. Set
  // VIBE_CONTAINER_CPU_RESERVE=0 (or any count) to change how many cores
  // stay with the host; VIBE_CONTAINER_CPUS still wins verbatim.
  let cpus: string | undefined;
  if (options.cpuCount && options.cpuCount > 0) {
    const reserveRaw = options.env("VIBE_CONTAINER_CPU_RESERVE")?.trim();
    const reserveParsed = reserveRaw === undefined || reserveRaw === ""
      ? NaN
      : Number(reserveRaw);
    const reserve = Number.isInteger(reserveParsed) && reserveParsed >= 0
      ? reserveParsed
      : DEFAULT_CPU_RESERVE;
    cpus = `${
      Math.min(
        options.cpuCount,
        Math.max(Math.min(4, options.cpuCount), options.cpuCount - reserve),
      )
    }`;
  }
  return {
    memory: envMemory || memory,
    ...(envCpus || cpus ? { cpus: envCpus || cpus } : {}),
  };
}

/** In-container paths the mounts land on. */
export interface ContainerTargetPaths {
  base: string;
  work: string;
  /** The content-approval store, always the work dir's sibling (#3717). */
  approvalState: string;
  logs: string;
  config: string;
  credentials: string;
}

/** The launch plan `run.sh` executes. */
export interface ContainerLaunchPlan {
  /** Runtime executable to invoke. */
  runtime: string;
  /** Image reference to run. */
  image: string;
  /** Container name. */
  containerName: string;
  /**
   * Seconds the launcher waits on the runtime client before reaping the
   * container as wedged (Issue #4173).
   */
  watchdogSeconds: number;
  /** The mounts, in the order they are passed. */
  mounts: ContainerMount[];
  /** Host directories the launcher must create before starting. */
  ensureDirectories: string[];
  /**
   * Named volumes the launcher must ensure exist before starting
   * (Issue #4186). Every supported runtime spells both steps identically:
   * `<runtime> volume inspect <name>` reports presence and
   * `<runtime> volume create <name>` creates one.
   */
  volumes: string[];
  /**
   * Arguments for the one-shot volume-ownership init run (Issue #4186): a
   * fresh named volume is root-owned, so root chowns the mount roots to the
   * image's worker account before the worker starts. Idempotent — the
   * launchers run it on every launch, so a half-finished first launch heals
   * itself rather than wedging the volume unowned forever.
   */
  initArgs: string[];
  /** Arguments that report whether the image is already present. */
  imageInspectArgs: string[];
  /** Arguments that build the image. */
  buildArgs: string[];
  /**
   * Arguments that stop the runtime's persistent build helper after the
   * image exists (Issue #4331) — empty for runtimes that have none.
   */
  builderStopArgs: string[];
  /** Arguments that run the worker container. */
  runArgs: string[];
}

/** Flags that would broaden the container beyond its intended privileges. */
export const FORBIDDEN_RUN_FLAGS: readonly string[] = [
  "--privileged",
  "--cap-add",
  "--device",
  "--publish",
  "-p",
  "--publish-all",
  "-P",
  "--pid=host",
  "--ipc=host",
  "--uts=host",
  "--userns=host",
  "--network=host",
  "--net=host",
];

/** Path fragments that identify a container-runtime control socket. */
const RUNTIME_SOCKET_HINTS: readonly string[] = [
  "docker.sock",
  "podman.sock",
  "containerd.sock",
  "container.sock",
  "crio.sock",
  // Windows names the Docker/Podman control endpoint as a pipe, not a socket.
  "docker_engine",
];

/** Container names the runtimes accept, and a shell cannot misread. */
const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * How the launching host spells its own paths (Issue #4066).
 *
 * Only the *host* side of a mount differs: `run.ps1` hands over
 * `C:\Users\vibe\logs` where `run.sh` hands over `/Users/vibe/logs`. The
 * in-container side is POSIX on every host, so the worker sees one
 * environment regardless of which launcher started it.
 */
export type LauncherPathStyle = "posix" | "windows";

/** A Windows drive-letter path, the only absolute form Windows hosts use. */
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;

/** A bare Windows drive root (`C:`, `C:\`, `C:/`). */
const WINDOWS_ROOT_RE = /^[A-Za-z]:[\\/]?$/;

/**
 * The path style a host path is written in.
 *
 * Derived from the path itself rather than from `Deno.build.os`, so the plan
 * a given set of host paths produces is the same wherever it is computed.
 *
 * @param path - A host path (typically the worker checkout)
 * @returns The style that path is spelled in
 */
export function pathStyleFor(path: string): LauncherPathStyle {
  return WINDOWS_ABSOLUTE_RE.test(path.trim()) ? "windows" : "posix";
}

/** The separator paths are joined with in a given style. */
function separatorFor(style: LauncherPathStyle): string {
  return style === "windows" ? "\\" : "/";
}

/** Strip trailing separators so `/a/b/` and `/a/b` compare equal. */
function normalise(path: string, style: LauncherPathStyle = "posix"): string {
  const trimmed = path.trim();
  if (style === "windows") {
    // The drive root keeps its separator: `C:` alone is a drive-relative
    // path on Windows, which is not the same thing as `C:\`.
    if (WINDOWS_ROOT_RE.test(trimmed)) return trimmed;
    return trimmed.replace(/[\\/]+$/, "");
  }
  if (trimmed.length > 1 && trimmed.endsWith("/")) {
    return trimmed.replace(/\/+$/, "");
  }
  return trimmed;
}

/** True when the path is absolute in the given style. */
function isAbsolutePath(path: string, style: LauncherPathStyle): boolean {
  return style === "windows"
    ? WINDOWS_ABSOLUTE_RE.test(path)
    : path.startsWith("/");
}

/** True when the path is the filesystem (or drive) root. */
function isRootPath(path: string, style: LauncherPathStyle): boolean {
  return style === "windows" ? WINDOWS_ROOT_RE.test(path) : path === "/";
}

/** Join a relative path onto a base in the host's own spelling. */
function joinPath(
  base: string,
  relative: string,
  style: LauncherPathStyle,
): string {
  const separator = separatorFor(style);
  const trimmed = relative.replace(/^\.[\\/]/, "");
  const spelled = style === "windows"
    ? trimmed.replace(/\//g, separator)
    : trimmed;
  return `${base}${separator}${spelled}`;
}

/**
 * A path reduced to a comparable form.
 *
 * Windows paths are matched case-insensitively and either separator, so
 * `C:\Users\Vibe` and `c:/users/vibe` are recognised as the same directory.
 */
function comparablePath(path: string, style: LauncherPathStyle): string {
  return style === "windows" ? path.replace(/\\/g, "/").toLowerCase() : path;
}

/**
 * True when a value carries a character the launcher's framing cannot pass.
 *
 * Scanned by code point rather than by regular expression so the check is
 * explicit about what it rejects (and does not trip `no-control-regex`).
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** True when `ancestor` is `path` or a directory above it. */
function isAtOrAbove(
  ancestor: string,
  path: string,
  style: LauncherPathStyle,
): boolean {
  const left = comparablePath(ancestor, style);
  const right = comparablePath(path, style);
  return left === right || right.startsWith(`${left}/`);
}

/**
 * Reject a host path the container must never see.
 *
 * @param source - Host path a mount would expose
 * @param homeDir - The host home directory
 * @param style - How this host spells its paths
 * @throws When the path is relative, unframeable, the home directory (or an
 *   ancestor of it), or a container-runtime control socket
 */
function assertMountSourcePermitted(
  source: string,
  homeDir: string,
  style: LauncherPathStyle,
): void {
  if (hasControlCharacter(source)) {
    throw new Error(
      `Mount source contains a control character and cannot be launched ` +
        `safely: ${JSON.stringify(source)}`,
    );
  }
  // Checked before the absolute-path test so a Windows named pipe is named
  // for what it is rather than reported as a malformed path.
  if (source.startsWith("\\\\.\\pipe\\") || source.startsWith("//./pipe/")) {
    throw new Error(
      `Refusing to mount ${source}: a container-runtime control socket ` +
        `would let the worker escape its own containment (Issue #4060).`,
    );
  }
  if (!isAbsolutePath(source, style)) {
    throw new Error(
      `Mount source must be an absolute host path, got: ${source}`,
    );
  }
  if (isRootPath(source, style)) {
    throw new Error("Refusing to mount the host filesystem root");
  }
  if (homeDir !== "" && isAtOrAbove(source, homeDir, style)) {
    throw new Error(
      `Refusing to mount ${source}: it is the host home directory (or an ` +
        `ancestor of it). The Vibe Coder controls its workspace, not the ` +
        `host (Issue #4060).`,
    );
  }
  const lower = source.toLowerCase();
  if (
    lower.endsWith(".sock") ||
    RUNTIME_SOCKET_HINTS.some((hint) => lower.includes(hint))
  ) {
    throw new Error(
      `Refusing to mount ${source}: a container-runtime control socket ` +
        `would let the worker escape its own containment (Issue #4060).`,
    );
  }
}

/** Reject an argument list that would broaden the container's privileges. */
function assertRunArgumentsContained(args: string[]): void {
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (FORBIDDEN_RUN_FLAGS.includes(lower)) {
      throw new Error(
        `Refusing to launch: run arguments contain ${arg}, which broadens ` +
          `the container beyond its least-privilege contract (Issue #4065).`,
      );
    }
    if (lower === "host" || lower.endsWith("=host")) {
      throw new Error(
        `Refusing to launch: run arguments request host namespace/network ` +
          `access (${arg}).`,
      );
    }
  }
}

/**
 * The in-container paths the mounts land on.
 *
 * Derived from `container/tools.json` so the launcher and the image cannot
 * disagree about where the worker lives or which account it runs as.
 *
 * @param manifest - The parsed container manifest
 * @returns The fixed in-container layout
 */
export function containerTargetPaths(
  manifest: ContainerManifest,
): ContainerTargetPaths {
  const home = `/home/${manifest.user.name}`;
  const work = `${home}/auto-issue-work`;
  return {
    base: manifest.workdir,
    // The worker resolves these from HOME itself (worker/deno/lib/
    // run_worker.ts), so mounting them here needs no environment plumbing.
    work,
    // Derived through the worker's own resolver so the volume mount and the
    // store the worker reads can never drift apart (Issues #3717, #4186).
    approvalState: resolveContentApprovalStateDir(work),
    logs: `${home}/logs`,
    // A directory outside the checkout mount: overlaying the config file at
    // `${workdir}/.config.json` breaks Apple container (see
    // ContainerLaunchHostPaths.configStageDir), and the worker follows
    // CONFIG_PATH to the staged copy instead.
    config: `${home}/.vibe-coder/run-config`,
    credentials: `${home}/${DEFAULT_CREDENTIAL_DIR_SUFFIX}`,
  };
}

/**
 * Resolve the host paths the launcher exposes.
 *
 * Every default matches how the worker itself resolves the same path, so the
 * container sees the directories the operator already uses.
 *
 * @param baseDir - The worker checkout
 * @param env - Environment reader (injectable for tests)
 * @param style - How this host spells its paths; inferred from `baseDir`
 * @returns The resolved host paths
 * @throws When no home directory can be resolved
 */
export function resolveContainerLaunchHostPaths(
  baseDir: string,
  env: (name: string) => string | undefined,
  style: LauncherPathStyle = pathStyleFor(baseDir),
): ContainerLaunchHostPaths {
  // Windows hosts lead with USERPROFILE: HOME, when it is set there at all,
  // is usually a POSIX-shaped path from a Unix emulation layer that the
  // container runtime cannot bind.
  const rawHome = style === "windows"
    ? env("USERPROFILE") ?? env("HOME") ?? ""
    : env("HOME") ?? env("USERPROFILE") ?? "";
  const home = normalise(rawHome, style);
  if (home === "") {
    throw new Error(
      "Cannot resolve the launcher's host paths: neither HOME nor " +
        "USERPROFILE is set.",
    );
  }

  const base = normalise(baseDir, style);
  const absolute = (value: string): string =>
    isAbsolutePath(value, style) ? value : joinPath(base, value, style);

  const workDir = normalise(
    env("WORK_DIR") ?? joinPath(home, "auto-issue-work", style),
    style,
  );
  const configFile = normalise(
    absolute(env("CONFIG_PATH") ?? ".config.json"),
    style,
  );
  const credentialDir = normalise(
    env("VIBE_CREDENTIAL_DIR") ??
      joinPath(home, DEFAULT_CREDENTIAL_DIR_SUFFIX, style),
    style,
  );

  return {
    homeDir: home,
    baseDir: base,
    workDir: normalise(absolute(workDir), style),
    logDir: joinPath(home, "logs", style),
    configFile,
    configStageDir: joinPath(home, ".vibe-coder/run-config", style),
    credentialDir: normalise(absolute(credentialDir), style),
  };
}

/**
 * Build the launch plan for one run.
 *
 * @param inputs - Runtime, manifest, image reference and host paths
 * @returns The plan the launcher executes
 * @throws When a mount source is not permitted, the container name is
 *   unusable, or the resulting arguments would broaden the container's
 *   privileges
 */
export function buildContainerLaunchPlan(
  inputs: ContainerLaunchInputs,
): ContainerLaunchPlan {
  const { descriptor, manifest, image, containerName, hostPaths } = inputs;
  const providers = inputs.agentProviders ?? enabledAgentProviders();

  if (!CONTAINER_NAME_RE.test(containerName)) {
    throw new Error(
      `Refusing to launch: container name ${
        JSON.stringify(containerName)
      } is not a plain name the runtime accepts.`,
    );
  }
  if (image.trim() === "" || hasControlCharacter(image) || /\s/.test(image)) {
    throw new Error(
      `Refusing to launch: image reference ${
        JSON.stringify(image)
      } is empty or unframeable.`,
    );
  }
  // A launcher with no usable deadline would wait on a wedged container for
  // ever, which is the whole failure Issue #4173 exists to end.
  if (
    !Number.isFinite(inputs.watchdogSeconds) ||
    Math.floor(inputs.watchdogSeconds) < 1
  ) {
    throw new Error(
      `Refusing to launch: watchdog deadline ${inputs.watchdogSeconds} is not ` +
        `a positive number of seconds (Issue #4173).`,
    );
  }

  const targets = containerTargetPaths(manifest);
  // The host spelling is whatever the launcher handed over; the in-container
  // side stays POSIX either way, so both launchers produce one environment.
  const style = pathStyleFor(hostPaths.baseDir);
  const base = normalise(hostPaths.baseDir, style);
  const mounts: ContainerMount[] = [
    // The worker's own checkout: the driver it executes and the tree its
    // bootstrap self-updates. Read/write for that reason alone.
    { source: base, target: targets.base },
    // The work dir and its approval-state sibling ride named volumes
    // (Issue #4186): guest-owned filesystems at native speed, durable
    // across containers and image upgrades, and no browsable copy of the
    // worker's repositories on the host.
    {
      source: inputs.volumes?.work ?? WORK_VOLUME_NAME,
      target: targets.work,
      volume: true,
    },
    {
      source: inputs.volumes?.approvalState ?? APPROVAL_STATE_VOLUME_NAME,
      target: targets.approvalState,
      volume: true,
    },
    { source: normalise(hostPaths.logDir, style), target: targets.logs },
    // The staged copy of the configuration, read-only, in its own directory
    // outside the checkout mount: the worker reads this copy via CONFIG_PATH,
    // so nothing it does inside the container changes the config a run
    // consumes. (A file mount overlaid on the checkout is not an option —
    // see ContainerLaunchHostPaths.configStageDir.)
    {
      source: normalise(hostPaths.configStageDir, style),
      target: targets.config,
      readOnly: true,
    },
    // Credentials are exposed per sub-directory, not wholesale: the worker's
    // own `gh` material and each enabled provider's, and nothing else that may
    // sit beside them in the credential directory (Issues #4067, #4108). A
    // provider that is not enabled has no mount, so no vendor can read
    // another's secret from inside the container.
    ...[
      GH_CREDENTIAL_SUBDIR,
      ...providers.map((provider) => provider.credentials.subdir),
    ].map((subdir) => ({
      source: joinPath(
        normalise(hostPaths.credentialDir, style),
        subdir,
        style,
      ),
      target: `${targets.credentials}/${subdir}`,
      readOnly: true,
    })),
  ];

  const home = normalise(hostPaths.homeDir, style);
  for (const mount of mounts) {
    if (mount.volume) {
      // A named volume exposes no host path; what needs validating is that
      // the name is one every runtime accepts and no shell can misread.
      if (!VOLUME_NAME_RE.test(mount.source)) {
        throw new Error(
          `Refusing to launch: volume name ${
            JSON.stringify(mount.source)
          } is not a plain name the runtime accepts.`,
        );
      }
      continue;
    }
    assertMountSourcePermitted(mount.source, home, style);
  }

  const { dialect } = descriptor;
  const runArgs: string[] = ["run", "--rm", "--name", containerName];

  // VM sizing: never the runtime's 1 GiB memory default (see
  // ContainerResources). --cpus only when the caller resolved a real host
  // count: a static guess can exceed a small host's cores, which Docker
  // hard-rejects rather than clamps.
  runArgs.push("--memory", inputs.resources?.memory ?? "8g");
  if (inputs.resources?.cpus) {
    runArgs.push("--cpus", inputs.resources.cpus);
  }

  // Networking: outbound only. No published ports and never host networking.
  if (dialect.networkMode) runArgs.push("--network", dialect.networkMode);
  // Least privilege, where the runtime understands the flag. Apple container
  // gives each container its own lightweight VM and takes neither.
  if (dialect.supportsCapDrop) runArgs.push("--cap-drop", "ALL");
  if (dialect.supportsSecurityOpt) {
    runArgs.push("--security-opt", "no-new-privileges");
  }
  // A writable tmpfs keeps the container root filesystem disposable.
  if (dialect.supportsTmpfs) {
    runArgs.push("--tmpfs", "/tmp:rw,nosuid,nodev,exec,mode=1777");
  }

  for (const mount of mounts) {
    runArgs.push(...buildMountArguments(descriptor, mount));
  }

  runArgs.push("--workdir", targets.base);
  // The image already sets this; restating it keeps the entrypoint's base
  // directory explicit in the recorded invocation.
  runArgs.push("--env", `VIBE_BASE_DIR=${targets.base}`);
  // The worker resolves its configuration from CONFIG_PATH everywhere, so
  // this points every command inside the container at the staged read-only
  // copy rather than the writable one in the checkout mount.
  runArgs.push("--env", `CONFIG_PATH=${targets.config}/.config.json`);
  // Fleet telemetry names the real host, not the per-run container name.
  if (inputs.hostId) {
    runArgs.push("--env", `VIBE_HOST_ID=${inputs.hostId}`);
  }
  // The host's own disk reading (Issue #226): inside the container df sees
  // the virtual volume, not the filesystem it is thin-provisioned on.
  if (inputs.hostDisk) {
    runArgs.push(
      "--env",
      `VIBE_HOST_DISK_AVAIL_BYTES=${
        Math.floor(inputs.hostDisk.availableBytes)
      }`,
    );
    runArgs.push(
      "--env",
      `VIBE_HOST_DISK_TOTAL_BYTES=${Math.floor(inputs.hostDisk.totalBytes)}`,
    );
  }
  // Last, so the launcher can append the worker's own arguments after it.
  runArgs.push(image);

  assertRunArgumentsContained(runArgs);

  // The volume-ownership init (Issue #4186): a fresh named volume is
  // root-owned and the worker runs as the manifest's unprivileged account,
  // so root chowns the two mount roots (non-recursive — the roots are all
  // the runtime creates) before the worker starts. Only the volumes and the
  // image are visible to this run: no host mount, no credentials, no
  // network use. Idempotent, so the launchers re-run it every launch.
  const volumeMounts = mounts.filter((mount) => mount.volume);
  const initArgs: string[] = [
    "run",
    "--rm",
    "--name",
    `${containerName}-init`,
    "--user",
    "0:0",
    "--entrypoint",
    "chown",
    ...volumeMounts.flatMap(
      (mount) => buildMountArguments(descriptor, mount),
    ),
    image,
    `${manifest.user.uid}:${manifest.user.gid}`,
    ...volumeMounts.map((mount) => mount.target),
  ];
  assertRunArgumentsContained(initArgs);

  const buildArgs = [
    "build",
    "--file",
    inputs.containerfile ?? joinPath(base, "container/Containerfile", style),
    "--tag",
    image,
    joinPath(base, "container", style),
  ];

  return {
    runtime: descriptor.executable,
    image,
    containerName,
    watchdogSeconds: Math.floor(inputs.watchdogSeconds),
    mounts,
    // Only the read/write host mounts are the launcher's to create — since
    // Issue #4186 that is the log directory alone. A missing config file or
    // credential directory is a loud failure, not something to conjure an
    // empty replacement for.
    ensureDirectories: mounts
      .filter((mount) => !mount.volume && !mount.readOnly)
      .map((mount) => mount.source)
      .filter((source) => source !== base),
    volumes: volumeMounts.map((mount) => mount.source),
    initArgs,
    imageInspectArgs: [...dialect.imageInspectArgs, image],
    buildArgs,
    builderStopArgs: [...dialect.builderStopArgs],
    runArgs,
  };
}

/** Keys the rendered plan uses, in the order they are emitted. */
export type ContainerLaunchPlanKey =
  | "runtime"
  | "image"
  | "name"
  | "watchdog"
  | "ensure"
  | "volume"
  | "init"
  | "exists"
  | "build"
  | "run";

/** A parsed plan, as the launcher reconstructs it. */
export interface ParsedContainerLaunchPlan {
  runtime: string;
  image: string;
  name: string;
  watchdog: string;
  ensure: string[];
  volume: string[];
  init: string[];
  exists: string[];
  build: string[];
  run: string[];
}

/**
 * Render the plan as the NUL-delimited `key=value` stream `run.sh` reads.
 *
 * NUL framing means a host path may contain any character a filesystem
 * allows except NUL itself; paths carrying control characters are refused
 * before they reach here.
 *
 * @param plan - The plan to render
 * @returns The NUL-delimited stream
 * @throws When a value contains a NUL byte
 */
export function renderContainerLaunchPlan(plan: ContainerLaunchPlan): string {
  const tokens: string[] = [
    `runtime=${plan.runtime}`,
    `image=${plan.image}`,
    `name=${plan.containerName}`,
    `watchdog=${plan.watchdogSeconds}`,
    ...plan.ensureDirectories.map((dir) => `ensure=${dir}`),
    ...plan.volumes.map((name) => `volume=${name}`),
    ...plan.initArgs.map((arg) => `init=${arg}`),
    ...plan.imageInspectArgs.map((arg) => `exists=${arg}`),
    ...plan.buildArgs.map((arg) => `build=${arg}`),
    ...plan.builderStopArgs.map((arg) => `builder-stop=${arg}`),
    ...plan.runArgs.map((arg) => `run=${arg}`),
  ];

  for (const token of tokens) {
    if (token.includes("\0")) {
      throw new Error(
        "Refusing to emit a launch plan containing a NUL byte — the " +
          "launcher's framing would silently truncate it.",
      );
    }
  }

  return tokens.map((token) => `${token}\0`).join("");
}

/**
 * Parse a rendered plan back into its parts.
 *
 * Used by the tests to assert on what `run.sh` will execute; `run.sh` itself
 * parses the same stream in bash.
 *
 * @param text - A stream produced by {@link renderContainerLaunchPlan}
 * @returns The parsed plan
 * @throws When the stream carries an unknown key
 */
export function parseContainerLaunchPlanText(
  text: string,
): ParsedContainerLaunchPlan {
  const parsed: ParsedContainerLaunchPlan = {
    runtime: "",
    image: "",
    name: "",
    watchdog: "",
    ensure: [],
    volume: [],
    init: [],
    exists: [],
    build: [],
    run: [],
  };

  for (const token of text.split("\0")) {
    if (token === "" || token === "\n") continue;
    const separator = token.indexOf("=");
    if (separator < 0) {
      throw new Error(`Malformed launch-plan token: ${JSON.stringify(token)}`);
    }
    const key = token.slice(0, separator);
    const value = token.slice(separator + 1);
    switch (key) {
      case "runtime":
        parsed.runtime = value;
        break;
      case "image":
        parsed.image = value;
        break;
      case "name":
        parsed.name = value;
        break;
      case "watchdog":
        parsed.watchdog = value;
        break;
      case "ensure":
        parsed.ensure.push(value);
        break;
      case "volume":
        parsed.volume.push(value);
        break;
      case "init":
        parsed.init.push(value);
        break;
      case "exists":
        parsed.exists.push(value);
        break;
      case "build":
        parsed.build.push(value);
        break;
      case "run":
        parsed.run.push(value);
        break;
      default:
        throw new Error(`Unknown launch-plan key: ${key}`);
    }
  }

  return parsed;
}
