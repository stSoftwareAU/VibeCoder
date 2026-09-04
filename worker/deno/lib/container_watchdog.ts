/**
 * Outer watchdog and forced reaper for a wedged worker container
 * (Issue #4173).
 *
 * ## What went wrong
 *
 * On host-23 a worker container's VM stopped answering mid-run: `container
 * exec` hung indefinitely, the worker's own run-duration timer never fired
 * (nothing inside the VM was still scheduling), and — the unattended killer —
 * the **host-side `container run` client never exited**, so `run.sh` never
 * returned and `loop.sh` sat blocked for three hours. `container stop`,
 * `container kill`, `container kill --signal KILL` and an apiserver restart all
 * refused to reap the record ("running and can not be deleted"). Only a
 * SIGKILL of the host-side `container run` and `container-runtime-linux`
 * processes cleared it.
 *
 * Diagnosing the VM wedge itself is out of scope; the fleet must survive it
 * either way, and unattended machines cannot wait for an operator to notice a
 * silent log and hand-kill PIDs.
 *
 * ## The two layers
 *
 * 1. **Outer watchdog (primary).** The launchers wait on the runtime client
 *    under a deadline — the worker's own maximum run duration plus a margin —
 *    instead of waiting for ever. On expiry they call the `container-reap`
 *    command, which runs {@link reapWedgedContainer}: `<runtime> kill <name>`
 *    first, then, if the client is still there after a grace period, SIGKILL
 *    of that client and of the runtime helper holding the VM — a process the
 *    runtime itself started whose argv carries the container name, never a
 *    bystander that merely quotes it. The launcher exits non-zero with
 *    {@link CONTAINER_WEDGED_EXIT_STATUS}, so the supervisor proceeds to the
 *    next cycle: "wedged for ever" becomes "one lost cycle".
 * 2. **Pre-launch reaper (belt and braces).** Before launching, the same
 *    command runs {@link reapStaleContainers}: any `vibe-coder-*` container
 *    older than the deadline, or whose launcher process is gone, is reaped the
 *    same way. This also covers a wedge that outlived a host reboot.
 *
 * Every forced reap is emitted as a `container_wedged` self-heal event, so
 * `self-heal-summary` surfaces a chronically wedging host rather than
 * losing it in a host log.
 *
 * ## Why the seams
 *
 * Killing processes and driving a container runtime are exactly the operations
 * a test must not really perform, so every one of them is a seam on
 * {@link ReapDeps}; {@link createReapDeps} supplies the production
 * implementations. Nothing here waits unbounded: each runtime invocation is
 * given a timeout by the production seam, because the wedge that started all
 * this is a CLI that never returns.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import {
  CONTAINER_RUNTIMES,
  type ContainerRuntimeDialect,
} from "./container_runtime.ts";
import { emitSelfHealEvent, type SelfHealEvent } from "./self_heal_events.ts";

/**
 * Seconds added to the worker's own maximum run duration to form the
 * launcher's deadline.
 *
 * The worker inside the container shuts itself down at its own limit, so the
 * host only steps in once that has demonstrably not happened. Ten minutes is
 * long enough to cover a slow graceful shutdown (git pushes, log rotation) and
 * short enough that a wedge costs one cycle rather than a night.
 */
export const WATCHDOG_MARGIN_SECONDS = 600;

/** Operator override for the launcher deadline, in seconds. */
export const WATCHDOG_SECONDS_ENV = "VIBE_CONTAINER_WATCHDOG_SECONDS";

/**
 * Exit status a launcher reports when it reaped a wedged container.
 *
 * A named reason rather than a bare failure: deliberately outside the runtime
 * CLI's own 125/126/127 range so a wedge is never attributed to a container
 * that failed to start.
 */
export const CONTAINER_WEDGED_EXIT_STATUS = 87;

/** Seconds a container is given to die to `<runtime> kill` before SIGKILL. */
export const DEFAULT_KILL_GRACE_SECONDS = 30;

/** Operator override for that grace period, in seconds. */
export const KILL_GRACE_SECONDS_ENV = "VIBE_CONTAINER_REAP_GRACE_SECONDS";

/** How often the grace period re-checks the runtime client, in milliseconds. */
const GRACE_POLL_MS = 1_000;

/** Settling time after a kill when there is no client process to watch. */
const SETTLE_MS = 2_000;

