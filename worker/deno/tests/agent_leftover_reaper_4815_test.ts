/**
 * Tests for the agent leftover reaper (Issue #4815).
 *
 * A pre-PR verifier ran `( timeout 1500 cargo test … & )`. The detached job
 * was re-parented to PID 1 at once, so the descendant collector never saw
 * it, and it kept running after the agent had finished. The reaper finds
 * every same-user process carrying the agent's spawn tag and terminates it
 * once the agent exits.
 *
 * The unit cases drive the reaper through fake process-table seams. The
 * Linux cases run real detached processes through the default seams and
 * through the runner.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  AGENT_SPAWN_TAG_ENV,
  DEFAULT_LEFTOVER_REAPER_DEPS,
  type FindTaggedResult,
  type LeftoverReaperDeps,
  newAgentSpawnTag,
  reapAgentLeftovers,
} from "../lib/agent_leftover_reaper.ts";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import type { Logger } from "../types.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

const TAG = "0b6f3c5e-8a1d-4f2e-9c7b-1a2b3c4d5e6f";

/** Lines the logger received, by level. */
interface Recorded {
  warn: string[];
  error: string[];
  security: Array<{ event: string; details: string }>;
}

function newRecorded(): Recorded {
  return { warn: [], error: [], security: [] };
}

/** The first recorded item; fails the test when nothing was recorded. */
function firstOf<T>(items: readonly T[]): T {
  const item = items[0];
  assert(item !== undefined, "expected at least one recorded line");
  return item;
}

