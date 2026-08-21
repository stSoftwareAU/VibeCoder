/**
 * Re-apply-on-moved-head tests (Issue #211).
 *
 * A sibling fleet host pushes to the PR branch while this host's agent runs.
 * Our push is then rejected, and the worker must re-apply its commits onto the
 * new head rather than hand the branch to a human. These tests drive real git
 * repositories end to end — a bare remote plus two clones.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { reapplyOntoRemoteHead } from "../lib/git_reapply.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

const BRANCH = "issue-556-fix";

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

/** Resolve a ref, or null when it does not exist. */
async function revParse(ref: string, cwd: string): Promise<string | null> {
  const result = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", ref],
    {
      cwd,
    },
  );
  if (!result.ok || result.value.code !== 0) return null;
  return result.value.stdout.trim();
}

interface TestRepos {
  tmpDir: string;
  remotePath: string;
  /** This host's clone — where the re-apply runs. */
  workerPath: string;
  /** The sibling fleet host's clone of the same remote. */
  siblingPath: string;
}

async function setupRepos(): Promise<TestRepos> {
  const tmpDir = await Deno.makeTempDir({ prefix: "git_reapply_" });
  const remotePath = `${tmpDir}/remote.git`;
  const workerPath = `${tmpDir}/worker`;
  const siblingPath = `${tmpDir}/sibling`;

  await Deno.mkdir(remotePath, { recursive: true });
  await git(["init", "--bare"], remotePath);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], remotePath);

  await git(["clone", remotePath, workerPath], tmpDir);
  await git(["config", "user.email", "worker@example.com"], workerPath);
  await git(["config", "user.name", "Worker"], workerPath);

  await Deno.writeTextFile(`${workerPath}/README.md`, "# Test\n");
  await Deno.writeTextFile(`${workerPath}/app.ts`, "export const a = 1;\n");
  await git(["add", "-A"], workerPath);
  await git(["commit", "-m", "Initial commit"], workerPath);
  await git(["push", "origin", "main"], workerPath);
  await git(["checkout", "-b", BRANCH], workerPath);
  await git(["push", "origin", BRANCH], workerPath);

  await git(["clone", remotePath, siblingPath], tmpDir);
  await git(["config", "user.email", "sibling@example.com"], siblingPath);
  await git(["config", "user.name", "Sibling Host"], siblingPath);
  await git(["checkout", BRANCH], siblingPath);

  return { tmpDir, remotePath, workerPath, siblingPath };
}

/** Commit a file in a clone without pushing. */
async function commitFile(
  repoPath: string,
  file: string,
  contents: string,
  message: string,
): Promise<void> {
  await Deno.writeTextFile(`${repoPath}/${file}`, contents);
  await git(["add", "-A"], repoPath);
  await git(["commit", "-m", message], repoPath);
}

