/**
 * The guest memory floor SIGKILLs the agent through its process handle when
 * the process-tree kill does not stop it (Issue #5638).
 *
 * The tree kill spawns `cat`, `ps`, `pgrep` and `kill`; on a guest out of
 * memory each spawn times out, so the kill returns with the agent still
 * running. These tests inject a tree kill that signals nothing, or fails, and
 * keep the agent stub gated so only the handle kill can end the run.
 */
import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_LEFTOVER_REAPER_DEPS,
  type LeftoverReaperDeps,
} from "../lib/agent_leftover_reaper.ts";
import {
  killClaudeProcessTree,
  runClaudeWithTimeout,
} from "../lib/claude_runner.ts";
import {
  GUEST_MEMORY_KILL_FAILED,
  GUEST_MEMORY_TAG_SWEEP,
  GuestMemoryFloorError,
} from "../lib/guest_memory_floor.ts";
import type { MemoryPressureReading } from "../lib/memory_pressure.ts";
import type { Logger } from "../types.ts";
import {
  type AgentStub,
  agentStubGate,
  createAgentStub,
  releaseAgentStub,
} from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Optional stub body, leftover seams and hook run once the agent has printed. */
interface DriveExtras {
  stubBody?: string;
  leftoverReaperDeps?: LeftoverReaperDeps;
  onReady?: (stub: AgentStub) => Promise<void>;
}

