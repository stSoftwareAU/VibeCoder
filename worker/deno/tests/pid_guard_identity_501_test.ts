/**
 * Identity-verified signalling in the kill path (Issue #501).
 *
 * A pid is only a handle, and the kernel hands it back out the moment the
 * process behind it is reaped. Every signal the worker sends is decided from
 * evidence gathered earlier — a `pgrep -P` sweep, a `ps` liveness probe — so
 * between the evidence and the signal the pid can come to belong to a
 * stranger. On CI that stranger was in the runner's own tree, and the suite
 * killed the runner mid-run ("The runner has received a shutdown signal").
 *
 * The contract pinned here: the kill path never signals a pid it cannot prove
 * still holds the process it started. Proof is the process's start time,
 * captured while the process was known to be ours and re-checked immediately
 * before every signal — TERM and KILL, parent and descendants.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  captureProcessIdentity,
  isRunning,
  isSameProcess,
  type ProcessIdentity,
  terminateDescendants,
  type TerminateDescendantsDeps,
  terminateProcessTree,
  type TerminateProcessTreeDeps,
} from "../lib/pid_guard.ts";
import { killClaudeProcessTree } from "../lib/claude_runner.ts";

/** One signal sent through the fake seams. */
interface SentSignal {
  target: number;
  signal: string;
}

/** Consume the next scripted value for a pid; the last value repeats. */
function nextFor<T>(
  queues: Map<number, T[]>,
  pid: number,
  fallback: T,
): T {
  const queue = queues.get(pid);
  if (!queue || queue.length === 0) return fallback;
  return queue.length > 1 ? queue.shift()! : queue[0]!;
}

/** Build scripted queues from a pid-keyed record. */
function toQueues<T>(source: Record<number, T[]>): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const [pid, values] of Object.entries(source)) {
    map.set(Number(pid), [...values]);
  }
  return map;
}

const FAKE_SELF_PID = 999_999;

/**
 * Fake seams for {@link terminateProcessTree}.
 *
 * `startTimes` scripts what `ps -o lstart=` reports for each pid on
 * successive lookups — the seam that lets a test replay a pid being reused
 * partway through a kill.
 */
function makeTreeDeps(opts: {
  pgidOutput?: string;
  startTimes: Record<number, string[]>;
  runningSequence: boolean[];
}): { deps: TerminateProcessTreeDeps; sent: SentSignal[] } {
  const sent: SentSignal[] = [];
  const running = [...opts.runningSequence];
  const startTimes = toQueues(opts.startTimes);

  const deps: TerminateProcessTreeDeps = {
    selfPid: FAKE_SELF_PID,
    runPgidCommand: (pid: number) =>
      Promise.resolve(
        pid === FAKE_SELF_PID
          ? { success: true, stdout: "1\n" }
          : { success: true, stdout: opts.pgidOutput ?? "" },
      ),
    getStartTime: (pid: number) =>
      Promise.resolve(nextFor(startTimes, pid, "")),
    sendSignal: (target: number, signal: string) => {
      sent.push({ target, signal });
      return Promise.resolve();
    },
    isRunning: () =>
      Promise.resolve(
        running.length > 1 ? running.shift()! : running[0] ?? false,
      ),
    sleep: () => Promise.resolve(),
  };

  return { deps, sent };
}

/** Fake seams for {@link terminateDescendants}. */
function makeDescendantDeps(opts: {
  descendants: number[];
  startTimes: Record<number, string[]>;
  running?: Record<number, boolean[]>;
}): { deps: TerminateDescendantsDeps; sent: SentSignal[] } {
  const sent: SentSignal[] = [];
  const startTimes = toQueues(opts.startTimes);
  const running = toQueues(opts.running ?? {});

  const deps: TerminateDescendantsDeps = {
    getDescendants: () => Promise.resolve([...opts.descendants]),
    getStartTime: (pid: number) =>
      Promise.resolve(nextFor(startTimes, pid, "")),
    sendSignal: (target: number, signal: string) => {
      sent.push({ target, signal });
      return Promise.resolve();
    },
    isRunning: (pid: number) => Promise.resolve(nextFor(running, pid, true)),
    sleep: () => Promise.resolve(),
  };

  return { deps, sent };
}

// ---------------------------------------------------------------------------
// terminateProcessTree
// ---------------------------------------------------------------------------

Deno.test("pid_guard - terminateProcessTree signals a target whose identity still matches (Issue #501)", async () => {
  const { deps, sent } = makeTreeDeps({
    pgidOutput: "1234\n",
    startTimes: { 1234: ["Mon Aug 24 09:00:00 2026"] },
    runningSequence: [false],
  });

  await terminateProcessTree(1234, 30, deps, {
    identity: { pid: 1234, startedAt: "Mon Aug 24 09:00:00 2026" },
  });

  assertEquals(sent, [
    { target: -1234, signal: "TERM" },
    { target: 1234, signal: "TERM" },
  ]);
});

