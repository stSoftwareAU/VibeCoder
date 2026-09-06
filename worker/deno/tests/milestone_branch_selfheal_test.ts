/**
 * Tests for milestone branch self-healing (Issue #4002).
 *
 * Two failure modes are covered, both using real git repositories:
 *
 * 1. `ensureMilestoneBranchExists` — when the remote milestone ref is absent
 *    but a stale local branch of the same name exists, the stale branch (which
 *    may carry a merge commit a repository rule forbids) must never be pushed.
 *    The branch is created on origin from the default branch ref instead, and
 *    the stale local branch is left untouched (Issue #1345).
 * 2. `syncMilestoneBranchWithDefault` — when the local and remote milestone
 *    branches have diverged, the sync must not manufacture a local merge
 *    commit; it resets to the remote ref instead.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ensureMilestoneBranchExists } from "../lib/git_branch.ts";
import { syncMilestoneBranchWithDefault } from "../lib/git_pull.ts";
import {
  commitFile,
  gitOk,
  setupGitRepoFixture,
} from "./support/git_repo_fixture.ts";

/** A bare remote seeded with `main`, plus a clone acting as the work tree. */
const setupRepo = () => setupGitRepoFixture("issue-4002-");

/** Number of parents of a commit — 2 or more means a merge commit. */
async function parentCount(cwd: string, rev: string): Promise<number> {
  const out = await gitOk(["rev-list", "--parents", "-n", "1", rev], cwd);
  return out.trim().split(/\s+/).length - 1;
}

