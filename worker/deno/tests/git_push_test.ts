/**
 * Tests for git_push.ts — Git push operations (Issue #912).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  assertPushTargetAllowed,
  commitAndPushPending,
  detectExistingPr,
  detectPushRejection,
  findOpenPrForBranch,
  pushUnpushedCommits,
  resolveLocalDefaultBranch,
} from "../lib/git_push.ts";

// ---------------------------------------------------------------------------
// detectPushRejection
// ---------------------------------------------------------------------------

Deno.test("git push - detectPushRejection detects fetch first rejection", () => {
  const output = "error: failed to push some refs (fetch first)";
  assertEquals(detectPushRejection(output), true);
});

Deno.test("git push - detectPushRejection detects non-fast-forward rejection", () => {
  const output = "error: failed to push some refs (non-fast-forward)";
  assertEquals(detectPushRejection(output), true);
});

Deno.test("git push - detectPushRejection returns false for empty output", () => {
  assertEquals(detectPushRejection(""), false);
});

Deno.test("git push - detectPushRejection returns false for unrelated error", () => {
  assertEquals(detectPushRejection("Permission denied (publickey)."), false);
});

Deno.test("git push - detectPushRejection returns false for success message", () => {
  assertEquals(detectPushRejection("Everything up-to-date"), false);
});

// ---------------------------------------------------------------------------
// detectExistingPr
// ---------------------------------------------------------------------------

Deno.test("git push - detectExistingPr extracts URL from already exists error", () => {
  const output =
    "a]l already exists for this branch: https://github.com/org/repo/pull/42";
  assertEquals(detectExistingPr(output), "https://github.com/org/repo/pull/42");
});

Deno.test("git push - detectExistingPr returns null for empty output", () => {
  assertEquals(detectExistingPr(""), null);
});

Deno.test("git push - detectExistingPr returns null for unrelated error", () => {
  assertEquals(detectExistingPr("Permission denied"), null);
});

Deno.test("git push - detectExistingPr returns null when no URL present", () => {
  assertEquals(
    detectExistingPr("A pull request already exists but no URL"),
    null,
  );
});

Deno.test("git push - detectExistingPr handles complex error message", () => {
  const output = `
Warning: 13 uncommitted changes
a]l already exists: https://github.com/myorg/myrepo/pull/123
Please check the existing PR.
`;
  assertEquals(
    detectExistingPr(output),
    "https://github.com/myorg/myrepo/pull/123",
  );
});

// ---------------------------------------------------------------------------
// findOpenPrForBranch — WHAT-tests via the injectable ghCommandFn seam (Issue #3044)
//
// Assert the observable contract — url string when an open PR exists, null when
// none or when the branch is empty, a wrapped error on gh failure — not how gh
// is invoked.
// ---------------------------------------------------------------------------

/** A gh stub that must never be called — fails the test if it is. */
const failingGh = (): Promise<string> =>
  Promise.reject(new Error("gh should not be called"));

Deno.test(
  "findOpenPrForBranch - empty branch short-circuits to null without calling gh",
  async () => {
    const result = await findOpenPrForBranch("org/repo", "", failingGh);
    assert(result.ok);
    if (result.ok) assertEquals(result.value, null);
  },
);

Deno.test(
  "findOpenPrForBranch - returns the open PR url when one exists",
  async () => {
    const result = await findOpenPrForBranch(
      "org/repo",
      "feat-x",
      () => Promise.resolve("https://github.com/org/repo/pull/7\n"),
    );
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value, "https://github.com/org/repo/pull/7");
    }
  },
);

Deno.test(
  "findOpenPrForBranch - returns null when gh reports no open PR",
  async () => {
    const result = await findOpenPrForBranch(
      "org/repo",
      "feat-x",
      () => Promise.resolve(""),
    );
    assert(result.ok);
    if (result.ok) assertEquals(result.value, null);
  },
);

Deno.test(
  "findOpenPrForBranch - normalises whitespace-only gh output to null",
  async () => {
    const result = await findOpenPrForBranch(
      "org/repo",
      "feat-x",
      () => Promise.resolve("   \n"),
    );
    assert(result.ok);
    if (result.ok) assertEquals(result.value, null);
  },
);