function recordingLogger(recorded: Recorded): Logger {
  return {
    info: () => {},
    warn: (msg: string) => recorded.warn.push(msg),
    error: (msg: string) => recorded.error.push(msg),
    debug: () => {},
    security: (event: string, details: string) =>
      recorded.security.push({ event, details }),
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

interface FakeOptions {
  /** What the environment scan answers. Default: nothing found. */
  found?: FindTaggedResult;
  /** Pids alive before the reaper runs. */
  alive: number[];
  /** Command name per pid. */
  names?: Record<number, string>;
  /** Pids that keep running after TERM. */
  ignoreTerm?: number[];
  /** Pids that keep running after KILL. */
  unkillable?: number[];
  /** A pid whose signal throws. */
  failOn?: number;
  /** Pids with no identity fingerprint, so they must never be signalled. */
  noIdentity?: number[];
  /** Pids whose identity changes once they have been sent TERM. */
  replacedAfterTerm?: number[];
  /**
   * Pids found by the scan whose process is an untagged replacement by the
   * time the identity is captured (the old tagged process has exited and the
   * pid was reused).
   */
  replacedBeforeCapture?: number[];
  /** Pids that start a tagged child, by pid, when sent TERM, then exit. */
  spawnsOnTerm?: Record<number, number>;
  /** Every signalled pid exits after starting a new tagged one. */
  respawnOnSignal?: boolean;
  /** The reaper's own pid. Default 1. */
  selfPid?: number;
  /** Whether the platform is supported. Default true. */
  supported?: boolean;
}

/** A fake process table plus the calls made against it. */
function fakeReaper(options: FakeOptions) {
  const alive = new Set(options.alive);
  const signals: string[] = [];
  const scans: string[] = [];
  const sleeps: number[] = [];
  const found: FindTaggedResult = options.found ?? { ok: true, pids: [] };
  // Tagged processes born while the reaper runs, still alive.
  const born: number[] = [];
  let nextBorn = 9000;
  const deps: LeftoverReaperDeps = {
    findTagged: (envEntry) => {
      scans.push(envEntry);
      if (!found.ok) return Promise.resolve(found);
      return Promise.resolve({
        ok: true as const,
        pids: [...found.pids, ...born.filter((pid) => alive.has(pid))],
      });
    },
    hasTag: (pid) => {
      const replaced = options.replacedBeforeCapture?.includes(pid) === true;
      return Promise.resolve(alive.has(pid) && !replaced);
    },
    processNames: (pids) => {
      const names = new Map<number, string>();
      for (const pid of pids) {
        const name = options.names?.[pid];
        if (name !== undefined) names.set(pid, name);
      }
      return Promise.resolve(names);
    },
    isRunning: (pid) => Promise.resolve(alive.has(pid)),
    captureIdentity: (pid) => {
      if (options.noIdentity?.includes(pid)) return Promise.resolve(null);
      return Promise.resolve({ pid, startedAt: `start-${pid}` });
    },
    isSame: (pid, identity) => {
      const replaced = options.replacedAfterTerm?.includes(pid) === true &&
        signals.includes(`TERM ${pid}`);
      return Promise.resolve(
        identity.pid === pid && alive.has(pid) && !replaced,
      );
    },
    sendSignal: (pid, signal) => {
      signals.push(`${signal} ${pid}`);
      if (options.failOn === pid) {
        return Promise.reject(
          new Error(`kill ${pid}: operation not permitted`),
        );
      }
      if (signal === "TERM" && options.ignoreTerm?.includes(pid)) {
        return Promise.resolve();
      }
      if (signal === "KILL" && options.unkillable?.includes(pid)) {
        return Promise.resolve();
      }
      alive.delete(pid);
      const child = options.respawnOnSignal === true
        ? nextBorn++
        : signal === "TERM"
        ? options.spawnsOnTerm?.[pid]
        : undefined;
      if (child !== undefined) {
        alive.add(child);
        born.push(child);
      }
      return Promise.resolve();
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    selfPid: options.selfPid ?? 1,
    supported: options.supported ?? true,
  };
  return { deps, signals, scans, sleeps, alive, born };
}

Deno.test({
  name:
    "reaper - terminates tagged processes, spares self, names them in the warning",
  permissions: { read: true, env: true },
  async fn() {
    const fake = fakeReaper({
      found: { ok: true, pids: [101, 102, 999] },
      alive: [101, 102, 999],
      names: { 101: "cargo", 102: "rustc" },
      selfPid: 999,
    });
    const recorded = newRecorded();
    const result = await reapAgentLeftovers({
      tag: TAG,
      maxWaitSeconds: 3,
      logger: recordingLogger(recorded),
      deps: fake.deps,
    });

    // The pass rescans while it runs; every scan asks for this spawn tag.
    assert(fake.scans.length >= 1, "the environment must be scanned");
    assertEquals(
      [...new Set(fake.scans)],
      [`${AGENT_SPAWN_TAG_ENV}=${TAG}`],
    );
    assertEquals(fake.signals, ["TERM 101", "TERM 102"]);
    assertEquals(result.collected, [101, 102]);
    assertEquals(result.survivors, []);
    assertEquals(result.error, undefined);
    assertEquals(recorded.warn.length, 1);
    assertStringIncludes(firstOf(recorded.warn), "101(cargo)");
    assertStringIncludes(firstOf(recorded.warn), "102(rustc)");
    assertStringIncludes(firstOf(recorded.warn), "Issue #4815");
    assertEquals(recorded.security.length, 1);
    assertEquals(firstOf(recorded.security).event, "AGENT_LEFTOVERS_COLLECTED");
    assertEquals(
      firstOf(recorded.security).details,
      "collected=101,102 survivors=",
    );
  },
});

Deno.test({
  name: "reaper - KILLs a pid that ignores TERM after the wait",
  permissions: { read: true, env: true },
  async fn() {
    const fake = fakeReaper({
      found: { ok: true, pids: [201] },
      alive: [201],
      names: { 201: "stubborn" },
      ignoreTerm: [201],
    });
    const recorded = newRecorded();
    const result = await reapAgentLeftovers({
      tag: TAG,
      maxWaitSeconds: 2,
      logger: recordingLogger(recorded),
      deps: fake.deps,
    });

    assertEquals(fake.signals, ["TERM 201", "KILL 201"]);
    // Two one-second polls for the TERM to take, then the settle pause.
    assertEquals(fake.sleeps, [1000, 1000, 500]);
    assertEquals(result.collected, [201]);
    assertEquals(result.survivors, []);
    assertStringIncludes(firstOf(recorded.warn), "201(stubborn)");
    assert(
      !firstOf(recorded.warn).includes("still running"),
      firstOf(recorded.warn),
    );
  },
});

Deno.test({
  name: "reaper - names a survivor that outlives SIGKILL",
  permissions: { read: true, env: true },
  async fn() {
    const fake = fakeReaper({
      found: { ok: true, pids: [301] },
      alive: [301],
      ignoreTerm: [301],
      unkillable: [301],
    });
    const recorded = newRecorded();
    const result = await reapAgentLeftovers({
      tag: TAG,
      maxWaitSeconds: 1,
      logger: recordingLogger(recorded),
      deps: fake.deps,
    });

    assertEquals(result.survivors, [301]);
    assertStringIncludes(firstOf(recorded.warn), "; still running: 301");
    assertEquals(
      firstOf(recorded.security).details,
      "collected=301 survivors=301",
    );
  },
});

Deno.test({
  name: "reaper - a scan failure logs its cause and signals nothing",
  permissions: { read: true, env: true },
  async fn() {
    const fake = fakeReaper({
      found: { ok: false, error: "pgrep failed with status 2" },
      alive: [401],
    });
    const recorded = newRecorded();
    const result = await reapAgentLeftovers({
      tag: TAG,
      maxWaitSeconds: 2,
      logger: recordingLogger(recorded),
      deps: fake.deps,
    });

    assertEquals(fake.signals, []);
    assertEquals(result.error, "pgrep failed with status 2");
    assertEquals(recorded.error.length, 1);
    assertStringIncludes(firstOf(recorded.error), "pgrep failed with status 2");
    assertStringIncludes(
      firstOf(recorded.error),
      "any leftover is still running",
    );
    assertEquals(recorded.security.length, 1);
    assertEquals(firstOf(recorded.security).event, "AGENT_LEFTOVERS_UNCHECKED");
    assertStringIncludes(
      firstOf(recorded.security).details,
      "cause=pgrep failed with status 2",
    );
    assertEquals(recorded.warn, []);
  },
});

Deno.test({
  name: "reaper - nothing tagged means no signal and no warning",
  permissions: { read: true, env: true },
  async fn() {
    const fake = fakeReaper({
      found: { ok: true, pids: [] },
      alive: [501],
    });
    const recorded = newRecorded();
    const result = await reapAgentLeftovers({
      tag: TAG,
      maxWaitSeconds: 2,
      logger: recordingLogger(recorded),
      deps: fake.deps,
    });

    assertEquals(fake.signals, []);
    assertEquals(result, {
      supported: true,
      collected: [],
      survivors: [],
      skipped: [],
    });
    assertEquals(recorded.warn, []);
    assertEquals(recorded.error, []);
    assertEquals(recorded.security, []);
  },
});

Deno.test({
  name: "reaper - an unsupported platform never scans",
  permissions: { read: true, env: true },
  async fn() {
    const fake = fakeReaper({
      found: { ok: true, pids: [601] },
      alive: [601],
      supported: false,
    });
    const recorded = newRecorded();
    const result = await reapAgentLeftovers({
      tag: TAG,
      maxWaitSeconds: 2,
      logger: recordingLogger(recorded),
      deps: fake.deps,
    });

    assertEquals(fake.scans, []);
    assertEquals(fake.signals, []);
    assertEquals(result.supported, false);
    assertEquals(recorded.error, []);
    assertEquals(recorded.warn, []);
  },
});

Deno.test({
  name: "reaper - a malformed tag is refused before any scan",
  permissions: { read: true, env: true },
  async fn() {
    const fake = fakeReaper({
      found: { ok: true, pids: [701] },
      alive: [701],
    });
    const recorded = newRecorded();
    const result = await reapAgentLeftovers({
      tag: "x; rm -rf /",
      maxWaitSeconds: 2,
      logger: recordingLogger(recorded),
      deps: fake.deps,
    });

    assertEquals(fake.scans, []);
    assertEquals(fake.signals, []);
    assert(result.error, "a malformed tag must name an error");
    assertEquals(recorded.error.length, 1);
  },
});

Deno.test({
  name: "reaper - a signal that throws stops the pass and names what was done",
  permissions: { read: true, env: true },
  async fn() {
    const fake = fakeReaper({
      found: { ok: true, pids: [801, 802] },
      alive: [801, 802],
      failOn: 802,
    });
    const recorded = newRecorded();
    const result = await reapAgentLeftovers({
      tag: TAG,
      maxWaitSeconds: 2,
      logger: recordingLogger(recorded),
      deps: fake.deps,
    });

    assertEquals(fake.signals, ["TERM 801", "TERM 802"]);
    assertEquals(result.collected, [801]);
    // Neither pid was proven gone, so both are listed as unknown.
    assertEquals(result.survivors, [801, 802]);
    assertStringIncludes(result.error ?? "", "operation not permitted");
    assertEquals(recorded.error.length, 1);
    assertStringIncludes(firstOf(recorded.error), "operation not permitted");
    assertStringIncludes(firstOf(recorded.error), "signalled: 801");
    assertEquals(recorded.security.length, 1);
    assertEquals(
      firstOf(recorded.security).event,
      "AGENT_LEFTOVERS_UNCHECKED",
    );
    assertStringIncludes(
      firstOf(recorded.security).details,
      "cause=kill 802: operation not permitted",
    );
    assertStringIncludes(
      firstOf(recorded.security).details,
      "unproven=801,802",
    );
  },
});

Deno.test({
  name: "reaper - a pid replaced between TERM and KILL is never KILLed",
  permissions: { read: true, env: true },
  async fn() {
    const fake = fakeReaper({
      found: { ok: true, pids: [401] },
      alive: [401],
      ignoreTerm: [401],
      replacedAfterTerm: [401],
    });
    const recorded = newRecorded();
    const result = await reapAgentLeftovers({
      tag: TAG,
      maxWaitSeconds: 1,
      logger: recordingLogger(recorded),
      deps: fake.deps,
    });

    // TERM was sent while the identity still matched; KILL was not, because
    // at KILL time the pid no longer holds the fingerprinted process.
    assertEquals(fake.signals, ["TERM 401"]);
    assertEquals(result.collected, [401]);
    assertEquals(result.skipped, [401]);
    assertEquals(result.survivors, []);
    assertStringIncludes(firstOf(recorded.warn), "; skipped: 401");
  },
});

Deno.test({
  name: "reaper - a pid with no identity is never signalled",
  permissions: { read: true, env: true },
  async fn() {
    const fake = fakeReaper({
      found: { ok: true, pids: [501, 502] },
      alive: [501, 502],
      noIdentity: [501],
    });
    const recorded = newRecorded();
    const result = await reapAgentLeftovers({
      tag: TAG,
      maxWaitSeconds: 2,
      logger: recordingLogger(recorded),
      deps: fake.deps,
    });

    assertEquals(fake.signals, ["TERM 502"]);
    assertEquals(result.collected, [502]);
    assertEquals(result.skipped, [501]);
    assertEquals(result.survivors, []);
    assertStringIncludes(firstOf(recorded.warn), "; skipped: 501");
  },
});

Deno.test({
  name:
    "reaper - a tagged pid replaced by an untagged process before the identity is captured is never signalled",
  permissions: { read: true, env: true },
  async fn() {
    // 101 was tagged at the scan, then exited and its pid was reused by an
    // unrelated process; 102 is a genuine leftover (the allowed control).
    const fake = fakeReaper({
      found: { ok: true, pids: [101, 102] },
      alive: [101, 102],
      replacedBeforeCapture: [101],
      ignoreTerm: [101],
    });
    const recorded = newRecorded();
    const result = await reapAgentLeftovers({
      tag: TAG,
      maxWaitSeconds: 2,
      logger: recordingLogger(recorded),
      deps: fake.deps,
    });

    assertEquals(fake.signals, ["TERM 102"]);
    assertEquals(result.collected, [102]);
    assertEquals(result.skipped, [101]);
    assertEquals(result.survivors, []);
    assert(fake.alive.has(101), "the unrelated replacement must keep running");
    assertEquals(result.error, undefined);
    // Only the genuine leftover is reported as one the agent left.
    assertStringIncludes(firstOf(recorded.warn), "left 1 process(es)");
    assertStringIncludes(firstOf(recorded.warn), "; skipped: 101");
  },
});

Deno.test({
  name:
    "reaper - when every found pid was replaced nothing is signalled and no leftover is claimed",
  permissions: { read: true, env: true },
  async fn() {
    const fake = fakeReaper({
      found: { ok: true, pids: [111] },
      alive: [111],
      replacedBeforeCapture: [111],
    });
    const recorded = newRecorded();
    const result = await reapAgentLeftovers({
      tag: TAG,
      maxWaitSeconds: 2,
      logger: recordingLogger(recorded),
      deps: fake.deps,
    });

    assertEquals(fake.signals, []);
    assertEquals(result.collected, []);
    assertEquals(result.skipped, [111]);
    assert(fake.alive.has(111), "the replacement must keep running");
    assertEquals(recorded.warn.length, 1);
    assert(
      !firstOf(recorded.warn).includes("left 1 process"),
      firstOf(recorded.warn),
    );
    assertStringIncludes(firstOf(recorded.warn), "Skipped 111");
  },
});

Deno.test({
  name:
    "reaper - a tagged child a leftover starts while handling TERM is terminated too",
  permissions: { read: true, env: true },
  async fn() {
    // 101 starts tagged 102 when sent TERM and exits; 900 is unrelated.
    const fake = fakeReaper({
      found: { ok: true, pids: [101] },
      alive: [101, 900],
      spawnsOnTerm: { 101: 102 },
    });
    const recorded = newRecorded();
    const result = await reapAgentLeftovers({
      tag: TAG,
      maxWaitSeconds: 3,
      logger: recordingLogger(recorded),
      deps: fake.deps,
    });

    assertEquals(fake.signals, ["TERM 101", "TERM 102"]);
    assertEquals(result.collected, [101, 102]);
    assertEquals(result.survivors, []);
    assertEquals(result.skipped, []);
    assert(!fake.alive.has(102), "the child born during the pass must be gone");
    assert(fake.alive.has(900), "unrelated work must survive");
    assertStringIncludes(firstOf(recorded.warn), "left 2 process(es)");
  },
});

Deno.test({
  name:
    "reaper - a tagged child that ignores TERM is KILLed, and one born during KILL is found by the next round",
  permissions: { read: true, env: true },
  async fn() {
    // 201 ignores TERM, and starts tagged 202 at the moment it is KILLed.
    const fake = fakeReaper({
      found: { ok: true, pids: [201] },
      alive: [201, 900],
      ignoreTerm: [201],
    });
    const inner = fake.deps.sendSignal;
    fake.deps.sendSignal = async (pid, signal) => {
      await inner(pid, signal);
      if (pid === 201 && signal === "KILL") {
        fake.alive.add(202);
        fake.born.push(202); // the scan can now find it
      }
    };
    const result = await reapAgentLeftovers({
      tag: TAG,
      maxWaitSeconds: 1,
      logger: recordingLogger(newRecorded()),
      deps: fake.deps,
    });

    assertEquals(fake.signals, ["TERM 201", "KILL 201", "KILL 202"]);
    assertEquals(result.survivors, []);
    assert(!fake.alive.has(202));
    assert(fake.alive.has(900), "unrelated work must survive");
  },
});

Deno.test({
  name:
    "reaper - tagged processes that keep appearing are bounded and reported as incomplete",
  permissions: { read: true, env: true },
  async fn() {
    // Every signalled pid exits after starting a new tagged one.
    const fake = fakeReaper({
      found: { ok: true, pids: [301] },
      alive: [301, 900],
      respawnOnSignal: true,
    });
    const recorded = newRecorded();
    const result = await reapAgentLeftovers({
      tag: TAG,
      maxWaitSeconds: 2,
      logger: recordingLogger(recorded),
      deps: fake.deps,
    });

    assert(result.survivors.length > 0, "the newest child must be reported");
    for (const pid of result.survivors) {
      assert(fake.alive.has(pid), `survivor ${pid} must still be running`);
    }
    assert(fake.alive.has(900), "unrelated work must survive");
    // Bounded: two TERM-wait rescans and four KILL rounds, one spawn each.
    assert(fake.signals.length <= 12, fake.signals.join(", "));
    assertStringIncludes(firstOf(recorded.warn), "cleanup is incomplete");
    assertStringIncludes(firstOf(recorded.warn), "; still running: ");
  },
});

Deno.test({
  name:
    "reaper - a rescan that fails stops the pass and lists what is unproven",
  permissions: { read: true, env: true },
  async fn() {
    const fake = fakeReaper({
      found: { ok: true, pids: [401] },
      alive: [401],
    });
    let scans = 0;
    const scan = fake.deps.findTagged;
    fake.deps.findTagged = (entry) => {
      scans++;
      return scans === 1
        ? scan(entry)
        : Promise.resolve({ ok: false, error: "pgrep failed with status 2" });
    };
    const recorded = newRecorded();
    const result = await reapAgentLeftovers({
      tag: TAG,
      maxWaitSeconds: 2,
      logger: recordingLogger(recorded),
      deps: fake.deps,
    });

    assertEquals(fake.signals, ["TERM 401"]);
    assertStringIncludes(result.error ?? "", "rescan failed");
    assertStringIncludes(result.error ?? "", "pgrep failed with status 2");
    assertEquals(firstOf(recorded.security).event, "AGENT_LEFTOVERS_UNCHECKED");
    assertStringIncludes(firstOf(recorded.security).details, "unproven=401");
  },
});

/** Pids whose full command line matches `pattern`, via `pgrep -f`. */
async function pgrepPids(pattern: string): Promise<number[]> {
  const out = await new Deno.Command("pgrep", {
    args: ["-f", pattern],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!out.success) return [];
  return new TextDecoder().decode(out.stdout)
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Best-effort SIGKILL of anything still matching `pattern`. */
async function killMatching(pattern: string): Promise<void> {
  for (const pid of await pgrepPids(pattern)) {
    try {
      Deno.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A `sleep` duration unique to this run, such as `300.482913`. GNU sleep
 * takes the fraction. The Linux tests match and kill by this exact string,
 * so they never touch another lane's `sleep` on a shared host.
 */
function uniqueSleepDuration(base: number): string {
  const digits = Math.floor(Math.random() * 1_000_000).toString()
    .padStart(6, "0");
  return `${base}.${digits}`;
}

Deno.test({
  name:
    "reaper - terminates a detached tagged job and spares an untagged one (Linux)",
  permissions: { run: true, read: true, env: true },
  ignore: Deno.build.os !== "linux",
  async fn() {
    const tag = newAgentSpawnTag();
    const taggedDuration = uniqueSleepDuration(300);
    const controlDuration = uniqueSleepDuration(301);
    const taggedPattern = `sleep ${taggedDuration}`;
    const controlPattern = `sleep ${controlDuration}`;
    // A control with a different tag: it must survive the reap.
    const control = new Deno.Command("sleep", {
      args: [controlDuration],
      stdin: "null",
      stdout: "null",
      stderr: "null",
      env: { [AGENT_SPAWN_TAG_ENV]: newAgentSpawnTag() },
    }).spawn();
    try {
      // A detached job, as an agent's `( … & )` leaves it: re-parented at once.
      const launch = await new Deno.Command("sh", {
        args: [
          "-c",
          `(${taggedPattern} >/dev/null 2>&1 &)`,
        ],
        stdin: "null",
        stdout: "null",
        stderr: "null",
        env: { [AGENT_SPAWN_TAG_ENV]: tag },
      }).output();
      assert(launch.success, "the detached job must launch");
      for (let i = 0; i < 50; i++) {
        if ((await pgrepPids(taggedPattern)).length > 0) break;
        await delay(100);
      }
      assert(
        (await pgrepPids(taggedPattern)).length > 0,
        "the job never ran",
      );

      const result = await reapAgentLeftovers({ tag, maxWaitSeconds: 2 });

      assertEquals(result.supported, true);
      assertEquals(result.error, undefined);
      assert(result.collected.length >= 1, "the tagged job must be collected");
      assertEquals(await pgrepPids(taggedPattern), []);
      assert(
        (await pgrepPids(controlPattern)).length > 0,
        "the untagged control must still run",
      );
    } finally {
      await killMatching(taggedPattern);
      try {
        control.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      await control.status;
    }
  },
});

Deno.test({
  name:
    "runner - terminates a detached job the agent left running (Linux, Issue #4815)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os !== "linux",
  async fn() {
    const duration = uniqueSleepDuration(303);
    const pattern = `sleep ${duration}`;
    const body = [
      "#!/usr/bin/env bash",
      `(sleep ${duration} >/dev/null 2>&1 &)`,
      `printf '%s\\n' '${JSON.stringify({ type: "result", result: "done" })}'`,
      "exit 0",
      "",
    ].join("\n");
    const recorded = newRecorded();
    try {
      const result = await withAgentStub(
        body,
        (stub) =>
          runClaudeWithTimeout({
            clock: fakeClock(),
            prompt: "test",
            agentBinaryPath: stub.path,
            model: "claude-opus-4-8",
            repo: "owner/repo",
            phase: "issue",
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            logger: recordingLogger(recorded),
          }),
        { prefix: "claude_leftover_stub_" },
      );

      assert(result.ok, "the stub run must succeed");
      assertEquals(await pgrepPids(pattern), []);
      const warning = recorded.warn.find((m) => m.includes("(sleep)"));
      assert(
        warning,
        `expected a leftover warning naming sleep, got: ${
          recorded.warn.join(" | ")
        }`,
      );
      assertStringIncludes(warning, "Issue #4815");
    } finally {
      await killMatching(pattern);
    }
  },
});

Deno.test({
  name:
    "reaper - the default tag read is true for a tagged process and false for others (Linux)",
  permissions: { run: true, read: true, env: true },
  ignore: Deno.build.os !== "linux",
  async fn() {
    const tagValue = newAgentSpawnTag();
    const entry = `${AGENT_SPAWN_TAG_ENV}=${tagValue}`;
    const duration = uniqueSleepDuration(302);
    const tagged = new Deno.Command("sleep", {
      args: [duration],
      stdin: "null",
      stdout: "null",
      stderr: "null",
      env: { [AGENT_SPAWN_TAG_ENV]: tagValue },
    }).spawn();
    try {
      const { hasTag } = DEFAULT_LEFTOVER_REAPER_DEPS;
      assertEquals(await hasTag(tagged.pid, entry), true);
      // Same process, a different tag: refused by the entry, not the pid.
      assertEquals(
        await hasTag(
          tagged.pid,
          `${AGENT_SPAWN_TAG_ENV}=${newAgentSpawnTag()}`,
        ),
        false,
      );
      // A process without the variable at all (this test runner).
      assertEquals(await hasTag(Deno.pid, entry), false);
      // A pid that does not exist.
      assertEquals(await hasTag(2_000_000_000, entry), false);
    } finally {
      try {
        tagged.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      await tagged.status;
    }
  },
});
