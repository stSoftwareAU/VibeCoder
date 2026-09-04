/**
 * Single-branch-clone regression for the final-mile push (Issue #211).
 *
 * `commitAndPushPending` reported `commitsPushed=4 finalUnpushedCount=4` after
 * a push that had in fact landed: the post-condition counted commits not on any
 * `origin/*` ref, and a `--single-branch` clone tracks only the default branch.
 * The self-contradictory result drove a bogus recovery attempt, a "please check
 * the branch status" comment to a human, and a spurious `merge-conflict` label
 * (NEAT-AI-core #557, #563).
 *
 * These tests drive real git repositories end to end.
 *
 * The run id is supplied as a parameter (Issue #963). It used to be set on
 * the process as `VIBE_RUN_ID`, which races every other test running at that
 * moment and pinned this file into the gate's serial pass (Issue #880).
 * {@link TEST_RUN_ID} exists in no real environment, so a fall back to
 * `Deno.env.get` would stamp a different id rather than pass unnoticed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { commitAndPushPending, pushUnpushedCommits } from "../lib/git_push.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import { RUN_ID_TRAILER_KEY } from "../lib/run_id.ts";

const DEFAULT_BRANCH = "Develop";
const FEATURE_BRANCH = "issue-556-single-branch";

/** Run id stamped on the commits these tests make (Issue #963). */
const TEST_RUN_ID = "vibe-963-single-branch-sentinel";

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
  /** The worker's `--single-branch` clone. */
  workerPath: string;
}

async function setupRepos(): Promise<TestRepos> {
  const tmpDir = await Deno.makeTempDir({ prefix: "single_branch_push_" });
  const remotePath = `${tmpDir}/remote.git`;
  const seedPath = `${tmpDir}/seed`;
  const workerPath = `${tmpDir}/worker`;

  await Deno.mkdir(remotePath, { recursive: true });
  await git(["init", "--bare"], remotePath);
  await git(
    ["symbolic-ref", "HEAD", `refs/heads/${DEFAULT_BRANCH}`],
    remotePath,
  );

  await git(["clone", remotePath, seedPath], tmpDir);
  await git(["config", "user.email", "seed@example.com"], seedPath);
  await git(["config", "user.name", "Seed"], seedPath);
  await git(["checkout", "-b", DEFAULT_BRANCH], seedPath);
  await Deno.writeTextFile(`${seedPath}/README.md`, "# Test\n");
  await git(["add", "README.md"], seedPath);
  await git(["commit", "-m", "Initial commit"], seedPath);
  await git(["push", "-u", "origin", DEFAULT_BRANCH], seedPath);

  await git([
    "clone",
    "--single-branch",
    "--branch",
    DEFAULT_BRANCH,
    remotePath,
    workerPath,
  ], tmpDir);
  await git(["config", "user.email", "worker@example.com"], workerPath);
  await git(["config", "user.name", "Worker"], workerPath);
  await git(["checkout", "-b", FEATURE_BRANCH], workerPath);

  return { tmpDir, remotePath, workerPath };
}

/** The remote's own view of a branch tip, or null when it has none. */
async function remoteTip(
  remotePath: string,
  branch: string,
): Promise<string | null> {
  const result = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: remotePath },
  );
  if (!result.ok || result.value.code !== 0) return null;
  return result.value.stdout.trim();
}

async function cleanup(tmpDir: string): Promise<void> {
  try {
    await Deno.remove(tmpDir, { recursive: true });
  } catch {
    // Best-effort cleanup
  }
}

Deno.test("commitAndPushPending - reports a clean post-condition on a single-branch clone", async () => {
  const { tmpDir, remotePath, workerPath } = await setupRepos();
  try {
    // Three commits made during the run, plus uncommitted work for the
    // final-mile commit to pick up.
    for (let i = 0; i < 3; i++) {
      await Deno.writeTextFile(`${workerPath}/file-${i}.txt`, `change ${i}\n`);
      await git(["add", `file-${i}.txt`], workerPath);
      await git(["commit", "-m", `Change ${i}`], workerPath);
    }
    await Deno.writeTextFile(`${workerPath}/pending.txt`, "pending\n");

    const result = await commitAndPushPending(
      FEATURE_BRANCH,
      "Fix CI failure: Quality Checks\n\nAutomated final-mile commit.",
      { cwd: workerPath },
      false,
      undefined,
      TEST_RUN_ID,
    );

    if (!result.ok) throw result.error;
    assertEquals(result.value.committedNewChanges, true);
    // The honest post-condition: everything reached the remote.
    assertEquals(result.value.finalUnpushedCount, 0);
    assertEquals(result.value.finalUnpushedSource, "remote-head");
    assertEquals(result.value.commitsPushed, 4);

    const localHead = await git(["rev-parse", "HEAD"], workerPath);
    assertEquals(await remoteTip(remotePath, FEATURE_BRANCH), localHead);

    // The commit that landed carries the run id it was given, so the pushed
    // work stays attributable to the run that made it (Issue #963).
    const trailer = await git(
      ["log", "-1", `--format=%(trailers:key=${RUN_ID_TRAILER_KEY},valueonly)`],
      workerPath,
    );
    assertEquals(trailer, TEST_RUN_ID);
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("commitAndPushPending - still reports unpushed commits when the push genuinely fails", async () => {
  const { tmpDir, remotePath, workerPath } = await setupRepos();
  try {
    await Deno.writeTextFile(`${workerPath}/only.txt`, "only\n");
    await git(["add", "only.txt"], workerPath);
    await git(["commit", "-m", "Local work"], workerPath);

    // Point origin at a path that does not exist so no push can land.
    await git(
      ["remote", "set-url", "origin", `${tmpDir}/vanished.git`],
      workerPath,
    );

    const result = await commitAndPushPending(
      FEATURE_BRANCH,
      "Fix CI failure: Quality Checks\n\nAutomated final-mile commit.",
      { cwd: workerPath },
      false,
      undefined,
      TEST_RUN_ID,
    );

    assertEquals(result.ok, false);
    assertEquals(await remoteTip(remotePath, FEATURE_BRANCH), null);
  } finally {
    await cleanup(tmpDir);
  }
});

Deno.test("pushUnpushedCommits - skips a redundant push when the remote already has HEAD", async () => {
  const { tmpDir, workerPath } = await setupRepos();
  try {
    await Deno.writeTextFile(`${workerPath}/one.txt`, "one\n");
    await git(["add", "one.txt"], workerPath);
    await git(["commit", "-m", "One"], workerPath);

    const first = await pushUnpushedCommits(FEATURE_BRANCH, {
      cwd: workerPath,
    });
    if (!first.ok) throw first.error;
    assertEquals(first.value, 1);

    // Nothing changed since — the branch is already on the remote even though
    // this clone has no remote-tracking ref for it.
    const second = await pushUnpushedCommits(FEATURE_BRANCH, {
      cwd: workerPath,
    });
    if (!second.ok) throw second.error;
    assertEquals(second.value, 0);
  } finally {
    await cleanup(tmpDir);
  }
});
