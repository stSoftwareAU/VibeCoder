/**
 * Push-recovery diagnostics (Issue #211).
 *
 * A rejected push used to end with a bare "Push failed after recovery
 * attempt" line: which recovery step gave up — the rebase, the automatic
 * conflict resolution, or the leased force push — and what git actually
 * said were both discarded, so an operator reading the log had nothing to
 * act on. Recovery failures must name the step and carry git's own stderr.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { recoverFromPushRejection } from "../lib/git_push_recovery.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

const BRANCH = "issue-211-diagnostics";

async function git(args: string[], cwd: string): Promise<void> {
  const result = await runGitCommand(args, { cwd });
  if (!result.ok) throw result.error;
  if (result.value.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.value.stderr}`,
    );
  }
}

/**
 * Bare remote plus two clones with `BRANCH` pushed, mirroring two fleet
 * hosts working the same PR branch.
 */
async function setupRepos(): Promise<
  { tmpDir: string; workerPath: string; otherPath: string }
> {
  const tmpDir = await Deno.makeTempDir({ prefix: "push_recovery_diag_" });
  const remotePath = `${tmpDir}/remote.git`;
  const workerPath = `${tmpDir}/worker`;
  const otherPath = `${tmpDir}/other`;

  await Deno.mkdir(remotePath, { recursive: true });
  await git(["init", "--bare"], remotePath);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], remotePath);

  await git(["clone", remotePath, workerPath], tmpDir);
  await git(["config", "user.email", "worker@example.com"], workerPath);
  await git(["config", "user.name", "Worker"], workerPath);
  await Deno.writeTextFile(`${workerPath}/README.md`, "# Test\n");
  await git(["add", "README.md"], workerPath);
  await git(["commit", "-m", "Initial commit"], workerPath);
  await git(["push", "origin", "main"], workerPath);
  await git(["checkout", "-b", BRANCH], workerPath);
  await git(["push", "origin", BRANCH], workerPath);

  await git(["clone", remotePath, otherPath], tmpDir);
  await git(["config", "user.email", "other@example.com"], otherPath);
  await git(["config", "user.name", "Other Author"], otherPath);
  await git(["checkout", BRANCH], otherPath);

  return { tmpDir, workerPath, otherPath };
}

Deno.test("recoverFromPushRejection - a refused lease names the step and carries git's stderr (Issue #211)", async () => {
  const { tmpDir, workerPath, otherPath } = await setupRepos();
  try {
    // A sibling host pushes to the branch after this host last fetched.
    await Deno.writeTextFile(`${otherPath}/other.txt`, "other author work\n");
    await git(["add", "other.txt"], otherPath);
    await git(["commit", "-m", "Other author commit"], otherPath);
    await git(["push", "origin", BRANCH], otherPath);

    // Local commit plus an untracked file that clashes with the sibling's
    // commit: the pull cannot rebase, auto-resolution has nothing to fix,
    // and the leased force push is refused because the lease is stale.
    await Deno.writeTextFile(`${workerPath}/worker.txt`, "worker work\n");
    await git(["add", "worker.txt"], workerPath);
    await git(["commit", "-m", "Worker commit"], workerPath);
    await Deno.writeTextFile(`${workerPath}/other.txt`, "untracked clash\n");

    const result = await recoverFromPushRejection(BRANCH, { cwd: workerPath });

    assertEquals(result.ok, false, "the recovery attempt must fail");
    if (!result.ok) {
      const message = result.error.message;
      assert(
        message.includes("force-with-lease"),
        `error must name the recovery step that failed, got: ${message}`,
      );
      assert(
        /stale info|rejected|failed to push/i.test(message),
        `error must carry git's own stderr, got: ${message}`,
      );
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("recoverFromPushRejection - a protected branch names the step it refused at (Issue #211)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "push_recovery_protected_" });
  try {
    const remotePath = `${tmpDir}/remote.git`;
    const workerPath = `${tmpDir}/worker`;
    await Deno.mkdir(remotePath, { recursive: true });
    await git(["init", "--bare"], remotePath);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"], remotePath);
    await git(["clone", remotePath, workerPath], tmpDir);
    await git(["config", "user.email", "worker@example.com"], workerPath);
    await git(["config", "user.name", "Worker"], workerPath);
    await Deno.writeTextFile(`${workerPath}/README.md`, "# Test\n");
    await git(["add", "README.md"], workerPath);
    await git(["commit", "-m", "Initial commit"], workerPath);
    await git(["push", "origin", "main"], workerPath);

    // `main` has no upstream divergence to rebase, but the pull of a branch
    // that cannot be reconciled ends at the protected-branch refusal.
    await Deno.writeTextFile(`${workerPath}/local.txt`, "local\n");
    await git(["add", "local.txt"], workerPath);
    await git(["commit", "-m", "Local commit"], workerPath);
    await git(
      ["remote", "set-url", "origin", `${tmpDir}/missing.git`],
      workerPath,
    );

    const result = await recoverFromPushRejection("main", { cwd: workerPath });

    assertEquals(result.ok, false);
    if (!result.ok) {
      assert(
        result.error.message.includes("Push recovery step"),
        `error must be labelled as a recovery failure, got: ${result.error.message}`,
      );
      assert(
        result.error.message.includes("protected branch 'main'"),
        `error must name the step it refused at, got: ${result.error.message}`,
      );
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
