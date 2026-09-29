/**
 * Real-repository fixture for push-recovery tests (Issue #2808).
 *
 * A bare remote plus two clones of one feature branch, where the "other"
 * clone has pushed a commit the worker clone has not seen — the shape in which
 * the worker's own push is rejected as non-fast-forward.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { runGitCommand } from "../../lib/git_timeout.ts";

/** Run a git command in a repo, failing loudly on a non-zero exit. */
export async function git(args: string[], cwd: string): Promise<string> {
  const result = await runGitCommand(args, { cwd });
  if (!result.ok) throw result.error;
  if (result.value.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.value.stderr}`);
  }
  return result.value.stdout.trim();
}

/** Write and commit one file in a clone. */
export async function commitFile(
  cwd: string,
  file: string,
  content: string,
): Promise<void> {
  await Deno.writeTextFile(`${cwd}/${file}`, content);
  await git(["add", file], cwd);
  await git(["commit", "-m", `Change ${file}`], cwd);
}

/** Paths and the other author's pushed commit. */
export interface DivergedRepos {
  tmpDir: string;
  branch: string;
  remotePath: string;
  /** The worker's clone — the one push recovery runs in. */
  workerPath: string;
  /** The other author's pushed commit, unseen by the worker clone. */
  otherSha: string;
}

async function cloneAs(
  remotePath: string,
  path: string,
  name: string,
  tmpDir: string,
): Promise<void> {
  await git(["clone", remotePath, path], tmpDir);
  await git(["config", "user.email", `${name}@example.com`], path);
  await git(["config", "user.name", name], path);
}

/**
 * Create the diverged fixture; the other author's commit writes `otherFile`.
 */
export async function setupDivergedRepos(
  otherFile: string,
  otherContent: string,
  branch = "feature-recovery",
): Promise<DivergedRepos> {
  const tmpDir = await Deno.makeTempDir({ prefix: "push_recovery_" });
  const remotePath = `${tmpDir}/remote.git`;
  const workerPath = `${tmpDir}/worker`;
  const otherPath = `${tmpDir}/other`;
  await Deno.mkdir(remotePath, { recursive: true });
  await git(["init", "--bare"], remotePath);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], remotePath);

  await cloneAs(remotePath, workerPath, "Worker", tmpDir);
  await commitFile(workerPath, "README.md", "# Test\n");
  await git(["push", "origin", "main"], workerPath);
  await git(["checkout", "-b", branch], workerPath);
  await git(["push", "origin", branch], workerPath);

  await cloneAs(remotePath, otherPath, "Other", tmpDir);
  await git(["checkout", branch], otherPath);
  await commitFile(otherPath, otherFile, otherContent);
  await git(["push", "origin", branch], otherPath);
  const otherSha = await git(["rev-parse", "HEAD"], otherPath);

  return { tmpDir, branch, remotePath, workerPath, otherSha };
}