Deno.test(
  "findOpenPrForBranch - wraps a gh failure in an error Result",
  async () => {
    const result = await findOpenPrForBranch(
      "org/repo",
      "feat-x",
      () => Promise.reject(new Error("boom")),
    );
    assert(!result.ok, "a gh failure must produce an error Result");
    if (!result.ok) {
      assertStringIncludes(result.error.message, "feat-x");
      assertStringIncludes(result.error.message, "boom");
    }
  },
);

// ---------------------------------------------------------------------------
// pushUnpushedCommits — integration against a fixture upstream/downstream pair
// ---------------------------------------------------------------------------

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(
  args: string[],
  cwd: string,
): Promise<GitRunResult> {
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

Deno.test(
  "pushUnpushedCommits - creates remote branch on first push (Issue #1463 regression)",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "push_unpushed_first_push_" });
    const upstream = `${tmp}/upstream.git`;
    const downstream = `${tmp}/downstream`;

    try {
      // Bare upstream so we can push into it without `receive.denyCurrentBranch`.
      assertEquals(
        (await runGit(["init", "--bare", "-b", "main", upstream], tmp)).code,
        0,
      );

      // Seed an initial commit via a throwaway working clone so `main` exists upstream.
      const seed = `${tmp}/seed`;
      assertEquals((await runGit(["clone", upstream, seed], tmp)).code, 0);
      await runGit(["config", "user.email", "t@t"], seed);
      await runGit(["config", "user.name", "t"], seed);
      await Deno.writeTextFile(`${seed}/README.md`, "seed\n");
      await runGit(["add", "."], seed);
      await runGit(["commit", "-m", "seed"], seed);
      await runGit(["push", "origin", "main"], seed);

      // Real downstream clone — this is the worker's working copy.
      assertEquals(
        (await runGit(["clone", upstream, downstream], tmp)).code,
        0,
      );
      await runGit(["config", "user.email", "t@t"], downstream);
      await runGit(["config", "user.name", "t"], downstream);

      // Create a feature branch locally only — origin/<branch> deliberately
      // does not exist. This is the state the completion phase sees after
      // setup_branch_phase + implementation, before any push has happened.
      const branchName = "issue-1463-add-dependency-review-workflow";
      assertEquals(
        (await runGit(["checkout", "-b", branchName], downstream)).code,
        0,
      );
      await Deno.writeTextFile(`${downstream}/feature.txt`, "feature work\n");
      await runGit(["add", "."], downstream);
      assertEquals(
        (await runGit(["commit", "-m", "implement feature"], downstream)).code,
        0,
      );

      // Sanity: origin/<branch> truly does not exist yet on the downstream.
      const preCheck = await runGit(
        ["rev-parse", "--verify", `refs/remotes/origin/${branchName}`],
        downstream,
      );
      assertEquals(
        preCheck.code !== 0,
        true,
        "Precondition: origin/<branch> must not exist before pushUnpushedCommits",
      );

      // Exercise the real function. Before the fix this returned ok with
      // value 0 and never pushed, leaving the remote branch missing and
      // `gh pr create` failing with "No commits between …".
      const result = await pushUnpushedCommits(branchName, { cwd: downstream });
      assert(
        result.ok,
        `pushUnpushedCommits should succeed, got: ${
          !result.ok ? result.error.message : ""
        }`,
      );
      if (result.ok) {
        assertEquals(
          result.value,
          1,
          "pushUnpushedCommits must report the one commit that was pushed",
        );
      }

      // Branch must now exist upstream.
      const refList = await runGit([
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/",
      ], upstream);
      assertEquals(refList.code, 0);
      assert(
        refList.stdout.includes(`refs/heads/${branchName}`),
        `Expected upstream to have refs/heads/${branchName}, got:\n${refList.stdout}`,
      );

      // And the remote-tracking ref locally must point to the same commit
      // as HEAD (i.e. the push really moved the feature commit upstream).
      const head = await runGit(["rev-parse", "HEAD"], downstream);
      const remote = await runGit(
        ["rev-parse", `refs/remotes/origin/${branchName}`],
        downstream,
      );
      assertEquals(head.code, 0);
      assertEquals(remote.code, 0);
      assertEquals(remote.stdout.trim(), head.stdout.trim());
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "pushUnpushedCommits - returns 0 when local branch is in sync with origin",
  async () => {
    // NOTE (Issue #2584): this test previously pushed the default branch
    // ("main") to exercise the in-sync → 0 path. The read-only default-branch
    // guard now forbids pushing to the default branch, so the test was
    // re-pointed at an in-sync *feature* branch. Its real intent — "returns 0
    // when there is nothing to push" — is preserved.
    const tmp = await Deno.makeTempDir({ prefix: "push_unpushed_in_sync_" });
    const upstream = `${tmp}/upstream.git`;
    const downstream = `${tmp}/downstream`;

    try {
      assertEquals(
        (await runGit(["init", "--bare", "-b", "main", upstream], tmp)).code,
        0,
      );

      const seed = `${tmp}/seed`;
      assertEquals((await runGit(["clone", upstream, seed], tmp)).code, 0);
      await runGit(["config", "user.email", "t@t"], seed);
      await runGit(["config", "user.name", "t"], seed);
      await Deno.writeTextFile(`${seed}/README.md`, "seed\n");
      await runGit(["add", "."], seed);
      await runGit(["commit", "-m", "seed"], seed);
      await runGit(["push", "origin", "main"], seed);

      assertEquals(
        (await runGit(["clone", upstream, downstream], tmp)).code,
        0,
      );
      await runGit(["config", "user.email", "t@t"], downstream);
      await runGit(["config", "user.name", "t"], downstream);

      // Create a feature branch and push it so origin/<branch> is in sync.
      const branchName = "issue-2584-in-sync-feature";
      await runGit(["checkout", "-b", branchName], downstream);
      await runGit(["push", "-u", "origin", branchName], downstream);

      // Local feature branch is already at origin/<branch> — nothing to push.
      const result = await pushUnpushedCommits(branchName, {
        cwd: downstream,
      });
      assert(result.ok);
      if (result.ok) assertEquals(result.value, 0);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Read-only default-branch guard (Issue #2584)
// ---------------------------------------------------------------------------

/**
 * Build a fixture upstream/downstream pair with `main` seeded and the
 * downstream's `origin/HEAD` pointing at `main` (a normal `git clone`).
 * Returns the downstream working-copy path.
 */
async function buildClonePair(tmp: string): Promise<string> {
  const upstream = `${tmp}/upstream.git`;
  const downstream = `${tmp}/downstream`;

  assertEquals(
    (await runGit(["init", "--bare", "-b", "main", upstream], tmp)).code,
    0,
  );

  const seed = `${tmp}/seed`;
  assertEquals((await runGit(["clone", upstream, seed], tmp)).code, 0);
  await runGit(["config", "user.email", "t@t"], seed);
  await runGit(["config", "user.name", "t"], seed);
  await Deno.writeTextFile(`${seed}/README.md`, "seed\n");
  await runGit(["add", "."], seed);
  await runGit(["commit", "-m", "seed"], seed);
  await runGit(["push", "origin", "main"], seed);

  assertEquals((await runGit(["clone", upstream, downstream], tmp)).code, 0);
  await runGit(["config", "user.email", "t@t"], downstream);
  await runGit(["config", "user.name", "t"], downstream);
  return downstream;
}

Deno.test(
  "resolveLocalDefaultBranch - resolves the default branch from origin/HEAD",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "resolve_default_" });
    try {
      const downstream = await buildClonePair(tmp);
      const branch = await resolveLocalDefaultBranch({ cwd: downstream });
      assertEquals(branch, "main");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "assertPushTargetAllowed - rejects a push to the default branch",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "guard_reject_" });
    try {
      const downstream = await buildClonePair(tmp);
      const guard = await assertPushTargetAllowed("main", { cwd: downstream });
      assert(!guard.ok, "guard must reject a push to the default branch");
      if (!guard.ok) {
        assertStringIncludes(guard.error.message, "default branch");
        assertStringIncludes(guard.error.message, "Issue #2584");
      }
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "assertPushTargetAllowed - allows a push to a feature branch",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "guard_allow_feature_" });
    try {
      const downstream = await buildClonePair(tmp);
      const guard = await assertPushTargetAllowed("issue-2584-feature", {
        cwd: downstream,
      });
      assert(guard.ok, "guard must allow a push to a feature branch");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "assertPushTargetAllowed - opt-out allows a push to the default branch",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "guard_optout_" });
    try {
      const downstream = await buildClonePair(tmp);
      const guard = await assertPushTargetAllowed(
        "main",
        { cwd: downstream },
        true, // allowDefaultBranch opt-out for legitimate merge machinery
      );
      assert(guard.ok, "opt-out must permit a default-branch push");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "assertPushTargetAllowed - fails open when origin/HEAD is unset",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "guard_open_" });
    const repo = `${tmp}/repo`;
    try {
      // A fresh `git init` has no origin/HEAD, so the default branch is
      // unknown — the guard must fail open and allow the push.
      await Deno.mkdir(repo);
      assertEquals((await runGit(["init", "-b", "main", repo], tmp)).code, 0);
      const guard = await assertPushTargetAllowed("main", { cwd: repo });
      assert(guard.ok, "guard must fail open when the default cannot resolve");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "pushUnpushedCommits - rejects a push to the default branch",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "push_default_reject_" });
    try {
      const downstream = await buildClonePair(tmp);
      const result = await pushUnpushedCommits("main", { cwd: downstream });
      assert(!result.ok, "must refuse to push the default branch");
      if (!result.ok) {
        assertStringIncludes(result.error.message, "default branch");
      }
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "commitAndPushPending - bump/gitignore-style change to default is staged " +
    "locally and never pushed (Issue #2584 regression)",
  async () => {
    // Regression guard: simulates a dependency-bump / gitignore-sync style
    // change landing on the default branch. The central guard must refuse to
    // push it, and the upstream default branch must stay untouched.
    const tmp = await Deno.makeTempDir({ prefix: "bump_no_push_default_" });
    const upstream = `${tmp}/upstream.git`;
    try {
      const downstream = await buildClonePair(tmp);

      // Record the upstream main SHA before the attempted push.
      const beforeSha =
        (await runGit(["rev-parse", "refs/heads/main"], upstream)).stdout
          .trim();

      // Stage a local change on main (as bump-deps / gitignore-sync would).
      await Deno.writeTextFile(`${downstream}/deno.lock`, "bumped\n");

      const result = await commitAndPushPending(
        "main",
        "chore: bump dependencies",
        { cwd: downstream },
      );
      assert(!result.ok, "commitAndPushPending must refuse the default branch");
      if (!result.ok) {
        assertStringIncludes(result.error.message, "default branch");
      }

      // Upstream main must be unchanged — nothing was pushed.
      const afterSha =
        (await runGit(["rev-parse", "refs/heads/main"], upstream)).stdout
          .trim();
      assertEquals(
        afterSha,
        beforeSha,
        "upstream default branch must be untouched after a refused push",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "commitAndPushPending - opt-out permits a push to the default branch",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "commit_push_optout_" });
    const upstream = `${tmp}/upstream.git`;
    try {
      const downstream = await buildClonePair(tmp);
      await Deno.writeTextFile(`${downstream}/merge.txt`, "merge machinery\n");

      const result = await commitAndPushPending(
        "main",
        "merge: legitimate default-branch update",
        { cwd: downstream },
        true, // allowDefaultBranch opt-out
      );
      assert(
        result.ok,
        `opt-out push should succeed, got: ${
          !result.ok ? result.error.message : ""
        }`,
      );

      // Upstream main now carries the new commit.
      const log = await runGit(
        ["log", "--oneline", "refs/heads/main"],
        upstream,
      );
      assertStringIncludes(log.stdout, "legitimate default-branch update");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "pushUnpushedCommits - refuses a dash-leading branch name loudly (Issue #148)",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "push_dash_branch_" });
    try {
      assertEquals((await runGit(["init", "-b", "main", tmp], tmp)).code, 0);
      await Deno.writeTextFile(`${tmp}/README.md`, "seed\n");
      await runGit(["add", "."], tmp);
      await runGit(["commit", "-m", "seed"], tmp);

      // A dash-leading ref is an argument-injection attempt, never a branch:
      // git would read it as an option (`--receive-pack=<cmd>`), so the push
      // must fail with a named error rather than run.
      const result = await pushUnpushedCommits(
        "--receive-pack=touch /tmp/pwned",
        { cwd: tmp },
      );
      assert(!result.ok, "a dash-leading branch must not be pushed");
      if (!result.ok) {
        assertStringIncludes(result.error.message, "must not begin with '-'");
        assertStringIncludes(result.error.message, "push branch name");
      }
      // Nothing was executed on its behalf.
      const pwned = await Deno.stat(`${tmp}/pwned`).then(() => true).catch(
        () => false,
      );
      assertEquals(pwned, false);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);
