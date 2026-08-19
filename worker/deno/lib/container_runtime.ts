/**
 * Container-runtime detection and validation (Issue #4063).
 *
 * The Vibe Coder runs inside a container by default (Issue #4060), so in
 * container mode the launchers must resolve a supported runtime before they do
 * anything else:
 *
 * - **macOS** — Apple `container` (https://github.com/apple/container)
 * - **Linux / Windows** — Docker or Podman, auto-detected in that order
 *
 * Two properties matter more than the list itself:
 *
 * 1. **Presence is not availability.** A runtime on `PATH` whose daemon is
 *    unreachable is rejected, not selected — every candidate is validated with
 *    a cheap read-only probe (`docker version`, `container system status`).
 * 2. **Detection never falls back to the host.** Nothing here can return "run
 *    on the host instead": the outcome is either a descriptor naming a
 *    container runtime or a loud `ContainerRuntimeUnavailableError`
 *    (Issue #3234). There is no host mode at all (Issue #4: containment is
 *    mandatory), so nothing can be selected because a runtime is absent.
 *
 * Platform and probe are both injectable, so every branch is testable on a host
 * with none of the runtimes installed.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { runWithTimeout } from "./subprocess_timeout.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Host platforms the Vibe Coder launchers support. */
export const SUPPORTED_HOST_PLATFORMS = [
  "darwin",
  "linux",
  "windows",
] as const;

/** A host platform the launchers support. */
export type HostPlatform = typeof SUPPORTED_HOST_PLATFORMS[number];

/**
 * The container runtimes the launchers know how to drive.
 *
 * Deliberately exhaustive: there is no "native" or "host" member, because a
 * non-container outcome is not a supported way to run the worker.
 */
export const CONTAINER_RUNTIME_KINDS = [
  "apple-container",
  "docker",
  "podman",
] as const;

/** A supported container runtime. */
export type ContainerRuntimeKind = typeof CONTAINER_RUNTIME_KINDS[number];

/**
 * The argument-dialect differences the launchers need.
 *
 * `run.sh` and `run.ps1` read these rather than each embedding per-runtime
 * special cases.
 */
export interface ContainerRuntimeDialect {
  /** Flag introducing a bind mount, e.g. `--volume`. */
  mountFlag: string;
  /** Separator between the host and container path in a mount value. */
  mountSeparator: string;
  /** Suffix that makes a mount read-only, e.g. `:ro`. */
  readOnlyMountSuffix: string;
  /** Whether `--userns=<mode>` is understood. */
  supportsUserns: boolean;
  /** Whether `--security-opt <option>` is understood. */
  supportsSecurityOpt: boolean;
  /** Whether `--cap-drop <capability>` is understood. */
  supportsCapDrop: boolean;
  /** Whether `--tmpfs <mount>` is understood. */
  supportsTmpfs: boolean;
  /**
   * Explicit non-host network mode to request, when the runtime takes one.
   * Undefined means "leave the runtime's own default", which is never host
   * networking on any supported runtime.
   */
  networkMode?: string;
  /** Sub-command that reports whether an image is present locally. */
  imageInspectArgs: readonly string[];
  /**
   * Sub-command that stops the runtime's persistent build helper (Issue
   * #4331), or empty when the runtime has none. Apple container starts a
   * `buildkit` builder VM for `container build` and leaves it running —
   * 2 CPUs, 2 GB, a 13 GB rootfs — for ever; Docker and Podman build
   * in-process and have nothing to stop.
   */
  builderStopArgs: readonly string[];
  /**
   * Sub-commands that restart the runtime's build helper, in order (Issue
   * #4441). Each entry is one complete invocation.
   *
   * Apple container's BuildKit builder VM remounts its own filesystem
   * read-only after an ENOSPC and stays that way until it is restarted, so
   * every later launch failed with `read-only file system` before it built
   * anything. Docker and Podman build in-process and have no VM to bounce;
   * pruning the build cache is the equivalent remedy for a builder store that
   * ran out of room.
   */
  builderRestartArgs: readonly (readonly string[])[];
  /**
   * Sub-commands that recreate the build helper from scratch, in order
   * (Issue #4441) — the escalation when a restart did not clear the failure.
   */
  builderRecreateArgs: readonly (readonly string[])[];
  /**
   * Sub-command that lists the local images (Issue #4162).
   *
   * Read by the image prune, which deletes every `vibe-coder` tag other than
   * the one this checkout resolves to, so the spelling difference stays here
   * with the rest of the dialect rather than in the launchers.
   */
  imageListArgs: readonly string[];
  /** Sub-command that removes one image, before its reference (#4162). */
  imageRemoveArgs: readonly string[];
  /**
   * Sub-command that lists the running containers as JSON (Issue #4173).
   *
   * The watchdog's pre-launch reaper reads this to find leaked `vibe-coder-*`
   * containers, so the spelling difference stays here with the rest of the
   * dialect rather than in the launchers or the reaper.
   */
  listArgs: readonly string[];
}

