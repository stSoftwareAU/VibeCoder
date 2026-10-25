/**
 * The production `reportHardKills` wiring (Issue #4254).
 *
 * Exercises the real deps object with the host log directory taken from an
 * injected environment, so no operator directory is read. With no evidence
 * present the hook completes quietly; with no HOME it skips and says so.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  createProductionRunCoreDeps,
  type ProductionDepsOptions,
} from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { envFrom } from "./support/env_lookup.ts";

function optionsWith(
  env: ReturnType<typeof envFrom>,
  logger = createLogger({ write: () => {} }),
): ProductionDepsOptions {
  return {
    repoDir: "/tmp/test-repo",
    workDir: "/tmp/test-work",
    githubUser: "test-user",
    logger,
    config: buildDefaultWorkerConfig(),
    env,
  };
}

Deno.test("reportHardKills - no evidence under HOME completes without throwing (Issue #4254)", async () => {
  const home = await Deno.makeTempDir();
  try {
    const { deps, cleanup } = await createProductionRunCoreDeps(
      optionsWith(envFrom({ HOME: home })),
    );
    try {
      assertEquals(typeof deps.reportHardKills, "function");
      await deps.reportHardKills!();
    } finally {
      cleanup();
    }
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("reportHardKills - no HOME skips with an info line and does not throw (Issue #4254)", async () => {
  const lines: string[] = [];
  const logger = createLogger({ write: (message) => lines.push(message) });
  const { deps, cleanup } = await createProductionRunCoreDeps(
    optionsWith(envFrom({}), logger),
  );
  try {
    await deps.reportHardKills!();
  } finally {
    cleanup();
  }
  assert(
    lines.some((line) => line.includes("Hard-kill reporting skipped")),
    lines.join("\n"),
  );
});
