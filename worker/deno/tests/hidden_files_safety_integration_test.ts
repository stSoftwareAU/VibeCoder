/**
 * End-to-end integration test for the hidden-file safety chain
 * (Issue #1760, regression guard for Issue #1751).
 *
 * The two safeguards that protect monitored repos from leaking secrets
 * are unit-tested in isolation:
 *
 *   - `ensureGitignorePatterns()` (Issue #1757) writes the canonical
 *     `.gitignore` block that ignores every hidden file by default.
 *   - `assertSafeToCommit()` (Issue #1758) inspects the index and
 *     refuses any commit that stages a hidden or secret-bearing path
 *     outside the allowlist.
 *
 * This test ties them together against a real git repo seeded with a
 * `.env` file so a future refactor cannot silently disable the chain.
 *
 * Two scenarios:
 *   A. `.gitignore` enforcer alone — `git add .` filters `.env` out.
 *   B. Pre-commit gate catches a forced bypass — `git add -f .env`
 *      stages the secret, but `assertSafeToCommit()` returns `Err`
 *      and no commit is created.
 *
 * Both scenarios run against local repos in `Deno.makeTempDir`, no
 * network, and complete well within the 30 s unit-test budget.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ensureGitignorePatterns } from "../lib/gitignore_enforcer.ts";
import { assertSafeToCommit } from "../lib/pre_commit_safety.ts";

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(args: string[], cwd: string): Promise<GitRunResult> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/**
 * Initialise an empty git repo with deterministic identity and no GPG
 * signing. Does NOT create a `.gitignore` — scenarios add their own.
 */
async function makeRepo(prefix: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix });
  await runGit(["init", "-q", "-b", "main"], dir);
  await runGit(["config", "commit.gpgsign", "false"], dir);
  await runGit(["config", "user.email", "test@example.com"], dir);
  await runGit(["config", "user.name", "test"], dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Scenario A — .gitignore enforcer alone protects against accidental staging
// ---------------------------------------------------------------------------

Deno.test(
  "hidden-files safety - Scenario A: gitignore enforcer keeps .env out of the index on git add .",
  async () => {
    const dir = await makeRepo("hidden_files_int_a_");
    try {
      // Plant a fake secret and a normal source file.
      await Deno.writeTextFile(
        `${dir}/.env`,
        "API_KEY=test_value_xyz\n",
      );
      await Deno.mkdir(`${dir}/src`, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/src/foo.ts`,
        "export const value = 1;\n",
      );

      // Ensure the canonical gitignore patterns are in place — this is
      // the call `setup.sh` makes once at setup time via the
      // `gitignore-sync` subcommand (Issue #1774).
      const ensure = await ensureGitignorePatterns(dir);
      assert(ensure.ok, ensure.ok ? "" : ensure.error.message);
      assert(ensure.value.added.length > 0, "expected patterns to be appended");

      // Sanity check: the on-disk .gitignore now contains the broad
      // hidden-file ignore.
      const gitignore = await Deno.readTextFile(`${dir}/.gitignore`);
      assertStringIncludes(gitignore, ".*");

      // Stage everything the way an unaware commit script would.
      const addResult = await runGit(["add", "."], dir);
      assertEquals(
        addResult.code,
        0,
        `git add . failed: ${addResult.stderr}`,
      );

      // The .gitignore must filter `.env` out of the index. Use NUL-
      // separated output so paths are unambiguous.
      const stagedResult = await runGit(
        ["diff", "--cached", "--name-only", "-z"],
        dir,
      );
      assertEquals(stagedResult.code, 0);
      const staged = stagedResult.stdout
        .split("\0")
        .filter((p) => p.length > 0);

      assert(
        staged.includes("src/foo.ts"),
        `expected src/foo.ts staged, got: ${JSON.stringify(staged)}`,
      );
      assert(
        staged.includes(".gitignore"),
        `expected .gitignore staged, got: ${JSON.stringify(staged)}`,
      );
      assert(
        !staged.includes(".env"),
        `.env must NOT be staged after git add . — got: ${
          JSON.stringify(staged)
        }`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Scenario B — pre-commit gate catches a forced-add bypass
// ---------------------------------------------------------------------------

Deno.test(
  "hidden-files safety - Scenario B: pre-commit gate refuses commit when .env is force-staged",
  async () => {
    const dir = await makeRepo("hidden_files_int_b_");
    try {
      // Same fixture as Scenario A.
      await Deno.writeTextFile(
        `${dir}/.env`,
        "API_KEY=test_value_xyz\n",
      );
      await Deno.mkdir(`${dir}/src`, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/src/foo.ts`,
        "export const value = 1;\n",
      );

      const ensure = await ensureGitignorePatterns(dir);
      assert(ensure.ok, ensure.ok ? "" : ensure.error.message);

      // Force-stage the secret, bypassing .gitignore — the exact
      // scenario the pre-commit gate exists to catch.
      const forceAdd = await runGit(["add", "-f", ".env"], dir);
      assertEquals(
        forceAdd.code,
        0,
        `git add -f .env failed: ${forceAdd.stderr}`,
      );

      // Stage the legitimate source file too so the violation is not
      // the only thing in the index.
      await runGit(["add", "src/foo.ts"], dir);

      // Pre-commit gate must refuse the commit and list .env in the
      // violations.
      const safety = await assertSafeToCommit({ cwd: dir });
      assert(
        !safety.ok,
        "assertSafeToCommit should have refused the commit but returned Ok",
      );
      if (!safety.ok) {
        assertStringIncludes(safety.error.message, ".env");
      }

      // No commit must have been created — the safety gate is a
      // pre-flight check, not a post-flight rollback.
      const log = await runGit(["log", "--oneline"], dir);
      // `git log` exits non-zero on an empty history. Either way,
      // stdout must be empty.
      assertEquals(
        log.stdout.trim(),
        "",
        `expected no commits, got log:\n${log.stdout}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);
