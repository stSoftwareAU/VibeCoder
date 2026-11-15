/**
 * Real-git fixtures for the babysitter tree gate tests (Issue #4930): a clone
 * of a bare remote whose `main` holds a small Deno root, left for an `edit`.
 */

const decoder = new TextDecoder();

/** Runs real git in `cwd` and returns its trimmed stdout; throws on failure. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${decoder.decode(out.stderr)}`,
    );
  }
  return decoder.decode(out.stdout).trim();
}

export const FOO_FAILURE =
  "FAILURES\n\nfoo works => ./tests/foo_test.ts:3:6\n\nFAILED | 0 passed | 1 failed\n";

/**
 * A clone of a bare remote whose `main` holds a Deno root at worker/deno (a
 * `foo` source and its test) and a markdownlint config, left clean. `edit` then
 * makes the agent's uncommitted changes.
 */
export async function agentClone(
  edit: (clone: string) => Promise<void>,
  body: (clone: string) => Promise<void>,
): Promise<void> {
  const top = await Deno.makeTempDir({ prefix: "tree-gate-real-4930-" });
  try {
    const clone = `${top}/clone`;
    await git(top, "init", "-q", "--bare", "-b", "main", `${top}/remote.git`);
    await git(top, "clone", "-q", `${top}/remote.git`, clone);
    await git(clone, "config", "user.email", "tree-gate@example.invalid");
    await git(clone, "config", "user.name", "Tree Gate Test");
    await git(clone, "config", "commit.gpgsign", "false");
    await Deno.mkdir(`${clone}/worker/deno/lib`, { recursive: true });
    await Deno.mkdir(`${clone}/worker/deno/tests`, { recursive: true });
    await Deno.writeTextFile(
      `${clone}/worker/deno/deno.json`,
      JSON.stringify({ tasks: { "test:unit": "x" } }),
    );
    await Deno.writeTextFile(
      `${clone}/worker/deno/lib/foo.ts`,
      "export const foo = 1;\n",
    );
    await Deno.writeTextFile(
      `${clone}/worker/deno/tests/foo_test.ts`,
      "export {};\n",
    );
    await Deno.writeTextFile(`${clone}/.markdownlint-cli2.jsonc`, "{}\n");
    await git(clone, "add", "-A");
    await git(clone, "commit", "-q", "-m", "base");
    await git(clone, "push", "-q", "--no-verify", "origin", "HEAD:main");
    await edit(clone);
    await body(clone);
  } finally {
    await Deno.remove(top, { recursive: true }).catch(() => {});
  }
}

export const editFoo = (clone: string) =>
  Deno.writeTextFile(
    `${clone}/worker/deno/lib/foo.ts`,
    "export const foo = 2;\n",
  );

export const BAR_FAILURE =
  "FAILURES\n\nbar works => ./tests/bar_test.ts:3:6\n\nFAILED | 0 passed | 1 failed\n";

/**
 * Leaves the clone as the repair container finds a PR whose base moved on: the
 * base gained a commit holding `baseFiles`, the PR head gained its own commit,
 * and the base is merged in with `merge --no-commit`, so every file it brings
 * in is staged but not committed.
 */
export async function mergeNewerBase(
  clone: string,
  baseFiles: Record<string, string>,
): Promise<void> {
  await git(clone, "checkout", "-q", "-b", "newer-base");
  for (const [name, text] of Object.entries(baseFiles)) {
    await Deno.mkdir(`${clone}/${name.split("/").slice(0, -1).join("/")}`, {
      recursive: true,
    });
    await Deno.writeTextFile(`${clone}/${name}`, text);
  }
  await git(clone, "add", "-A");
  await git(clone, "commit", "-q", "-m", "base moves on");
  await git(clone, "push", "-q", "--no-verify", "origin", "HEAD:main");
  await git(clone, "checkout", "-q", "main");
  await Deno.writeTextFile(`${clone}/PR.txt`, "the PR's own change\n");
  await git(clone, "add", "-A");
  await git(clone, "commit", "-q", "-m", "PR change");
  await git(
    clone,
    "merge",
    "--no-commit",
    "--no-ff",
    "refs/remotes/origin/main",
  );
}
