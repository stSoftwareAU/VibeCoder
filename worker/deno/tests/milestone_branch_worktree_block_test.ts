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
import {
  git,
  gitOk,
  type GitRepoFixture,
  setupGitRepoFixture,
} from "./support/git_repo_fixture.ts";
import { capturingWarningsAsync } from "./support/warnings.ts";

/**
 * Put the milestone branch in the exact state NEAT-AI-Ockham#133 was in: a
 * local-only branch, never pushed, checked out in a second worktree so
 * `git checkout -B` in the primary clone is refused.
 */
async function blockBranchWithStaleWorktree(
  fx: GitRepoFixture,
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
    const fx = await setupGitRepoFixture("issue-1345-");
    const branch = "milestone/133-blocked";
    try {
      const stale = await blockBranchWithStaleWorktree(fx, branch);

      // Precondition: the local checkout genuinely blocks `checkout -B`.
      const blocked = await git(["checkout", "-B", branch, "main"], fx.clone);
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
    const fx = await setupGitRepoFixture("issue-1345-");
    const branch = "milestone/133-untouched";
    try {
      const stale = await blockBranchWithStaleWorktree(fx, branch);

      const warnings = await capturingWarningsAsync(async () => {
        const result = await ensureMilestoneBranchExists(branch, "main", {
          cwd: fx.clone,
        });
        assert(
          result.ok,
          `expected ok, got: ${!result.ok && result.error.message}`,
        );
      });

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
      await fx.cleanup();
    }
  },
);

Deno.test(
  "ensureMilestoneBranchExists - no local branch means no blocking-checkout line",
  async () => {
    const fx = await setupGitRepoFixture("issue-1345-");
    try {
      const warnings = await capturingWarningsAsync(async () => {
        const result = await ensureMilestoneBranchExists(
          "milestone/133-fresh",
          "main",
          { cwd: fx.clone },
        );
        assert(
          result.ok,
          `expected ok, got: ${!result.ok && result.error.message}`,
        );
      });

      assertEquals(
        warnings.filter((w) => w.includes("milestone/133-fresh")),
        [],
        "a branch with no local ref must not report a blocking checkout",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "ensureMilestoneBranchExists - a failed default-branch fetch is warned about, not swallowed",
  async () => {
    const fx = await setupGitRepoFixture("issue-1345-");
    try {
      // The default branch has no remote counterpart to fetch, so the branch
      // is created from the local ref — a fallback that must not be silent.
      await gitOk(["branch", "detached-default", "main"], fx.clone);

      const warnings = await capturingWarningsAsync(async () => {
        const result = await ensureMilestoneBranchExists(
          "milestone/133-local-base",
          "detached-default",
          { cwd: fx.clone },
        );
        assert(
          result.ok,
          `expected ok, got: ${!result.ok && result.error.message}`,
        );
      });

      const fetchWarnings = warnings.filter((w) =>
        w.includes("failed to fetch origin/detached-default")
      );
      assertEquals(
        fetchWarnings.length,
        1,
        `expected the fallback to be named once, got: ${
          JSON.stringify(warnings)
        }`,
      );
      assertStringIncludes(fetchWarnings[0]!, "milestone/133-local-base");
    } finally {
      await fx.cleanup();
    }
  },
);
