/**
 * TokenEconomizer reaches the PR-feedback and CI-fix processors from the
 * production run-core wiring (Issue #4956).
 *
 * `createProductionRunCoreDeps` builds the PR-feedback and CI-fix closures
 * that hand `config.tokenEconomizer` to their processors. Each test enables
 * the block on the host config, runs the closure through the factory's own
 * `processPrFeedbackFn` / `processCiFailure` seams, and asserts that the
 * processor deps carry the enabled block. The same harness shape as
 * `run_core_production_deps_test.ts` drives the closures.
 *
 * Standalone commands are covered through the real command handlers in
 * token_economizer_impl_callsites_test.ts and
 * token_economizer_reactive_callsites_test.ts.
 *
 * Uses Australian English throughout (behaviour, recognised, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

/** No-op logger so the factory does not open file handles. */
const testLogger = createLogger({ write: () => {} });

/** The host's TokenEconomizer block with the switch turned on. */
function enabledBlock() {
  return {
    ...buildDefaultWorkerConfig().tokenEconomizer,
    enabled: true,
  };
}

/** Keep the factory's paths inside a root owned by this test. */
async function withLayout(
  body: (workDir: string, repoDir: string) => Promise<void>,
): Promise<void> {
  const workDir = await Deno.makeTempDir({ prefix: "te-production-deps-" });
  const repoDir = join(workDir, "repo");
  await Deno.mkdir(repoDir);
  try {
    await body(workDir, repoDir);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

Deno.test("run-core PR-feedback callback passes the enabled TokenEconomizer block to the processor (Issue #4956)", async () => {
  await withLayout(async (workDir, repoDir) => {
    let captured: unknown;
    const { deps, cleanup } = await createProductionRunCoreDeps({
      repoDir,
      workDir,
      githubUser: "test-user",
      logger: testLogger,
      config: buildDefaultWorkerConfig({
        workDir,
        repos: ["org/repo"],
        prFeedbackTimeout: 600,
        claudeTimeout: 3600,
        tokenEconomizer: enabledBlock(),
      }),
      findPrCommentsToFix: () =>
        Promise.resolve({
          ok: true,
          value: {
            repo: "org/repo",
            prNumber: 42,
            branchName: "issue-42-fix",
            commentType: "review",
            commentId: "comment-1",
            encodedBody: btoa("Please fix the issue"),
          },
        }),
      setupRepoFn: () => Promise.resolve({ success: true, message: repoDir }),
      runGitCommandFn: () =>
        Promise.resolve({
          ok: true,
          value: { code: 0, stdout: "", stderr: "" },
        }),
      processPrFeedbackFn: (_input, processorDeps) => {
        captured = processorDeps.tokenEconomizer;
        return Promise.resolve({ ok: false, error: new Error("captured") });
      },
    });
    try {
      await deps.findAndProcessPrFeedback();
      assertEquals(captured, enabledBlock());
      assertEquals((captured as { enabled?: boolean }).enabled, true);
    } finally {
      cleanup();
    }
  });
});

Deno.test("run-core CI-fix callback passes the enabled TokenEconomizer block to the processor (Issue #4956)", async () => {
  await withLayout(async (workDir, repoDir) => {
    let captured: unknown;
    const { deps, cleanup } = await createProductionRunCoreDeps({
      repoDir,
      workDir,
      githubUser: "test-user",
      logger: testLogger,
      config: buildDefaultWorkerConfig({
        workDir,
        repos: ["org/repo"],
        claudeTimeout: 3600,
        ciFixTimeout: 1200,
        tokenEconomizer: enabledBlock(),
      }),
      findFailedCiChecks: () =>
        Promise.resolve({
          ok: true,
          value: {
            repo: "org/repo",
            prNumber: 42,
            branchName: "issue-42-fix",
            checkId: "check-1",
            checkName: "build",
            encodedAnnotations: btoa("[]"),
          },
        }),
      setupRepoFn: () => Promise.resolve({ success: true, message: repoDir }),
      runGitCommandFn: () =>
        Promise.resolve({
          ok: true,
          value: { code: 0, stdout: "", stderr: "" },
        }),
      processCiFailure: (_input, processorDeps) => {
        captured = processorDeps.tokenEconomizer;
        return Promise.resolve({ ok: false, error: new Error("captured") });
      },
    });
    try {
      await deps.findAndProcessCiFailure();
      assert(captured !== undefined, "the CI-fix processor received no block");
      assertEquals(captured, enabledBlock());
      assertEquals((captured as { enabled?: boolean }).enabled, true);
    } finally {
      cleanup();
    }
  });
});