/** Name prefix every worker container carries (`vibe-coder-<launcher pid>`). */
export const WORKER_CONTAINER_PREFIX = "vibe-coder-";

/** Module name used for the self-heal events this file emits. */
export const WEDGE_SELF_HEAL_MODULE = "container_watchdog";

/** Action name used for the self-heal events this file emits. */
export const WEDGE_SELF_HEAL_ACTION = "container_wedged";

/** Container names the runtimes accept, and no shell can misread. */
const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Characters that continue a container name, for whole-name argv matching. */
const NAME_CONTINUATION_RE = /[A-Za-z0-9_.-]/;

// ---------------------------------------------------------------------------
// The deadline
// ---------------------------------------------------------------------------

/**
 * Resolve the launcher's deadline for one run.
 *
 * @param options.env - Environment reader (injected for tests)
 * @param options.maxRunSeconds - The worker's own maximum run duration
 * @param options.warn - Sink for the loud note an unusable override earns
 * @returns Seconds the launcher waits on the runtime client before reaping
 */
export function resolveWatchdogSeconds(options: {
  env: (name: string) => string | undefined;
  maxRunSeconds: number;
  warn?: (message: string) => void;
}): number {
  const fallback = Math.max(1, Math.floor(options.maxRunSeconds)) +
    WATCHDOG_MARGIN_SECONDS;
  const raw = options.env(WATCHDOG_SECONDS_ENV)?.trim();
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || Math.floor(parsed) < 1) {
    // Never silently obey a value that would disable the watchdog or kill
    // every healthy run: say so and use the derived deadline (Issue #3234).
    (options.warn ?? console.error)(
      `[container-watchdog] ignoring ${WATCHDOG_SECONDS_ENV}=${raw}: not a ` +
        `positive number of seconds — using ${fallback}s`,
    );
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * Resolve how long a container is given to die to `<runtime> kill`.
 *
 * A knob for hosts whose runtime is slow to stop a container, and the seam the
 * launcher tests use to keep the wedge case fast.
 *
 * @param env - Environment reader
 * @param warn - Sink for the loud note an unusable override earns
 * @returns Grace period in seconds
 */
export function resolveGraceSeconds(
  env: (name: string) => string | undefined,
  warn?: (message: string) => void,
): number {
  const raw = env(KILL_GRACE_SECONDS_ENV)?.trim();
  if (!raw) return DEFAULT_KILL_GRACE_SECONDS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || Math.floor(parsed) < 1) {
    (warn ?? console.error)(
      `[container-watchdog] ignoring ${KILL_GRACE_SECONDS_ENV}=${raw}: not a ` +
        `positive number of seconds — using ${DEFAULT_KILL_GRACE_SECONDS}s`,
    );
    return DEFAULT_KILL_GRACE_SECONDS;
  }
  return Math.floor(parsed);
}

// ---------------------------------------------------------------------------
// The host process table
// ---------------------------------------------------------------------------

/** One host process, as the reaper needs to see it. */
export interface ProcessEntry {
  /** Process id. */
  pid: number;
  /** Full argument vector, as one string. */
  args: string;
}

/**
 * Parse `ps -A -o pid=,args=` output.
 *
 * @param text - Raw `ps` output
 * @returns One entry per parseable line; unparseable lines are dropped
 */
export function parseProcessTable(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    entries.push({ pid, args: match[2]!.trim() });
  }
  return entries;
}

/** True when an argument vector names exactly this container. */
function argsNameContainer(args: string, containerName: string): boolean {
  let from = 0;
  while (true) {
    const index = args.indexOf(containerName, from);
    if (index < 0) return false;
    const after = args.charAt(index + containerName.length);
    // `vibe-coder-667` must not match `vibe-coder-66770`.
    if (after === "" || !NAME_CONTINUATION_RE.test(after)) return true;
    from = index + 1;
  }
}

/** The executable a process was started from, without directory or suffix. */
function executableOf(args: string): string {
  const first = args.trim().split(/\s+/)[0] ?? "";
  const basename = first.replace(/\\/g, "/").split("/").pop() ?? "";
  return basename.replace(/\.exe$/i, "").toLowerCase();
}

