/**
 * Production wiring for the durable fast-failure back-off (Issue #1950).
 *
 * The tracker's own behaviour is covered in
 * `repo_fast_failure_tracker_test.ts`; these cases assert that the worker's
 * production deps are wired to the same sidecar — that a counter written by
 * one process is read by the next (the restart requirement), that the cycle
 * summary names it, and that a success clears it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import type { ProductionDepsOptions } from "../lib/run_core_production_deps.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  backedOffRepos,
  recordRepoFastFailure,
} from "../lib/repo_fast_failure_tracker.ts";
import { createLogger } from "../lib/logger.ts";

const REPO = "org/broken";

const silentLogger = createLogger({ write: () => {} });

function options(workDir: string): ProductionDepsOptions {
  return {
    repoDir: `${workDir}/repo`,
    workDir,
    githubUser: "test-user",
    logger: silentLogger,
    config: buildDefaultWorkerConfig(),
  };
}

/**
 * Seed the sidecar exactly as a previous worker process would have — the
 * back-off must be visible to a freshly built set of deps.
 */
async function seedBackedOffRepo(workDir: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  for (const offset of [300, 200, 100]) {
    const result = await recordRepoFastFailure({
      workDir,
      nowSeconds: () => now - offset,
      repo: REPO,
      failure: {
        phase: "setup",
        message: "quality.sh: line 3: deno: command not found",
        issueNumber: 11,
        elapsedSeconds: 9,
      },
    });
    assert(result.ok, result.ok ? "" : result.error.message);
  }
}

Deno.test("fast-failure deps - the cycle summary names a repository a previous process backed off", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "deps-fast-failure-" });
  try {
    await seedBackedOffRepo(workDir);

    const { deps, cleanup } = await createProductionRunCoreDeps(
      options(workDir),
    );
    try {
      assert(deps.describeRepoFastFailures);
      const line = await deps.describeRepoFastFailures();
      assert(line !== null);
      assertStringIncludes(line, `${REPO}: 3 fast failures`);
      assertStringIncludes(line, "backed off until");
    } finally {
      cleanup();
    }
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("fast-failure deps - the top-of-cycle reset does not clear the durable back-off", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "deps-fast-failure-" });
  try {
    await seedBackedOffRepo(workDir);

    const { deps, cleanup } = await createProductionRunCoreDeps(
      options(workDir),
    );
    try {
      // `run_core.ts` calls this at the top of every scan. Before Issue
      // #1950 it was the only per-repo state there was, so a repository
      // failing at setup was fully claimable again one cycle later.
      await deps.resetRepoFailures();
    } finally {
      cleanup();
    }

    assertEquals([...await backedOffRepos({ workDir })], [REPO]);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("fast-failure deps - recordRepoSuccess releases the back-off", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "deps-fast-failure-" });
  try {
    await seedBackedOffRepo(workDir);
    assertEquals([...await backedOffRepos({ workDir })], [REPO]);

    const { deps, cleanup } = await createProductionRunCoreDeps(
      options(workDir),
    );
    try {
      await deps.recordRepoSuccess(REPO);
    } finally {
      cleanup();
    }

    assertEquals((await backedOffRepos({ workDir })).size, 0);
    assert(deps.describeRepoFastFailures);
    assertEquals(await deps.describeRepoFastFailures(), null);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
