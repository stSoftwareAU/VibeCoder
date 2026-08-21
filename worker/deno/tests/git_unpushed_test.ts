/**
 * Remote-authoritative unpushed-commit counting (Issue #211).
 *
 * `rev-list --count HEAD --not --remotes=origin` counts commits that are not
 * on ANY origin remote-tracking ref. A `--single-branch` clone only tracks the
 * default branch, and `git push -u origin <feature>` does NOT create
 * `refs/remotes/origin/<feature>` there (the fetch refspec does not cover it).
 * A perfectly good push therefore reported every commit as still unpushed,
 * which drove bogus recovery, a "please check the branch" comment to a human,
 * and a spurious `merge-conflict` label (NEAT-AI-core #557).
 *
 * These tests drive real git repositories end to end.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { countUnpushedCommits } from "../lib/git_unpushed.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

const DEFAULT_BRANCH = "Develop";
const FEATURE_BRANCH = "issue-556-feature";

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
  remotePath: string;
  /** A `--single-branch` clone — only `origin/Develop` is tracked. */
  singleBranchPath: string;
  /** An ordinary full clone of the same remote. */
  fullClonePath: string;
}

/** Create a bare remote seeded with `DEFAULT_BRANCH`, plus two clones. */
async function setupRepos(): Promise<TestRepos> {
  const tmpDir = await Deno.makeTempDir({ prefix: "git_unpushed_" });
  const remotePath = `${tmpDir}/remote.git`;
  const seedPath = `${tmpDir}/seed`;
  const singleBranchPath = `${tmpDir}/single`;
  const fullClonePath = `${tmpDir}/full`;

  await Deno.mkdir(remotePath, { recursive: true });
  await git(["init", "--bare"], remotePath);
  await git(
    ["symbolic-ref", "HEAD", `refs/heads/${DEFAULT_BRANCH}`],
    remotePath,
  );

  await git(["clone", remotePath, seedPath], tmpDir);
  await configureAuthor(seedPath);
  await git(["checkout", "-b", DEFAULT_BRANCH], seedPath);
  await Deno.writeTextFile(`${seedPath}/README.md`, "# Test\n");
  await git(["add", "README.md"], seedPath);
  await git(["commit", "-m", "Initial commit"], seedPath);
  await git(["push", "-u", "origin", DEFAULT_BRANCH], seedPath);

  await git(
    [
      "clone",
      "--single-branch",
      "--branch",
      DEFAULT_BRANCH,
      remotePath,
      singleBranchPath,
    ],
    tmpDir,
  );
  await configureAuthor(singleBranchPath);

  await git(["clone", remotePath, fullClonePath], tmpDir);
  await configureAuthor(fullClonePath);

  return { tmpDir, remotePath, singleBranchPath, fullClonePath };
}

async function configureAuthor(repoPath: string): Promise<void> {
  await git(["config", "user.email", "worker@example.com"], repoPath);
  await git(["config", "user.name", "Worker"], repoPath);
}

/** Create `count` commits on a new branch checked out from HEAD. */
async function commitOnNewBranch(
  repoPath: string,
  branch: string,
  count: number,
): Promise<void> {
  await git(["checkout", "-b", branch], repoPath);
  for (let i = 0; i < count; i++) {
    await Deno.writeTextFile(`${repoPath}/file-${i}.txt`, `change ${i}\n`);
    await git(["add", `file-${i}.txt`], repoPath);
    await git(["commit", "-m", `Change ${i}`], repoPath);
  }
}

