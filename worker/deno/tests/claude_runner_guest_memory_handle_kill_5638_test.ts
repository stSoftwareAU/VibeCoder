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
  killClaudeProcessTree,
  runClaudeWithTimeout,
} from "../lib/claude_runner.ts";
import { GuestMemoryFloorError } from "../lib/guest_memory_floor.ts";
import type { MemoryPressureReading } from "../lib/memory_pressure.ts";
import type { Logger } from "../types.ts";
import {
  agentStubGate,
  createAgentStub,
  releaseAgentStub,
} from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

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
): Promise<Awaited<ReturnType<typeof runClaudeWithTimeout>>> {
  const clock = fakeClock();
  const ready = Promise.withResolvers<void>();
  const probe = (): Promise<MemoryPressureReading> =>
    Promise.resolve({ level: "high", totalBytes: 8 * GIB, availableBytes });
  const stub = await createAgentStub(
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
    });
    await ready.promise;
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
  },
});
