/**
 * Regression tests for the default-branch cache (Issues #1269, #1652).
 *
 * `setupRepo()` used to read the default branch out of `.vibe_default_branch`
 * at the root of the working tree, so a repository that committed the file
 * controlled the value. It survived `git reset --hard HEAD` and `git clean
 * -fd`, and the read happened before both, so an unvalidated value reached
 * `git checkout <value>` as a bare positional — an option slot
 * (`--pathspec-from-file=…`, `--orphan`, `-f`) on the worker's clone
 * (Issue #1269). The cache now lives in the clone's git directory,
 * `.git/vibe/default_branch` (Issue #1652), where the repository cannot commit
 * it and `git add -A` cannot stage it; the ref-component validation stays as
 * defence in depth.
 *
 * The tests below call the real functions with the attack input and assert the
 * refusal; they fail against the unvalidated code. The #1652 tests assert the
 * in-tree file is neither read nor written any more.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  defaultBranchCachePath,
  setupRepo,
} from "../commands/git_operations.ts";
import { recoverGitState } from "../lib/git_state_recovery.ts";
import { ensureDefaultBranchCurrent } from "../lib/git_push.ts";

/** The attack value the finding names. */
const POISONED_BRANCH = "--pathspec-from-file=/etc/passwd";

async function runGit(args: string[], cwd: string): Promise<number> {
  return (await gitOutput(args, cwd)).code;
}

async function gitOutput(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string }> {
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
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
}

/** Seed the git-directory cache (Issue #1652) with `value`. */
async function seedCache(clonePath: string, value: string): Promise<string> {
  const path = await defaultBranchCachePath(clonePath);
  assert(path !== null, "the clone's git directory must resolve");
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, value);
  return path;
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
  "setupRepo - ignores a poisoned default-branch cache instead of checking it out",
  async () => {
    const { tmp, clonePath, cleanup } = await buildClone();
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      // The cache is read before reset --hard and clean -fd run; whatever is
      // in it must still be validated before it can reach git.
      const cachePath = await seedCache(clonePath, `${POISONED_BRANCH}\n`);

      const result = await setupRepo("owner/downstream", tmp);

      // The poisoned value must never become the default branch: the
      // git-derived value stands and the refusal is logged loudly, naming
      // the file it ignored.
      assertEquals(
        (result.data as { defaultBranch?: string } | undefined)?.defaultBranch,
        "main",
      );
      const warning = errors.find((e) => e.includes(cachePath));
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
      await seedCache(clonePath, "main\n");
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
  "setupRepo - keeps the cache in the git directory and never in the working tree (Issue #1652)",
  async () => {
    const { tmp, clonePath, cleanup } = await buildClone();
    try {
      const result = await setupRepo("owner/downstream", tmp);
      assertEquals(result.success, true, result.message);

      // Written where git cannot stage or commit it …
      const cachePath = await defaultBranchCachePath(clonePath);
      assert(cachePath !== null);
      assertStringIncludes(cachePath, "/.git/vibe/default_branch");
      assertEquals((await Deno.readTextFile(cachePath)).trim(), "main");

      // … and nowhere in the tree: nothing for `git add -A` to pick up.
      let inTree = true;
      try {
        await Deno.stat(`${clonePath}/.vibe_default_branch`);
      } catch {
        inTree = false;
      }
      assertEquals(inTree, false, ".vibe_default_branch must not be written");
      const status = await gitOutput(["status", "--porcelain"], clonePath);
      assertEquals(status.stdout.trim(), "", "the tree is clean after setup");
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "setupRepo - an in-tree .vibe_default_branch is neither read nor left behind (Issue #1652)",
  async () => {
    const { tmp, clonePath, cleanup } = await buildClone();
    try {
      // A repository that COMMITS the file names a branch that exists, so a
      // worker still reading the tree would adopt it. The upstream gets the
      // branch and the committed file; the clone fetches both.
      const upstream = `${tmp}/upstream`;
      assertEquals(await runGit(["branch", "other"], upstream), 0);
      await Deno.writeTextFile(`${upstream}/.vibe_default_branch`, "other\n");
      assertEquals(await runGit(["add", ".vibe_default_branch"], upstream), 0);
      assertEquals(
        await runGit(["commit", "-m", "commit the old cache"], upstream),
        0,
      );
      assertEquals(await runGit(["fetch", "origin"], clonePath), 0);
      assertEquals(
        await runGit(["reset", "--hard", "origin/main"], clonePath),
        0,
      );
      // And an untracked copy on top, the shape an older worker left behind.
      await Deno.writeTextFile(`${clonePath}/.vibe_default_branch`, "other\n");

      const result = await setupRepo("owner/downstream", tmp);
      assertEquals(result.success, true, result.message);
      assertEquals(
        (result.data as { defaultBranch?: string } | undefined)?.defaultBranch,
        "main",
        "the in-tree value must not be used",
      );
      const head = await gitOutput(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        clonePath,
      );
      assertEquals(head.stdout.trim(), "main");

      // The untracked copy is gone with the working-tree clean, the committed
      // copy is tracked content the worker leaves to its own follow-up, and
      // either way `git status --porcelain` lists no such path.
      const status = await gitOutput(["status", "--porcelain"], clonePath);
      assertEquals(
        status.stdout.split("\n").some((l) =>
          l.includes(".vibe_default_branch")
        ),
        false,
        `status listed the old cache: ${status.stdout}`,
      );
      const cachePath = await defaultBranchCachePath(clonePath);
      assert(cachePath !== null);
      assertEquals((await Deno.readTextFile(cachePath)).trim(), "main");
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
