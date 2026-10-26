/** A running build may consume its admission headroom (Issue #4390). */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import {
  enableInFlightHostDiskGate,
  type HeavyBuildDiskReading,
  registerHeavyBuildDiskProbe,
} from "../lib/heavy_build_gate.ts";
import type { Logger } from "../types.ts";
import { defaultMutationRunnerSeams } from "../lib/mutation_runner.ts";
import {
  agentStubGate,
  createAgentStub,
  releaseAgentStub,
} from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

const GIB = 1_073_741_824;
function reading(freeGb: number): HeavyBuildDiskReading {
  return {
    status: {
      level: freeGb < 46 ? "low" : "ok",
      availableBytes: freeGb * GIB,
      totalBytes: 460 * GIB,
      source: "launch-baseline",
      detail: `${freeGb} GB free, floor 46.0 GB`,
    },
    floorBytes: 46 * GIB,
    trimRefused: true,
  };
}

for (const crossFloor of [false, true]) {
  Deno.test({
    name: crossFloor
      ? "agent disk watch - admitted work stops at the real floor (Issue #4390)"
      : "agent disk watch - admitted work completes after consuming headroom (Issue #4390)",
    ignore: Deno.build.os === "windows",
    permissions: { read: true, write: true, run: true, env: true },
    async fn() {
      const clock = fakeClock();
      const ready = Promise.withResolvers<void>();
      const errors: string[] = [];
      const logger = {
        info: () => {},
        warn: () => {},
        error: (message: string) => errors.push(message),
        debug: () => {},
        security: () => {},
        skipReason: () => {},
        timing: () => {},
        scanSummary: () => {},
        workerSummary: () => {},
      } as Logger;
      let freeGb = 75.9;
      let probes = 0;
      registerHeavyBuildDiskProbe(() => {
        probes++;
        return Promise.resolve(reading(freeGb));
      });
      enableInFlightHostDiskGate(true);
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
          hostDiskPollMs: 30_000,
          progressIntervalMs: 86_400_000,
          descendantSnapshotIntervalMs: 86_400_000,
          onActivity: () => ready.resolve(),
        });
        await ready.promise;
        assertEquals(
          probes,
          1,
          "the new process passed the full admission gate",
        );
        freeGb = 66.4;
        await clock.advance(30_000);
        assertEquals(probes, 2);
        assertEquals(
          errors,
          [],
          "using admitted headroom must not kill the agent",
        );
        if (crossFloor) {
          freeGb = 45;
          await clock.advance(30_000);
          assertEquals(errors.length, 1);
          assertStringIncludes(errors[0]!, "host disk below its floor");
          const result = await run;
          assert(!result.ok);
          assertStringIncludes(
            result.error.message,
            "Parked as infrastructure",
          );
        } else {
          await releaseAgentStub(stub);
          const result = await run;
          assert(result.ok);
          assertEquals(result.value.exitCode, 0);
          assertEquals(result.value.timedOut, false);
        }
      } finally {
        await releaseAgentStub(stub);
        await run;
        await stub.dispose();
        enableInFlightHostDiskGate(false);
        registerHeavyBuildDiskProbe(undefined);
      }
    },
  });
}

Deno.test({
  name:
    "mutation disk watch - an active process can consume admitted headroom (Issue #4390)",
  ignore: Deno.build.os === "windows",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const secondPoll = Promise.withResolvers<"polled">();
    let probes = 0;
    registerHeavyBuildDiskProbe(() => {
      if (++probes === 2) secondPoll.resolve("polled");
      return Promise.resolve(reading(66.4));
    });
    enableInFlightHostDiskGate(true);
    const stub = await createAgentStub(agentStubGate() + "exit 0\n");
    const seams = defaultMutationRunnerSeams(undefined, 50, { diskPollMs: 20 });
    const run = seams.runProcess(stub.path, [], {
      cwd: stub.dir,
      timeoutMs: 5_000,
    });
    // Attach rejection handling immediately: an old watcher kills at its
    // first poll; the fixed watcher reaches a second poll while still alive.
    const first = Promise.race([
      secondPoll.promise,
      run.then(() => "exited", () => "parked"),
    ]);
    try {
      assertEquals(await first, "polled");
      await releaseAgentStub(stub);
      const result = await run;
      assertEquals(result.code, 0);
      assertEquals(result.timedOut, false);
    } finally {
      await releaseAgentStub(stub);
      await run.catch(() => {});
      await stub.dispose();
      enableInFlightHostDiskGate(false);
      registerHeavyBuildDiskProbe(undefined);
    }
  },
});
