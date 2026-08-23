/**
 * A failed checkout must name git's own failure (Issue #335).
 *
 * `Failed to checkout branch 'issue-3832-detect-cycles-linear'` was logged 65
 * times for one branch without ever saying *why*, so even the sixty-fifth line
 * could not be acted on without reproducing the failure by hand. Both
 * checkout sites in `git_pull.ts` now carry git's stderr.
 *
 * Real git repositories — no stubs.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { ensurePrMergeable, updatePrBranch } from "../lib/git_pull.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

/** A clone on `main` with one commit and no feature branch anywhere. */
async function setupCloneWithoutFeatureBranch(): Promise<{
  tmpDir: string;
  localPath: string;
}> {
  const tmpDir = await Deno.makeTempDir({ prefix: "git_pull_checkout_err_" });
  const remotePath = `${tmpDir}/remote.git`;
  const localPath = `${tmpDir}/local`;

  await Deno.mkdir(remotePath, { recursive: true });
  await runGitCommand(["init", "--bare"], { cwd: remotePath });
  await runGitCommand(["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: remotePath,
  });
  await runGitCommand(["clone", remotePath, localPath], { cwd: tmpDir });
  await runGitCommand(["config", "user.email", "test@example.com"], {
    cwd: localPath,
  });
  await runGitCommand(["config", "user.name", "Test User"], { cwd: localPath });

  await Deno.writeTextFile(`${localPath}/shared.txt`, "base\n");
  await runGitCommand(["add", "."], { cwd: localPath });
  await runGitCommand(["commit", "-m", "Initial commit"], { cwd: localPath });
  await runGitCommand(["push", "origin", "main"], { cwd: localPath });

  return { tmpDir, localPath };
}

Deno.test("#335 - updatePrBranch names git's failure when the checkout fails", async () => {
  const { tmpDir, localPath } = await setupCloneWithoutFeatureBranch();
  try {
    const result = await updatePrBranch("issue-999-missing", "main", {
      cwd: localPath,
    });

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "issue-999-missing");
      // git's own diagnosis — the whole point of the line.
      assertStringIncludes(
        result.error.message.toLowerCase(),
        "pathspec",
        `expected git's stderr in: ${result.error.message}`,
      );
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("#335 - ensurePrMergeable names git's failure when the checkout fails", async () => {
  const { tmpDir, localPath } = await setupCloneWithoutFeatureBranch();
  try {
    const result = await ensurePrMergeable(
      "o/r",
      7,
      "issue-999-missing",
      "main",
      { cwd: localPath },
    );

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "issue-999-missing");
      assertStringIncludes(
        result.error.message.toLowerCase(),
        "pathspec",
        `expected git's stderr in: ${result.error.message}`,
      );
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
