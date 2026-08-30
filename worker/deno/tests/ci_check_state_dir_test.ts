/**
 * Tests for ci_check_state_dir.ts and the CI-fix lane's state directory
 * (Issue #552).
 *
 * Regression: the retry counter was written to the bare relative path
 * `.ci_check_state`, resolved against the worker's current working
 * directory. In container mode that is the read-only `--base-dir` mount, so
 * every automatic CI fix died with `Read-only file system (os error 30)`
 * before Claude ran — semgrep failures then sat until a human asked for a fix.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  CI_CHECK_STATE_DIR_NAME,
  FALLBACK_CI_CHECK_WORK_DIR,
  resolveCiCheckStateDir,
} from "../lib/ci_check_state_dir.ts";
import { recordCiCheckRetry } from "../lib/pr_ci_checks.ts";
import {
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
import type { Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Environment stub — nothing here reads the real process environment. */
function envOf(
  values: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => values[name];
}

function makeSilentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

// ============================================================================
// resolveCiCheckStateDir
// ============================================================================

Deno.test("resolveCiCheckStateDir - places the store inside an explicit work directory", () => {
  assertEquals(
    resolveCiCheckStateDir({
      workDir: "/home/vibe/auto-issue-work",
      env: envOf({}),
    }),
    `/home/vibe/auto-issue-work/${CI_CHECK_STATE_DIR_NAME}`,
  );
});

Deno.test("resolveCiCheckStateDir - strips trailing slashes from the work directory", () => {
  assertEquals(
    resolveCiCheckStateDir({ workDir: "/var/work//", env: envOf({}) }),
    `/var/work/${CI_CHECK_STATE_DIR_NAME}`,
  );
});

Deno.test("resolveCiCheckStateDir - falls back to WORK_DIR when no work directory is passed", () => {
  assertEquals(
    resolveCiCheckStateDir({
      env: envOf({ WORK_DIR: "/srv/work", HOME: "/home/vibe" }),
    }),
    `/srv/work/${CI_CHECK_STATE_DIR_NAME}`,
  );
});

Deno.test("resolveCiCheckStateDir - falls back to the home work directory when WORK_DIR is unset", () => {
  assertEquals(
    resolveCiCheckStateDir({ env: envOf({ HOME: "/home/vibe" }) }),
    `/home/vibe/auto-issue-work/${CI_CHECK_STATE_DIR_NAME}`,
  );
});

Deno.test("resolveCiCheckStateDir - never returns a path relative to the working directory", () => {
  // The read-only-cwd regression: a blank, relative or root-only base must
  // still resolve somewhere absolute and writable.
  for (const workDir of ["", "   ", ".", "relative/dir", "/"]) {
    const resolved = resolveCiCheckStateDir({ workDir, env: envOf({}) });
    assertEquals(
      resolved.startsWith("/"),
      true,
      `expected an absolute path for work dir '${workDir}', got '${resolved}'`,
    );
    assertEquals(
      resolved,
      `${FALLBACK_CI_CHECK_WORK_DIR}/${CI_CHECK_STATE_DIR_NAME}`,
    );
  }
});

Deno.test("resolveCiCheckStateDir - ignores a relative WORK_DIR and uses HOME instead", () => {
  assertEquals(
    resolveCiCheckStateDir({
      env: envOf({ WORK_DIR: "some/relative/dir", HOME: "/home/vibe" }),
    }),
    `/home/vibe/auto-issue-work/${CI_CHECK_STATE_DIR_NAME}`,
  );
});

// ============================================================================
// recordCiCheckRetry — fails loud with the directory named
// ============================================================================

Deno.test("recordCiCheckRetry - writes the counter into the state directory", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const stateDir = `${tmpDir}/${CI_CHECK_STATE_DIR_NAME}`;
    assertEquals(await recordCiCheckRetry(stateDir, "org/repo", "12345"), 1);
    assertEquals(await recordCiCheckRetry(stateDir, "org/repo", "12345"), 2);
    assertEquals(
      (await Deno.readTextFile(`${stateDir}/org_repo_12345.retries`)).trim(),
      "2",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("recordCiCheckRetry - an unwritable state directory fails loud and names the path", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // A file where the state directory should be — mkdir cannot succeed.
    const blocker = `${tmpDir}/blocker`;
    await Deno.writeTextFile(blocker, "not a directory");
    const stateDir = `${blocker}/${CI_CHECK_STATE_DIR_NAME}`;

    const error = await recordCiCheckRetry(stateDir, "org/repo", "12345")
      .then(() => undefined, (err: unknown) => err);

    assertEquals(error instanceof Error, true);
    const message = (error as Error).message;
    assertStringIncludes(message, stateDir);
    assertStringIncludes(message, "org/repo");
    assertStringIncludes(message, "12345");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// processCiFailure — default state directory (the regression)
// ============================================================================

Deno.test("processCiFailure - records the retry under the work directory, not the process cwd", async () => {
  const tmpDir = await Deno.makeTempDir();
  const previousWorkDir = Deno.env.get("WORK_DIR");
  Deno.env.set("WORK_DIR", tmpDir);
  try {
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: {
            output: "Fixed semgrep finding",
            exitCode: 0,
            timedOut: false,
          },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: () => Promise.resolve(""),
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 1,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
      },
    });

    const annotations: CheckAnnotation[] = [
      {
        path: "worker/deno/lib/planning_carrier.ts",
        start_line: 371,
        message: "detect-non-literal-regexp",
      },
    ];

    // No `stateDir` — production's default path is what this exercises.
    const processorDeps: CiProcessorDeps = {
      logger: makeSilentLogger(),
      deps,
      workDir: tmpDir,
    };

    const result = await processCiFailure({
      repo: "org/repo",
      prNumber: 548,
      branchName: "issue-518-example",
      checkRunId: "99156131115",
      checkName: "semgrep",
      encodedAnnotations: btoa(JSON.stringify(annotations)),
    }, processorDeps);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.processed, true);
      assertEquals(result.value.retryCount, 1);
    }

    const counter = await Deno.readTextFile(
      `${tmpDir}/${CI_CHECK_STATE_DIR_NAME}/org_repo_99156131115.retries`,
    );
    assertEquals(counter.trim(), "1");
  } finally {
    if (previousWorkDir === undefined) {
      Deno.env.delete("WORK_DIR");
    } else {
      Deno.env.set("WORK_DIR", previousWorkDir);
    }
    await Deno.remove(tmpDir, { recursive: true });
  }
});
