/**
 * Leftover-process reaper for agent runs (Issue #4815).
 *
 * The descendant collector (Issue #4382) only sees a process while it is
 * still a descendant of the agent. A detached `( … & )` job is re-parented
 * to PID 1 at once, so no snapshot ever holds it, and on a normal exit the
 * collector is not run at all: a job the agent left behind can keep running
 * after the run ended. That leak is one possible cause of the completion
 * wedge, not an established one. Every agent
 * spawn therefore carries a unique `VIBE_AGENT_SPAWN_TAG` in its environment,
 * and once the agent has exited the runner terminates each process of the
 * same user that still carries that tag. Linux only: the scan reads
 * `/proc/<pid>/environ` through `grep`, because Deno refuses that file under
 * `--allow-read` alone. The guest memory floor's tag reaper
 * (guest_memory_tag_reaper.ts) applies the same tag rule without spawning.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import { commandOutputWithTimeout } from "./subprocess_timeout.ts";
import { DEFAULT_ORPHAN_COLLECTOR_DEPS } from "./orphan_collector.ts";
import {
  captureProcessIdentity,
  isSameProcess,
  type ProcessIdentity,
} from "./pid_guard.ts";

/** Environment variable carrying the per-spawn tag (Issue #4815). */
export const AGENT_SPAWN_TAG_ENV = "VIBE_AGENT_SPAWN_TAG";

/** Bound on the environment scan and the name lookup. */
const REAPER_PROBE_TIMEOUT_MS = 10_000;

/** Only the shape {@link newAgentSpawnTag} produces is accepted. */
export const TAG_PATTERN = /^[0-9a-f-]{8,64}$/i;

/** Pause after KILL before the survivors are re-checked. */
const POST_KILL_SETTLE_MS = 500;

/**
 * Bound on KILL rounds. Each round rescans for tagged processes born since
 * the last one, so a tree that keeps forking cannot hold the pass open.
 */
const MAX_KILL_ROUNDS = 4;

/**
 * Prints the pid of every same-user process whose environment carries the
 * entry in `$1`. The entry is an argument, never interpolated. A pid that
 * vanishes mid-scan is skipped. A missing `pgrep` or a failed scan exits
 * non-zero, so it is never mistaken for "nothing found".
 */
const FIND_TAGGED_SCRIPT = [
  "entry=$1",
  'command -v pgrep >/dev/null 2>&1 || { echo "pgrep is not installed" >&2; exit 1; }',
  "uid=$(id -u) || exit 1",
  'pids=$(pgrep -U "$uid"); rc=$?',
  '[ "$rc" -le 1 ] || { echo "pgrep failed with status $rc" >&2; exit 1; }',
  'for p in $pids; do f=/proc/$p/environ; [ -r "$f" ] || continue; if grep -q -z -x -F -e "$entry" "$f" 2>/dev/null; then echo "$p"; fi; done',
  "exit 0",
].join("\n");

/**
 * Exits 0 only when `/proc/$1/environ` holds the entry in `$2`. A pid that
 * has gone, or whose environment cannot be read, exits non-zero.
 */
const HAS_TAG_SCRIPT = [
  'f=/proc/$1/environ; [ -r "$f" ] || exit 1',
  'grep -q -z -x -F -e "$2" "$f" 2>/dev/null',
].join("\n");

/** Result of one scan for tagged processes. */
export type FindTaggedResult =
  | { ok: true; pids: number[] }
  | { ok: false; error: string };

/** Process-table seams for the reaper; every default is the real OS. */
export interface LeftoverReaperDeps {
  /** Pids whose environment carries `envEntry` (`NAME=value`). */
  findTagged: (envEntry: string) => Promise<FindTaggedResult>;
  /**
   * Whether the process now holding `pid` carries `envEntry`. Read after the
   * identity is captured, so the fingerprint is bound to a tagged process.
   * An unreadable or unmatched process answers `false`; a probe timeout or
   * spawn failure throws, and the pass reports it as an error.
   */
  hasTag: (pid: number, envEntry: string) => Promise<boolean>;
  /** Command name (never arguments) for each pid, when readable. */
  processNames: (pids: number[]) => Promise<Map<number, string>>;
  /** Whether a pid is still running. */
  isRunning: (pid: number) => Promise<boolean>;
  /** Send TERM or KILL to a single pid (never a group). */
  sendSignal: (pid: number, signal: "TERM" | "KILL") => Promise<void>;
  /** Fingerprint of the process holding a pid; `null` when unidentifiable. */
  captureIdentity: (pid: number) => Promise<ProcessIdentity | null>;
  /** Whether the pid still holds the process `identity` fingerprinted. */
  isSame: (pid: number, identity: ProcessIdentity) => Promise<boolean>;
  /** Sleep between poll iterations. */
  sleep: (ms: number) => Promise<void>;
  /** This process; never signalled. */
  selfPid: number;
  /** Whether the scan can run on this platform. */
  supported: boolean;
}