async function cleanup(tmpDir: string): Promise<void> {
  try {
    await Deno.remove(tmpDir, { recursive: true });
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// The incident: sibling pushed, our commits must be re-applied on top
// ---------------------------------------------------------------------------

Deno.test("reapplyOntoRemoteHead - rebases local commits onto a sibling's push and pushes them", async () => {
  const { tmpDir, remotePath, workerPath, siblingPath } = await setupRepos();
  try {
    // The sibling fixes the failing check and pushes while our agent runs.
    await commitFile(
      siblingPath,
      "quality.txt",
      "sibling fix\n",
      "Sibling fix",
    );
    await git(["push", "origin", BRANCH], siblingPath);
    const siblingSha = await revParse("HEAD", siblingPath);

    // Our agent commits its own work on the old head — the push was rejected.
    await commitFile(workerPath, "feedback.txt", "our fix\n", "Our fix");
    const ourSha = await revParse("HEAD", workerPath);

    const result = await reapplyOntoRemoteHead(BRANCH, { cwd: workerPath });

    assert(
      result.ok,
      `expected success, got ${!result.ok && result.error.message}`,
    );
    assertEquals(result.value.rebased, true);
    assertEquals(result.value.pushed, true);
    assertEquals(result.value.commitsReapplied, 1);

    // The remote tip is our re-applied commit, and the sibling's commit is
    // still in its history — nothing was overwritten.
    const remoteTip = await revParse(`refs/heads/${BRANCH}`, remotePath);
    assertEquals(remoteTip, await revParse("HEAD", workerPath));
    assert(remoteTip !== ourSha, "the commit should have been rebased");
    const history = await git(["log", "--format=%H", BRANCH], remotePath);
    assert(
      history.split("\n").includes(siblingSha!),
      "the sibling's commit must survive the re-apply",
    );
    assertEquals(
      await Deno.readTextFile(`${workerPath}/quality.txt`),
      "sibling fix\n",
    );
  } finally {
    await cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Head did not move — a plain push still lands
// ---------------------------------------------------------------------------

Deno.test("reapplyOntoRemoteHead - pushes without rebasing when the remote head did not move", async () => {
  const { tmpDir, remotePath, workerPath } = await setupRepos();
  try {
    await commitFile(workerPath, "feedback.txt", "our fix\n", "Our fix");
    const ourSha = await revParse("HEAD", workerPath);

    const result = await reapplyOntoRemoteHead(BRANCH, { cwd: workerPath });

    assert(
      result.ok,
      `expected success, got ${!result.ok && result.error.message}`,
    );
    assertEquals(result.value.rebased, false);
    assertEquals(result.value.pushed, true);
    assertEquals(result.value.commitsReapplied, 1);
    assertEquals(await revParse(`refs/heads/${BRANCH}`, remotePath), ourSha);
  } finally {
    await cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Nothing local ahead — no-op success, not a failure
// ---------------------------------------------------------------------------

Deno.test("reapplyOntoRemoteHead - reports a no-op when HEAD is not ahead of the remote", async () => {
  const { tmpDir, workerPath, siblingPath } = await setupRepos();
  try {
    await commitFile(siblingPath, "sibling.txt", "sibling\n", "Sibling commit");
    await git(["push", "origin", BRANCH], siblingPath);

    const result = await reapplyOntoRemoteHead(BRANCH, { cwd: workerPath });

    assert(
      result.ok,
      `expected success, got ${!result.ok && result.error.message}`,
    );
    assertEquals(result.value.pushed, false);
    assertEquals(result.value.commitsReapplied, 0);
    assertStringIncludes(result.value.detail, "nothing to re-apply");
  } finally {
    await cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// A rebase left in progress by an earlier recovery attempt is cleared first
// ---------------------------------------------------------------------------

Deno.test("reapplyOntoRemoteHead - aborts a rebase left in progress and still lands the push", async () => {
  const { tmpDir, remotePath, workerPath, siblingPath } = await setupRepos();
  try {
    // Sibling and worker both change the same file — a rebase will conflict.
    await commitFile(
      siblingPath,
      "app.ts",
      "export const a = 2;\n",
      "Sibling edit",
    );
    await git(["push", "origin", BRANCH], siblingPath);
    await commitFile(workerPath, "notes.txt", "our notes\n", "Our notes");
    await commitFile(workerPath, "app.ts", "export const a = 3;\n", "Our edit");

    // Leave a conflicted rebase in progress, exactly as a failed recovery does.
    await git(["fetch", "origin", BRANCH], workerPath);
    const conflicted = await runGitCommand(
      ["rebase", `origin/${BRANCH}`],
      { cwd: workerPath },
    );
    assert(
      conflicted.ok && conflicted.value.code !== 0,
      "rebase should conflict",
    );

    const result = await reapplyOntoRemoteHead(BRANCH, { cwd: workerPath });

    // Auto-resolution takes over from the aborted rebase and the push lands.
    assert(
      result.ok,
      `expected success, got ${!result.ok && result.error.message}`,
    );
    assertEquals(result.value.pushed, true);
    assertEquals(
      await revParse(`refs/heads/${BRANCH}`, remotePath),
      await revParse("HEAD", workerPath),
    );
  } finally {
    await cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Failures name the step and carry the git stderr
// ---------------------------------------------------------------------------

Deno.test("reapplyOntoRemoteHead - failure names the step that failed", async () => {
  const { tmpDir, workerPath } = await setupRepos();
  try {
    await git(["checkout", "-b", "never-pushed"], workerPath);
    await commitFile(workerPath, "new.txt", "new\n", "New work");

    const result = await reapplyOntoRemoteHead("never-pushed", {
      cwd: workerPath,
    });

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "re-apply step");
      assertStringIncludes(result.error.message, "never-pushed");
    }
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("reapplyOntoRemoteHead - refuses an option-injecting branch name", async () => {
  const result = await reapplyOntoRemoteHead("--upload-pack=evil");
  assertEquals(result.ok, false);
});