Deno.test("pid_guard - terminateProcessTree never signals a pid that has been reused since we fingerprinted it (Issue #501)", async () => {
  // The agent was reaped and the kernel handed its pid to a stranger — on CI,
  // one of the runner's own processes.
  const { deps, sent } = makeTreeDeps({
    pgidOutput: "1234\n",
    startTimes: { 1234: ["Mon Aug 24 11:11:11 2026"] },
    runningSequence: [true],
  });

  await terminateProcessTree(1234, 30, deps, {
    identity: { pid: 1234, startedAt: "Mon Aug 24 09:00:00 2026" },
  });

  assertEquals(sent, [], "a reused pid must receive no signal at all");
});

Deno.test("pid_guard - terminateProcessTree escalation re-checks identity: a pid reused after SIGTERM is never SIGKILLed (Issue #501)", async () => {
  // Same start time for the capture and the pre-TERM check, a stranger's by
  // the time the escalation fires.
  const { deps, sent } = makeTreeDeps({
    pgidOutput: "1234\n",
    startTimes: {
      1234: [
        "Mon Aug 24 09:00:00 2026",
        "Mon Aug 24 09:00:00 2026",
        "Mon Aug 24 09:00:00 2026",
        "Mon Aug 24 12:00:00 2026",
      ],
    },
    runningSequence: [true],
  });

  await terminateProcessTree(1234, 1, deps, {
    identity: { pid: 1234, startedAt: "Mon Aug 24 09:00:00 2026" },
  });

  assertEquals(sent.filter((s) => s.signal === "KILL"), []);
});

Deno.test("pid_guard - terminateProcessTree refuses to signal when the target was never fingerprinted (Issue #501)", async () => {
  const { deps, sent } = makeTreeDeps({
    pgidOutput: "1234\n",
    startTimes: { 1234: ["Mon Aug 24 09:00:00 2026"] },
    runningSequence: [true],
  });

  // `null` means the caller tried to fingerprint the process and could not;
  // an unproven target is never signalled.
  await terminateProcessTree(1234, 1, deps, { identity: null });

  assertEquals(sent, []);
});

Deno.test("pid_guard - terminateProcessTree fingerprints the target itself when the caller supplies no identity (Issue #501)", async () => {
  const { deps, sent } = makeTreeDeps({
    pgidOutput: "1234\n",
    startTimes: { 1234: ["Mon Aug 24 09:00:00 2026"] },
    runningSequence: [false],
  });

  await terminateProcessTree(1234, 30, deps);

  assertEquals(sent, [
    { target: -1234, signal: "TERM" },
    { target: 1234, signal: "TERM" },
  ]);
});

Deno.test("pid_guard - terminateProcessTree sends nothing when the pid is already gone (Issue #501)", async () => {
  // An empty `ps -o lstart=` means the pid holds no process we can identify.
  const { deps, sent } = makeTreeDeps({
    pgidOutput: "1234\n",
    startTimes: { 1234: [""] },
    runningSequence: [true],
  });

  await terminateProcessTree(1234, 30, deps);

  assertEquals(sent, []);
});

// ---------------------------------------------------------------------------
// terminateDescendants
// ---------------------------------------------------------------------------

Deno.test("pid_guard - terminateDescendants signals descendants of a parent that is still ours (Issue #501)", async () => {
  const { deps, sent } = makeDescendantDeps({
    descendants: [201, 202],
    startTimes: {
      100: ["Mon Aug 24 09:00:00 2026"],
      201: ["Mon Aug 24 09:00:01 2026"],
      202: ["Mon Aug 24 09:00:02 2026"],
    },
    running: { 201: [false], 202: [false] },
  });

  const result = await terminateDescendants(100, 5, deps, {
    identity: { pid: 100, startedAt: "Mon Aug 24 09:00:00 2026" },
  });

  assertEquals(sent, [
    { target: 201, signal: "TERM" },
    { target: 202, signal: "TERM" },
  ]);
  assertEquals(result.targetedPids, [201, 202]);
});

Deno.test("pid_guard - terminateDescendants signals nothing when the parent pid has been reused (Issue #501)", async () => {
  // `pgrep -P <reused pid>` lists a stranger's children. Sweeping them is how
  // a watchdog kill reached processes the worker never started.
  const { deps, sent } = makeDescendantDeps({
    descendants: [201, 202],
    startTimes: {
      100: ["Mon Aug 24 13:00:00 2026"],
      201: ["Mon Aug 24 13:00:01 2026"],
      202: ["Mon Aug 24 13:00:02 2026"],
    },
  });

  const result = await terminateDescendants(100, 5, deps, {
    identity: { pid: 100, startedAt: "Mon Aug 24 09:00:00 2026" },
  });

  assertEquals(sent, [], "a stranger's children must never be signalled");
  assertEquals(result.targetedPids, []);
});