/** One runtime the detector may probe on a given platform. */
export interface ContainerRuntimeCandidate {
  /** Normalised runtime identity. */
  kind: ContainerRuntimeKind;
  /** Command looked up on `PATH`. */
  executable: string;
  /** Name used in operator-facing messages. */
  displayName: string;
  /** Cheap read-only probe arguments (no side effects). */
  probeArgs: readonly string[];
  /**
   * Arguments that start this runtime's own service, when its CLI can.
   *
   * Apple `container` can (`container system start`), which is what makes a
   * stopped service a cheaper failure than an absent binary (Issue #4136).
   * Docker Desktop and Podman machines are started outside the probe's reach,
   * so they leave this undefined and keep their manual hint.
   */
  serviceStartArgs?: readonly string[];
  /** How an operator installs this runtime. */
  installHint: string;
  /** Argument dialect for this runtime. */
  dialect: ContainerRuntimeDialect;
}

/** What a probe reports about one candidate. */
export interface ContainerRuntimeProbeResult {
  /** True only when the runtime is present *and* answered its probe. */
  available: boolean;
  /** Resolved executable path, when the probe found one. */
  path?: string;
  /** Why the candidate was rejected — named in the failure message. */
  reason?: string;
}

/** Validates one candidate. Injectable so tests need no runtime installed. */
export type ContainerRuntimeProbe = (
  candidate: ContainerRuntimeCandidate,
) => Promise<ContainerRuntimeProbeResult>;

/** The normalised runtime decision the launchers consume. */
export interface ContainerRuntimeDescriptor {
  /** Platform the decision was made for. */
  platform: HostPlatform;
  /** Which runtime was selected. */
  kind: ContainerRuntimeKind;
  /** Executable path (or command name) the launchers invoke. */
  executable: string;
  /** Human-readable name of the selected runtime. */
  displayName: string;
  /** Argument dialect the launchers must use. */
  dialect: ContainerRuntimeDialect;
  /** Runtimes probed, in order, up to and including the one selected. */
  probed: ContainerRuntimeKind[];
}