/**
 * Host processes holding a named container.
 *
 * Matches the runtime client (`container run --name <name>`) and the runtime
 * helper (`container-runtime-linux … <name>`), because the name is what both
 * carry — but *only* those: a process must have been started from the runtime
 * executable, or a helper named after it, before it is a SIGKILL candidate.
 * That second condition is deliberate. A container name is a plain string, and
 * plenty of unrelated processes can quote one — a log tail, an editor, the
 * worker's own agent session carrying an issue body that mentions it. Killing
 * one of those instead of the wedge would be a far worse failure than missing
 * the helper (Issue #4275 is the same lesson learnt the hard way). The reaper's
 * own command line is skipped for the same reason.
 *
 * @param entries - The host process table
 * @param options.containerName - Container whose holders are wanted
 * @param options.runtimeExecutable - Runtime the launcher chose
 * @param options.excludePids - Process ids to leave alone
 * @returns The matching entries, in process-table order
 */
export function selectContainerProcesses(
  entries: readonly ProcessEntry[],
  options: {
    containerName: string;
    runtimeExecutable: string;
    excludePids?: readonly number[];
  },
): ProcessEntry[] {
  const excluded = new Set(options.excludePids ?? []);
  const runtime = executableOf(options.runtimeExecutable);
  return entries.filter((entry) => {
    if (excluded.has(entry.pid)) return false;
    if (entry.args.includes("container-reap")) return false;
    const executable = executableOf(entry.args);
    // `container` (the client) and `container-runtime-linux` (the helper that
    // actually holds the VM); `docker`/`podman` and their own helpers alike.
    if (executable !== runtime && !executable.startsWith(`${runtime}-`)) {
      return false;
    }
    return argsNameContainer(entry.args, options.containerName);
  });
}

// ---------------------------------------------------------------------------
// The runtime's container listing
// ---------------------------------------------------------------------------

/** One container the runtime reports as running. */
export interface ContainerRecord {
  /** Container name. */
  name: string;
  /** Creation time in milliseconds since the epoch, when the runtime says. */
  createdAt?: number;
}

/** Keys the supported runtimes spell a container's name with. */
const NAME_KEYS = ["Names", "names", "Name", "name", "ID", "Id", "id"];

/** Keys the supported runtimes spell a creation time with. */
const CREATED_KEYS = ["CreatedAt", "Created", "createdAt", "created"];

/** Read a creation time out of whatever shape the runtime used. */
function readCreatedAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Docker and Podman report epoch seconds; anything already in
    // milliseconds is far past this threshold.
    return value < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    // Go's time formatting appends the zone abbreviation after the offset
    // ("+1000 AEST"), which Date.parse rejects — the offset alone is enough.
    const cleaned = value.trim().replace(/\s+[A-Z]{3,5}$/, "");
    const parsed = Date.parse(cleaned);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Read a container name out of whatever shape the runtime used. */
function readName(record: Record<string, unknown>): string | undefined {
  for (const key of NAME_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      // Docker joins multiple names with a comma; the first is the one the
      // launcher asked for.
      return value.split(",")[0]!.trim();
    }
    if (Array.isArray(value)) {
      const first = value.find((entry) =>
        typeof entry === "string" && entry.trim() !== ""
      );
      if (typeof first === "string") return first.trim();
    }
  }
  // Apple container nests the identity under `configuration`.
  const configuration = record["configuration"];
  if (typeof configuration === "object" && configuration !== null) {
    return readName(configuration as Record<string, unknown>);
  }
  return undefined;
}

/** One record out of a parsed JSON object, when it names a container. */
function recordFrom(value: unknown): ContainerRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const object = value as Record<string, unknown>;
  const name = readName(object);
  if (!name) return undefined;

  let createdAt: number | undefined;
  for (const key of CREATED_KEYS) {
    createdAt = readCreatedAt(object[key]);
    if (createdAt !== undefined) break;
  }
  return createdAt === undefined ? { name } : { name, createdAt };
}

/**
 * Parse a runtime's container listing.
 *
 * Accepts every shape the supported runtimes produce: a JSON array (Podman,
 * Apple container), one JSON object per line (Docker), or a plain list of
 * names. Unparseable output yields no records — the caller reports that as a
 * failed listing rather than as "nothing is running".
 *
 * @param text - Raw listing output
 * @returns The containers named in it
 */