/** Options for {@link reapAgentLeftovers}. */
export interface ReapAgentLeftoversOptions {
  /** The spawn tag from {@link newAgentSpawnTag}. */
  tag: string;
  /** Seconds to wait after SIGTERM before SIGKILL. */
  maxWaitSeconds: number;
  logger?: Logger;
  /** Noun for the run in log lines. Default `agent`. */
  label?: string;
  /** Process-table seams — tests only. */
  deps?: LeftoverReaperDeps;
}

/** What one reaping pass found and did. Never thrown. */
export interface ReapAgentLeftoversResult {
  /** False only on a platform the scan does not run on. */
  supported: boolean;
  /** Pids signalled with TERM, in the order they were found. */
  collected: number[];
  /**
   * Pids still running after KILL. When the pass stopped on an error, every
   * pid not proven gone, since none of them can be called clear.
   */
  survivors: number[];
  /**
   * Pids never signalled because their identity was missing or no longer
   * matched at the moment of a signal.
   */
  skipped: number[];
  /** The cause, when the scan or the signalling failed. */
  error?: string;
}

/** A fresh tag for one agent spawn. */
export function newAgentSpawnTag(): string {
  return crypto.randomUUID();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePids(text: string): number[] {
  const pids: number[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^[1-9][0-9]*$/.test(line)) pids.push(Number(line));
  }
  return [...new Set(pids)];
}