/** One rejected candidate, kept so the failure message can name it. */
export interface ContainerRuntimeFailure {
  kind: ContainerRuntimeKind;
  displayName: string;
  executable: string;
  /** Why it was rejected (not installed, daemon unreachable, …). */
  reason: string;
  installHint: string;
  /**
   * True when the probe found the executable but it did not answer — a
   * stopped service rather than a missing install. The two failures have very
   * different fixes, so the distinction is kept rather than flattened
   * (Issue #4136).
   */
  binaryPresent: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when the host platform is not one the launchers support. */
export class UnsupportedHostPlatformError extends Error {
  constructor(public readonly platform: string) {
    super(
      `Unsupported host platform: ${platform}. The Vibe Coder launchers ` +
        `support ${SUPPORTED_HOST_PLATFORMS.join(", ")} only, in either run ` +
        `mode — an unsupported platform is not a reason to run uncontained.`,
    );
    this.name = "UnsupportedHostPlatformError";
  }
}

/** Raised when no supported runtime on this platform passed its probe. */
export class ContainerRuntimeUnavailableError extends Error {
  constructor(
    public readonly platform: HostPlatform,
    public readonly failures: ContainerRuntimeFailure[],
  ) {
    super(buildUnavailableMessage(platform, failures));
    this.name = "ContainerRuntimeUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// The runtime catalogue
// ---------------------------------------------------------------------------

/** Docker and Podman share the OCI-style flag dialect. */
const OCI_DIALECT: ContainerRuntimeDialect = {
  mountFlag: "--volume",
  mountSeparator: ":",
  readOnlyMountSuffix: ":ro",
  supportsUserns: true,
  supportsSecurityOpt: true,
  supportsCapDrop: true,
  supportsTmpfs: true,
  // Explicit rather than implicit: the launcher asks for bridge networking so
  // a reviewer can see host networking was never requested.
  networkMode: "bridge",
  imageInspectArgs: ["image", "inspect"],
  // A reference per line rather than `--format json`: the Go template has been
  // understood by both Docker and Podman for far longer than the `json`
  // shorthand, and one reference per line is what the prune compares anyway.
  imageListArgs: ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"],
  imageRemoveArgs: ["image", "rm"],
  builderStopArgs: [],
  // No builder VM to bounce (Issue #4441): the equivalent remedy for a build
  // that died on storage is to drop the build cache, which is what fills the
  // builder store. The escalation is the same command — there is nothing
  // further to recreate.
  builderRestartArgs: [["builder", "prune", "-f"]],
  builderRecreateArgs: [["builder", "prune", "-f"]],
  listArgs: ["ps", "--format", "json"],
};

/**
 * Apple `container` takes `--volume src:dst[:ro]` but has neither `--userns`,
 * `--security-opt`, `--cap-drop` nor `--tmpfs` — each container is already
 * its own lightweight VM with its own IP address, so there is no host
 * namespace to opt out of (apple/container `docs/command-reference.md`).
 */
const APPLE_DIALECT: ContainerRuntimeDialect = {
  mountFlag: "--volume",
  mountSeparator: ":",
  readOnlyMountSuffix: ":ro",
  supportsUserns: false,
  supportsSecurityOpt: false,
  supportsCapDrop: false,
  supportsTmpfs: false,
  // Singular `image` — `container images ...` is not a subcommand on Apple
  // container 1.2.2: the CLI resolves it as a plugin named `container-images`,
  // fails, and exits 64. run.sh reads any non-zero exists-check as "image
  // absent", so the plural argv would trigger a full rebuild on every launch.
  imageInspectArgs: ["image", "inspect"],
  // No Go templates here, so the prune reads the JSON listing instead
  // (Issue #4162), and the removal is spelled `delete` rather than `rm`.
  imageListArgs: ["image", "list", "--format", "json"],
  imageRemoveArgs: ["image", "delete"],
  // The builder VM outlives the build it was started for (Issue #4331):
  // stop it once the image exists so it stops holding 2 CPUs, 2 GB and a
  // 13 GB rootfs on every fleet host. `builder start` is implicit on the
  // next `container build`, so stopping costs nothing but a cold builder
  // on the next definition change.
  builderStopArgs: ["builder", "stop"],
  // The builder VM remounts its filesystem read-only after an ENOSPC and
  // stays that way until it is restarted (Issue #4441): a stop/start is what
  // a human ran by hand on host-23 to end a launch loop that had already
  // backed off to 960 s. `builder delete` + `builder start` is the
  // escalation, for a builder whose backing volume is itself damaged.
  builderRestartArgs: [["builder", "stop"], ["builder", "start"]],
  builderRecreateArgs: [["builder", "delete"], ["builder", "start"]],
  // Apple container spells the listing `container list`; `ps` is not a
  // sub-command there (Issue #4173).
  listArgs: ["list", "--format", "json"],
};

/** Every runtime the launchers know, keyed by kind. */
export const CONTAINER_RUNTIMES: Readonly<
  Record<ContainerRuntimeKind, ContainerRuntimeCandidate>
> = {
  "apple-container": {
    kind: "apple-container",
    executable: "container",
    displayName: "Apple container",
    // `system status` health-checks the API server, so a stopped service is
    // reported as unavailable rather than passing on the binary's presence.
    probeArgs: ["system", "status"],
    // `--enable-kernel-install`: setup runs this step with stdin closed, and
    // without the flag a first start prompts "Install the recommended default
    // kernel? [Y/n]", dies with "Error: failed to read user input", and
    // leaves a kernel-less runtime that cannot run containers. The consent
    // question names this argv, so the kernel download is agreed to up front.
    serviceStartArgs: ["system", "start", "--enable-kernel-install"],
    installHint:
      "install Apple container from https://github.com/apple/container " +
      "and run `container system start`",
    dialect: APPLE_DIALECT,
  },
  docker: {
    kind: "docker",
    executable: "docker",
    displayName: "Docker",
    // `docker version` contacts the daemon, so a stopped daemon exits non-zero.
    probeArgs: ["version"],
    installHint:
      "install Docker from https://docs.docker.com/get-docker/ and start the " +
      "Docker daemon",
    dialect: OCI_DIALECT,
  },
  podman: {
    kind: "podman",
    executable: "podman",
    displayName: "Podman",
    probeArgs: ["version"],
    installHint:
      "install Podman from https://podman.io/docs/installation (on Windows " +
      "also run `podman machine start`)",
    dialect: OCI_DIALECT,
  },
};

/**
 * Probe order per platform.
 *
 * macOS deliberately lists only Apple `container`: Docker Desktop on macOS is
 * not the containment boundary Issue #4060 specifies.
 */
const PLATFORM_RUNTIME_ORDER: Readonly<
  Record<HostPlatform, readonly ContainerRuntimeKind[]>
> = {
  darwin: ["apple-container"],
  linux: ["docker", "podman"],
  windows: ["docker", "podman"],
};

/** Aliases accepted for each supported platform. */
const PLATFORM_ALIASES: Readonly<Record<string, HostPlatform>> = {
  darwin: "darwin",
  macos: "darwin",
  "mac os": "darwin",
  osx: "darwin",
  linux: "linux",
  windows: "windows",
  win32: "windows",
  win: "windows",
};

// ---------------------------------------------------------------------------
// Platform + candidates
// ---------------------------------------------------------------------------

/**
 * Normalise a platform name (e.g. `Deno.build.os`) to a supported platform.
 *
 * @param os - Raw platform name
 * @returns The supported platform it denotes
 * @throws {UnsupportedHostPlatformError} When the platform is not supported
 */
export function normaliseHostPlatform(os: string): HostPlatform {
  const key = os.trim().toLowerCase();
  const platform = PLATFORM_ALIASES[key];
  if (!platform) throw new UnsupportedHostPlatformError(os.trim());
  return platform;
}

/**
 * The runtimes probed on a platform, in preference order.
 *
 * @param platform - Supported host platform
 * @returns Candidates in probe order
 */
export function candidatesForPlatform(
  platform: HostPlatform,
): ContainerRuntimeCandidate[] {
  return PLATFORM_RUNTIME_ORDER[platform].map((kind) =>
    CONTAINER_RUNTIMES[kind]
  );
}

// ---------------------------------------------------------------------------
// The default probe
// ---------------------------------------------------------------------------

/** How long a probe may take before it is treated as unavailable. */
const PROBE_TIMEOUT_MS = 15_000;

/** Keep a runtime's diagnostic output to one short, single-line reason. */
function firstLine(text: string, limit = 200): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) =>
    part !== ""
  );
  if (!line) return "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/**
 * Run a candidate's read-only probe command.
 *
 * A missing executable, a non-zero exit, or a probe that does not answer
 * within {@link PROBE_TIMEOUT_MS} all mean "not available" — presence on
 * `PATH` alone never counts.
 */
export const defaultContainerRuntimeProbe: ContainerRuntimeProbe = async (
  candidate,
) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const command = new Deno.Command(candidate.executable, {
      args: [...candidate.probeArgs],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    });
    const output = await command.output();
    if (output.success) return { available: true, path: candidate.executable };

