/**
 * Tests for ensureMilestoneBranchExists and the `ensure-milestone-branch`
 * git-operations command (Issue #3910).
 *
 * A milestone-assigned issue must be based on its milestone branch. These
 * tests use real git repositories to prove two things: a missing milestone
 * branch is created on origin from the default branch, and every failure comes back
 * as a failure carrying the underlying git stderr — never as a quiet success
 * that would let the caller fall back to the default branch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ensureMilestoneBranchExists } from "../lib/git_branch.ts";
import { gitOperationsCommand } from "../commands/git_operations.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { gitOk, setupGitRepoFixture } from "./support/git_repo_fixture.ts";

const config = buildDefaultWorkerConfig();

/** A bare remote seeded with `main`, plus a clone acting as the work tree. */
const setupRepo = () => setupGitRepoFixture("issue-3910-");

Deno.test(
  "ensureMilestoneBranchExists - recreates a missing milestone branch from the default branch",
  async () => {
    const fx = await setupRepo();
    try {
      const result = await ensureMilestoneBranchExists(
        "milestone/3906-example",
        "main",
        { cwd: fx.clone },
      );

      assert(
        result.ok,
        `expected ok, got: ${!result.ok && result.error.message}`,
      );

      // The branch now exists on the remote, at the default branch's tip.
      const remoteSha =
        (await gitOk(["rev-parse", "milestone/3906-example"], fx.remote))
          .trim();
      const mainSha = (await gitOk(["rev-parse", "main"], fx.remote)).trim();
      assertEquals(remoteSha, mainSha);
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "ensureMilestoneBranchExists - already-present remote branch is reported as existing",
  async () => {
    const fx = await setupRepo();
    try {
      await gitOk(["checkout", "-b", "milestone/existing"], fx.clone);
      await gitOk(["push", "-u", "origin", "milestone/existing"], fx.clone);
      await gitOk(["checkout", "main"], fx.clone);

      const result = await ensureMilestoneBranchExists(
        "milestone/existing",
        "main",
        { cwd: fx.clone },
      );

      assert(
        result.ok,
        `expected ok, got: ${!result.ok && result.error.message}`,
      );
      assertStringIncludes(result.value, "already exists on remote");
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "ensureMilestoneBranchExists - creation failure reports the underlying git error",
  async () => {
    const fx = await setupRepo();
    try {
      // The default branch does not exist, so neither source ref can be
      // pushed to the milestone ref name.
      const result = await ensureMilestoneBranchExists(
        "milestone/unbuildable",
        "no-such-default",
        { cwd: fx.clone },
      );

      assertEquals(result.ok, false);
      if (result.ok) return;
      const message = result.error.message;
      assertStringIncludes(message, "milestone/unbuildable");
      assertStringIncludes(message, "no-such-default");
      // The git command and its stderr are propagated, not collapsed. The
      // branch is created by pushing the default ref straight to the
      // milestone ref name (Issue #1345), so the failing command is the push.
      assertStringIncludes(message, "git push");
      assertStringIncludes(message, "exited");
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "ensureMilestoneBranchExists - push failure reports the underlying git error",
  async () => {
    const fx = await setupRepo();
    const missingRemote = `${fx.root}/gone.git`;
    try {
      // Point origin at a path that is not a repository so the push fails
      // the way branch protection or an auth failure would.
      await gitOk(["remote", "set-url", "origin", missingRemote], fx.clone);

      const result = await ensureMilestoneBranchExists(
        "milestone/unpushable",
        "main",
        { cwd: fx.clone },
      );

      assertEquals(result.ok, false);
      if (result.ok) return;
      const message = result.error.message;
      assertStringIncludes(message, "Failed to push milestone branch");
      assertStringIncludes(message, "milestone/unpushable");
      assertStringIncludes(message, missingRemote);
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "git operations command - ensure-milestone-branch fails loud instead of falling back",
  async () => {
    const fx = await setupRepo();
    try {
      const result = await gitOperationsCommand.execute(
        {
          operation: "ensure-milestone-branch",
          "milestone-branch": "milestone/unbuildable",
          "default-branch": "no-such-default",
          cwd: fx.clone,
        },
        config,
      );

      assertEquals(result.success, false);
      assertStringIncludes(result.message, "milestone/unbuildable");
      assertStringIncludes(result.message, "git push");
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "git operations command - ensure-milestone-branch recreates a missing branch",
  async () => {
    const fx = await setupRepo();
    try {
      const result = await gitOperationsCommand.execute(
        {
          operation: "ensure-milestone-branch",
          "milestone-branch": "milestone/recreated",
          "default-branch": "main",
          cwd: fx.clone,
        },
        config,
      );

      assertEquals(result.success, true);
      const remoteSha =
        (await gitOk(["rev-parse", "milestone/recreated"], fx.remote)).trim();
      const mainSha = (await gitOk(["rev-parse", "main"], fx.remote)).trim();
      assertEquals(remoteSha, mainSha);
    } finally {
      await fx.cleanup();
    }
  },
);
