/**
 * The launch-plan command hands the worker the watchdog's kill instant
 * (Issue #4242).
 *
 * `buildLaunchPlanForCommand` reads the clock where the plan is built and
 * passes it on as `planEpochSeconds`. Dropping that input would leave
 * `VIBE_HARD_KILL_AT_EPOCH` off the run arguments, so this drives the real
 * function with an injected environment, clock and runtime probe and reads the
 * variable off the plan it returns.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals } from "@std/assert";
import { buildLaunchPlanForCommand } from "../commands/container_launch_plan.ts";
import { DEFAULT_MAX_RUN_SECONDS } from "../lib/run_entrypoint.ts";
import { resolveWatchdogSeconds } from "../lib/container_watchdog.ts";
import { REPO_ROOT } from "./fixtures/launcher_harness.ts";

Deno.test("buildLaunchPlanForCommand - the run carries the plan clock plus the watchdog as the hard kill (Issue #4242)", async () => {
  const home = await Deno.makeTempDir({ prefix: "vibe-launch-plan-" });
  try {
    const credentialDir = `${home}/credentials`;
    for (const sub of ["gh", "claude", "codex", "deepseek"]) {
      await Deno.mkdir(`${credentialDir}/${sub}`, { recursive: true });
    }
    const configFile = `${home}/config.json`;
    await Deno.writeTextFile(configFile, "{}");

    const environment: Record<string, string> = {
      HOME: home,
      VIBE_CREDENTIAL_DIR: credentialDir,
      CONFIG_PATH: configFile,
      WORK_DIR: `${home}/work`,
    };
    const env = (name: string) => environment[name];
    const planEpochSeconds = 1_900_000_000;

    const plan = await buildLaunchPlanForCommand(REPO_ROOT, "vibe-test", {
      env,
      now: () => planEpochSeconds * 1000 + 999,
      probe: (candidate) =>
        Promise.resolve({
          available: true,
          path: `/usr/bin/${candidate.executable}`,
        }),
    });

    const watchdogSeconds = resolveWatchdogSeconds({
      env,
      maxRunSeconds: DEFAULT_MAX_RUN_SECONDS,
    });
    assertEquals(
      plan.runArgs.filter((arg) => arg.startsWith("VIBE_HARD_KILL_AT_EPOCH=")),
      [`VIBE_HARD_KILL_AT_EPOCH=${planEpochSeconds + watchdogSeconds}`],
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