    const detail = firstLine(new TextDecoder().decode(output.stderr)) ||
      firstLine(new TextDecoder().decode(output.stdout));
    const probe = `${candidate.executable} ${candidate.probeArgs.join(" ")}`;
    return {
      available: false,
      path: candidate.executable,
      reason: `\`${probe}\` exited ${output.code}${
        detail ? `: ${detail}` : ""
      }`,
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        available: false,
        reason: `\`${candidate.executable}\` was not found on PATH`,
      };
    }
    if (controller.signal.aborted) {
      return {
        available: false,
        path: candidate.executable,
        reason: `\`${candidate.executable} ${
          candidate.probeArgs.join(" ")
        }\` did not answer within ${PROBE_TIMEOUT_MS / 1000}s`,
      };
    }
    return {
      available: false,
      reason: `probing \`${candidate.executable}\` failed: ${
        (error as Error).message
      }`,
    };
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Options for {@link detectContainerRuntime}. */
export interface DetectContainerRuntimeOptions {
  /** Platform to resolve for. Defaults to `Deno.build.os`. */
  platform?: string;
  /** Probe used to validate each candidate. Defaults to the real one. */
  probe?: ContainerRuntimeProbe;
  /**
   * Attempt a one-shot bounded service start when a candidate's binary is
   * present but its service is not answering, then re-probe (Issue #4253).
   * Opt-in: only the launch path sets this — setup and the read-only
   * prerequisite probe keep their side-effect-free behaviour. host-25 sat
   * dark ~5 h across 21 launcher invocations (including after a reboot)
   * because the probe knew `container system start` would fix it and the
   * launcher never ran it.
   */
  selfHeal?: boolean;
  /** Runs a candidate's service-start command. Injectable for tests. */
  serviceStarter?: (
    executable: string,
    args: readonly string[],
  ) => Promise<{ ok: boolean; detail?: string }>;
  /**
   * Self-heal progress lines. The launch-plan command prints its plan on
   * stdout, so its wiring must send these to stderr.
   */
  log?: (message: string) => void;
  /** Optional self-heal event sink (production wires emitSelfHealEventAuto). */
  emitSelfHealEvent?: (event: {
    module: string;
    action: string;
    reason: string;
    result: "ok" | "skipped" | "failed";
  }) => Promise<boolean>;
}