async function defaultFindTagged(envEntry: string): Promise<FindTaggedResult> {
  const decoder = new TextDecoder();
  let out: Deno.CommandOutput;
  try {
    out = await commandOutputWithTimeout("sh", {
      args: ["-c", FIND_TAGGED_SCRIPT, "sh", envEntry],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      timeoutMs: REAPER_PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
  if (!out.success) {
    const firstLine = decoder.decode(out.stderr).split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return {
      ok: false,
      error: firstLine ?? `the scan exited with status ${out.code}`,
    };
  }
  return { ok: true, pids: parsePids(decoder.decode(out.stdout)) };
}

async function defaultHasTag(pid: number, envEntry: string): Promise<boolean> {
  if (!Number.isInteger(pid) || pid < 1) return false;
  const out = await commandOutputWithTimeout("sh", {
    args: ["-c", HAS_TAG_SCRIPT, "sh", String(pid), envEntry],
    stdin: "null",
    stdout: "null",
    stderr: "null",
    timeoutMs: REAPER_PROBE_TIMEOUT_MS,
  });
  return out.success;
}

async function defaultProcessNames(
  pids: number[],
): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  if (pids.length === 0) return names;
  try {
    const out = await commandOutputWithTimeout("ps", {
      args: ["-o", "pid=,comm=", "-p", pids.join(",")],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      timeoutMs: REAPER_PROBE_TIMEOUT_MS,
    });
    if (!out.success) return names;
    for (const line of new TextDecoder().decode(out.stdout).split("\n")) {
      const match = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
      const pid = match?.[1];
      const name = match?.[2];
      if (pid !== undefined && name !== undefined) {
        names.set(Number(pid), name);
      }
    }
  } catch {
    // Names are for the log line only; a failed lookup leaves "unknown".
    return new Map<number, string>();
  }
  return names;
}

/** Injectable seams with the real OS behind them. */
export const DEFAULT_LEFTOVER_REAPER_DEPS: LeftoverReaperDeps = {
  findTagged: defaultFindTagged,
  hasTag: defaultHasTag,
  processNames: defaultProcessNames,
  isRunning: DEFAULT_ORPHAN_COLLECTOR_DEPS.isRunning,
  sendSignal: DEFAULT_ORPHAN_COLLECTOR_DEPS.sendSignal,
  captureIdentity: captureProcessIdentity,
  isSame: async (pid, identity) =>
    identity.pid === pid && await isSameProcess(identity),
  sleep: DEFAULT_ORPHAN_COLLECTOR_DEPS.sleep,
  selfPid: Deno.pid,
  supported: Deno.build.os === "linux",
};

/**
 * The pids among `pids` still running. Each pid found gone is recorded in
 * `gone` when one is given, so a pass that stops early knows what it proved.
 */
async function runningOf(
  deps: LeftoverReaperDeps,
  pids: number[],
  gone?: Set<number>,
): Promise<number[]> {
  const running: number[] = [];
  for (const pid of pids) {
    if (await deps.isRunning(pid)) running.push(pid);
    else gone?.add(pid);
  }
  return running;
}

/**
 * Terminate the same-user processes that carry the agent's spawn tag.
 * Normally called once the agent has exited; the error path of the runner
 * calls it while the agent may still be running, and it is terminated too
 * (it carries the tag). The pass is bounded by {@link MAX_KILL_ROUNDS}.
 * Each pid is fingerprinted after the scan,
 * and its tag is read again after the fingerprint, so a pid reused since the
 * scan is never taken for a leftover. The fingerprint is re-checked
 * immediately before every TERM and KILL; a pid with no fingerprint, no tag
 * or a changed fingerprint is never signalled and is reported as skipped.
 * TERM first, then KILL after the bound. The pass rescans while it runs
 * (each second of the TERM wait, then each KILL round, at most
 * {@link MAX_KILL_ROUNDS}), so a tagged child a leftover starts meanwhile is
 * terminated too; when new ones are still appearing at the bound, they are
 * reported as survivors and the warning says cleanup is incomplete.
 * Never throws: a scan failure is logged with its cause and reported as
 * `AGENT_LEFTOVERS_UNCHECKED`. A signal, identity, rescan or probe that
 * throws stops the pass, logs the cause under the same event, and reports as
 * survivors every pid not proven gone.
 */
export async function reapAgentLeftovers(
  options: ReapAgentLeftoversOptions,
): Promise<ReapAgentLeftoversResult> {
  const deps = options.deps ?? DEFAULT_LEFTOVER_REAPER_DEPS;
  const logger = options.logger;
  const label = options.label ?? "agent";

  if (!TAG_PATTERN.test(options.tag)) {
    const error = "malformed spawn tag";
    logger?.error(
      `Not checking for processes the ${label} left running (Issue #4815): ` +
        `${error}; nothing was scanned`,
    );
    return {
      supported: deps.supported,
      collected: [],
      survivors: [],
      skipped: [],
      error,
    };
  }
  if (!deps.supported) {
    return { supported: false, collected: [], survivors: [], skipped: [] };
  }

  const entry = `${AGENT_SPAWN_TAG_ENV}=${options.tag}`;
  let found: FindTaggedResult;
  try {
    found = await deps.findTagged(entry);
  } catch (error) {
    found = { ok: false, error: errorText(error) };
  }
  if (!found.ok) {
    logger?.error(
      `Could not scan for processes the ${label} left running ` +
        `(Issue #4815): ${found.error}; any leftover is still running`,
    );
    logger?.security?.("AGENT_LEFTOVERS_UNCHECKED", `cause=${found.error}`);
    return {
      supported: true,
      collected: [],
      survivors: [],
      skipped: [],
      error: found.error,
    };
  }

  const initial = found.pids.filter((pid) => pid !== deps.selfPid);
  if (initial.length === 0) {
    return { supported: true, collected: [], survivors: [], skipped: [] };
  }

  const signalled: number[] = [];
  const skipped: number[] = [];
  const gone = new Set<number>();
  const identities = new Map<number, ProcessIdentity>();
  // Every pid the pass has taken up, in the order found. `untagged` holds the
  // ones that no longer carried the tag when checked: not the agent's.
  const known: number[] = [];
  const knownSet = new Set<number>();
  const untagged = new Set<number>();
  const names = new Map<number, string>();

  // Takes up pids not seen before. Each is fingerprinted and then its tag is
  // read again, in that order: a pid reused between the scan and the
  // fingerprint holds an untagged process, so the fingerprint is never bound
  // to it, and it is skipped, not signalled.
  const adopt = async (candidates: number[]): Promise<number[]> => {
    const fresh = candidates.filter((pid) =>
      pid !== deps.selfPid && !knownSet.has(pid)
    );
    if (fresh.length === 0) return fresh;
    for (const pid of fresh) {
      knownSet.add(pid);
      known.push(pid);
    }
    for (const [pid, name] of await deps.processNames(fresh)) {
      names.set(pid, name);
    }
    for (const pid of fresh) {
      const identity = await deps.captureIdentity(pid);
      if (identity === null) {
        skipped.push(pid);
      } else if (!(await deps.hasTag(pid, entry))) {
        untagged.add(pid);
        skipped.push(pid);
      } else {
        identities.set(pid, identity);
      }
    }
    return fresh;
  };
  // Scans again for tagged processes born since the last scan, such as a
  // child a leftover starts while it handles TERM, and takes them up.
  const rescan = async (): Promise<number[]> => {
    const result = await deps.findTagged(entry);
    if (!result.ok) throw new Error(`rescan failed: ${result.error}`);
    return await adopt(result.pids);
  };
  // Checked immediately before every signal: a pid with no fingerprint, or
  // one that no longer matches its fingerprint, is never signalled.
  const stillOurs = async (pid: number): Promise<boolean> => {
    const identity = identities.get(pid);
    return identity !== undefined && await deps.isSame(pid, identity);
  };
  const signalAll = async (
    pids: number[],
    signal: "TERM" | "KILL",
  ): Promise<number> => {
    let sent = 0;
    for (const pid of pids) {
      if (skipped.includes(pid)) continue;
      if (!(await stillOurs(pid))) {
        skipped.push(pid);
        continue;
      }
      await deps.sendSignal(pid, signal);
      sent++;
      if (!signalled.includes(pid)) signalled.push(pid);
    }
    return sent;
  };
  const killedPids = new Set<number>();
  let survivors: number[];
  let exhausted = false;
  try {
    await adopt(initial);
    await signalAll(known, "TERM");
    const waitSeconds = Math.max(1, Math.floor(options.maxWaitSeconds));
    for (let i = 0; i < waitSeconds; i++) {
      const born = await rescan();
      await signalAll(born, "TERM");
      if (
        born.length === 0 &&
        (await runningOf(deps, signalled, gone)).length === 0
      ) break;
      await deps.sleep(1000);
    }
    // KILL until a rescan finds nothing new and nothing is left to KILL, so a
    // tagged child born while the pass ran is found before it is called clear.
    exhausted = true;
    for (let round = 0; round < MAX_KILL_ROUNDS; round++) {
      const born = await rescan();
      const running = await runningOf(deps, signalled, gone);
      // A pid already sent KILL is not sent it again: one that survives it
      // is reported, not retried.
      const targets = [...born, ...running].filter((pid) =>
        !killedPids.has(pid)
      );
      for (const pid of targets) killedPids.add(pid);
      const killed = await signalAll(targets, "KILL");
      if (born.length === 0 && killed === 0) {
        // The scan snapshots pids before probing their tags. A parent can
        // fork and exit between that snapshot and the liveness check above.
        const late = await rescan();
        if (late.length === 0) {
          exhausted = false;
          break;
        }
        for (const pid of late) killedPids.add(pid);
        await signalAll(late, "KILL");
      }
      await deps.sleep(POST_KILL_SETTLE_MS);
    }
    // After the last round, anything tagged and still running is a survivor.
    const late = exhausted ? await rescan() : [];
    survivors = (await runningOf(deps, [...signalled, ...late], gone)).filter((
      pid,
    ) => !skipped.includes(pid));
  } catch (error) {
    const cause = errorText(error);
    const done = signalled.length > 0 ? signalled.join(",") : "none";
    // Not proven gone: a pid the pass never confirmed absent, so it is listed
    // as unknown rather than as clear. A skipped pid is not ours to report.
    const unproven = known.filter((pid) =>
      !gone.has(pid) && !skipped.includes(pid)
    );
    logger?.error(
      `Stopped terminating the processes the ${label} left running: ` +
        `${cause}; signalled: ${done}; any other leftover is still ` +
        "running (Issue #4815)",
    );
    logger?.security?.(
      "AGENT_LEFTOVERS_UNCHECKED",
      `cause=${cause} unproven=${unproven.join(",") || "none"}`,
    );
    return {
      supported: true,
      collected: signalled,
      survivors: unproven,
      skipped,
      error: cause,
    };
  }

  const leftovers = known.filter((pid) => !untagged.has(pid));
  if (leftovers.length > 0) {
    const described = leftovers
      .map((pid) => `${pid}(${names.get(pid) ?? "unknown"})`)
      .join(", ");
    logger?.warn(
      `The ${label} left ${leftovers.length} process(es) running after it ` +
        `exited: ${described}; terminated (Issue #4815)` +
        (survivors.length > 0
          ? `; still running: ${survivors.join(", ")}`
          : "") +
        (exhausted
          ? `; new tagged processes kept appearing for ${MAX_KILL_ROUNDS} ` +
            "KILL rounds, so cleanup is incomplete"
          : "") +
        (skipped.length > 0 ? `; skipped: ${skipped.join(", ")}` : ""),
    );
  } else if (skipped.length > 0) {
    logger?.warn(
      `Skipped ${skipped.join(", ")}: no longer carried the ${label}'s ` +
        "spawn tag when checked, so it was not signalled (Issue #4815)",
    );
  }
  logger?.security?.(
    "AGENT_LEFTOVERS_COLLECTED",
    `collected=${signalled.join(",")} survivors=${survivors.join(",")}`,
  );
  return { supported: true, collected: signalled, survivors, skipped };
}
