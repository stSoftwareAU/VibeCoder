/**
 * The production `processIssue` logs the run pressure line while the run is
 * in flight (Issue #4815).
 *
 * Uses Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert } from "@std/assert";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { RUN_PRESSURE_MARKER } from "../lib/liveness_guard.ts";
import type { Logger } from "../types.ts";

Deno.test("production processIssue logs the run pressure line while the run is in flight (Issue #4815)", async () => {
  const lines: string[] = [];
  const push = (message: string) => lines.push(message);
  const logger = {
    info: push,
    warn: push,
    error: push,
    debug: push,
    timing: () => {},
    workerSummary: () => {},
  } as unknown as Logger;
  const workerDeps = createMockDeps();
  let ghCalls = 0;
  let sawLineInFlight = false;
  workerDeps.github.runGhCommand = async () => {
    ghCalls += 1;
    // The first `gh` call is the issue fetch, inside the run: hold the run
    // there until the pressure line is logged (5 s cap).
    for (
      let i = 0;
      i < 500 && !lines.some((l) => l.startsWith(RUN_PRESSURE_MARKER));
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (ghCalls === 1) {
      sawLineInFlight = lines.some((l) => l.startsWith(RUN_PRESSURE_MARKER));
    }
    throw new Error("gh is not available in this test");
  };
  const configured = await createProductionRunCoreDeps({
    repoDir: "/tmp/test-repo",
    workDir: "/tmp/test-work",
    githubUser: "test-user",
    logger,
    workerDeps,
  });
  try {
    await configured.deps.processIssue(
      { repo: "o/r", issueNumber: 4815 } as never,
    ).catch(() => {});
  } finally {
    configured.cleanup();
  }
  assert(sawLineInFlight, lines.join("\n"));
});