export function parseContainerListing(text: string): ContainerRecord[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];

  try {
    const parsed = JSON.parse(trimmed);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const records = values
      .map(recordFrom)
      .filter((record): record is ContainerRecord => record !== undefined);
    if (records.length > 0) return records;
  } catch {
    // Not one JSON document — try the per-line shapes below.
  }

  const records: ContainerRecord[] = [];
  for (const line of trimmed.split("\n")) {
    const value = line.trim();
    if (value === "") continue;
    if (value.startsWith("{")) {
      try {
        const record = recordFrom(JSON.parse(value));
        if (record) records.push(record);
      } catch {
        // A truncated line names nothing; skip it.
      }
      continue;
    }
    // A plain name list (`--quiet`, or a table with no header).
    const name = value.split(/\s+/)[0]!;
    if (CONTAINER_NAME_RE.test(name)) records.push({ name });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Choosing what to reap before a launch
// ---------------------------------------------------------------------------

/**
 * The launcher pid a worker container name carries.
 *
 * Worker containers are named `vibe-coder-<launcher pid>`, so the name itself
 * says which host process is supposed to be watching the container.
 *
 * @param name - Container name
 * @param prefix - Worker container prefix
 * @returns The pid, or null when the name is not a worker container's
 */
export function launcherPidFromContainerName(
  name: string,
  prefix: string = WORKER_CONTAINER_PREFIX,
): number | null {
  if (!name.startsWith(prefix)) return null;
  const suffix = name.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return null;
  const pid = Number(suffix);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** A container the pre-launch scan wants reaped, and why. */
export interface StaleContainer {
  /** Container name. */
  name: string;
  /** `age` when it outlived the deadline, `orphaned` when its launcher is gone. */
  reason: "age" | "orphaned";
  /** Age in seconds, when the runtime reported a creation time. */
  ageSeconds?: number;
}

/**
 * Pick the leaked worker containers a launch should reap first.
 *
 * Two independent signals, because no supported runtime reports both:
 *
 * - **Age.** A container older than the launcher's own deadline cannot be a
 *   healthy run — the worker inside it stops itself long before.
 * - **A dead launcher.** The name carries the launcher pid, so a worker
 *   container nobody is waiting on is a leak whatever its age (this is what
 *   catches a wedge that survived a host reboot, and Apple container, which
 *   reports no creation time at all). A pid that is alive is left alone even
 *   though pid reuse could make it a stranger's: skipping a real leak costs
 *   one cycle, killing a healthy run costs the run.
 *
 * @param options.records - Containers the runtime reports
 * @param options.maxAgeSeconds - The launcher's deadline
 * @param options.now - Current time in milliseconds since the epoch
 * @param options.prefix - Worker container prefix
 * @param options.excludeNames - Names to leave alone (this run's own)
 * @param options.isProcessAlive - Host pid liveness probe
 * @returns The containers to reap, with the reason each was chosen
 */
export function selectStaleContainers(options: {
  records: readonly ContainerRecord[];
  maxAgeSeconds: number;
  now: number;
  prefix?: string;
  excludeNames?: readonly string[];
  isProcessAlive: (pid: number) => boolean;
}): StaleContainer[] {
  const prefix = options.prefix ?? WORKER_CONTAINER_PREFIX;
  const excluded = new Set(options.excludeNames ?? []);
  const stale: StaleContainer[] = [];

  for (const record of options.records) {
    if (excluded.has(record.name)) continue;
    const pid = launcherPidFromContainerName(record.name, prefix);
    // Not a worker container (or a derived one such as the `-init` helper):
    // nothing here may touch another workload.
    if (pid === null) continue;

    if (record.createdAt !== undefined) {
      const ageSeconds = Math.floor((options.now - record.createdAt) / 1000);
      if (ageSeconds > options.maxAgeSeconds) {
        stale.push({ name: record.name, reason: "age", ageSeconds });
        continue;
      }
    }
    if (!options.isProcessAlive(pid)) {
      stale.push({ name: record.name, reason: "orphaned" });
    }
  }

  return stale;
}

// ---------------------------------------------------------------------------
// Reaping
// ---------------------------------------------------------------------------

/** What one bounded runtime invocation reported. */
export interface RuntimeInvocation {
  /** Exit status, or -1 when the invocation could not be completed. */
  code: number;
  stdout: string;
  stderr: string;
}

/** Every operation the reaper needs, injected so tests perform none of them. */
export interface ReapDeps {
  /** Runtime executable the launcher chose — the SIGKILL candidate filter. */
  runtimeExecutable: string;
  /** Arguments that list the runtime's running containers. */
  listArgs: readonly string[];
  /** Run the container runtime, bounded by a timeout. */
  runRuntime: (args: readonly string[]) => Promise<RuntimeInvocation>;
  /** Read the host process table. */
  listProcesses: () => Promise<ProcessEntry[]>;
  /** SIGKILL a host process; false when it could not be signalled. */
  killProcess: (pid: number) => boolean;
  /** Host pid liveness probe. */
  isProcessAlive: (pid: number) => boolean;
  /** Wait, in milliseconds. */
  sleep: (ms: number) => Promise<void>;
  /** Clock, in milliseconds since the epoch. */
  now: () => number;
  /** Self-heal telemetry sink. */
  emit: (event: Omit<SelfHealEvent, "timestamp">) => Promise<unknown>;
  /** Operator-facing log sink (stderr in production). */
  log: (message: string) => void;
}

/** One reap request. */
export interface ReapOptions {
  /** Container to reap. */
  containerName: string;
  /** The launcher's own runtime-client pid, when it has one to watch. */
  clientPid?: number;
  /** Seconds the container is given to die to `<runtime> kill`. */
  graceSeconds?: number;
  /** Why the reap was triggered, in operator-facing words. */
  reason: string;
  /** Which layer triggered it. */
  trigger: "watchdog" | "pre_launch";
}

/** What one reap achieved. */
export interface ReapResult {
  containerName: string;
  /** Exit status of `<runtime> kill`, or -1 when it could not be run. */
  runtimeKillExit: number | null;
  /** Host processes this reap SIGKILLed. */
  killedPids: number[];
  /** True when no runtime client is left waiting on the container. */
  clientExited: boolean;
  /** True when the runtime still lists the container afterwards. */
  stillListed: boolean;
  /** True when the wedge is demonstrably gone. */
  reaped: boolean;
}

/** Reject a container name that is not a plain name the runtime accepts. */
function assertContainerName(name: string): void {
  if (!CONTAINER_NAME_RE.test(name)) {
    throw new Error(
      `Refusing to reap: container name ${JSON.stringify(name)} is not a ` +
        `plain name the runtime accepts.`,
    );
  }
}

/** Whether the runtime still lists a container. */
async function stillListed(
  deps: ReapDeps,
  containerName: string,
): Promise<{ listed: boolean; verified: boolean }> {
  const listing = await deps.runRuntime(deps.listArgs);
  if (listing.code !== 0) {
    deps.log(
      `[container-watchdog] could not confirm whether ${containerName} is ` +
        `gone: ${deps.listArgs.join(" ")} exited ${listing.code} ` +
        `(${listing.stderr.trim() || "no output"})`,
    );
    return { listed: false, verified: false };
  }
  const records = parseContainerListing(listing.stdout);
  return {
    listed: records.some((record) => record.name === containerName),
    verified: true,
  };
}

/**
 * Reap one wedged container: runtime kill first, SIGKILL if that is refused.
 *
 * The client process is killed before the runtime helper, because the client
 * is what blocks the launcher — and therefore the supervisor. Nothing here
 * throws for a failed kill: the outcome is reported (loudly, and as a
 * `container_wedged` self-heal event) so a host that cannot reap its own
 * containers is visible rather than silently green.
 *
 * @param deps - Injected operations
 * @param options - The reap request
 * @returns What the reap achieved
 * @throws When the container name is not one the runtime would accept
 */
export async function reapWedgedContainer(
  deps: ReapDeps,
  options: ReapOptions,
): Promise<ReapResult> {
  const { containerName, clientPid } = options;
  assertContainerName(containerName);
  const graceSeconds = Math.max(
    0,
    Math.floor(options.graceSeconds ?? DEFAULT_KILL_GRACE_SECONDS),
  );

  deps.log(
    `[container-watchdog] reaping ${containerName}: ${options.reason} ` +
      `(Issue #4173)`,
  );

  const kill = await deps.runRuntime(["kill", containerName]);
  if (kill.code !== 0) {
    deps.log(
      `[container-watchdog] kill ${containerName} exited ${kill.code} ` +
        `(${kill.stderr.trim() || "no output"}) — escalating to SIGKILL`,
    );
  }

  // Give the container the grace period to die to that kill. Only the client
  // pid is polled: it is cheap, and it is the thing whose survival blocks the
  // launcher. A stale record with no client left is handled by the listing
  // check below.
  if (clientPid !== undefined) {
    const polls = Math.ceil((graceSeconds * 1000) / GRACE_POLL_MS);
    for (let poll = 0; poll < polls; poll++) {
      if (!deps.isProcessAlive(clientPid)) break;
      await deps.sleep(GRACE_POLL_MS);
    }
  } else if (graceSeconds > 0) {
    await deps.sleep(Math.min(graceSeconds * 1000, SETTLE_MS));
  }

  const killedPids: number[] = [];
  if (clientPid !== undefined && deps.isProcessAlive(clientPid)) {
    if (deps.killProcess(clientPid)) killedPids.push(clientPid);
    else {
      deps.log(
        `[container-watchdog] could not SIGKILL the runtime client ` +
          `${clientPid} for ${containerName}`,
      );
    }
  }

  // The helper process that actually holds the VM: it is not the launcher's
  // child, so only its argv identifies it.
  const holders = selectContainerProcesses(await deps.listProcesses(), {
    containerName,
    runtimeExecutable: deps.runtimeExecutable,
    excludePids: killedPids,
  });
  for (const holder of holders) {
    if (deps.killProcess(holder.pid)) killedPids.push(holder.pid);
    else {
      deps.log(
        `[container-watchdog] could not SIGKILL ${holder.pid} holding ` +
          `${containerName}`,
      );
    }
  }

  const listing = await stillListed(deps, containerName);
  const clientExited = clientPid === undefined ||
    !deps.isProcessAlive(clientPid);
  const reaped = clientExited && !listing.listed;

  await deps.emit({
    module: WEDGE_SELF_HEAL_MODULE,
    action: WEDGE_SELF_HEAL_ACTION,
    reason: reaped
      ? `reaped wedged container ${containerName} — ${options.reason}`
      : `wedged container ${containerName} survived the reap — ` +
        options.reason,
    result: reaped ? "ok" : "failed",
    details: {
      containerName,
      trigger: options.trigger,
      runtimeKillExit: kill.code,
      killedPids,
      clientPid: clientPid ?? null,
      clientExited,
      stillListed: listing.listed,
      listingVerified: listing.verified,
    },
  });

  if (!reaped) {
    deps.log(
      `[container-watchdog] ${containerName} is still present after the ` +
        `reap — this host needs an operator (Issue #4173)`,
    );
  }

  return {
    containerName,
    runtimeKillExit: kill.code,
    killedPids,
    clientExited,
    stillListed: listing.listed,
    reaped,
  };
}

/** A worker container another launcher is still legitimately running. */
export interface LiveWorkerContainer {
  /** Container name (`vibe-coder-<launcher pid>`). */
  name: string;
  /** The launcher process behind it, alive on this host. */
  launcherPid: number;
  /** Age in seconds, when the runtime reported a creation time. */
  ageSeconds?: number;
}

/**
 * The worker containers the pre-launch scan must leave alone *and* that
 * therefore stop this launch: one worker per host (Issue #26).
 *
 * The named work volumes are per-host singletons, so a second worker cannot
 * start while a first is running — its `-init` helper fails on the storage
 * attachment with a VM-internals error that names nothing. A container that
 * is young enough and whose launcher pid is alive is exactly the one the
 * stale scan keeps; this is that set, so the launcher can say "already
 * running" before it builds or launches anything.
 *
 * @param options.records - The runtime's container listing
 * @param options.maxAgeSeconds - The launcher's deadline
 * @param options.now - Current time in milliseconds since the epoch
 * @param options.prefix - Worker container prefix
 * @param options.excludeNames - Names to leave alone (this run's own)
 * @param options.isProcessAlive - Host pid liveness probe
 * @returns The live worker containers, oldest first
 */
export function selectLiveWorkerContainers(options: {
  records: readonly ContainerRecord[];
  maxAgeSeconds: number;
  now: number;
  prefix?: string;
  excludeNames?: readonly string[];
  isProcessAlive: (pid: number) => boolean;
}): LiveWorkerContainer[] {
  const prefix = options.prefix ?? WORKER_CONTAINER_PREFIX;
  const excluded = new Set(options.excludeNames ?? []);
  const live: LiveWorkerContainer[] = [];

  for (const record of options.records) {
    if (excluded.has(record.name)) continue;
    const pid = launcherPidFromContainerName(record.name, prefix);
    if (pid === null) continue;

    let ageSeconds: number | undefined;
    if (record.createdAt !== undefined) {
      ageSeconds = Math.floor((options.now - record.createdAt) / 1000);
      if (ageSeconds > options.maxAgeSeconds) continue; // stale: reaped
    }
    if (!options.isProcessAlive(pid)) continue; // orphaned: reaped

    live.push({
      name: record.name,
      launcherPid: pid,
      ...(ageSeconds !== undefined ? { ageSeconds } : {}),
    });
  }

  return live.sort((a, b) => (b.ageSeconds ?? 0) - (a.ageSeconds ?? 0));
}

/**
 * List the worker containers other launchers are still running (Issue #26).
 *
 * A listing the runtime cannot produce is an error, never "nothing is
 * running" (Issue #3234): the caller decides whether that stops the launch.
 *
 * @param deps - Injected operations
 * @param options - Scan bounds (the same as the stale scan's)
 * @returns The live worker containers, or the listing failure
 */
export async function listLiveWorkerContainers(
  deps: Pick<ReapDeps, "runRuntime" | "listArgs" | "isProcessAlive" | "now">,
  options: ReapStaleOptions,
): Promise<
  { ok: true; live: LiveWorkerContainer[] } | { ok: false; error: string }
> {
  const listing = await deps.runRuntime(deps.listArgs);
  if (listing.code !== 0) {
    return {
      ok: false,
      error: `could not list containers: ${deps.listArgs.join(" ")} exited ` +
        `${listing.code} (${listing.stderr.trim() || "no output"})`,
    };
  }
  return {
    ok: true,
    live: selectLiveWorkerContainers({
      records: parseContainerListing(listing.stdout),
      maxAgeSeconds: options.maxAgeSeconds,
      now: deps.now(),
      ...(options.prefix ? { prefix: options.prefix } : {}),
      ...(options.excludeNames ? { excludeNames: options.excludeNames } : {}),
      isProcessAlive: deps.isProcessAlive,
    }),
  };
}

/** Options for the pre-launch scan. */
export interface ReapStaleOptions {
  /** The launcher's deadline — a container older than this is a leak. */
  maxAgeSeconds: number;
  /** Names to leave alone (this run's own container). */
  excludeNames?: readonly string[];
  /** Seconds each container is given to die to `<runtime> kill`. */
  graceSeconds?: number;
  /** Worker container prefix. */
  prefix?: string;
}

/**
 * Reap every leaked worker container before a launch.
 *
 * A listing the runtime cannot produce is reported and treated as "unknown",
 * never as "nothing is running": that distinction is what keeps a broken
 * runtime from looking like a clean host (Issue #3234).
 *
 * @param deps - Injected operations
 * @param options - Scan bounds
 * @returns One result per container reaped
 */
export async function reapStaleContainers(
  deps: ReapDeps,
  options: ReapStaleOptions,
): Promise<ReapResult[]> {
  const listing = await deps.runRuntime(deps.listArgs);
  if (listing.code !== 0) {
    deps.log(
      `[container-watchdog] pre-launch scan could not list containers: ` +
        `${deps.listArgs.join(" ")} exited ${listing.code} ` +
        `(${listing.stderr.trim() || "no output"})`,
    );
    return [];
  }

  const stale = selectStaleContainers({
    records: parseContainerListing(listing.stdout),
    maxAgeSeconds: options.maxAgeSeconds,
    now: deps.now(),
    ...(options.prefix ? { prefix: options.prefix } : {}),
    ...(options.excludeNames ? { excludeNames: options.excludeNames } : {}),
    isProcessAlive: deps.isProcessAlive,
  });

  const results: ReapResult[] = [];
  for (const candidate of stale) {
    results.push(
      await reapWedgedContainer(deps, {
        containerName: candidate.name,
        ...(options.graceSeconds !== undefined
          ? { graceSeconds: options.graceSeconds }
          : {}),
        reason: candidate.reason === "age"
          ? `pre-launch scan found it ${candidate.ageSeconds}s old, past the ` +
            `${options.maxAgeSeconds}s deadline`
          : `pre-launch scan found no live launcher process for it`,
        trigger: "pre_launch",
      }),
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// Production seams
// ---------------------------------------------------------------------------

/**
 * The argument dialect for a runtime executable.
 *
 * Resolved from the executable the launcher already chose rather than by
 * re-probing: a wedged host is exactly where a second probe would hang. Used by
 * the reaper for its container listing and by the image prune for its own
 * listing and removal spelling (Issue #4162), so the message names no single
 * caller.
 *
 * @param executable - Runtime executable path or name
 * @returns That runtime's dialect
 * @throws When the executable is not a runtime the launchers support
 */
export function dialectForExecutable(
  executable: string,
): ContainerRuntimeDialect {
  const basename = executable.replace(/\\/g, "/").split("/").pop() ?? "";
  const stem = basename.replace(/\.exe$/i, "").toLowerCase();
  for (const candidate of Object.values(CONTAINER_RUNTIMES)) {
    if (candidate.executable === stem) return candidate.dialect;
  }
  throw new Error(
    `${executable} is not a container runtime the launchers ` +
      `support (${
        Object.values(CONTAINER_RUNTIMES).map((candidate) =>
          candidate.executable
        ).join(", ")
      }).`,
  );
}

/** Options for {@link createReapDeps}. */
export interface ReapDepsOptions {
  /** Runtime executable the launcher chose. */
  runtime: string;
  /** Arguments that list running containers. */
  listArgs: readonly string[];
  /** Work directory whose `logs/self-heal.jsonl` receives the events. */
  workDir: string;
  /** Timeout applied to every runtime invocation, in milliseconds. */
  timeoutMs?: number;
}

/** Default bound on one runtime invocation — a wedged CLI never returns. */
export const RUNTIME_TIMEOUT_MS = 60_000;

/** Run a host command with its output captured and a hard timeout. */
async function runBounded(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<RuntimeInvocation> {
  try {
    const output = await new Deno.Command(command, {
      args: [...args],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(timeoutMs),
    }).output();
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  } catch (error) {
    // A timeout or a missing executable is a failed invocation, never an
    // empty success.
    return {
      code: -1,
      stdout: "",
      stderr: `${command} could not be run: ${(error as Error).message}`,
    };
  }
}

/**
 * The production seams: real subprocesses, real signals, real telemetry.
 *
 * @param options - Runtime, listing dialect and telemetry sink
 * @returns Dependencies for {@link reapWedgedContainer}
 */
export function createReapDeps(options: ReapDepsOptions): ReapDeps {
  const timeoutMs = options.timeoutMs ?? RUNTIME_TIMEOUT_MS;
  const windows = Deno.build.os === "windows";

  return {
    runtimeExecutable: options.runtime,
    listArgs: options.listArgs,
    runRuntime: (args) => runBounded(options.runtime, args, timeoutMs),
    listProcesses: async () => {
      if (windows) {
        // No POSIX `ps` here. The runtime client is still SIGKILLed by pid
        // (the launcher hands it over), and Docker/Podman on Windows keep
        // their helper processes inside the daemon rather than in this
        // host's process table — so the scan has nothing to find. Said out
        // loud rather than passed off as an empty result.
        console.error(
          "[container-watchdog] host process scan is unavailable on Windows " +
            "— reaping by container name and client pid only",
        );
        return [];
      }
      const output = await runBounded("ps", ["-A", "-o", "pid=,args="], 15_000);
      if (output.code !== 0) {
        console.error(
          `[container-watchdog] could not read the host process table: ` +
            `${output.stderr.trim() || `ps exited ${output.code}`}`,
        );
        return [];
      }
      return parseProcessTable(output.stdout);
    },
    killProcess: (pid) => {
      try {
        Deno.kill(pid, "SIGKILL");
        return true;
      } catch {
        // Already gone, or not ours to signal.
        return false;
      }
    },
    isProcessAlive: (pid) => {
      if (windows) {
        // Unknowable cheaply here; assume alive so the reap proceeds to the
        // SIGKILL, which is harmless against a process that already exited.
        return true;
      }
      try {
        const output = new Deno.Command("kill", {
          args: ["-0", String(pid)],
          stdin: "null",
          stdout: "null",
          stderr: "null",
        }).outputSync();
        return output.code === 0;
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    emit: (event) => emitSelfHealEvent(event, { workDir: options.workDir }),
    log: (message) => console.error(message),
  };
}