/** Whether `pid` is running and not a zombie. Deno refuses /proc/<pid>/stat, so `ps` answers. */
async function isLive(pid: number): Promise<boolean> {
  const out = await new Deno.Command("ps", {
    args: ["-o", "stat=", "-p", String(pid)],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).output();
  const state = new TextDecoder().decode(out.stdout).trim();
  return state !== "" && !state.startsWith("Z");
}

/** Poll until `pid` is gone or a zombie, for up to 5 s. */
async function waitUntilGone(pid: number): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (!(await isLive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Captures the warn and error lines the run logs. */
function capturingLogger(): {
  logger: Logger;
  warns: string[];
  errors: string[];
} {
  const warns: string[] = [];
  const errors: string[] = [];
  const logger = {
    info: () => {},
    warn: (message: string) => {
      warns.push(message);
    },
    error: (message: string) => {
      errors.push(message);
    },
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  } as unknown as Logger;
  return { logger, warns, errors };
}

async function drive(
  availableBytes: number,
  killProcessTree: typeof killClaudeProcessTree,
  logger: Logger,
  releaseBeforeAwait: boolean,
  extras: DriveExtras = {},
): Promise<Awaited<ReturnType<typeof runClaudeWithTimeout>>> {
  const clock = fakeClock();
  const ready = Promise.withResolvers<void>();
  const probe = (): Promise<MemoryPressureReading> =>
    Promise.resolve({ level: "high", totalBytes: 8 * GIB, availableBytes });
  const stub = await createAgentStub(
    extras.stubBody ??
      `printf '%s\\n' '{"type":"result","result":"working"}'\n` +
        agentStubGate() + "exit 0\n",
  );
  let run: ReturnType<typeof runClaudeWithTimeout> | undefined;
  try {
    run = runClaudeWithTimeout({
      prompt: "test",
      cwd: stub.dir,
      agentBinaryPath: stub.path,
      clock,
      logger,
      timeoutSeconds: 3600,
      killAfterSeconds: 1,
      guestMemoryPollMs: 1_000,
      probeMemoryPressure: probe,
      killProcessTree,
      progressIntervalMs: 86_400_000,
      descendantSnapshotIntervalMs: 86_400_000,
      onActivity: () => ready.resolve(),
      ...(extras.leftoverReaperDeps
        ? { leftoverReaperDeps: extras.leftoverReaperDeps }
        : {}),
    });
    await ready.promise;
    await extras.onReady?.(stub);
    for (let i = 0; i < 3; i++) {
      await clock.advance(1_000);
      await new Promise((r) => setTimeout(r, 20));
    }
    if (releaseBeforeAwait) await releaseAgentStub(stub);
    return await run;
  } finally {
    await releaseAgentStub(stub);
    await run;
    await stub.dispose();
  }
}

const opts = { ignore: Deno.build.os === "windows" };
const permissions = {
  read: true,
  write: true,
  run: true,
  env: true,
} as const;

/** The reason the runner reports for a 100 MiB reading on an 8 GiB guest. */
const LOW_REASON =
  "[GUEST_MEMORY_FLOOR] guest memory stayed below its floor (100 MiB available, " +
  "floor 512 MiB) for 2 readings in a row: the agent run was stopped so the " +
  "guest keeps answering (Issue #4815)";

Deno.test({
  name:
    "guest memory handle kill - a tree kill that signals nothing still stops the agent (Issue #5638)",
  ...opts,
  permissions,
  async fn() {
    const killed: number[] = [];
    const killProcessTree = (pid: number): Promise<void> => {
      killed.push(pid);
      return Promise.resolve();
    };
    const { logger, warns } = capturingLogger();
    const result = await drive(100 * MIB, killProcessTree, logger, false);
    assert(!result.ok);
    assert(result.error instanceof GuestMemoryFloorError);
    assertEquals(result.error.message, LOW_REASON);
    assertEquals(killed.length, 1);
    const pid = killed[0];
    assert(pid !== undefined && pid > 0);
    assert(
      warns.includes(
        `Guest-memory floor sent SIGKILL through the agent's process handle, PID ${pid}: the process-tree kill returned and the agent had not exited (Issue #5638)`,
      ),
      `missing handle-kill warn line in ${JSON.stringify(warns)}`,
    );
  },
});

Deno.test({
  name:
    "guest memory handle kill - a tree kill that throws still stops the agent (Issue #5638)",
  ...opts,
  permissions,
  async fn() {
    const killed: number[] = [];
    const killProcessTree = (pid: number): Promise<void> => {
      killed.push(pid);
      return Promise.reject(new Error("ps timed out after 10000ms"));
    };
    const { logger, warns, errors } = capturingLogger();
    const result = await drive(100 * MIB, killProcessTree, logger, false);
    assert(!result.ok);
    assert(result.error instanceof GuestMemoryFloorError);
    assertEquals(result.error.message, LOW_REASON);
    assertEquals(killed.length, 1);
    const pid = killed[0];
    assert(pid !== undefined && pid > 0);
    assert(
      errors.includes(
        `Guest-memory kill failed for PID ${pid}: ps timed out after 10000ms`,
      ),
      `missing kill-failed error line in ${JSON.stringify(errors)}`,
    );
    assert(
      warns.includes(
        `Guest-memory floor sent SIGKILL through the agent's process handle, PID ${pid}: the process-tree kill returned and the agent had not exited (Issue #5638)`,
      ),
      `missing handle-kill warn line in ${JSON.stringify(warns)}`,
    );
  },
});

Deno.test({
  name:
    "guest memory handle kill - a healthy guest never calls the tree kill (Issue #5638)",
  ...opts,
  permissions,
  async fn() {
    const killed: number[] = [];
    const killProcessTree = (pid: number): Promise<void> => {
      killed.push(pid);
      return Promise.resolve();
    };
    const { logger, warns } = capturingLogger();
    const result = await drive(4 * GIB, killProcessTree, logger, true);
    assert(result.ok);
    assertEquals(result.value.exitCode, 0);
    assertEquals(result.value.output, "working");
    assertEquals(killed.length, 0);
    assert(
      !warns.some((message) =>
        message.startsWith("Guest-memory floor sent SIGKILL")
      ),
    );
    assert(
      !warns.some((message) => message.startsWith(GUEST_MEMORY_TAG_SWEEP)),
    );
  },
});

Deno.test({
  name:
    "guest memory handle kill - a descendant still holding memory is killed without spawning (Issue #5638)",
  ...opts,
  permissions,
  async fn() {
    const killed: number[] = [];
    // Signals nothing, as on a full guest: only the tag sweep can reach the child.
    const killProcessTree = (pid: number): Promise<void> => {
      killed.push(pid);
      return Promise.resolve();
    };
    const leftoverReaperDeps: LeftoverReaperDeps = {
      ...DEFAULT_LEFTOVER_REAPER_DEPS,
      findTagged: () =>
        Promise.resolve({
          ok: false,
          error: "pgrep timed out after 10000ms",
        }),
    };
    let childPid = 0;
    const { logger, warns } = capturingLogger();
    try {
      const result = await drive(100 * MIB, killProcessTree, logger, false, {
        stubBody: "sleep 300 &\n" +
          `echo $! > "$0.child"\n` +
          `printf '%s\\n' '{"type":"result","result":"working"}'\n` +
          agentStubGate() + "exit 0\n",
        leftoverReaperDeps,
        onReady: async (stub) => {
          childPid = Number(
            (await Deno.readTextFile(`${stub.path}.child`)).trim(),
          );
          // Positive control: the descendant is alive before the floor fires.
          assert(await isLive(childPid), "descendant not running before floor");
        },
      });
      assert(!result.ok);
      assert(result.error instanceof GuestMemoryFloorError);
      assertEquals(result.error.message, LOW_REASON);
      assertEquals(killed.length, 1);
      const pid = killed[0];
      assert(pid !== undefined && pid > 0);
      await waitUntilGone(childPid);
      assert(!(await isLive(childPid)), "descendant still running");
      // The agent and its sleep carry the tag; the gate's own sleeps may add one.
      const prefix = `${GUEST_MEMORY_TAG_SWEEP} `;
      const suffix = ` signalled for PID ${pid} (Issue #5638)`;
      const line = warns.find((message) =>
        message.startsWith(prefix) && message.endsWith(suffix)
      );
      assert(
        line !== undefined,
        `missing tag sweep warn line in ${JSON.stringify(warns)}`,
      );
      const signalled = Number(
        line.slice(prefix.length, line.length - suffix.length),
      );
      assert(signalled >= 2, `expected at least 2 signalled, got ${line}`);
    } finally {
      if (childPid > 0 && await isLive(childPid)) {
        Deno.kill(childPid, "SIGKILL");
      }
    }
  },
});

Deno.test({
  name:
    "guest memory handle kill - a descendant is swept even when the agent exits before the tree kill returns (Issue #5638)",
  ...opts,
  permissions,
  async fn() {
    let agentPid = 0;
    let childPid = 0;
    let killDone: Promise<void> | undefined;
    // Signals only the agent, then returns a little after it is gone, so the
    // run can finish while the floor's kill is still in flight.
    const killProcessTree = (pid: number): Promise<void> => {
      agentPid = pid;
      Deno.kill(pid, "SIGKILL");
      killDone = (async () => {
        for (let i = 0; i < 250 && await isLive(pid); i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      })();
      return killDone;
    };
    const leftoverReaperDeps: LeftoverReaperDeps = {
      ...DEFAULT_LEFTOVER_REAPER_DEPS,
      findTagged: () =>
        Promise.resolve({
          ok: false,
          error: "pgrep timed out after 10000ms",
        }),
    };
    const { logger, warns, errors } = capturingLogger();
    try {
      const result = await drive(100 * MIB, killProcessTree, logger, false, {
        // A detached job: the subshell exits at once, so the descendant snapshot
        // never sees the sleep and only the tag sweep can reach it. Its stdio is
        // redirected so it does not hold the stdout pipe open.
        stubBody: `(sleep 300 >/dev/null 2>&1 & echo $! > "$0.child")\n` +
          `printf '%s\\n' '{"type":"result","result":"working"}'\n` +
          agentStubGate() + "exit 0\n",
        leftoverReaperDeps,
        onReady: async (stub) => {
          childPid = Number(
            (await Deno.readTextFile(`${stub.path}.child`)).trim(),
          );
          assert(await isLive(childPid), "descendant not running before floor");
        },
      });
      await killDone;
      assert(agentPid > 0, "the floor never called the tree kill");
      assert(!result.ok);
      assert(result.error instanceof GuestMemoryFloorError);
      assertEquals(result.error.message, LOW_REASON);
      assert(!(await isLive(childPid)), "descendant still running");
      assert(
        warns.some((message) => message.startsWith(GUEST_MEMORY_TAG_SWEEP)),
        `missing tag sweep warn line in ${JSON.stringify(warns)}`,
      );
      assert(
        !errors.some((message) => message.startsWith(GUEST_MEMORY_KILL_FAILED)),
        `unexpected kill-failed error line in ${JSON.stringify(errors)}`,
      );
    } finally {
      if (childPid > 0 && await isLive(childPid)) {
        Deno.kill(childPid, "SIGKILL");
      }
    }
  },
});