async function cleanup(tmpDir: string): Promise<void> {
  try {
    await Deno.remove(tmpDir, { recursive: true });
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// The regression: a good push on a single-branch clone
// ---------------------------------------------------------------------------

Deno.test("countUnpushedCommits - reports 0 after a successful push on a single-branch clone", async () => {
  const { tmpDir, singleBranchPath } = await setupRepos();
  try {
    await commitOnNewBranch(singleBranchPath, FEATURE_BRANCH, 4);
    await git(["push", "-u", "origin", FEATURE_BRANCH], singleBranchPath);

    // Precondition: this clone genuinely has no remote-tracking ref for the
    // feature branch, which is exactly what fooled the old local-only count.
    const trackingRef = await runGitCommand(
      [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/remotes/origin/${FEATURE_BRANCH}`,
      ],
      { cwd: singleBranchPath },
    );
    assertEquals(trackingRef.ok && trackingRef.value.code === 0, false);

    const unpushed = await countUnpushedCommits(FEATURE_BRANCH, {
      cwd: singleBranchPath,
    });
    assertEquals(unpushed.count, 0);
    assertEquals(unpushed.source, "remote-head");
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("countUnpushedCommits - counts genuinely unpushed commits on a single-branch clone", async () => {
  const { tmpDir, singleBranchPath } = await setupRepos();
  try {
    await commitOnNewBranch(singleBranchPath, FEATURE_BRANCH, 1);
    await git(["push", "-u", "origin", FEATURE_BRANCH], singleBranchPath);

    // Two more commits that never reached the remote.
    await Deno.writeTextFile(`${singleBranchPath}/late.txt`, "late\n");
    await git(["add", "late.txt"], singleBranchPath);
    await git(["commit", "-m", "Late one"], singleBranchPath);
    await Deno.writeTextFile(`${singleBranchPath}/later.txt`, "later\n");
    await git(["add", "later.txt"], singleBranchPath);
    await git(["commit", "-m", "Later one"], singleBranchPath);

    const unpushed = await countUnpushedCommits(FEATURE_BRANCH, {
      cwd: singleBranchPath,
    });
    assertEquals(unpushed.count, 2);
    assertEquals(unpushed.source, "remote-head");
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("countUnpushedCommits - counts every commit when the remote branch does not exist", async () => {
  const { tmpDir, singleBranchPath } = await setupRepos();
  try {
    await commitOnNewBranch(singleBranchPath, FEATURE_BRANCH, 3);

    const unpushed = await countUnpushedCommits(FEATURE_BRANCH, {
      cwd: singleBranchPath,
    });
    assertEquals(unpushed.count, 3);
    assertEquals(unpushed.source, "remote-absent");
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("countUnpushedCommits - uses the local tracking ref on a full clone", async () => {
  const { tmpDir, fullClonePath } = await setupRepos();
  try {
    await commitOnNewBranch(fullClonePath, FEATURE_BRANCH, 2);
    await git(["push", "-u", "origin", FEATURE_BRANCH], fullClonePath);

    const unpushed = await countUnpushedCommits(FEATURE_BRANCH, {
      cwd: fullClonePath,
    });
    assertEquals(unpushed.count, 0);
    assertEquals(unpushed.source, "tracking-ref");
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("countUnpushedCommits - counts against a sibling's newer remote head", async () => {
  const { tmpDir, singleBranchPath, fullClonePath } = await setupRepos();
  try {
    await commitOnNewBranch(singleBranchPath, FEATURE_BRANCH, 1);
    await git(["push", "-u", "origin", FEATURE_BRANCH], singleBranchPath);

    // A fleet sibling pushes a commit this clone has never seen.
    await git(["fetch", "origin", FEATURE_BRANCH], fullClonePath);
    await git(["checkout", FEATURE_BRANCH], fullClonePath);
    await Deno.writeTextFile(`${fullClonePath}/sibling.txt`, "sibling\n");
    await git(["add", "sibling.txt"], fullClonePath);
    await git(["commit", "-m", "Sibling commit"], fullClonePath);
    await git(["push", "origin", FEATURE_BRANCH], fullClonePath);

    // Our clone adds one local commit on top of the now-stale head.
    await Deno.writeTextFile(`${singleBranchPath}/ours.txt`, "ours\n");
    await git(["add", "ours.txt"], singleBranchPath);
    await git(["commit", "-m", "Our commit"], singleBranchPath);

    const unpushed = await countUnpushedCommits(FEATURE_BRANCH, {
      cwd: singleBranchPath,
    });
    // The remote head is unknown locally, so the count is established against
    // the fetched remote head: only our own commit is unpushed.
    assertEquals(unpushed.count, 1);
    assertEquals(unpushed.source, "remote-head");
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("countUnpushedCommits - falls back loudly when the remote cannot be consulted", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "git_unpushed_noremote_" });
  try {
    const repoPath = `${tmpDir}/repo`;
    await Deno.mkdir(repoPath, { recursive: true });
    await git(["init", "-b", DEFAULT_BRANCH], repoPath);
    await configureAuthor(repoPath);
    await Deno.writeTextFile(`${repoPath}/README.md`, "# Test\n");
    await git(["add", "README.md"], repoPath);
    await git(["commit", "-m", "Initial commit"], repoPath);
    await git(["remote", "add", "origin", `${tmpDir}/missing.git`], repoPath);

    const unpushed = await countUnpushedCommits(DEFAULT_BRANCH, {
      cwd: repoPath,
    });
    assertEquals(unpushed.count, 1);
    assertEquals(unpushed.source, "local-fallback");
    // The reason the remote could not be consulted must reach the caller.
    assertEquals(typeof unpushed.detail, "string");
    assertEquals((unpushed.detail ?? "").length > 0, true);
  } finally {
    await cleanup(tmpDir);
  }
});