/** Bound on the one-shot service start (Issue #4253). */
export const SERVICE_START_TIMEOUT_MS = 60_000;

/** Real service starter: run the start command, bounded, capture the tail. */
async function defaultServiceStarter(
  executable: string,
  args: readonly string[],
): Promise<{ ok: boolean; detail?: string }> {
  const result = await runWithTimeout(executable, [...args], {
    timeoutMs: SERVICE_START_TIMEOUT_MS,
  });
  if (!result.ok) return { ok: false, detail: result.error.message };
  if (result.value.timedOut) {
    return {
      ok: false,
      detail: `timed out after ${SERVICE_START_TIMEOUT_MS / 1000}s`,
    };
  }
  if (!result.value.success) {
    return {
      ok: false,
      detail: (result.value.stderr || result.value.stdout)
        .trim().split("\n").slice(-2).join(" | "),
    };
  }
  return { ok: true };
}

/**
 * Resolve the container runtime this host must use.
 *
 * Candidates are probed in platform preference order and the first one that
 * answers its probe wins. There is no fallback outcome: when nothing answers,
 * the call throws.
 *
 * @param options - Platform and probe overrides (both injectable for tests)
 * @returns The normalised descriptor the launchers consume
 * @throws {UnsupportedHostPlatformError} When the platform is not supported
 * @throws {ContainerRuntimeUnavailableError} When no candidate is available
 */
