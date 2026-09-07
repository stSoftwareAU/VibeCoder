/**
 * Regression tests for the poisoned `.vibe_default_branch` cache (Issue #1269).
 *
 * `setupRepo()` reads the default branch out of a file that lives *inside* the
 * clone, so a repository that commits `.vibe_default_branch` controls the
 * value. The file survives `git reset --hard HEAD` and `git clean -fd`, and the
 * read happens before both, so an unvalidated value reached
 * `git checkout <value>` as a bare positional — an option slot
 * (`--pathspec-from-file=…`, `--orphan`, `-f`) on the worker's clone.
 *
 * The tests below call the real functions with the attack input and assert the
 * refusal; they fail against the unvalidated code.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { setupRepo } from "../commands/git_operations.ts";
import { recoverGitState } from "../lib/git_state_recovery.ts";
import { ensureDefaultBranchCurrent } from "../lib/git_push.ts";

/** The attack value the finding names. */
const POISONED_BRANCH = "--pathspec-from-file=/etc/passwd";

async function runGit(args: string[], cwd: string): Promise<number> {
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
  return (await cmd.output()).code;
}

/** Build an upstream repo plus a clone of it, as `setupRepo` expects. */
async function buildClone(): Promise<{
  tmp: string;
  clonePath: string;
  cleanup: () => Promise<void>;
}> {
  const tmp = await Deno.makeTempDir({ prefix: "vibe_default_branch_" });
  const upstream = `${tmp}/upstream`;
  const clonePath = `${tmp}/downstream`;
  await Deno.mkdir(upstream, { recursive: true });
  assertEquals(await runGit(["init", "-b", "main"], upstream), 0);
  await runGit(["config", "user.email", "t@t"], upstream);
  await runGit(["config", "user.name", "t"], upstream);
  await Deno.writeTextFile(`${upstream}/file.txt`, "first\n");
  await runGit(["add", "file.txt"], upstream);
  await runGit(["commit", "-m", "first"], upstream);
  assertEquals(
    await runGit(["clone", `file://${upstream}`, clonePath], tmp),
    0,
  );
  return {
    tmp,
    clonePath,
    cleanup: () => Deno.remove(tmp, { recursive: true }),
  };
}

Deno.test(
  "setupRepo - ignores a poisoned .vibe_default_branch instead of checking it out",
  async () => {
    const { tmp, clonePath, cleanup } = await buildClone();
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      // A committed cache file: it survives reset --hard and clean -fd, and
      // setupRepo reads it before either runs.
      await Deno.writeTextFile(
        `${clonePath}/.vibe_default_branch`,
        `${POISONED_BRANCH}\n`,
      );

      const result = await setupRepo("owner/downstream", tmp);

      // The poisoned value must never become the default branch: the
      // git-derived value stands and the refusal is logged loudly.
      assertEquals(
        (result.data as { defaultBranch?: string } | undefined)?.defaultBranch,
        "main",
      );
      const warning = errors.find((e) => e.includes(".vibe_default_branch"));
      assert(
        warning !== undefined,
        `expected a loud refusal on stderr, got: ${errors.join(" / ")}`,
      );
      assertStringIncludes(warning, "Issue #1269");

      // The clone must still be on its real default branch — the poisoned
      // value never reached `git checkout` as an option slot.
      const head = new TextDecoder().decode(
        (await new Deno.Command("git", {
          args: ["rev-parse", "--abbrev-ref", "HEAD"],
          cwd: clonePath,
          stdout: "piped",
          stderr: "piped",
        }).output()).stdout,
      ).trim();
      assertEquals(head, "main");
    } finally {
      console.error = realError;
      await cleanup();
    }
  },
);

Deno.test(
  "setupRepo - accepts a legitimate cached default branch",
  async () => {
    const { tmp, clonePath, cleanup } = await buildClone();
    try {
      await Deno.writeTextFile(`${clonePath}/.vibe_default_branch`, "main\n");
      const result = await setupRepo("owner/downstream", tmp);
      assertEquals(result.success, true, result.message);
      assertEquals(
        (result.data as { defaultBranch?: string } | undefined)?.defaultBranch,
        "main",
      );
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "recoverGitState - refuses a dash-leading default branch (Issue #1269)",
  async () => {
    const { clonePath, cleanup } = await buildClone();
    try {
      const result = await recoverGitState(POISONED_BRANCH, {
        cwd: clonePath,
      });
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertStringIncludes(result.error.message, "must not begin with '-'");
      }
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "recoverGitState - a clean tree on a valid branch still recovers",
  async () => {
    const { clonePath, cleanup } = await buildClone();
    try {
      const result = await recoverGitState("main", { cwd: clonePath });
      assert(result.ok, "expected recovery to succeed on a clean clone");
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "ensureDefaultBranchCurrent - refuses a dash-leading default branch (Issue #1269)",
  async () => {
    const { clonePath, cleanup } = await buildClone();
    try {
      const result = await ensureDefaultBranchCurrent(POISONED_BRANCH, {
        cwd: clonePath,
      });
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertStringIncludes(result.error.message, "must not begin with '-'");
      }
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "ensureDefaultBranchCurrent - a valid default branch is brought up to date",
  async () => {
    const { clonePath, cleanup } = await buildClone();
    try {
      const result = await ensureDefaultBranchCurrent("main", {
        cwd: clonePath,
      });
      assert(result.ok, "expected a valid branch name to be accepted");
      if (result.ok) assertStringIncludes(result.value, "main");
    } finally {
      await cleanup();
    }
  },
);
