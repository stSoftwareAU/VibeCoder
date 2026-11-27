/**
 * The guest memory floor stops the agent with no TERM grace (Issue #5634).
 *
 * A guest already below its floor cannot afford the `killAfterSeconds` grace:
 * the tree keeps its memory while each probe of the wait loop spawns a new
 * process. The real tree kill is used here, with an agent that ignores
 * SIGTERM and a one hour grace, so only an immediate SIGKILL ends the run.
 */
import { assert, assertEquals } from "@std/assert";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
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

/** A logger that records nothing; the run's lines are not asserted. */
function capturingLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  } as unknown as Logger;
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
    "guest memory floor - an agent that ignores SIGTERM is SIGKILLed without waiting out its grace (Issue #5634)",
  ...opts,
  permissions,
  async fn() {
    const clock = fakeClock();
    const ready = Promise.withResolvers<void>();
    const probe = (): Promise<MemoryPressureReading> =>
      Promise.resolve({
        level: "high",
        totalBytes: 8 * GIB,
        availableBytes: 100 * MIB,
      });
    const stub = await createAgentStub(
      `trap '' TERM\n` +
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
        logger: capturingLogger(),
        timeoutSeconds: 3600,
        killAfterSeconds: 3600,
        guestMemoryPollMs: 1_000,
        probeMemoryPressure: probe,
        progressIntervalMs: 86_400_000,
        descendantSnapshotIntervalMs: 86_400_000,
        onActivity: () => ready.resolve(),
      });
      await ready.promise;
      for (let i = 0; i < 3; i++) {
        await clock.advance(1_000);
        await new Promise((r) => setTimeout(r, 20));
      }
      const result = await run;
      assert(!result.ok);
      assert(result.error instanceof GuestMemoryFloorError);
      assertEquals(result.error.message, LOW_REASON);
    } finally {
      await releaseAgentStub(stub);
      await run;
      await stub.dispose();
    }
  },
});
