/**
 * The child branch is cut from the milestone tip the pre-cut sync produced
 * (Issue #1780).
 *
 * Real git throughout — a bare remote, a clone, a milestone branch and a
 * default branch that has moved on. The assertion is the one that matters at
 * runtime: the SHA the issue branch starts at is the milestone tip *after* the
 * merge-down, and it carries the default-branch commit the branch was missing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { presyncMilestoneBranchForIssueRun } from "../lib/milestone_presync.ts";
import { createFeatureBranchFromBase } from "../lib/git_branch.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  loadSyncStreaks,
  milestoneSyncStreakPath,
} from "../lib/milestone_sync_streak.ts";
import type { Logger } from "../types.ts";

const MILESTONE_BRANCH = "milestone/1780-presync";
const REPO = "owner/repo";

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  skipReason: () => {},
  timing: () => {},
  scanSummary: () => {},
  workerSummary: () => {},
};

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

/**
 * `main` and `milestone/1780-presync` share a seed; `main` then gains a commit
 * the milestone branch does not carry — a milestone one commit behind.
 */
async function fixture(): Promise<{ root: string; clone: string }> {
  const root = await Deno.makeTempDir({ prefix: "issue-1780-presync-" });
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

  return { root, clone };
}

Deno.test(
  "#1780 - the issue branch starts at the milestone tip the pre-cut sync produced",
  async () => {
    const { root, clone } = await fixture();
    const workDir = await Deno.makeTempDir({ prefix: "issue-1780-workdir-" });
    try {
      const behindTip = await git(
        ["rev-parse", `origin/${MILESTONE_BRANCH}`],
        clone,
      );
      const defaultTip = await git(["rev-parse", "origin/main"], clone);

      const result = await presyncMilestoneBranchForIssueRun({
        repo: REPO,
        milestoneTitle: "#1780 Presync",
        milestoneBranch: MILESTONE_BRANCH,
        defaultBranch: "main",
        cwd: clone,
        workDir,
        config: { ...buildDefaultWorkerConfig(), workDir },
        logger: silentLogger,
      });

      assertEquals(result.status, "synced");
      assertEquals(result.behindBy, 1);

      // The sync pushed, so the remote-tracking tip moved off the behind tip.
      const syncedTip = await git(
        ["rev-parse", `origin/${MILESTONE_BRANCH}`],
        clone,
      );
      assert(syncedTip !== behindTip, "the milestone branch advanced");
      assertEquals(result.baseSha, syncedTip);

      // The default branch's commit is now in the milestone branch's ancestry.
      await git(
        [
          "merge-base",
          "--is-ancestor",
          defaultTip,
          `origin/${MILESTONE_BRANCH}`,
        ],
        clone,
      );

      // And the child branch is cut from exactly that commit.
      const created = await createFeatureBranchFromBase(
        "issue-1780-child",
        MILESTONE_BRANCH,
        { cwd: clone },
      );
      assert(created.ok, created.ok ? "" : created.error.message);
      assertEquals(await git(["rev-parse", "HEAD"], clone), syncedTip);

      // A landed sync leaves an unspent budget and records the tip it merged.
      const entry = (await loadSyncStreaks(milestoneSyncStreakPath(workDir)))[
        `${REPO}|${MILESTONE_BRANCH}`
      ];
      assertEquals(entry?.conflictAttempts, 0);
      assertEquals(entry?.lastSyncedDefaultSha, defaultTip);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
      await Deno.remove(workDir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "#1780 - a milestone branch already level is reported level and nothing is pushed",
  async () => {
    const { root, clone } = await fixture();
    const workDir = await Deno.makeTempDir({ prefix: "issue-1780-workdir-" });
    try {
      // Bring the branch level by hand first.
      await git(["checkout", MILESTONE_BRANCH], clone);
      await git(["merge", "--no-edit", "origin/main"], clone);
      await git(["push", "origin", MILESTONE_BRANCH], clone);
      const levelTip = await git(
        ["rev-parse", `origin/${MILESTONE_BRANCH}`],
        clone,
      );

      const result = await presyncMilestoneBranchForIssueRun({
        repo: REPO,
        milestoneTitle: "#1780 Presync",
        milestoneBranch: MILESTONE_BRANCH,
        defaultBranch: "main",
        cwd: clone,
        workDir,
        config: { ...buildDefaultWorkerConfig(), workDir },
        logger: silentLogger,
      });

      assertEquals(result.status, "level");
      assertEquals(result.behindBy, 0);
      assertEquals(
        await git(["rev-parse", `origin/${MILESTONE_BRANCH}`], clone),
        levelTip,
      );
      // A level branch touches no ledger at all.
      assertEquals(await loadSyncStreaks(milestoneSyncStreakPath(workDir)), {});
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
      await Deno.remove(workDir, { recursive: true }).catch(() => {});
    }
  },
);
