/**
 * The production factory's `checkLivenessWindow` hook writes the resource
 * fields onto the per-cycle `[liveness] tick` line (Issue #4225).
 *
 * `formatLivenessTickLine` and the resource probe are unit-tested on their
 * own, but a running worker only logs them if the hook in
 * `run_core_production_deps.ts` passes every field through. These tests drive
 * the real `createProductionRunCoreDeps`, call the real hook, and read the
 * log lines it emits. An empty `repos` list keeps the guard off the network.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assertEquals, assertMatch } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { LIVENESS_STATE_FILENAME } from "../lib/liveness_guard.ts";

const RESOURCE_KEYS = [
  "mem_available_mib",
  "mem_total_mib",
  "psi_mem_some_avg10",
  "psi_mem_full_avg10",
  "psi_cpu_some_avg10",
];

/** Run the hook once in a fresh work dir and return everything it logged. */
async function logLinesFromHook(
  prepare: (workDir: string) => Promise<void>,
): Promise<string[]> {
  const workDir = await Deno.makeTempDir({ prefix: "liveness-tick-wiring-" });
  const lines: string[] = [];
  try {
    await prepare(workDir);
    const { deps } = await createProductionRunCoreDeps({
      repoDir: workDir,
      workDir,
      githubUser: "worker-bot",
      logger: createLogger({ write: (line) => lines.push(line) }),
      config: { ...buildDefaultWorkerConfig(), repos: [], workDir },
    });
    await deps.checkLivenessWindow!({ tick: 42 });
    return lines;
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test("production deps - the liveness tick line carries every field, resource fields last (Issue #4225)", async () => {
  const lines = await logLinesFromHook(() => Promise.resolve());
  const tick = lines.find((l) => l.includes("[liveness] tick="));
  assertEquals(tick !== undefined, true, `no tick line in ${lines}`);
  const body = tick!.slice(tick!.indexOf("[liveness] tick="));
  // The fleet is empty, so no epoch is known and nothing has alerted. Each
  // field must still be present with its own value — a dropped property would
  // print `undefined`.
  assertMatch(
    body,
    new RegExp(
      "^\\[liveness\\] tick=42 alerted=false live_epoch=none " +
        "last_idle_claimed=none last_productive=none " +
        "hook_fail_success=\\d+ hook_fail_failure=\\d+ hook_fail_always=\\d+ " +
        RESOURCE_KEYS.map((k) => `${k}=(?:unknown|[\\d.]+)`).join(" ") +
        "(?: host=\\S+)?$",
    ),
  );
});

Deno.test("production deps - a failed state write still logs the resource fields (Issue #4225)", async () => {
  // A directory where the state file belongs makes the atomic write fail.
  const lines = await logLinesFromHook((workDir) =>
    Deno.mkdir(`${workDir}/${LIVENESS_STATE_FILENAME}`)
  );
  const warn = lines.find((l) => l.includes("Liveness guard write failed"));
  assertEquals(warn !== undefined, true, `no write-failure line in ${lines}`);
  for (const key of RESOURCE_KEYS) {
    assertEquals(
      warn!.includes(`${key}=`),
      true,
      `${key} missing from ${warn}`,
    );
  }
});
