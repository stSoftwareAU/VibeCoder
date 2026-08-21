/**
 * Tests for evaluating a PR branch against its remote head (Issue #211).
 *
 * The branch-update pass runs in a long-lived clone. A run that failed to
 * push leaves its commits on the local branch, and nothing ever resets it.
 * The next pass merged the base into that stale branch, hit a conflict that
 * exists only locally, and labelled a mergeable PR `merge-conflict`
 * (NEAT-AI-core #557). The PR is what lives on origin, so that is what the
 * pass must evaluate.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { isPrBranchConflictError, updatePrBranch } from "../lib/git_pull.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

const BRANCH = "issue-556-feature";

/** Bare remote + clone, with `main` seeded. */
async function setupRepos(
  tmpDir: string,
): Promise<{ remotePath: string; localPath: string }> {
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

  await Deno.writeTextFile(`${localPath}/README.md`, "# Test Repo\n");
  await runGitCommand(["add", "README.md"], { cwd: localPath });
  await runGitCommand(["commit", "-m", "Initial commit"], { cwd: localPath });
  await runGitCommand(["push", "origin", "main"], { cwd: localPath });

  return { remotePath, localPath };
}

async function headSha(cwd: string): Promise<string> {
  const result = await runGitCommand(["rev-parse", "HEAD"], { cwd });
  return result.ok ? result.value.stdout.trim() : "";
}

/**
 * Reproduce the incident: the PR branch on origin is mergeable with the base,
 * but the local clone still carries an unpushed commit that collides with the
 * base's change to the same file.
 */
async function seedStaleLocalBranch(localPath: string): Promise<string> {
  // The PR as it exists on origin: touches only feature.txt.
  await runGitCommand(["checkout", "-b", BRANCH], { cwd: localPath });
  await Deno.writeTextFile(`${localPath}/feature.txt`, "feature work\n");
  await runGitCommand(["add", "."], { cwd: localPath });
  await runGitCommand(["commit", "-m", "PR commit"], { cwd: localPath });
  await runGitCommand(["push", "-u", "origin", BRANCH], { cwd: localPath });
  const remoteHead = await headSha(localPath);

  // The base moves on, editing shared.txt.
  await runGitCommand(["checkout", "main"], { cwd: localPath });
  await Deno.writeTextFile(`${localPath}/shared.txt`, "base version\n");
  await runGitCommand(["add", "."], { cwd: localPath });
  await runGitCommand(["commit", "-m", "base change"], { cwd: localPath });
  await runGitCommand(["push", "origin", "main"], { cwd: localPath });

  // A failed run leaves an unpushed commit on the local PR branch that
  // collides with that base change.
  await runGitCommand(["checkout", BRANCH], { cwd: localPath });
  await Deno.writeTextFile(`${localPath}/shared.txt`, "local unpushed\n");
  await runGitCommand(["add", "."], { cwd: localPath });
  await runGitCommand(["commit", "-m", "unpushed local commit"], {
    cwd: localPath,
  });

  return remoteHead;
}

Deno.test("updatePrBranch - refuses loudly instead of reporting a conflict that exists only on the stale local branch (Issue #211)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "remote_head_update_" });
  try {
    const { localPath } = await setupRepos(tmpDir);
    await seedStaleLocalBranch(localPath);

    const result = await updatePrBranch(BRANCH, "main", { cwd: localPath });

    assertEquals(result.ok, false, "unpushed local commits must not be judged");
    if (!result.ok) {
      // A plain failure, never the conflict error — the conflict error is what
      // hands the PR to the pass that labels it `merge-conflict`, and the
      // remote PR is mergeable.
      assertEquals(
        isPrBranchConflictError(result.error),
        false,
        `must not look like a base conflict: ${result.error.message}`,
      );
      assert(
        result.error.message.includes("1 commit(s)"),
        `must name the unpushed commits: ${result.error.message}`,
      );
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("updatePrBranch - evaluates the sibling's remote head, not the behind local branch (Issue #211)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "remote_head_sibling_" });
  try {
    const { localPath } = await setupRepos(tmpDir);
    const siblingPath = `${tmpDir}/sibling`;

    // The PR as this clone last saw it.
    await runGitCommand(["checkout", "-b", BRANCH], { cwd: localPath });
    await Deno.writeTextFile(`${localPath}/feature.txt`, "feature work\n");
    await runGitCommand(["add", "."], { cwd: localPath });
    await runGitCommand(["commit", "-m", "PR commit"], { cwd: localPath });
    await runGitCommand(["push", "-u", "origin", BRANCH], { cwd: localPath });

    // A sibling fleet host pushes to the same PR branch.
    await runGitCommand(["clone", `${tmpDir}/remote.git`, siblingPath], {
      cwd: tmpDir,
    });
    await runGitCommand(["config", "user.email", "sibling@example.com"], {
      cwd: siblingPath,
    });
    await runGitCommand(["config", "user.name", "Sibling"], {
      cwd: siblingPath,
    });
    await runGitCommand(["checkout", BRANCH], { cwd: siblingPath });
    await Deno.writeTextFile(`${siblingPath}/feature.txt`, "sibling fix\n");
    await runGitCommand(["add", "."], { cwd: siblingPath });
    await runGitCommand(["commit", "-m", "sibling fix"], { cwd: siblingPath });
    await runGitCommand(["push", "origin", BRANCH], { cwd: siblingPath });

    // The base moves on too, so the branch is genuinely behind.
    await runGitCommand(["checkout", "main"], { cwd: localPath });
    await Deno.writeTextFile(`${localPath}/base.txt`, "base change\n");
    await runGitCommand(["add", "."], { cwd: localPath });
    await runGitCommand(["commit", "-m", "base change"], { cwd: localPath });
    await runGitCommand(["push", "origin", "main"], { cwd: localPath });
    await runGitCommand(["checkout", BRANCH], { cwd: localPath });

    const result = await updatePrBranch(BRANCH, "main", { cwd: localPath });

    assert(result.ok, !result.ok ? result.error.message : "");
    // The sibling's work rode through the update — the stale local head, which
    // still held the pre-sibling content, was never what got rebased.
    assertEquals(
      await Deno.readTextFile(`${localPath}/feature.txt`),
      "sibling fix\n",
    );
    // …and the base's change is on the branch, so it really was updated.
    assertEquals(
      await Deno.readTextFile(`${localPath}/base.txt`),
      "base change\n",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
