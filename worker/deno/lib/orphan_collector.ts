/**
 * Orphaned-descendant collector for agent runs (Issue #4382).
 *
 * The runner kills the agent's descendant tree when ITS OWN watchdog fires
 * (`killClaudeProcessTree`). When the agent is killed from outside — the
 * container VM's OOM killer sending SIGKILL, the case observed live on
 * host-23 — nothing collected the children: by the time the runner saw exit
 * 137 the kernel had re-parented them to PID 1, so `pgrep -P <pid>` found
 * nothing. The killed agent's Bash-tool shell (`timeout 3000 ./quality.sh`
 * → `deno run` → `deno test` over the whole tree) kept running beside the
 * in-process retry (#1550), which then met a heavier VM and was killed at
 * ~90 s.
 *
 * The fix is to remember the tree while the child is alive: a periodic
 * snapshot of its descendant PIDs. After an external kill, every snapshot
 * member that is still running and whose parent is no longer the child or
 * another live snapshot member has been re-parented — an orphan. Its
 * current subtree (grandchildren born after the last snapshot included) is
 * terminated bottom-up, SIGTERM then SIGKILL after a bounded wait.
 *
 * PID reuse guard: a snapshot pid whose process started AFTER the snapshot
 * was taken (`ps -o etimes=` shorter than the snapshot's age) is not the
 * process we saw and is never signalled.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import {
  getDescendants as pidGuardGetDescendants,
  getElapsedSeconds as pidGuardGetElapsedSeconds,
  isRunning as pidGuardIsRunning,
  trim,
} from "./pid_guard.ts";

/** Injectable process-table seams; every default is the real OS. */
export interface OrphanCollectorDeps {
  /** Descendants of a pid, bottom-up (deepest first). */
  getDescendants: (pid: number) => Promise<number[]>;
  /** Parent pid of a live process, `null` when it is gone or unreadable. */
  getParentPid: (pid: number) => Promise<number | null>;
  /** Seconds since the process started, `null` when unreadable. */
  getElapsedSeconds: (pid: number) => Promise<number | null>;
  /** Whether a pid is still running. */
  isRunning: (pid: number) => Promise<boolean>;
  /** Send TERM or KILL to a single pid (never a group). */
  sendSignal: (pid: number, signal: "TERM" | "KILL") => Promise<void>;
  /** Sleep between poll iterations. */
  sleep: (ms: number) => Promise<void>;
}

/** Default snapshot cadence while the child runs. */
export const DEFAULT_DESCENDANT_SNAPSHOT_INTERVAL_MS = 20_000;

/** Result of one collection pass. */
export interface OrphanCollection {
  /** Pids signalled, deepest first. */
  collected: number[];
  /** Snapshot pids left alone because they no longer look like ours. */
  skipped: number[];
}

/** Options for {@link DescendantTracker.collectOrphans}. */
export interface CollectOrphansOptions {
  /** Why the collection ran — named in the security line (`after=`). */
  reason: string;
  /** Seconds to wait after SIGTERM before SIGKILL. */
  maxWaitSeconds: number;
  logger?: Logger;
}