Deno.test("pid_guard - terminateDescendants skips a descendant whose pid was reused between discovery and SIGTERM (Issue #501)", async () => {
  const { deps, sent } = makeDescendantDeps({
    descendants: [201, 202],
    startTimes: {
      100: ["Mon Aug 24 09:00:00 2026"],
      201: ["Mon Aug 24 09:00:01 2026"],
      // Captured, then reused before its TERM.
      202: ["Mon Aug 24 09:00:02 2026", "Mon Aug 24 14:00:00 2026"],
    },
    running: { 201: [false], 202: [false] },
  });

  const result = await terminateDescendants(100, 5, deps, {
    identity: { pid: 100, startedAt: "Mon Aug 24 09:00:00 2026" },
  });

  assertEquals(sent, [{ target: 201, signal: "TERM" }]);
  assertEquals(result.targetedPids, [201]);
  assertEquals(result.skippedPids, [202]);
});

Deno.test("pid_guard - terminateDescendants escalation re-checks identity: a descendant reused after SIGTERM is never SIGKILLed (Issue #501)", async () => {
  const { deps, sent } = makeDescendantDeps({
    descendants: [201],
    startTimes: {
      100: ["Mon Aug 24 09:00:00 2026"],
      201: [
        "Mon Aug 24 09:00:01 2026",
        "Mon Aug 24 09:00:01 2026",
        "Mon Aug 24 09:00:01 2026",
        "Mon Aug 24 15:00:00 2026",
      ],
    },
    running: { 201: [true] },
  });

  const result = await terminateDescendants(100, 1, deps, {
    identity: { pid: 100, startedAt: "Mon Aug 24 09:00:00 2026" },
  });

  assertEquals(sent, [{ target: 201, signal: "TERM" }]);
  assertEquals(result.skippedPids, [201]);
});

// ---------------------------------------------------------------------------
// Identity capture against the real process table
// ---------------------------------------------------------------------------

Deno.test("pid_guard - captureProcessIdentity fingerprints a live process and matches it back (Issue #501)", async () => {
  const identity = await captureProcessIdentity(Deno.pid);
  assert(identity, "the running test process must be identifiable");
  assertEquals(identity.pid, Deno.pid);
  assert(identity.startedAt.length > 0, "a start time must be captured");
  assertEquals(await isSameProcess(identity), true);
});

Deno.test("pid_guard - captureProcessIdentity returns null for a pid holding no process (Issue #501)", async () => {
  assertEquals(await captureProcessIdentity(999_999_999), null);
});

Deno.test("pid_guard - isSameProcess rejects an identity whose start time no longer matches (Issue #501)", async () => {
  const stale: ProcessIdentity = {
    pid: Deno.pid,
    startedAt: "Thu Jan  1 00:00:00 1970",
  };
  assertEquals(await isSameProcess(stale), false);
});

// ---------------------------------------------------------------------------
// End to end, against real processes
// ---------------------------------------------------------------------------

Deno.test("killClaudeProcessTree - a live process whose identity does not match is left alone, and a matching one is killed (Issue #501)", async () => {
  // `sleep 60 & wait` gives the tree a real descendant, so both halves of the
  // kill path (descendants, then the parent) are exercised.
  const child = new Deno.Command("bash", {
    args: ["-c", "sleep 60 & wait"],
    stdout: "null",
    stderr: "null",
  }).spawn();

  const identity = await captureProcessIdentity(child.pid);
  assert(identity, "the spawned child must be identifiable");

  // A stale fingerprint stands in for a reaped-and-reused pid: the kill path
  // must send nothing, and the process must survive untouched.
  await killClaudeProcessTree(child.pid, 1, undefined, {
    pid: child.pid,
    startedAt: "Thu Jan  1 00:00:00 1970",
  });
  assertEquals(
    await isRunning(child.pid),
    true,
    "a process we cannot prove we started must never be signalled",
  );

  // The real fingerprint still kills, so the guard costs no capability: the
  // tree ends long before the 60 s sleep would have ended it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"still-running">((resolve) => {
    timer = setTimeout(() => resolve("still-running"), 15_000);
  });
  const killing = killClaudeProcessTree(child.pid, 5, undefined, identity);
  const outcome = await Promise.race([
    child.status.then(() => "exited" as const),
    timedOut,
  ]);
  clearTimeout(timer);
  await killing;
  if (outcome !== "exited") {
    child.kill("SIGKILL");
    await child.status;
  }
  assertEquals(outcome, "exited", "the fingerprinted tree must be killed");
});
