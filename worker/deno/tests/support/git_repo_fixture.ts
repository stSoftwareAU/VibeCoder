/**
 * A real bare remote plus a clone, for tests that drive git itself.
 *
 * The milestone-branch suites each carried their own byte-identical copy of
 * this fixture (Issue #1345). One helper rather than one copy per suite: how a
 * throwaway repository is seeded and torn down is exactly the detail that must
 * not be written three ways.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Run git, returning its exit code and streams rather than throwing. */
export async function git(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/** Run git, throwing with git's own stderr when it fails. */
export async function gitOk(args: string[], cwd: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return r.stdout;
}

/** A seeded remote/clone pair under one temporary root. */
export interface GitRepoFixture {
  /** Temporary directory holding both repositories. */
  root: string;
  /** Path to the bare remote (`origin`). */
  remote: string;
  /** Path to the clone acting as the work tree. */
  clone: string;
  /** Remove the whole root; safe to call more than once. */
  cleanup: () => Promise<void>;
}

/**
 * Create a bare remote seeded with `main`, plus a clone of it.
 *
 * @param prefix - Temp-directory prefix, e.g. `"issue-1345-"`.
 */
export async function setupGitRepoFixture(
  prefix: string,
): Promise<GitRepoFixture> {
  const root = await Deno.makeTempDir({ prefix });
  const remote = `${root}/remote.git`;
  const clone = `${root}/clone`;

  await gitOk(["init", "--bare", "-b", "main", remote], root);
  await gitOk(["clone", remote, clone], root);
  await gitOk(["config", "user.email", "t@example.com"], clone);
  await gitOk(["config", "user.name", "Test"], clone);
  await Deno.writeTextFile(`${clone}/README.md`, "seed\n");
  await gitOk(["add", "README.md"], clone);
  await gitOk(["commit", "-m", "seed"], clone);
  await gitOk(["push", "-u", "origin", "main"], clone);

  return {
    root,
    remote,
    clone,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

/** Add a file, commit it, and return the resulting SHA. */
export async function commitFile(
  cwd: string,
  file: string,
  contents: string,
  message: string,
): Promise<string> {
  await Deno.writeTextFile(`${cwd}/${file}`, contents);
  await gitOk(["add", file], cwd);
  await gitOk(["commit", "-m", message], cwd);
  return (await gitOk(["rev-parse", "HEAD"], cwd)).trim();
}
