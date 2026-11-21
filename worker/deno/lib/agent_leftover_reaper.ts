/**
 * Leftover-process reaper for agent runs (Issue #4815).
 *
 * The descendant collector (Issue #4382) only sees a process while it is
 * still a descendant of the agent. A detached `( … & )` job is re-parented
 * to PID 1 at once, so no snapshot ever holds it, and on a normal exit the
 * collector is not run at all: a heavy build the agent left behind kept
 * going after the run ended and starved the container guest. Every agent
 * spawn therefore carries a unique `VIBE_AGENT_SPAWN_TAG` in its environment,
 * and once the agent has exited the runner terminates each process of the
 * same user that still carries that tag. Linux only: the scan reads
 * `/proc/<pid>/environ` through `grep`, because Deno refuses that file under
 * `--allow-read` alone.
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
const TAG_PATTERN = /^[0-9a-f-]{8,64}$/i;

/** Pause after KILL before the survivors are re-checked. */
const POST_KILL_SETTLE_MS = 500;

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

/** Result of one scan for tagged processes. */
export type FindTaggedResult =
  | { ok: true; pids: number[] }
  | { ok: false; error: string };

/** Process-table seams for the reaper; every default is the real OS. */
export interface LeftoverReaperDeps {
  /** Pids whose environment carries `envEntry` (`NAME=value`). */
  findTagged: (envEntry: string) => Promise<FindTaggedResult>;
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
 * Terminate every same-user process that carries the agent's spawn tag.
 * Call once the agent has exited. Each pid is fingerprinted after the scan
 * and re-checked immediately before every TERM and KILL; a pid with no
 * fingerprint, or one that no longer matches, is never signalled and is
 * reported as skipped. TERM first, then KILL after the bound.
 * Never throws: a scan failure is logged with its cause and reported as
 * `AGENT_LEFTOVERS_UNCHECKED`. A signal, identity or probe that throws stops
 * the pass, logs the cause under the same event, and reports as survivors
 * every pid not proven gone.
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

  const pids = found.pids.filter((pid) => pid !== deps.selfPid);
  if (pids.length === 0) {
    return { supported: true, collected: [], survivors: [], skipped: [] };
  }

  const signalled: number[] = [];
  const skipped: number[] = [];
  const gone = new Set<number>();
  const identities = new Map<number, ProcessIdentity>();
  let names = new Map<number, string>();
  // Checked immediately before every signal: a pid with no fingerprint, or
  // one that no longer matches its fingerprint, is never signalled.
  const stillOurs = async (pid: number): Promise<boolean> => {
    const identity = identities.get(pid);
    return identity !== undefined && await deps.isSame(pid, identity);
  };
  let survivors: number[];
  try {
    names = await deps.processNames(pids);
    for (const pid of pids) {
      const identity = await deps.captureIdentity(pid);
      if (identity !== null) identities.set(pid, identity);
    }
    for (const pid of pids) {
      if (!(await stillOurs(pid))) {
        skipped.push(pid);
        continue;
      }
      await deps.sendSignal(pid, "TERM");
      signalled.push(pid);
    }
    const waitSeconds = Math.max(1, Math.floor(options.maxWaitSeconds));
    for (let i = 0; i < waitSeconds; i++) {
      if ((await runningOf(deps, signalled, gone)).length === 0) break;
      await deps.sleep(1000);
    }
    for (const pid of await runningOf(deps, signalled, gone)) {
      if (!(await stillOurs(pid))) {
        skipped.push(pid);
        continue;
      }
      await deps.sendSignal(pid, "KILL");
    }
    await deps.sleep(POST_KILL_SETTLE_MS);
    survivors = (await runningOf(deps, signalled, gone)).filter((pid) =>
      !skipped.includes(pid)
    );
  } catch (error) {
    const cause = errorText(error);
    const done = signalled.length > 0 ? signalled.join(",") : "none";
    // Not proven gone: a pid the pass never confirmed absent, so it is listed
    // as unknown rather than as clear. A skipped pid is not ours to report.
    const unproven = pids.filter((pid) =>
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

  const described = pids
    .map((pid) => `${pid}(${names.get(pid) ?? "unknown"})`)
    .join(", ");
  logger?.warn(
    `The ${label} left ${pids.length} process(es) running after it exited: ` +
      `${described}; terminated (Issue #4815)` +
      (survivors.length > 0 ? `; still running: ${survivors.join(", ")}` : "") +
      (skipped.length > 0 ? `; skipped: ${skipped.join(", ")}` : ""),
  );
  logger?.security?.(
    "AGENT_LEFTOVERS_COLLECTED",
    `collected=${signalled.join(",")} survivors=${survivors.join(",")}`,
  );
  return { supported: true, collected: signalled, survivors, skipped };
}
