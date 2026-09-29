/**
 * A broken remote-tracking ref no longer blocks the behind-count (Issue #2824).
 *
 * `git rev-list --count` refuses to read a remote-tracking ref whose loose
 * file content will not parse: `warning: ignoring broken ref ...` followed by
 * exit 128. `countCommitsAheadRepairingBrokenRef` deletes and re-fetches
 * exactly the ref the warning names — but only when that ref is one this
 * count itself asked git to read — and retries the count once.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Result } from "../types.ts";
import {
  countCommitsAhead,
  countCommitsAheadRepairingBrokenRef,
} from "../lib/git_issue_branches.ts";
import type { GitCommandOutput } from "../lib/git_timeout.ts";

async function git(args: string[], cwd: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(out.stdout).trim();
}

const MILESTONE_BRANCH = "milestone/2824-repair";

/**
 * `main` and the milestone branch share a seed; `main` then gains a commit
 * the milestone branch does not carry, so `origin/main..origin/<milestone>`
 * counts to a known value once `origin/main` is readable again.
 */
async function fixture(): Promise<{ root: string; clone: string }> {
  const root = await Deno.makeTempDir({ prefix: "issue-2824-repair-" });
  const remote = `${root}/remote.git`;
  const clone = `${root}/clone`;

  await git(["init", "--bare", "-b", "main", remote], root);
  await git(["clone", remote, clone], root);
  await git(["config", "user.email", "t@example.com"], clone);
  await git(["config", "user.name", "Test"], clone);
  await git(["config", "commit.gpgsign", "false"], clone);

  await Deno.writeTextFile(`${clone}/README.md`, "seed\n");
  await git(["add", "."], clone);
  await git(["commit", "-m", "seed"], clone);
  await git(["push", "-u", "origin", "main"], clone);

  await git(["checkout", "-b", MILESTONE_BRANCH], clone);
  await Deno.writeTextFile(`${clone}/milestone.txt`, "milestone work\n");
  await git(["add", "milestone.txt"], clone);
  await git(["commit", "-m", "milestone work"], clone);
  await git(["push", "-u", "origin", MILESTONE_BRANCH], clone);

  await git(["checkout", "main"], clone);
  await Deno.writeTextFile(`${clone}/default.txt`, "moved on\n");
  await git(["add", "default.txt"], clone);
  await git(["commit", "-m", "default branch moves on"], clone);
  await git(["push", "origin", "main"], clone);

  // The milestone branch needs its own remote-tracking ref, exactly as
  // `measureMilestoneBehindCount` creates it via `buildFetchTrackingRefArgs`.
  await git(
    [
      "fetch",
      "origin",
      `+refs/heads/${MILESTONE_BRANCH}:refs/remotes/origin/${MILESTONE_BRANCH}`,
    ],
    clone,
  );

  return { root, clone };
}

/** Corrupt `refs/remotes/origin/main` in-place with unparsable loose content. */
async function corruptOriginMainRef(clone: string): Promise<void> {
  const refPath = `${clone}/.git/refs/remotes/origin/main`;
  await Deno.writeTextFile(
    refPath,
    "0000000000000000000000000000000000000zz\n",
  );
}

