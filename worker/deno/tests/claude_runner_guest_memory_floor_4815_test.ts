/** The runner stops an agent at the guest memory floor (Issue #4815). */
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

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  skipReason: () => {},
  timing: () => {},
  scanSummary: () => {},
  workerSummary: () => {},
} as Logger;

async function drive(
  availableBytes: number,
  guestMemoryPollMs: number | undefined,
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
      guestMemoryPollMs,
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
    await releaseAgentStub(stub);
    return await run;
  } finally {
    await releaseAgentStub(stub);
    await run;
    await stub.dispose();
  }
}

const opts = { ignore: Deno.build.os === "windows" };

Deno.test({
  name: "guest memory watch - a low guest stops the agent (Issue #4815)",
  ...opts,
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const result = await drive(100 * MIB, 1_000);
    assert(!result.ok);
    assert(result.error instanceof GuestMemoryFloorError);
    assert(result.error.message.startsWith("[GUEST_MEMORY_FLOOR]"));
  },
});

Deno.test({
  name: "guest memory watch - a healthy guest completes (Issue #4815)",
  ...opts,
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const result = await drive(4 * GIB, 1_000);
    assert(result.ok);
    assertEquals(result.value.exitCode, 0);
  },
});

Deno.test({
  name: "guest memory watch - not armed, a low probe does not stop the run",
  ...opts,
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const result = await drive(100 * MIB, undefined);
    assert(result.ok);
  },
});