export async function detectContainerRuntime(
  options: DetectContainerRuntimeOptions = {},
): Promise<ContainerRuntimeDescriptor> {
  const platform = normaliseHostPlatform(options.platform ?? Deno.build.os);
  const probe = options.probe ?? defaultContainerRuntimeProbe;

  const probed: ContainerRuntimeKind[] = [];
  const failures: ContainerRuntimeFailure[] = [];

  for (const candidate of candidatesForPlatform(platform)) {
    probed.push(candidate.kind);
    let result = await probe(candidate);

    // Launcher self-heal (Issue #4253): the binary answered but its service
    // did not, and this candidate knows how to start it — try once,
    // bounded, then re-probe. An absent install has nothing to start.
    if (
      !result.available && options.selfHeal &&
      result.path !== undefined && candidate.serviceStartArgs
    ) {
      const starter = options.serviceStarter ?? defaultServiceStarter;
      const startCommand = [candidate.executable, ...candidate.serviceStartArgs]
        .join(" ");
      options.log?.(
        `[container-runtime] ${candidate.displayName} probe failed (` +
          `${result.reason ?? "unavailable"}) with the binary present — ` +
          `attempting '${startCommand}' (Issue #4253)`,
      );
      const outcome = await starter(result.path, candidate.serviceStartArgs);
      if (outcome.ok) {
        result = await probe(candidate);
      }
      const healed = outcome.ok && result.available;
      options.log?.(
        healed
          ? `[container-runtime] ${candidate.displayName}: service started; ` +
            `the probe now passes`
          : `[container-runtime] ${candidate.displayName}: self-heal failed` +
            (outcome.detail ? ` (${outcome.detail})` : ""),
      );
      try {
        await options.emitSelfHealEvent?.({
          module: "container_runtime",
          action: "container_service_restart",
          reason: `${candidate.displayName}: service was not answering — ` +
            `ran '${startCommand}'` +
            (healed ? "" : ` — ${outcome.detail ?? "probe still failing"}`),
          result: healed ? "ok" : "failed",
        });
      } catch {
        // Telemetry must never fail runtime detection.
      }
    }

    if (result.available) {
      return {
        platform,
        kind: candidate.kind,
        executable: result.path ?? candidate.executable,
        displayName: candidate.displayName,
        dialect: candidate.dialect,
        probed,
      };
    }

    failures.push({
      kind: candidate.kind,
      displayName: candidate.displayName,
      executable: result.path ?? candidate.executable,
      reason: result.reason ?? "the probe reported it unavailable",
      installHint: candidate.installHint,
      // The probe only resolves a path when it actually found the executable.
      binaryPresent: result.path !== undefined,
    });
  }

  throw new ContainerRuntimeUnavailableError(platform, failures);
}

/** Build the actionable message an unavailable runtime exits with. */
function buildUnavailableMessage(
  platform: HostPlatform,
  failures: ContainerRuntimeFailure[],
): string {
  const probed = failures
    .map((failure) =>
      `  - ${failure.displayName} (${failure.executable}): ${failure.reason}`
    )
    .join("\n");
  const hints = failures
    .map((failure) => `  - ${failure.displayName}: ${failure.installHint}`)
    .join("\n");

  return [
    `No supported container runtime is available on ${platform}.`,
    "",
    "Probed:",
    probed,
    "",
    "To fix this, install and start one of:",
    hints,
    "",
    "Container mode has no host fallback (Issues #4060, #4): containment " +
    "is mandatory, so this fails rather than running the worker on the host. " +
    "Install a supported runtime (./setup.sh offers to) and launch again.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Dialect helpers
// ---------------------------------------------------------------------------

/** A mount the launchers hand to the runtime. */
export interface ContainerMount {
  /**
   * Host path to expose — or, when {@link ContainerMount.volume} is set, the
   * name of a runtime-managed named volume (Issue #4186).
   */
  source: string;
  /** Absolute path inside the container. */
  target: string;
  /** Mount read-only. Defaults to read/write. */
  readOnly?: boolean;
  /**
   * True when `source` names a runtime-managed named volume rather than a
   * host path (Issue #4186). Every supported runtime spells both the same
   * way (`--volume <source>:<target>`); the flag exists so the containment
   * checks know no host path is being exposed.
   */
  volume?: boolean;
}

/**
 * Render one bind mount in the selected runtime's dialect.
 *
 * Keeps mount syntax in this module rather than duplicated across `run.sh` and
 * `run.ps1`.
 *
 * @param descriptor - The resolved runtime
 * @param mount - The mount to render
 * @returns Arguments to append to the runtime invocation
 * @throws When the mount is empty or the container path is not absolute
 */
export function buildMountArguments(
  descriptor: ContainerRuntimeDescriptor,
  mount: ContainerMount,
): string[] {
  const source = mount.source.trim();
  const target = mount.target.trim();

  if (source === "") {
    throw new Error("Mount source is empty — refusing to build a mount");
  }
  if (target === "") {
    throw new Error(
      `Mount target is empty for source ${source} — refusing to build a mount`,
    );
  }
  if (!target.startsWith("/")) {
    throw new Error(
      `Mount target must be an absolute container path, got: ${target}`,
    );
  }

  const { mountFlag, mountSeparator, readOnlyMountSuffix } = descriptor.dialect;
  const value = `${source}${mountSeparator}${target}${
    mount.readOnly ? readOnlyMountSuffix : ""
  }`;
  return [mountFlag, value];
}
