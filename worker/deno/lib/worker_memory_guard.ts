/**
 * Worker-wide early-OOM guard (Issue #5634).
 *
 * The guest wedged during an agent turn with 208 MiB available two minutes
 * before it went silent. The per-run guard (Issue #5529, `memory_guard.ts`,
 * driven from the agent runner) only kills processes inside ONE agent run's
 * own tree, so memory held by anything else the worker starts (another lane's
 * quality gate run through sudo, merge fast checks, milestone gates) was never
 * acted on.
 *
 * This guard runs for the worker's whole life. Every {@link
 * WORKER_MEMORY_GUARD_POLL_MS} it reads available memory; below the same floor
 * as the per-run guard it SIGKILLs the largest process (at least 256 MiB) in
 * the worker's own process tree. An agent CLI itself and the worker are never
 * chosen, but processes inside an agent's tree can be. The kill goes through
 * {@link killMemoryGuardVictim}, so it is sent only to a pid proven to be the
 * process chosen and still in the worker's tree. A tick never throws, and a
 * failed probe never kills (fail safe).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { listActiveAgentRuns, readAgentProcessTable } from "./claude_runner.ts";
import { formatBytesShort, parseProcessTable } from "./kill_diagnostics.ts";
import { commandOutputWithTimeout } from "./subprocess_timeout.ts";
import { asUntrustedUser } from "./untrusted_command_env.ts";
import {
  formatMemoryGuardKill,
  isBelowMemoryGuardFloor,
  killMemoryGuardVictim,
  MEMORY_GUARD_MIN_VICTIM_RSS_KB,
  memoryGuardFloorBytes,
  selectMemoryGuardVictim,
} from "./memory_guard.ts";
import {
  type MemoryPressureReading,
  probeHostMemoryPressure,
} from "./memory_pressure.ts";
import {
  captureProcessIdentity,
  getStartTime,
  type ProcessIdentity,
} from "./pid_guard.ts";

/** How often the worker-wide guard reads available memory, in milliseconds. */
export const WORKER_MEMORY_GUARD_POLL_MS = 5_000;

/** Opens the line for a failed process-table read or a failed kill. */
export const WORKER_MEMORY_GUARD_COULD_NOT = "Worker memory guard could not";
/** Opens the line for a victim the worker-wide guard declined to signal. */
export const WORKER_MEMORY_GUARD_LEFT_ALONE = "Worker memory guard left pid=";
/** Opens the line for a tick that threw. */
export const WORKER_MEMORY_GUARD_FAILED = "Worker memory guard failed:";
/** Opens the once-per-low-spell line when no process in the tree qualified. */
export const WORKER_MEMORY_GUARD_NO_VICTIM =
  "Worker memory guard found no process to kill:";

/** Injectable seams for {@link WorkerMemoryGuard}. */
export interface WorkerMemoryGuardDeps {
  /** Reads the guest's memory. A throw means "no reading": nothing is killed. */
  probe: () => Promise<MemoryPressureReading>;
  /** `ps -eo pid,ppid,rss,etime,args`. */
  runPs: () => Promise<string>;
  /** The SIGKILL itself. May throw; the guard logs the failure. */
  kill: (pid: number) => void | Promise<void>;
  /** Where the guard's lines go. */
  log: (message: string) => void;
  /** Pids of the live agent CLIs, which are never chosen. */
  activeAgentPids: () => readonly number[];
  /** A process's start token; defaults to the real reader. */
  readStartTime?: (pid: number) => Promise<string>;
  /** The worker's own pid, the root of the tree. Defaults to `Deno.pid`. */
  workerPid?: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The worker-wide memory guard. Drive it with {@link startWorkerMemoryGuard}. */
export class WorkerMemoryGuard {
  readonly #deps: WorkerMemoryGuardDeps;
  readonly #workerPid: number;
  #running = false;
  #noVictimLogged = false;
  #identity: ProcessIdentity | null = null;

  constructor(deps: WorkerMemoryGuardDeps) {
    this.#deps = deps;
    this.#workerPid = deps.workerPid ?? Deno.pid;
  }