async function defaultGetParentPid(pid: number): Promise<number | null> {
  try {
    const out = await new Deno.Command("ps", {
      args: ["-p", String(pid), "-o", "ppid="],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!out.success) return null;
    const ppid = parseInt(trim(new TextDecoder().decode(out.stdout)), 10);
    return Number.isNaN(ppid) ? null : ppid;
  } catch {
    return null;
  }
}

async function defaultSendSignal(
  pid: number,
  signal: "TERM" | "KILL",
): Promise<void> {
  try {
    await new Deno.Command("kill", {
      args: [`-${signal}`, String(pid)],
      stdout: "null",
      stderr: "null",
    }).output();
  } catch {
    // best-effort
  }
}

export const DEFAULT_ORPHAN_COLLECTOR_DEPS: OrphanCollectorDeps = {
  getDescendants: (pid) => pidGuardGetDescendants(pid),
  getParentPid: defaultGetParentPid,
  getElapsedSeconds: (pid) => pidGuardGetElapsedSeconds(pid),
  isRunning: (pid) => pidGuardIsRunning(pid),
  sendSignal: defaultSendSignal,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Remembers a child's descendant tree while it runs so the survivors can be
 * collected after the child dies from outside.
 */
export class DescendantTracker {
  readonly #childPid: number;
  readonly #deps: OrphanCollectorDeps;
  readonly #nowMs: () => number;
  #snapshot: number[] = [];
  #snapshotAtMs: number | undefined;
  #inFlight: Promise<void> | undefined;

  constructor(
    childPid: number,
    deps: OrphanCollectorDeps = DEFAULT_ORPHAN_COLLECTOR_DEPS,
    options: { nowMs?: () => number } = {},
  ) {
    this.#childPid = childPid;
    this.#deps = deps;
    this.#nowMs = options.nowMs ?? (() => Date.now());
  }

  /** The most recent snapshot, bottom-up. */
  snapshot(): readonly number[] {
    return this.#snapshot;
  }

  /**
   * Take a fresh snapshot. One probe at a time: a call that lands while a
   * probe is in flight joins it rather than starting another.
   *
   * An empty result never erases a tree already seen (Issue #1135). The
   * probe is on an interval, so on a busy host one of its ticks lands in
   * the moment the child is dying — and `getDescendants` answers `[]` to
   * three different questions: the tree really is empty, the parent has
   * gone (`pid_guard.getDescendants` returns `[]` for a parent it cannot
   * see), and the probe itself failed (a `pgrep` that could not spawn under
   * load answers `[]` too). Letting that last tick overwrite the snapshot
   * destroys the only record of the tree at exactly the moment the record
   * is about to be needed, and `collectOrphans` then collects nothing —
   * the orphan survives, which is the whole failure #4382 exists to
   * prevent, and it strikes hardest under the memory pressure that causes
   * the external kill in the first place. Keeping the older members costs
   * nothing: `collectOrphans` re-checks liveness, parentage and age before
   * it signals any of them.
   */
  refresh(): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    const takenAt = this.#nowMs();
    this.#inFlight = this.#deps.getDescendants(this.#childPid)
      .then((pids) => {
        if (pids.length === 0 && this.#snapshot.length > 0) return;
        this.#snapshot = pids;
        this.#snapshotAtMs = takenAt;
      })
      .catch(() => {
        // A failed probe keeps the previous snapshot.
      })
      .finally(() => {
        this.#inFlight = undefined;
      });
    return this.#inFlight;
  }

  /** Await an in-flight probe (so nothing outlives the run). */
  async settle(): Promise<void> {
    if (this.#inFlight) await this.#inFlight;
  }

  /**
   * Terminate every snapshot member that outlived the child and was
   * re-parented, together with its current subtree. Bottom-up, TERM then
   * KILL after `maxWaitSeconds`. Never throws.
   */
  async collectOrphans(
    options: CollectOrphansOptions,
  ): Promise<OrphanCollection> {
    await this.settle();
    const deps = this.#deps;
    const skipped: number[] = [];
    if (this.#snapshot.length === 0) return { collected: [], skipped };

    const snapshotAgeSeconds = this.#snapshotAtMs === undefined
      ? 0
      : Math.floor((this.#nowMs() - this.#snapshotAtMs) / 1000);

    // Live snapshot members and their current parents.
    const alive = new Map<number, number | null>();
    for (const pid of this.#snapshot) {
      if (!(await deps.isRunning(pid))) continue;
      alive.set(pid, await deps.getParentPid(pid));
    }

    // Orphan roots: alive, parent is neither the child nor another live
    // member, and old enough to be the process we snapshotted.
    const roots: number[] = [];
    for (const [pid, ppid] of alive) {
      const parentIsOurs = ppid === this.#childPid ||
        (ppid !== null && alive.has(ppid));
      if (parentIsOurs) continue;
      const elapsed = await deps.getElapsedSeconds(pid);
      // A younger process than the snapshot is a reused pid — not ours.
      if (elapsed !== null && elapsed < Math.max(0, snapshotAgeSeconds - 1)) {
        skipped.push(pid);
        continue;
      }
      roots.push(pid);
    }
    if (roots.length === 0) return { collected: [], skipped };

    // Each root's current subtree first (deepest first), then the root.
    const targets: number[] = [];
    const seen = new Set<number>();
    for (const root of roots) {
      let subtree: number[] = [];
      try {
        subtree = await deps.getDescendants(root);
      } catch {
        // Fall back to the root alone.
      }
      for (const pid of [...subtree, root]) {
        if (!seen.has(pid)) {
          seen.add(pid);
          targets.push(pid);
        }
      }
    }

    for (const pid of targets) await deps.sendSignal(pid, "TERM");
    for (let i = 0; i < options.maxWaitSeconds; i++) {
      let anyRunning = false;
      for (const pid of targets) {
        if (await deps.isRunning(pid)) {
          anyRunning = true;
          break;
        }
      }
      if (!anyRunning) break;
      await deps.sleep(1000);
    }
    const killed: number[] = [];
    for (const pid of targets) {
      if (await deps.isRunning(pid)) {
        await deps.sendSignal(pid, "KILL");
        killed.push(pid);
      }
    }

    options.logger?.warn(
      `Collected ${targets.length} orphaned descendant(s) of the killed ` +
        `agent (pid ${this.#childPid}) after ${options.reason}: ` +
        `${targets.join(",")}` +
        (killed.length > 0 ? ` (SIGKILL needed for ${killed.join(",")})` : "") +
        " (Issue #4382)",
    );
    options.logger?.security?.(
      "ORPHANS_COLLECTED",
      `after=${options.reason} pids=${targets.join(",")}` +
        (killed.length > 0 ? ` sigkilled=${killed.join(",")}` : "") +
        (skipped.length > 0 ? ` skipped=${skipped.join(",")}` : ""),
    );
    return { collected: targets, skipped };
  }
}
