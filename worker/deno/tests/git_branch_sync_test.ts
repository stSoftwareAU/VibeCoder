/**
 * Branch-update verdicts must describe the PR, not this clone (Issue #211).
 *
 * The branch-update pass checked out whatever local branch of that name the
 * clone held and judged it against the base. With a stale local branch — a
 * fleet sibling pushed, or an earlier run left commits behind — the pass found
 * a conflict the remote PR did not have and labelled a mergeable PR
 * `merge-conflict` (NEAT-AI-core #557, #563).
 *
 * These tests drive real git repositories end to end.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  isLocalAheadOfRemoteError,
  syncBranchToRemoteHead,
} from "../lib/git_branch_sync.ts";
import { isPrBranchConflictError, updatePrBranch } from "../lib/git_pull.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

const DEFAULT_BRANCH = "Develop";
const FEATURE_BRANCH = "issue-556-sync";

/** Run a git command in a repo, failing loudly on a non-zero exit. */
async function git(args: string[], cwd: string): Promise<string> {
  const result = await runGitCommand(args, { cwd });
  if (!result.ok) throw result.error;
  if (result.value.code !== 0) {
    throw new Error(
      `git ${
        args.join(" ")
      } failed (${result.value.code}): ${result.value.stderr}`,
    );
  }
  return result.value.stdout.trim();
}

interface TestRepos {
  tmpDir: string;
  /** The worker's clone — where the branch-update pass runs. */
  workerPath: string;
  /** A fleet sibling's clone of the same remote. */
  siblingPath: string;
}

/** Bare remote with `DEFAULT_BRANCH` and `FEATURE_BRANCH`, plus two clones. */
async function setupRepos(): Promise<TestRepos> {
  const tmpDir = await Deno.makeTempDir({ prefix: "branch_sync_" });
  const remotePath = `${tmpDir}/remote.git`;
  const workerPath = `${tmpDir}/worker`;
  const siblingPath = `${tmpDir}/sibling`;

  await Deno.mkdir(remotePath, { recursive: true });
  await git(["init", "--bare"], remotePath);
  await git(
    ["symbolic-ref", "HEAD", `refs/heads/${DEFAULT_BRANCH}`],
    remotePath,
  );

  await git(["clone", remotePath, workerPath], tmpDir);
  await git(["config", "user.email", "worker@example.com"], workerPath);
  await git(["config", "user.name", "Worker"], workerPath);
  await git(["checkout", "-b", DEFAULT_BRANCH], workerPath);
  await Deno.writeTextFile(`${workerPath}/README.md`, "# Test\n");
  await git(["add", "README.md"], workerPath);
  await git(["commit", "-m", "Initial commit"], workerPath);
  await git(["push", "-u", "origin", DEFAULT_BRANCH], workerPath);
  await git(["checkout", "-b", FEATURE_BRANCH], workerPath);
  await Deno.writeTextFile(`${workerPath}/feature.txt`, "feature\n");
  await git(["add", "feature.txt"], workerPath);
  await git(["commit", "-m", "Feature work"], workerPath);
  await git(["push", "-u", "origin", FEATURE_BRANCH], workerPath);

  await git(["clone", remotePath, siblingPath], tmpDir);
  await git(["config", "user.email", "sibling@example.com"], siblingPath);
  await git(["config", "user.name", "Sibling"], siblingPath);
  await git(["checkout", FEATURE_BRANCH], siblingPath);

  return { tmpDir, workerPath, siblingPath };
}