  /** One check. Single-flight, and never throws. */
  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.#check();
    } catch (err) {
      try {
        this.#deps.log(
          `${WORKER_MEMORY_GUARD_FAILED} ${errorMessage(err)} (Issue #5634)`,
        );
      } catch {
        // Logging must not break the guard either.
      }
    } finally {
      this.#running = false;
    }
  }

  async #check(): Promise<void> {
    const deps = this.#deps;
    let reading: MemoryPressureReading;
    try {
      reading = await deps.probe();
    } catch {
      return;
    }
    if (!isBelowMemoryGuardFloor(reading)) {
      this.#noVictimLogged = false;
      return;
    }
    let psText: string;
    try {
      psText = await deps.runPs();
    } catch (err) {
      deps.log(
        `${WORKER_MEMORY_GUARD_COULD_NOT} read the process table: ${
          errorMessage(err)
        } (Issue #5634)`,
      );
      return;
    }
    const workerPid = this.#workerPid;
    const victim = selectMemoryGuardVictim({
      reading,
      rows: parseProcessTable(psText),
      agentPid: workerPid,
      selfPid: workerPid,
      excludePids: deps.activeAgentPids(),
    });
    const floorBytes = memoryGuardFloorBytes(reading.totalBytes ?? 0);
    if (victim === undefined) {
      if (this.#noVictimLogged) return;
      this.#noVictimLogged = true;
      const available = formatBytesShort(reading.availableBytes ?? 0);
      const total = formatBytesShort(reading.totalBytes ?? 0);
      deps.log(
        `${WORKER_MEMORY_GUARD_NO_VICTIM} guest memory critically low ` +
          `(${available} of ${total} available, floor ` +
          `${formatBytesShort(floorBytes)}), and no process of at least ` +
          `${MEMORY_GUARD_MIN_VICTIM_RSS_KB / 1024} MiB in the worker's own ` +
          `tree (Issue #5634)`,
      );
      return;
    }
    const readStartTime = deps.readStartTime ?? getStartTime;
    // Only a proven identity is kept: a failed first capture is retried on
    // the next tick rather than refusing every later kill.
    if (this.#identity === null) {
      this.#identity = await captureProcessIdentity(workerPid, readStartTime);
    }
    try {
      const outcome = await killMemoryGuardVictim({
        victim,
        agentPid: workerPid,
        agentIdentity: this.#identity,
      }, { runPs: deps.runPs, kill: deps.kill, readStartTime });
      if (outcome.killed) {
        deps.log(formatMemoryGuardKill({
          reading,
          victim,
          floorBytes,
          scope: "worker",
        }));
      } else {
        deps.log(
          `${WORKER_MEMORY_GUARD_LEFT_ALONE}${victim.pid} alone: ${outcome.reason} ` +
            `(Issue #5634)`,
        );
      }
    } catch (err) {
      deps.log(
        `${WORKER_MEMORY_GUARD_COULD_NOT} kill pid=${victim.pid}: ${
          errorMessage(err)
        } (Issue #5634)`,
      );
    }
  }
}

/**
 * Start the guard on a timer. The timer is unref'd so it never holds the
 * process open. Returns a function that stops it.
 */
export function startWorkerMemoryGuard(
  deps: WorkerMemoryGuardDeps,
  intervalMs: number = WORKER_MEMORY_GUARD_POLL_MS,
): () => void {
  const guard = new WorkerMemoryGuard(deps);
  const id = setInterval(() => void guard.tick(), intervalMs);
  Deno.unrefTimer(id);
  return () => clearInterval(id);
}

/** The production wiring for {@link startWorkerMemoryGuard}. */
export function productionWorkerMemoryGuardDeps(
  log: (message: string) => void,
): WorkerMemoryGuardDeps {
  return {
    probe: () => probeHostMemoryPressure({}),
    runPs: () => readAgentProcessTable(),
    kill: (pid) => killWorkerTreeProcess(pid),
    log,
    activeAgentPids: () => listActiveAgentRuns().map((r) => r.pid),
  };
}

/** Bound on the `sudo ... kill` fallback, in milliseconds. */
const SUDO_KILL_TIMEOUT_MS = 5_000;

/** Injectable seams for {@link killWorkerTreeProcess}. */
export interface KillWorkerTreeProcessDeps {
  /** The direct SIGKILL. Defaults to `Deno.kill(pid, "SIGKILL")`. */
  signal?: (pid: number) => void;
  /** Runs an argv and reports its exit code and stderr. Defaults to the bounded command runner. */
  run?: (argv: string[]) => Promise<{ code: number; stderr: string }>;
}

async function runBounded(
  argv: string[],
): Promise<{ code: number; stderr: string }> {
  const [executable, ...args] = argv;
  const out = await commandOutputWithTimeout(executable!, {
    args,
    stdin: "null",
    stdout: "null",
    stderr: "piped",
    timeoutMs: SUDO_KILL_TIMEOUT_MS,
  });
  return { code: out.code, stderr: new TextDecoder().decode(out.stderr) };
}

/**
 * SIGKILL a process in the worker's tree (Issue #5634). The worker runs as
 * `vibe`, but quality gates run as the separate `agent` account, which `vibe`
 * cannot signal directly (EPERM). On `PermissionDenied` the kill is retried
 * as `sudo -n -u agent -- kill -s KILL <pid>`; any other error rethrows.
 */
export async function killWorkerTreeProcess(
  pid: number,
  deps: KillWorkerTreeProcessDeps = {},
): Promise<void> {
  const signal = deps.signal ?? ((p: number) => Deno.kill(p, "SIGKILL"));
  const run = deps.run ?? runBounded;
  try {
    signal(pid);
    return;
  } catch (err) {
    if (!(err instanceof Deno.errors.PermissionDenied)) throw err;
  }
  const result = await run(
    asUntrustedUser(["kill", "-s", "KILL", String(pid)], { enabled: true }),
  );
  if (result.code !== 0) {
    const cause = result.stderr.split("\n")[0]?.trim() ?? "";
    throw new Error(
      `sudo -n -u agent -- kill exited ${result.code}: ${cause}`,
    );
  }
}
