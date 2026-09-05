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
 * | the worker checkout        | `/workspace`                       | ro   |
 * | volume `vibe-work`         | `/home/vibe/auto-issue-work`       | rw   |
 * | volume `vibe-approval-state`| `…/auto-issue-work-approval-state`| rw   |
 * | the worker log directory   | `/home/vibe/logs`                  | rw   |
 * | staged `.config.json` dir  | `/home/vibe/.vibe-coder/run-config`| ro   |
 * | the `gh` credential dir    | `…/credentials/gh`                 | ro   |
 * | each enabled provider's dir| `…/credentials/<provider>`         | ro   |
 *
 * The first is the worker's own code, not host data: the image ships only the
 * entrypoint, so without the checkout at the manifest `workdir` there is no
 * driver to run. It is mounted **read-only** (Issue #514) — the Vibe Coder
 * never modifies the running code. The rest are the persistent state
 * Issue #4060 enumerates. Their in-container paths are
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
 * ## The read-only root filesystem
 *
 * Where the runtime understands it, the container root filesystem is mounted
 * **immutable** (`--read-only`, Issue #516) and the only writable places left
 * are the mounts above, the named volumes, and the scratch tmpfs mounts in
 * {@link SCRATCH_TMPFS_MOUNTS}. A compromise inside the container can then
 * persist nothing that survives the launch it happened in.
 *
 * `--read-only` and those tmpfs mounts are **one decision, not two**: a
 * read-only root with no writable scratch is a container that cannot run.
 * Tmpfs support is therefore a *precondition* of read-only support — a
 * dialect claiming one without the other is refused loudly rather than
 * silently emitting half the pair — and a dialect that takes no tmpfs gets
 * **neither**. Apple `container` is that dialect (`supportsTmpfs: false`,
 * `supportsReadOnly: false`): each container there is its own lightweight VM,
 * which is the compensating control, and `container/entrypoint.sh` resolves
 * its scratch root onto the `vibe-work` volume instead (Issue #515).
 * {@link assertRunArgumentsContained} then re-checks the finished list — the
 * flag must be present for a supporting dialect and can never appear without
 * its scratch — so neither half can be dropped by a later edit.
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
  type TmpfsOwnershipStyle,
} from "./container_runtime.ts";
import type { ContainerManifest } from "./container_manifest.ts";
import {
  DEFAULT_CREDENTIAL_DIR_SUFFIX,
  GH_CREDENTIAL_SUBDIR,
} from "./credential_preflight.ts";
import {
  AGENT_PROVIDERS_BUILD_ARG,
  type AgentProviderDescriptor,
  agentProvidersBuildValue,
  enabledAgentProviders,
} from "./agent_provider.ts";
import { resolveContentApprovalStateDir } from "./content_approval_state_dir.ts";
import {
  CUSTOM_PROMPT_PATH_MAP_ENV,
  CUSTOM_PROMPTS_TARGET_SUBDIR,
  planCustomPromptMounts,
} from "./custom_prompt_mounts.ts";

/**
 * Named volume holding the worker's work directory (Issue #4186): repo
 * clones, build churn, agent transcripts and session stores. Fixed name —
 * never derived from the per-run container name or the image tag — so the
 * content survives every cycle and every image upgrade.
 */
/** The image's volume-init script (container/volume-init.sh, Issue #229). */
export const VOLUME_INIT_ENTRYPOINT = "/usr/local/bin/vibe-volume-init";

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
   * The claiming floor this deployment states (Issue #732). Omitted → the
   * environment overrides and then the defaults, which is what every host had
   * before the floor was configurable.
   */
  claimFloors?: DiskFloors;
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
   * The deployer-selected build-time tools (#5), as the compact JSON the
   * Containerfile's `VIBE_CONTAINER_TOOLS` build arg carries and
   * install-tools.sh (#70) consumes (Issue #72). Absent or empty → no
   * `--build-arg`, so the default fleet build is byte-for-byte unchanged.
   * The caller validates the spec (#69) before setting this.
   */
  containerToolsSpecJson?: string;
  /**
   * The host's own short hostname, passed into the container as
   * VIBE_HOST_ID so fleet telemetry names the real machine
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
   * The supervisor's wall-clock cap and the epoch-seconds this run started
   * (Issue #421), passed in as VIBE_RUN_MAX_SECONDS / VIBE_RUN_STARTED_EPOCH
   * so the worker's progress-extension policy can stop the run before
   * `loop.sh`'s `timeout` does. Optional: absent — a launcher invoked outside
   * loop.sh, or a host that disabled the cap — means the worker applies no
   * ceiling, which is the behaviour that shipped before this issue.
   */
  runCap?: { maxSeconds: number; startedEpochSeconds: number };
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
  /**
   * Absolute host paths of the operator's `custom_label_prompts` templates
   * (Issue #850, part of #843), in configuration order.
   *
   * Their containing directories are mounted **read-only** and the plan
   * carries the host → in-container translation the worker applies when it
   * loads the same `.config.json` inside the container. Absent or empty — the
   * deployment configured none — adds no mount and no variable, so the plan
   * is byte-identical to what an unconfigured host had before.
   */
  customPromptPaths?: readonly string[];
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
  /**
   * Where the operator's own prompt directories are mounted (Issue #850).
   * Each configured directory lands in a numbered sub-directory of this one.
   */
  customPrompts: string;
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
  /**
   * Arguments that remove one named volume, before its name (Issue #731).
   *
   * The verb is the runtime's, not the launcher's guess: Docker and Podman
   * spell it `volume rm`, Apple `container` spells it `volume delete`, and
   * `run.sh` hardcoded the latter — which Podman does not have, so recovery
   * removed nothing and the `volume create` after it failed on a name that
   * was still taken.
   */
  volumeRemoveArgs: string[];
  /**
   * The claiming floor the launcher's own disk decisions use (Issue #732):
   * the gigabyte term, the percentage term, and where each came from.
   *
   * Resolved here — where the deployment's `.config.json` can be read —
   * rather than in `run.sh`, which had the two environment variables and
   * nothing else. On a 1.875 TB filesystem the 10 % default term is ≈ 187 GB,
   * so a host with 37.5 GB free was judged low and refused work; the default
   * formula is unchanged, but a deployment can now state its own.
   */
  claimFloorGb: number;
  claimFloorPercent: number;
  /** Where each floor term came from, e.g. `gb=env,percent=config`. */
  claimFloorOrigin: string;
  /** Arguments that report whether the image is already present. */
  imageInspectArgs: string[];
  /** Arguments that build the image. */
  buildArgs: string[];
  /**
   * Arguments that stop the runtime's persistent build helper after the
   * image exists (Issue #4331) — empty for runtimes that have none.
   */
  builderStopArgs: string[];
  /**
   * Error-text fragments meaning "there is no builder to stop" (Issue
   * #492) — empty for runtimes with no builder helper.
   */
  builderAbsentPatterns: string[];
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

/**
 * The writable scratch a read-only root filesystem is given in its place
 * (Issue #516), in the order they are passed.
 *
 * Each is a tmpfs, so it is per-launch by construction and dies with the
 * container — the durable state is on the mounts and the named volumes.
 * `nosuid,nodev` everywhere, and `exec` only where it is genuinely needed:
 *
 * - `/tmp` keeps `exec` and `mode=1777`. It is the entrypoint's scratch root
 *   (`VIBE_SCRATCH_DIR`), `TMPDIR`, and the browser profile, and the agent
 *   runs scratch scripts it writes there.
 * - `/var/tmp` is pure data — POSIX's other world-writable scratch directory,
 *   which tools reach for without asking and which nothing in the writable-path
 *   inventory owns — so it is `noexec`.
 *
 * `/run` is deliberately **not** here: the image ships it root-owned `0755`
 * and the worker runs as an unprivileged account, so it was never writable
 * from inside the container and a tmpfs would only hand a root this container
 * does not have somewhere to write.
 */
/**
 * Where the container keeps its credential copies (Issue #570).
 *
 * `/run` by convention: it is tmpfs by definition, and every runtime with a
 * secrets primitive puts them there.
 */
export const SECRETS_MOUNT_PATH = "/run/vibe-secrets";

export const SCRATCH_TMPFS_MOUNTS: readonly string[] = [
  "/tmp:rw,nosuid,nodev,exec,mode=1777",
  "/var/tmp:rw,nosuid,nodev,noexec,mode=1777",
  // The credential copies, on their own mount away from the agents' scratch
  // (Issue #570). `/run` is where every runtime with a secrets primitive puts
  // them — Docker and Podman `--secret` land at `/run/secrets`, Kubernetes
  // mounts a Secret on tmpfs, systemd's `LoadCredential=` uses
  // `$CREDENTIALS_DIRECTORY` — and for the same reasons: memory-backed, so
  // nothing touches disk, enters an image layer or survives the container.
  //
  // `noexec` and `mode=0700`: a credential is data, and only the worker's own
  // account has business reading it. The agents' `/tmp` above is `1777` and
  // `exec` precisely because they need that; the secrets mount is the
  // opposite of it in both respects. Issue #564 is what this prevents — the
  // gh credential was staged in that world-writable `/tmp` and deleted
  // mid-run by something in the agents' churn.
  // `${uid}`/`${gid}` are substituted per launch by `secretsTmpfsMount` — a
  // `mode=0700` tmpfs mounted root-owned is unusable by an unprivileged
  // process, which the live containment probe caught in CI:
  //
  //     mount: /run/vibe-secrets — expected writable, was not-writable
  //
  // Docker honours `uid=`/`gid=`, so the mount arrives owned by the worker
  // and 0700 means what it says. Apple container ignores the options
  // entirely and mounts 1777 root-owned; there the entrypoint's own 0700
  // subdirectory is the protection instead. Podman refuses the pair outright
  // and spells the same request `U`, which `tmpfsArgument` substitutes per
  // dialect (Issue #727).
  `${SECRETS_MOUNT_PATH}:rw,nosuid,nodev,noexec,mode=0700,uid=\${uid},gid=\${gid}`,
];

/**
 * The scratch mounts for one launch, with the container user substituted in.
 *
 * @param user - The image's unprivileged account, from the manifest.
 */
export function scratchTmpfsMounts(
  user: { uid: number; gid: number },
): string[] {
  return SCRATCH_TMPFS_MOUNTS.map((mount) =>
    mount.replace("${uid}", String(user.uid)).replace(
      "${gid}",
      String(user.gid),
    )
  );
}

/** The kernel tmpfs options that name an owner (Issue #727). */
const TMPFS_OWNER_OPTION = /^(uid|gid)=/;

/**
 * The `--tmpfs` value this dialect will actually honour (Issue #570, #727).
 *
 * A dialect that ignores the `path:options` form gets the bare path: passing
 * options it does not parse mounts a directory *named* for the whole string
 * and leaves the intended path absent — a failure that looks like success.
 * The entrypoint applies the permissions there instead.
 *
 * Ownership is a second, narrower question (Issue #727). Podman parses the
 * option list but hands it to the OCI runtime rather than the kernel's tmpfs
 * parser, so `uid=`/`gid=` are refused — `unknown mount option "uid=1000"` —
 * and the refusal kills the launch. Its own spelling is `U`, which Podman
 * rewrites into the exec user's `uid=`/`gid=` before the runtime sees the
 * mount. Only the ownership pair is rewritten: `mode=0700` and `noexec` are
 * honoured by Podman as they are by Docker, and dropping them would hand back
 * the world-readable credential directory Issue #564 closed.
 *
 * @param dialect - The runtime's tmpfs capabilities.
 * @param mount - A declared `path:options` scratch mount, already substituted.
 * @returns The value to pass after `--tmpfs`.
 */
export function tmpfsArgument(
  dialect: {
    tmpfsHonoursOptions: boolean;
    tmpfsOwnership: TmpfsOwnershipStyle;
  },
  mount: string,
): string {
  const separator = mount.indexOf(":");
  if (!dialect.tmpfsHonoursOptions) {
    return separator === -1 ? mount : mount.slice(0, separator);
  }
  if (separator === -1 || dialect.tmpfsOwnership === "mount-options") {
    return mount;
  }
  const path = mount.slice(0, separator);
  const options = mount.slice(separator + 1).split(",");
  const kept = options.filter((option) => !TMPFS_OWNER_OPTION.test(option));
  // A mount that never asked for an owner is passed through untouched: only
  // the credentials mount carries `uid=`/`gid=`, and adding `U` to the
  // agents' shared 1777 scratch would change a mount this issue is not about.
  if (kept.length === options.length) return mount;
  if (dialect.tmpfsOwnership === "chown-flag") kept.push("U");
  return `${path}:${kept.join(",")}`;
}

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

// The host path helpers moved to host_path_style.ts so setup and the launcher
// resolve a relative path against the same base in the same spelling (#750).
// The two names container_launch has always published are re-exported here.
import {
  isAbsolutePath,
  isRootPath,
  joinPath,
  type LauncherPathStyle,
  normalisePath as normalise,
  pathStyleFor,
} from "./host_path_style.ts";
import { resolveHostConfigPath } from "./host_config_path.ts";
// One resolution of the log directory for the launcher, run.sh, loop.sh and
// the container mount (Issues #872, #873).
import {
  hostLogDirPlatform,
  type LogDirPlatform,
  resolveLogDir,
} from "./log_dir.ts";
import {
  diskFloorOrigin,
  type DiskFloors,
  resolveDiskFloors,
} from "./host_disk.ts";

export { type LauncherPathStyle, pathStyleFor };

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

/**
 * Reject an argument list that would broaden the container's privileges.
 *
 * @param args - The finished argument list
 * @param expectReadOnlyRoot - True when this list runs on a dialect that
 *   supports an immutable root filesystem, so `--read-only` must be present.
 *   The read-only root is a containment control, not a nicety: without this
 *   check a later edit could drop it and nothing would notice (Issue #516).
 */
function assertRunArgumentsContained(
  args: string[],
  expectReadOnlyRoot = false,
  /**
   * The `--tmpfs` values the caller emitted, when it emitted any. The scratch
   * check compares against exactly those: they carry the substituted
   * container user (Issue #570) and the ownership spelling this dialect
   * accepts (Issue #727), which is what the arguments themselves hold.
   */
  expectedTmpfsArguments?: readonly string[],
): void {
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

  const readOnly = args.includes("--read-only");
  if (expectReadOnlyRoot && !readOnly) {
    throw new Error(
      `Refusing to launch: the runtime supports an immutable root filesystem ` +
        `but the run arguments do not carry --read-only (Issue #516).`,
    );
  }
  // Never the flag without its scratch: a read-only root with nowhere to
  // write is a container that cannot run, so the pairing is checked here as
  // well as gated at the point it is emitted.
  if (readOnly) {
    const expected = expectedTmpfsArguments ?? SCRATCH_TMPFS_MOUNTS;
    const missing = expected.filter((mount) => !args.includes(mount));
    if (missing.length > 0) {
      throw new Error(
        `Refusing to launch: --read-only was requested without the scratch ` +
          `tmpfs mounts it depends on (missing: ${missing.join(", ")}) — the ` +
          `container would have nowhere writable to run (Issue #516).`,
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
    // The operator's `custom_label_prompts` templates (Issue #850), beside
    // the staged configuration rather than inside the read-only checkout.
    customPrompts: `${home}/${CUSTOM_PROMPTS_TARGET_SUBDIR}`,
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
// The log directory's own resolution lives in log_dir.ts (Issues #872, #873):
// `run.sh`, `loop.sh` and `run.ps1` reach the same rule through the `log-dir`
// command, so the default cannot mean one thing here and another in shell.
export { resolveLogDir };

export function resolveContainerLaunchHostPaths(
  baseDir: string,
  env: (name: string) => string | undefined,
  style: LauncherPathStyle = pathStyleFor(baseDir),
  platform: LogDirPlatform = hostLogDirPlatform(),
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
  // CONFIG_FILE, with CONFIG_PATH as its alias — setup resolves the same
  // file the same way, so a relocated config is one file, not two (#750).
  const configFile = resolveHostConfigPath({ baseDir: base, env, style });
  const credentialDir = normalise(
    env("VIBE_CREDENTIAL_DIR") ??
      joinPath(home, DEFAULT_CREDENTIAL_DIR_SUFFIX, style),
    style,
  );

  return {
    homeDir: home,
    baseDir: base,
    workDir: normalise(absolute(workDir), style),
    // Issue #872: `LOG_DIR` was honoured by `loop.sh` but ignored here and in
    // `run.sh`, so setting it split the logs across two directories with no
    // warning — and the worker's own `worker-*.log` could not be relocated at
    // all, because this value is the container's writable host mount. One
    // resolution, shared by all three. `LAUNCH_LOG_DIR` is checked first to
    // match `loop.sh`'s precedence exactly. Issue #873 moved the default that
    // chain falls back to onto the platform's own standard location.
    logDir: resolveLogDir(home, env, style, platform),
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
    // The worker's own checkout: the driver it executes, and nothing else.
    // Read-only (Issue #514) — there is no reason the Vibe Coder should ever
    // modify the running code. The last intentional in-container writer was
    // the bootstrap prelude's git reset; Issue #512 moved the checkout update
    // to the host and Issue #513 retired the reset, so a write to /workspace
    // now is a bug, and this mount makes it fail loudly with EROFS instead of
    // silently changing the code the next cycle runs.
    { source: base, target: targets.base, readOnly: true },
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

  // The operator's own prompt templates (Issue #850, part of #843): the
  // directories named by `custom_label_prompts`, read-only, one mount per
  // distinct directory and nothing else from the host. Derived only from
  // paths the operator explicitly configured — never a general-purpose
  // host-path mount — and each source is checked against the same allowlist
  // as every other mount below.
  // The translation is keyed by the path exactly as configured, so the worker
  // inside the container can look up what it read from `.config.json`.
  const customPrompts = planCustomPromptMounts(
    inputs.customPromptPaths ?? [],
    targets.customPrompts,
    style,
  );
  for (const mount of customPrompts.mounts) {
    mounts.push({
      source: normalise(mount.source, style),
      target: mount.target,
      readOnly: true,
    });
  }

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
  // The immutable root filesystem and the scratch it needs are ONE decision
  // (Issue #516): `--read-only` without a writable tmpfs is a container that
  // cannot run, so a dialect that takes no tmpfs gets neither half. Apple
  // container is that dialect — its per-container VM is the compensating
  // control, and the entrypoint puts its scratch on the vibe-work volume.
  if (dialect.supportsReadOnly && !dialect.supportsTmpfs) {
    throw new Error(
      `Refusing to launch: the ${descriptor.displayName} dialect asks for a ` +
        `read-only root filesystem but supports no tmpfs, so the container ` +
        `would have nowhere writable to run (Issue #516).`,
    );
  }
  const readOnlyRoot = dialect.supportsReadOnly;
  if (readOnlyRoot) runArgs.push("--read-only");
  // The scratch that flag depends on. The guard above makes tmpfs support a
  // precondition of read-only support, so `--read-only` can never be emitted
  // without these mounts; a runtime that took a tmpfs but no `--read-only`
  // still gets a disposable root, exactly as before.
  const tmpfsArguments: string[] = [];
  if (dialect.supportsTmpfs) {
    for (const mount of scratchTmpfsMounts(manifest.user)) {
      const value = tmpfsArgument(dialect, mount);
      tmpfsArguments.push(value);
      runArgs.push("--tmpfs", value);
    }
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
  // The staged configuration still names the operator's *host* prompt paths —
  // one `.config.json` works in both modes — so the worker is handed the map
  // from each of those paths to where the mount above makes it readable
  // (Issue #850). Emitted only when mappings are configured.
  const customPromptMap = Object.keys(customPrompts.translations).length > 0
    ? JSON.stringify(customPrompts.translations)
    : undefined;
  if (customPromptMap) {
    runArgs.push("--env", `${CUSTOM_PROMPT_PATH_MAP_ENV}=${customPromptMap}`);
  }
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
  // The supervisor's cap (Issue #421): inside the container the worker cannot
  // see loop.sh's `timeout`, so the cap and the run's start epoch are handed
  // over explicitly. Without them the progress-extension policy applies no
  // ceiling and a progressing run walks into the SIGTERM.
  if (inputs.runCap) {
    runArgs.push(
      "--env",
      `VIBE_RUN_MAX_SECONDS=${Math.floor(inputs.runCap.maxSeconds)}`,
    );
    runArgs.push(
      "--env",
      `VIBE_RUN_STARTED_EPOCH=${Math.floor(inputs.runCap.startedEpochSeconds)}`,
    );
  }
  // Last, so the launcher can append the worker's own arguments after it.
  runArgs.push(image);

  assertRunArgumentsContained(runArgs, readOnlyRoot, tmpfsArguments);

  // The volume init (Issues #4186, #229): a fresh named volume is
  // root-owned and the worker runs as the manifest's unprivileged account,
  // so root chowns the two mount roots (non-recursive — the roots are all
  // the runtime creates) before the worker starts; since Issue #229 the
  // same run first checks and repairs a block-device volume's filesystem
  // (see container/volume-init.sh) and reports one it cannot repair with
  // exit 3 so the launcher can recreate it. Only the volumes and the image
  // are visible to this run: no host mount, no credentials, no network use.
  // Idempotent, so the launchers re-run it every launch. Deliberately not
  // `--read-only` (Issue #516): it runs as root, where a read-only root is
  // remountable and therefore not a boundary, and its `fsck` repair path
  // needs the image's own scratch. The containment control that matters here
  // is the mount set — volumes and image only.
  const volumeMounts = mounts.filter((mount) => mount.volume);
  const initArgs: string[] = [
    "run",
    "--rm",
    "--name",
    `${containerName}-init`,
    "--user",
    "0:0",
    "--entrypoint",
    VOLUME_INIT_ENTRYPOINT,
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
  ];
  // Issue #72: carry the deployer's validated container_tools spec into the
  // build (before the context path — options precede PATH). Nothing appended
  // when unset, so the default fleet build is byte-for-byte unchanged.
  if (inputs.containerToolsSpecJson) {
    buildArgs.push(
      "--build-arg",
      `VIBE_CONTAINER_TOOLS=${inputs.containerToolsSpecJson}`,
    );
  }
  // Issue #729: the deployment's enabled providers decide which agent CLIs the
  // image installs, so the *same* set that decides the credential mounts above
  // is carried into the build. Nothing appended when it is already what the
  // image installs by default, so the default fleet build — and its tag — are
  // byte-for-byte unchanged.
  const providersBuildValue = agentProvidersBuildValue(
    providers.map((provider) => provider.id),
    manifest.installedProviders,
  );
  if (providersBuildValue) {
    buildArgs.push(
      "--build-arg",
      `${AGENT_PROVIDERS_BUILD_ARG}=${providersBuildValue}`,
    );
  }
  buildArgs.push(joinPath(base, "container", style));

  // The floor the launcher's own disk decisions compare against, and where
  // each term came from, so `run.sh` names the number that refused a launch
  // instead of recomputing it from two environment variables (Issue #732).
  const floors = inputs.claimFloors ??
    resolveDiskFloors((name) => Deno.env.get(name));

  return {
    runtime: descriptor.executable,
    image,
    containerName,
    watchdogSeconds: Math.floor(inputs.watchdogSeconds),
    mounts,
    // Only the read/write host mounts are the launcher's to create — since
    // Issue #4186 that is the log directory alone. One filter, one reason:
    // the checkout used to need a second `!== base` exclusion, and since
    // Issue #514 made it read-only the read-only test already covers it. A
    // missing config file or credential directory is a loud failure, not
    // something to conjure an empty replacement for.
    ensureDirectories: mounts
      .filter((mount) => !mount.volume && !mount.readOnly)
      .map((mount) => mount.source),
    volumes: volumeMounts.map((mount) => mount.source),
    initArgs,
    volumeRemoveArgs: [...dialect.volumeRemoveArgs],
    claimFloorGb: floors.lowFloorGb,
    claimFloorPercent: floors.lowFloorPercent,
    claimFloorOrigin: diskFloorOrigin(floors),
    imageInspectArgs: [...dialect.imageInspectArgs, image],
    buildArgs,
    builderStopArgs: [...dialect.builderStopArgs],
    builderAbsentPatterns: [...dialect.builderAbsentPatterns],
    runArgs,
  };
}

/** Exit status volume-init uses for a volume it could not repair (#229). */
export const VOLUME_INIT_UNREPAIRABLE_EXIT_STATUS = 3;

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
  /** The runtime's own "remove one volume" verb (Issue #731). */
  volumeRemove: string[];
  /** The claiming floor's terms and their origin (Issue #732). */
  claimFloorGb: string;
  claimFloorPercent: string;
  claimFloorOrigin: string;
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
    ...plan.volumeRemoveArgs.map((arg) => `volume-remove=${arg}`),
    `claim-floor-gb=${plan.claimFloorGb}`,
    `claim-floor-percent=${plan.claimFloorPercent}`,
    `claim-floor-origin=${plan.claimFloorOrigin}`,
    ...plan.imageInspectArgs.map((arg) => `exists=${arg}`),
    ...plan.buildArgs.map((arg) => `build=${arg}`),
    ...plan.builderStopArgs.map((arg) => `builder-stop=${arg}`),
    ...plan.builderAbsentPatterns.map((p) => `builder-absent=${p}`),
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
    volumeRemove: [],
    claimFloorGb: "",
    claimFloorPercent: "",
    claimFloorOrigin: "",
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
      case "volume-remove":
        parsed.volumeRemove.push(value);
        break;
      case "claim-floor-gb":
        parsed.claimFloorGb = value;
        break;
      case "claim-floor-percent":
        parsed.claimFloorPercent = value;
        break;
      case "claim-floor-origin":
        parsed.claimFloorOrigin = value;
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