async function cleanup(tmpDir: string): Promise<void> {
  try {
    await Deno.remove(tmpDir, { recursive: true });
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// syncBranchToRemoteHead
// ---------------------------------------------------------------------------

Deno.test("syncBranchToRemoteHead - fast-forwards onto a sibling's newer head", async () => {
  const { tmpDir, workerPath, siblingPath } = await setupRepos();
  try {
    await Deno.writeTextFile(`${siblingPath}/sibling.txt`, "sibling\n");
    await git(["add", "sibling.txt"], siblingPath);
    await git(["commit", "-m", "Sibling fix"], siblingPath);
    await git(["push", "origin", FEATURE_BRANCH], siblingPath);
    const remoteHead = await git(["rev-parse", "HEAD"], siblingPath);

    const result = await syncBranchToRemoteHead(FEATURE_BRANCH, {
      cwd: workerPath,
    });

    if (!result.ok) throw result.error;
    assertEquals(result.value.action, "fast-forwarded");
    assertEquals(await git(["rev-parse", "HEAD"], workerPath), remoteHead);
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("syncBranchToRemoteHead - reports already-current when nothing moved", async () => {
  const { tmpDir, workerPath } = await setupRepos();
  try {
    const result = await syncBranchToRemoteHead(FEATURE_BRANCH, {
      cwd: workerPath,
    });
    if (!result.ok) throw result.error;
    assertEquals(result.value.action, "already-current");
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("syncBranchToRemoteHead - refuses when the local branch is ahead of the remote", async () => {
  const { tmpDir, workerPath } = await setupRepos();
  try {
    await Deno.writeTextFile(`${workerPath}/local.txt`, "local only\n");
    await git(["add", "local.txt"], workerPath);
    await git(["commit", "-m", "Unpushed work"], workerPath);

    const result = await syncBranchToRemoteHead(FEATURE_BRANCH, {
      cwd: workerPath,
    });

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(isLocalAheadOfRemoteError(result.error), true);
      assertStringIncludes(result.error.message, "1 commit(s)");
    }
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("syncBranchToRemoteHead - treats a missing remote branch as nothing to align", async () => {
  const { tmpDir, workerPath } = await setupRepos();
  try {
    const result = await syncBranchToRemoteHead("never-pushed", {
      cwd: workerPath,
    });
    if (!result.ok) throw result.error;
    assertEquals(result.value.action, "remote-absent");
  } finally {
    await cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// updatePrBranch — the verdict that drives the merge-conflict label
// ---------------------------------------------------------------------------

Deno.test("updatePrBranch - does not report a conflict from a stale local branch", async () => {
  const { tmpDir, workerPath, siblingPath } = await setupRepos();
  try {
    // The sibling resolves the clash on the remote: the PR as it stands merges
    // cleanly with the base.
    await git(["checkout", DEFAULT_BRANCH], siblingPath);
    await Deno.writeTextFile(`${siblingPath}/shared.txt`, "base version\n");
    await git(["add", "shared.txt"], siblingPath);
    await git(["commit", "-m", "Base adds shared.txt"], siblingPath);
    await git(["push", "origin", DEFAULT_BRANCH], siblingPath);
    await git(["checkout", FEATURE_BRANCH], siblingPath);
    await git(["merge", DEFAULT_BRANCH, "--no-edit"], siblingPath);
    await git(["push", "origin", FEATURE_BRANCH], siblingPath);

    // The worker's clone is stale: it still holds the pre-merge branch with a
    // clashing version of the same file, never pushed.
    await Deno.writeTextFile(`${workerPath}/shared.txt`, "worker version\n");
    await git(["add", "shared.txt"], workerPath);
    await git(["commit", "-m", "Worker adds shared.txt"], workerPath);
    await git(["fetch", "origin", DEFAULT_BRANCH], workerPath);
    await git(
      ["branch", "-f", DEFAULT_BRANCH, `origin/${DEFAULT_BRANCH}`],
      workerPath,
    );

    const result = await updatePrBranch(
      FEATURE_BRANCH,
      DEFAULT_BRANCH,
      { cwd: workerPath },
      "conflicting",
    );

    assertEquals(result.ok, false);
    if (!result.ok) {
      // The refusal must not be a conflict verdict — that is what put a
      // `merge-conflict` label on a mergeable PR.
      assertEquals(isPrBranchConflictError(result.error), false);
      assertEquals(isLocalAheadOfRemoteError(result.error), true);
    }
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("updatePrBranch - judges the branch after aligning with the remote head", async () => {
  const { tmpDir, workerPath, siblingPath } = await setupRepos();
  try {
    // The base moves; the sibling merges it into the PR branch on the remote.
    await git(["checkout", DEFAULT_BRANCH], siblingPath);
    await Deno.writeTextFile(`${siblingPath}/base.txt`, "base\n");
    await git(["add", "base.txt"], siblingPath);
    await git(["commit", "-m", "Base moves"], siblingPath);
    await git(["push", "origin", DEFAULT_BRANCH], siblingPath);
    await git(["checkout", FEATURE_BRANCH], siblingPath);
    await git(["merge", DEFAULT_BRANCH, "--no-edit"], siblingPath);
    await git(["push", "origin", FEATURE_BRANCH], siblingPath);
    const remoteHead = await git(["rev-parse", "HEAD"], siblingPath);

    await git(["fetch", "origin", DEFAULT_BRANCH], workerPath);
    await git(
      ["branch", "-f", DEFAULT_BRANCH, `origin/${DEFAULT_BRANCH}`],
      workerPath,
    );

    const result = await updatePrBranch(
      FEATURE_BRANCH,
      DEFAULT_BRANCH,
      { cwd: workerPath },
    );

    if (!result.ok) throw result.error;
    // Already current with the base once the remote head is in view.
    assertStringIncludes(result.value, "up to date");
    assertEquals(await git(["rev-parse", "HEAD"], workerPath), remoteHead);
  } finally {
    await cleanup(tmpDir);
  }
});
