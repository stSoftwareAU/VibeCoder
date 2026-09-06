/**
 * Tests for milestone branch creation when a stale local checkout holds the
 * branch name (Issue #1345).
 *
 * NEAT-AI-Ockham#133 failed three times in a day with the identical
 * "Milestone branch unavailable" escalation: the milestone branch existed only
 * as a stale local checkout in the host's clone and was never pushed, so
 * `git fetch` found no remote ref and `git checkout -B` was refused because
 * another worktree held the branch name. Creating the branch on origin by
 * pushing the default branch ref straight to the milestone ref name needs no
 * local checkout, so no local state can block it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ensureMilestoneBranchExists } from "../lib/git_branch.ts";
import { findWorktreeHoldingBranch } from "../lib/milestone_local_branch.ts";

async function git(
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

async function gitOk(args: string[], cwd: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return r.stdout;
}

interface Fixture {
  root: string;
  remote: string;
  clone: string;
  cleanup: () => Promise<void>;
}

/** A bare remote seeded with `main`, plus a clone acting as the work tree. */
async function setupRepo(): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "issue-1345-" });
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

/**
 * Put the milestone branch in the exact state NEAT-AI-Ockham#133 was in: a
 * local-only branch, never pushed, checked out in a second worktree so
 * `git checkout -B` in the primary clone is refused.
 */
async function blockBranchWithStaleWorktree(
  fx: Fixture,
  branch: string,
): Promise<{ worktree: string; sha: string }> {
  const worktree = `${fx.root}/stale-worktree`;
  await gitOk(["branch", branch, "main"], fx.clone);
  await gitOk(["worktree", "add", worktree, branch], fx.clone);
  await gitOk(["config", "user.email", "t@example.com"], worktree);
  await gitOk(["config", "user.name", "Test"], worktree);
  await Deno.writeTextFile(`${worktree}/stale.txt`, "stale\n");
  await gitOk(["add", "stale.txt"], worktree);
  await gitOk(["commit", "-m", "stale local-only work"], worktree);
  const sha = (await gitOk(["rev-parse", branch], fx.clone)).trim();
  return { worktree, sha };
}

Deno.test(
  "ensureMilestoneBranchExists - creates the branch on origin when a stale worktree holds the name",
  async () => {
    const fx = await setupRepo();
    const branch = "milestone/133-blocked";
    try {
      const stale = await blockBranchWithStaleWorktree(fx, branch);

      // Precondition: the local checkout genuinely blocks `checkout -B`.
      const blocked = await git(
        ["checkout", "-B", branch, "main"],
        fx.clone,
      );
      assertEquals(
        blocked.code === 0,
        false,
        "precondition: checkout -B must be refused by the stale worktree",
      );

      const result = await ensureMilestoneBranchExists(branch, "main", {
        cwd: fx.clone,
      });

      assert(
        result.ok,
        `expected ok, got: ${!result.ok && result.error.message}`,
      );

      // The branch now exists on origin at the default branch's tip, so the
      // run can base its PR on it instead of escalating.
      const mainSha = (await gitOk(["rev-parse", "main"], fx.remote)).trim();
      const remoteSha = (await gitOk(["rev-parse", branch], fx.remote)).trim();
      assertEquals(remoteSha, mainSha, "remote milestone must sit at main tip");
      assertEquals(
        remoteSha === stale.sha,
        false,
        "the stale local commit must never reach the remote",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "ensureMilestoneBranchExists - leaves the blocking checkout untouched and logs it",
  async () => {
    const fx = await setupRepo();
    const branch = "milestone/133-untouched";
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const stale = await blockBranchWithStaleWorktree(fx, branch);

      const result = await ensureMilestoneBranchExists(branch, "main", {
        cwd: fx.clone,
      });
      assert(
        result.ok,
        `expected ok, got: ${!result.ok && result.error.message}`,
      );

      // Nothing local is deleted or reset — the branch still points at the
      // stale commit and its worktree still exists.
      const localSha = (await gitOk(["rev-parse", branch], fx.clone)).trim();
      assertEquals(localSha, stale.sha, "local branch must be left untouched");
      assertEquals((await Deno.stat(stale.worktree)).isDirectory, true);

      // Exactly one line names the blocking checkout.
      const naming = warnings.filter((w) => w.includes(stale.worktree));
      assertEquals(
        naming.length,
        1,
        `expected one line naming the blocking checkout, got: ${
          JSON.stringify(warnings)
        }`,
      );
      assertStringIncludes(naming[0]!, branch);
      assertStringIncludes(naming[0]!, "left untouched");
    } finally {
      console.warn = originalWarn;
      await fx.cleanup();
    }
  },
);

Deno.test(
  "ensureMilestoneBranchExists - no local branch means no blocking-checkout line",
  async () => {
    const fx = await setupRepo();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const result = await ensureMilestoneBranchExists(
        "milestone/133-fresh",
        "main",
        { cwd: fx.clone },
      );
      assert(
        result.ok,
        `expected ok, got: ${!result.ok && result.error.message}`,
      );
      assertEquals(
        warnings.filter((w) => w.includes("milestone/133-fresh")),
        [],
        "a branch with no local ref must not report a blocking checkout",
      );
    } finally {
      console.warn = originalWarn;
      await fx.cleanup();
    }
  },
);

Deno.test(
  "ensureMilestoneBranchExists - push failure names the branch that could not be created",
  async () => {
    const fx = await setupRepo();
    const missingRemote = `${fx.root}/gone.git`;
    try {
      await gitOk(["remote", "set-url", "origin", missingRemote], fx.clone);

      const result = await ensureMilestoneBranchExists(
        "milestone/133-unpushable",
        "main",
        { cwd: fx.clone },
      );

      assertEquals(result.ok, false);
      if (result.ok) return;
      assertStringIncludes(result.error.message, "milestone/133-unpushable");
      assertStringIncludes(result.error.message, "git push");
      assertStringIncludes(result.error.message, missingRemote);
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test("findWorktreeHoldingBranch - matches the branch's own worktree", () => {
  const output = [
    "worktree /work/repo",
    "HEAD 1111111111111111111111111111111111111111",
    "branch refs/heads/main",
    "",
    "worktree /work/repo-lane-2",
    "HEAD 2222222222222222222222222222222222222222",
    "branch refs/heads/milestone/69-example",
    "",
  ].join("\n");

  assertEquals(
    findWorktreeHoldingBranch(output, "milestone/69-example"),
    "/work/repo-lane-2",
  );
  assertEquals(findWorktreeHoldingBranch(output, "main"), "/work/repo");
  assertEquals(findWorktreeHoldingBranch(output, "milestone/other"), null);
  assertEquals(findWorktreeHoldingBranch("", "main"), null);
});