Deno.test(
  "ensureMilestoneBranchExists - never pushes a stale local milestone branch",
  async () => {
    const fx = await setupRepo();
    try {
      // Stale local milestone branch carrying a merge commit, never pushed —
      // exactly the state that made the worker push an unpushable branch.
      await gitOk(["checkout", "-b", "side"], fx.clone);
      await commitFile(fx.clone, "side.txt", "side\n", "side work");
      await gitOk(["checkout", "-b", "milestone/69-stale", "main"], fx.clone);
      await gitOk(["merge", "--no-ff", "--no-edit", "side"], fx.clone);
      const staleSha = (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim();
      assertEquals(
        await parentCount(fx.clone, staleSha),
        2,
        "precondition: the stale local branch tip is a merge commit",
      );
      await gitOk(["checkout", "main"], fx.clone);

      const result = await ensureMilestoneBranchExists(
        "milestone/69-stale",
        "main",
        { cwd: fx.clone },
      );

      assert(
        result.ok,
        `expected ok, got: ${!result.ok && result.error.message}`,
      );

      const mainSha = (await gitOk(["rev-parse", "main"], fx.remote)).trim();
      const remoteSha =
        (await gitOk(["rev-parse", "milestone/69-stale"], fx.remote)).trim();
      const localSha =
        (await gitOk(["rev-parse", "milestone/69-stale"], fx.clone)).trim();

      assertEquals(remoteSha, mainSha, "remote milestone must sit at main tip");
      const merges = (await gitOk(
        ["rev-list", "--merges", "milestone/69-stale"],
        fx.remote,
      )).trim();
      assertEquals(merges, "", "the stale merge commit must never be pushed");
      // Issue #1345 narrowed the self-heal: the branch is created on origin by
      // pushing the default ref, so the stale LOCAL branch is left as it was
      // rather than reset. What #4002 protects — the stale tip never becoming
      // the milestone branch on the remote — is asserted above.
      assertEquals(localSha, staleSha, "the local branch is left untouched");
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "ensureMilestoneBranchExists - a checked-out stale branch does not reach the remote",
  async () => {
    const fx = await setupRepo();
    try {
      await gitOk(["checkout", "-b", "milestone/70-current", "main"], fx.clone);
      const localSha = await commitFile(
        fx.clone,
        "local.txt",
        "local\n",
        "local-only work",
      );

      const result = await ensureMilestoneBranchExists(
        "milestone/70-current",
        "main",
        { cwd: fx.clone },
      );

      assert(
        result.ok,
        `expected ok, got: ${!result.ok && result.error.message}`,
      );

      const mainSha = (await gitOk(["rev-parse", "main"], fx.remote)).trim();
      const remoteSha =
        (await gitOk(["rev-parse", "milestone/70-current"], fx.remote)).trim();
      assertEquals(remoteSha, mainSha, "local-only commits must not be pushed");

      // Issue #1345: creating the branch on origin needs no checkout, so the
      // checked-out local branch keeps its local-only commit — the remote is
      // what had to be protected from it.
      assertEquals(
        (await gitOk(["rev-parse", "milestone/70-current"], fx.clone)).trim(),
        localSha,
        "the checked-out local branch is left untouched",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - diverged milestone branch is reset, not merged",
  async () => {
    const fx = await setupRepo();
    try {
      // Publish the milestone branch, then diverge: the worker clone gains a
      // local-only commit while the remote gains a different one.
      await gitOk(
        ["checkout", "-b", "milestone/71-diverged", "main"],
        fx.clone,
      );
      await gitOk(["push", "-u", "origin", "milestone/71-diverged"], fx.clone);

      const worker = `${fx.root}/worker`;
      await gitOk(["clone", fx.remote, worker], fx.root);
      await gitOk(["config", "user.email", "t@example.com"], worker);
      await gitOk(["config", "user.name", "Test"], worker);
      await gitOk(["checkout", "milestone/71-diverged"], worker);
      await commitFile(worker, "local.txt", "local\n", "local-only work");

      const remoteTip = await commitFile(
        fx.clone,
        "remote.txt",
        "remote\n",
        "remote work",
      );
      await gitOk(["push", "origin", "milestone/71-diverged"], fx.clone);

      const result = await syncMilestoneBranchWithDefault(
        "milestone/71-diverged",
        "main",
        { cwd: worker },
      );

      assert(
        result.ok,
        `expected ok, got: ${!result.ok && result.error.message}`,
      );
      assertStringIncludes(result.value, "SELF-HEALING");

      const headSha = (await gitOk(["rev-parse", "HEAD"], worker)).trim();
      assertEquals(headSha, remoteTip, "HEAD must match the remote tip");

      const merges = (await gitOk(
        ["rev-list", "--merges", "HEAD"],
        worker,
      )).trim();
      assertEquals(merges, "", "no merge commit may be created locally");
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - fast-forwards when the remote is simply ahead",
  async () => {
    const fx = await setupRepo();
    try {
      await gitOk(["checkout", "-b", "milestone/72-behind", "main"], fx.clone);
      await gitOk(["push", "-u", "origin", "milestone/72-behind"], fx.clone);

      const worker = `${fx.root}/worker`;
      await gitOk(["clone", fx.remote, worker], fx.root);
      await gitOk(["config", "user.email", "t@example.com"], worker);
      await gitOk(["config", "user.name", "Test"], worker);
      await gitOk(["checkout", "milestone/72-behind"], worker);

      const remoteTip = await commitFile(
        fx.clone,
        "remote.txt",
        "remote\n",
        "remote work",
      );
      await gitOk(["push", "origin", "milestone/72-behind"], fx.clone);

      const result = await syncMilestoneBranchWithDefault(
        "milestone/72-behind",
        "main",
        { cwd: worker },
      );

      assert(
        result.ok,
        `expected ok, got: ${!result.ok && result.error.message}`,
      );
      // A plain fast-forward is not a self-heal — nothing was discarded.
      assertEquals(result.value.includes("SELF-HEALING"), false);

      const headSha = (await gitOk(["rev-parse", "HEAD"], worker)).trim();
      assertEquals(headSha, remoteTip);
    } finally {
      await fx.cleanup();
    }
  },
);