Deno.test(
  "#2824 - a broken origin/main ref blocks a plain count with the git warning",
  async () => {
    const { root, clone } = await fixture();
    try {
      await corruptOriginMainRef(clone);
      const result = await countCommitsAhead(
        `origin/${MILESTONE_BRANCH}`,
        "origin/main",
        { cwd: clone },
      );
      assert(!result.ok, "the plain count should fail on the broken ref");
      assertStringIncludes(
        result.ok ? "" : result.error.message,
        "ignoring broken ref",
      );
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "#2824 - countCommitsAheadRepairingBrokenRef repairs the ref and returns the right count",
  async () => {
    const { root, clone } = await fixture();
    try {
      await corruptOriginMainRef(clone);

      const logged: string[] = [];
      const result = await countCommitsAheadRepairingBrokenRef(
        `origin/${MILESTONE_BRANCH}`,
        "origin/main",
        { cwd: clone },
        { log: (message) => logged.push(message) },
      );

      assert(result.ok, result.ok ? "" : result.error.message);
      assertEquals(result.value, 1);

      const loggedRefLines = logged.filter((line) =>
        line.includes("refs/remotes/origin/main")
      );
      assertEquals(loggedRefLines.length, 1);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "#2824 - a linked worktree repairs the ref in the common dir, not the worktree",
  async () => {
    const { root, clone } = await fixture();
    const worktree = `${root}/wt1`;
    try {
      await git(
        ["worktree", "add", "-b", "wt1-branch", worktree, "main"],
        clone,
      );

      // The remote-tracking ref lives in the common dir (the clone's own
      // `.git`), not under the worktree — corrupt it there.
      await corruptOriginMainRef(clone);

      const logged: string[] = [];
      const result = await countCommitsAheadRepairingBrokenRef(
        `origin/${MILESTONE_BRANCH}`,
        "origin/main",
        { cwd: worktree },
        { log: (message) => logged.push(message) },
      );

      assert(result.ok, result.ok ? "" : result.error.message);
      assertEquals(result.value, 1);

      const loggedRefLines = logged.filter((line) =>
        line.includes("refs/remotes/origin/main")
      );
      assertEquals(loggedRefLines.length, 1);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);

// ---------------------------------------------------------------------------
// Injected-fake tests: the repair logic itself, independent of real git.
// ---------------------------------------------------------------------------

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(message: string): Result<T> {
  return { ok: false, error: new Error(message) };
}

function fakeGitOutput(
  code: number,
  stdout = "",
  stderr = "",
): Result<GitCommandOutput> {
  return ok({ code, stdout, stderr });
}

Deno.test(
  "#2824 - a successful count makes no git calls and logs nothing",
  async () => {
    let countCalls = 0;
    let gitCalls = 0;
    const logged: string[] = [];
    const countFn = async (): Promise<Result<number>> => {
      countCalls++;
      return ok(3);
    };
    const gitFn = async (): Promise<Result<GitCommandOutput>> => {
      gitCalls++;
      return fakeGitOutput(0);
    };

    const result = await countCommitsAheadRepairingBrokenRef(
      "origin/milestone-x",
      "origin/main",
      {},
      { log: (m) => logged.push(m), countFn, gitFn },
    );

    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(result.value, 3);
    assertEquals(countCalls, 1);
    assertEquals(gitCalls, 0);
    assertEquals(logged, []);
  },
);

Deno.test(
  "#2824 - a failure without the broken-ref warning is returned unchanged with no git calls",
  async () => {
    let gitCalls = 0;
    const countFn = async (): Promise<Result<number>> =>
      fail("git rev-list --count exited 1: fatal: bad revision 'origin/main'");
    const gitFn = async (): Promise<Result<GitCommandOutput>> => {
      gitCalls++;
      return fakeGitOutput(0);
    };
    const logged: string[] = [];

    const result = await countCommitsAheadRepairingBrokenRef(
      "origin/milestone-x",
      "origin/main",
      {},
      { log: (m) => logged.push(m), countFn, gitFn },
    );

    assert(!result.ok);
    assertStringIncludes(result.error.message, "bad revision");
    assertEquals(gitCalls, 0);
    assertEquals(logged, []);
  },
);

Deno.test(
  "#2824 - a warning naming a ref the count did not read repairs nothing",
  async () => {
    let gitCalls = 0;
    const countFn = async (): Promise<Result<number>> =>
      fail(
        "git rev-list --count exited 128: warning: ignoring broken ref " +
          "refs/remotes/origin/other\nfatal: ambiguous argument",
      );
    const gitFn = async (): Promise<Result<GitCommandOutput>> => {
      gitCalls++;
      return fakeGitOutput(0);
    };
    const logged: string[] = [];

    const result = await countCommitsAheadRepairingBrokenRef(
      "origin/milestone-x",
      "origin/main",
      {},
      { log: (m) => logged.push(m), countFn, gitFn },
    );

    assert(!result.ok);
    assertStringIncludes(result.error.message, "ignoring broken ref");
    assertEquals(gitCalls, 0);
    assertEquals(logged, []);
  },
);

Deno.test(
  "#2824 - a retry that still fails returns the retry's failure, count called exactly twice",
  async () => {
    let countCalls = 0;
    const countFn = async (): Promise<Result<number>> => {
      countCalls++;
      if (countCalls === 1) {
        return fail(
          "git rev-list --count exited 128: warning: ignoring broken ref " +
            "refs/remotes/origin/main\nfatal: ambiguous argument",
        );
      }
      return fail("git rev-list --count exited 128: still broken");
    };
    const gitFn = async (
      args: string[],
    ): Promise<Result<GitCommandOutput>> => {
      // rev-parse and fetch both succeed; only the retried count fails.
      if (args[0] === "rev-parse") {
        return fakeGitOutput(0, ".git/refs/remotes/origin/main\n");
      }
      return fakeGitOutput(0);
    };
    const removed: string[] = [];
    const removeFileFn = async (path: string) => {
      removed.push(path);
    };
    const logged: string[] = [];

    const result = await countCommitsAheadRepairingBrokenRef(
      "origin/milestone-x",
      "origin/main",
      {},
      { log: (m) => logged.push(m), countFn, gitFn, removeFileFn },
    );

    assert(!result.ok);
    assertStringIncludes(result.error.message, "still broken");
    assertEquals(countCalls, 2);
    assertEquals(logged.length, 1);
    assertEquals(removed.length, 1);
  },
);

Deno.test(
  "#2824 - a failed rev-parse --git-path returns an error naming it and does not retry",
  async () => {
    let countCalls = 0;
    const countFn = async (): Promise<Result<number>> => {
      countCalls++;
      return fail(
        "git rev-list --count exited 128: warning: ignoring broken ref " +
          "refs/remotes/origin/main\nfatal: ambiguous argument",
      );
    };
    const gitFn = async (
      args: string[],
    ): Promise<Result<GitCommandOutput>> => {
      if (args[0] === "rev-parse") {
        return fakeGitOutput(128, "", "fatal: not a git repository");
      }
      return fakeGitOutput(0);
    };
    const removeFileFn = async (): Promise<void> => {
      throw new Error("removeFileFn should not be called");
    };
    const logged: string[] = [];

    const result = await countCommitsAheadRepairingBrokenRef(
      "origin/milestone-x",
      "origin/main",
      {},
      { log: (m) => logged.push(m), countFn, gitFn, removeFileFn },
    );

    assert(!result.ok);
    assertStringIncludes(result.error.message, "rev-parse --git-path");
    assertEquals(countCalls, 1);
    assertEquals(logged, []);
  },
);

Deno.test(
  "#2824 - a failed removeFileFn returns an error naming it and does not retry",
  async () => {
    let countCalls = 0;
    const countFn = async (): Promise<Result<number>> => {
      countCalls++;
      return fail(
        "git rev-list --count exited 128: warning: ignoring broken ref " +
          "refs/remotes/origin/main\nfatal: ambiguous argument",
      );
    };
    const gitFn = async (
      args: string[],
    ): Promise<Result<GitCommandOutput>> => {
      if (args[0] === "rev-parse") {
        return fakeGitOutput(0, ".git/refs/remotes/origin/main\n");
      }
      return fakeGitOutput(0);
    };
    const removeFileFn = async (): Promise<void> => {
      throw new Deno.errors.NotFound("no such file or directory");
    };
    const logged: string[] = [];

    const result = await countCommitsAheadRepairingBrokenRef(
      "origin/milestone-x",
      "origin/main",
      {},
      { log: (m) => logged.push(m), countFn, gitFn, removeFileFn },
    );

    assert(!result.ok);
    assertStringIncludes(result.error.message, "remove the broken loose");
    assertEquals(countCalls, 1);
    assertEquals(logged, []);
  },
);
