/**
 * Integration tests for the ref-taking git argv builders (Issue #3714).
 *
 * The unit tests pin argv shape; these run real `git` to prove two things the
 * shape alone cannot:
 *
 *   1. Inserting `--end-of-options` does not break ordinary operation of
 *      `fetch`, `pull`, `rebase` or `checkout`.
 *   2. The separator genuinely demotes a dash-leading ref from "option" to
 *      "ref" — the vulnerability the builders exist to close.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runGitCommand } from "../lib/git_timeout.ts";
import {
  buildCheckoutArgs,
  buildCheckoutNewBranchArgs,
  buildFetchArgs,
  buildPullArgs,
  buildRebaseArgs,
} from "../lib/git_ref_args.ts";

/** Initialise a bare "remote" plus a working clone with one commit on main. */
async function setupRepos(
  tmpDir: string,
): Promise<{ localPath: string }> {
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

  return { localPath };
}

async function withRepos(
  fn: (localPath: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "git_ref_args_test_" });
  try {
    const { localPath } = await setupRepos(tmpDir);
    await fn(localPath);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

Deno.test("built argv still performs the ordinary operation", async () => {
  await withRepos(async (cwd) => {
    const fetch = await runGitCommand(buildFetchArgs("origin", "main"), {
      cwd,
    });
    assertEquals(fetch.ok && fetch.value.code, 0);

    const branch = await runGitCommand(
      buildCheckoutNewBranchArgs("feature", "main"),
      { cwd },
    );
    assertEquals(branch.ok && branch.value.code, 0);

    const switchBack = await runGitCommand(buildCheckoutArgs("main"), { cwd });
    assertEquals(switchBack.ok && switchBack.value.code, 0);
    const head = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
    });
    assertEquals(head.ok && head.value.stdout.trim(), "main");

    const rebase = await runGitCommand(buildRebaseArgs("main"), { cwd });
    assertEquals(rebase.ok && rebase.value.code, 0);

    const pull = await runGitCommand(buildPullArgs("origin", "main"), { cwd });
    assertEquals(pull.ok && pull.value.code, 0);

    const pullFf = await runGitCommand(
      buildPullArgs("origin", "main", { ffOnly: true }),
      { cwd },
    );
    assertEquals(pullFf.ok && pullFf.value.code, 0);
  });
});

Deno.test("fetch - separator demotes --upload-pack from option to ref", async () => {
  await withRepos(async (cwd) => {
    // Unprotected: git honours --upload-pack and tries to run it remotely.
    const unguarded = await runGitCommand(
      ["fetch", "origin", "--upload-pack=/nonexistent/vibe-3714"],
      { cwd },
    );
    assertStringIncludes(
      unguarded.ok ? unguarded.value.stderr : "",
      "Could not read from remote repository",
    );

    // Guarded: the same value is treated as a ref that simply does not exist.
    const guarded = await runGitCommand(
      [
        "fetch",
        "--end-of-options",
        "origin",
        "--upload-pack=/nonexistent/vibe-3714",
      ],
      { cwd },
    );
    assertStringIncludes(
      guarded.ok ? guarded.value.stderr : "",
      "couldn't find remote ref",
    );
  });
});

Deno.test("rebase - separator demotes a dash-leading upstream to a ref", async () => {
  await withRepos(async (cwd) => {
    const guarded = await runGitCommand(
      ["rebase", "--end-of-options", "--autostash"],
      { cwd },
    );
    assertStringIncludes(
      guarded.ok ? guarded.value.stderr : "",
      "invalid upstream '--autostash'",
    );
  });
});

Deno.test("checkout - separator demotes a dash-leading ref to a positional", async () => {
  await withRepos(async (cwd) => {
    const unguarded = await runGitCommand(["checkout", "--orphan"], { cwd });
    // Parsed as the --orphan option, which then complains about its value.
    assertStringIncludes(
      unguarded.ok ? unguarded.value.stderr : "",
      "requires a value",
    );

    const guarded = await runGitCommand(
      ["checkout", "--end-of-options", "--orphan"],
      { cwd },
    );
    assertStringIncludes(
      guarded.ok ? guarded.value.stderr : "",
      "did not match any file(s) known to git",
    );
  });
});
