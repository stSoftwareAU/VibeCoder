/**
 * Tests for the base-branch fetch in work_on_issue_prepare (Issue #1457).
 *
 * After sync_milestone_branch_with_default pushes the synced milestone branch
 * to origin, the local tracking ref `origin/<milestone>` may be stale if the
 * sync ran in a context that did not update this clone's refs. The shell
 * orchestration in worker/issue_worker.sh must refetch the base branch when a
 * milestone is in play, so create_feature_branch_from_base starts the feature
 * branch at the correct (synced) commit.
 *
 * These tests set up a real bare remote plus two clones to reproduce that
 * drift, then exercise the fetch block from issue_worker.sh as a shell script
 * and assert on observed git state. Australian English throughout.
 */

import { assertEquals, assertMatch } from "@std/assert";

async function run(
  cmd: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = new Deno.Command(cmd[0]!, {
    args: cmd.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await p.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function gitOk(cmd: string[], cwd: string) {
  const r = await run(["git", ...cmd], cwd);
  if (r.code !== 0) {
    throw new Error(`git ${cmd.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return r;
}

async function revParse(ref: string, cwd: string): Promise<string> {
  const r = await gitOk(["rev-parse", ref], cwd);
  return r.stdout.trim();
}

/**
 * Build the shell block under test verbatim from issue_worker.sh. The block
 * is guarded purely by the presence of `_WOI_MILESTONE_BRANCH`; it fetches
 * the feature branch (if present) and then — when a milestone is active —
 * refreshes the base branch tracking ref before creating the feature branch.
 */
function fetchBlockScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
git fetch origin "$_WOI_BRANCH_NAME" 2>/dev/null || true
if [[ -n "$_WOI_MILESTONE_BRANCH" ]]; then
    git fetch origin "$_WOI_BASE_BRANCH" 2>/dev/null || true
fi
# Mirror the no-remote-branch path in issue_worker.sh: explicitly create the
# feature branch from the (hopefully now-current) base tracking ref.
if git show-ref --verify --quiet "refs/remotes/origin/$_WOI_BRANCH_NAME"; then
    :
else
    git show-ref --verify --quiet "refs/heads/$_WOI_BRANCH_NAME" && git branch -D "$_WOI_BRANCH_NAME"
    git checkout -b "$_WOI_BRANCH_NAME" "origin/$_WOI_BASE_BRANCH"
fi
`;
}

interface Fixture {
  root: string;
  remote: string;
  clone: string;
  script: string;
  cleanup: () => Promise<void>;
}

async function setupRemoteAndClone(): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "issue-1457-" });
  const remote = `${root}/remote.git`;
  const clone = `${root}/clone`;
  const other = `${root}/other`;

  await gitOk(["init", "--bare", "-b", "main", remote], root);

  // Seed the remote with an initial commit via the "other" clone.
  await gitOk(["clone", remote, other], root);
  await gitOk(["config", "user.email", "t@example.com"], other);
  await gitOk(["config", "user.name", "Test"], other);
  await Deno.writeTextFile(`${other}/README.md`, "seed\n");
  await gitOk(["add", "README.md"], other);
  await gitOk(["commit", "-m", "seed"], other);
  await gitOk(["push", "origin", "main"], other);

  // Create a milestone branch on the remote.
  await gitOk(["checkout", "-b", "milestone/v1"], other);
  await Deno.writeTextFile(`${other}/milestone.txt`, "milestone initial\n");
  await gitOk(["add", "milestone.txt"], other);
  await gitOk(["commit", "-m", "milestone initial"], other);
  await gitOk(["push", "origin", "milestone/v1"], other);

  // Prepare the clone (this is the worker's working tree).
  await gitOk(["clone", remote, clone], root);
  await gitOk(["config", "user.email", "t@example.com"], clone);
  await gitOk(["config", "user.name", "Test"], clone);
  await gitOk(["fetch", "origin", "milestone/v1"], clone);

  // Simulate the milestone sync push happening out-of-band: a second process
  // advances origin/milestone/v1 without the worker's clone observing it.
  await gitOk(["checkout", "milestone/v1"], other);
  await Deno.writeTextFile(`${other}/synced.txt`, "synced commit\n");
  await gitOk(["add", "synced.txt"], other);
  await gitOk([
    "commit",
    "-m",
    "synced commit from sync_milestone_branch_with_default",
  ], other);
  await gitOk(["push", "origin", "milestone/v1"], other);

  const script = `${root}/fetch_block.sh`;
  await Deno.writeTextFile(script, fetchBlockScript());
  await Deno.chmod(script, 0o755);

  return {
    root,
    remote,
    clone,
    script,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

async function runFetchBlock(
  fx: Fixture,
  env: { milestoneBranch: string; baseBranch: string; featureBranch: string },
): Promise<{ code: number; stderr: string; stdout: string }> {
  const p = new Deno.Command("bash", {
    args: [fx.script],
    cwd: fx.clone,
    env: {
      _WOI_BRANCH_NAME: env.featureBranch,
      _WOI_BASE_BRANCH: env.baseBranch,
      _WOI_MILESTONE_BRANCH: env.milestoneBranch,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const out = await p.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

Deno.test(
  "Issue #1457 - feature branch starts at synced milestone commit after base fetch",
  async () => {
    const fx = await setupRemoteAndClone();
    try {
      const remoteHead = await revParse("refs/heads/milestone/v1", fx.remote);

      // Pre-condition: the worker clone's tracking ref is stale.
      const preTracking = await revParse(
        "refs/remotes/origin/milestone/v1",
        fx.clone,
      );
      assertMatch(preTracking, /^[0-9a-f]{40}$/);
      if (preTracking === remoteHead) {
        throw new Error(
          "Test setup failed: origin/milestone/v1 was already up to date before fetch block",
        );
      }

      const res = await runFetchBlock(fx, {
        milestoneBranch: "milestone/v1",
        baseBranch: "milestone/v1",
        featureBranch: "issue-1457-demo",
      });
      assertEquals(res.code, 0, `fetch block failed: ${res.stderr}`);

      // The base-branch tracking ref must now match the remote HEAD.
      const postTracking = await revParse(
        "refs/remotes/origin/milestone/v1",
        fx.clone,
      );
      assertEquals(
        postTracking,
        remoteHead,
        "origin/milestone/v1 was not refreshed",
      );

      // The feature branch must have been created from the synced commit.
      const featureHead = await revParse(
        "refs/heads/issue-1457-demo",
        fx.clone,
      );
      assertEquals(
        featureHead,
        remoteHead,
        "feature branch did not start at the synced milestone commit",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "Issue #1457 - non-milestone issues skip the extra base fetch",
  async () => {
    const fx = await setupRemoteAndClone();
    try {
      // Advance origin/main out of band so we can detect whether the block
      // refetched it. With _WOI_MILESTONE_BRANCH empty, the guard must skip
      // the extra fetch and origin/main stays at the pre-fetch commit.
      const otherClone = `${fx.root}/other2`;
      await gitOk(["clone", fx.remote, otherClone], fx.root);
      await gitOk(["config", "user.email", "t@example.com"], otherClone);
      await gitOk(["config", "user.name", "Test"], otherClone);
      await Deno.writeTextFile(`${otherClone}/main-extra.txt`, "extra\n");
      await gitOk(["add", "main-extra.txt"], otherClone);
      await gitOk(["commit", "-m", "extra main"], otherClone);
      await gitOk(["push", "origin", "main"], otherClone);

      const mainHeadBefore = await revParse(
        "refs/remotes/origin/main",
        fx.clone,
      );
      const remoteMainHead = await revParse("refs/heads/main", fx.remote);
      if (mainHeadBefore === remoteMainHead) {
        throw new Error(
          "Test setup failed: origin/main already synced before the block ran",
        );
      }

      const res = await runFetchBlock(fx, {
        milestoneBranch: "", // no milestone — skip extra fetch
        baseBranch: "main",
        featureBranch: "issue-1457-no-milestone",
      });
      assertEquals(res.code, 0, `fetch block failed: ${res.stderr}`);

      // Base-branch tracking ref must NOT have been refreshed.
      const mainHeadAfter = await revParse(
        "refs/remotes/origin/main",
        fx.clone,
      );
      assertEquals(
        mainHeadAfter,
        mainHeadBefore,
        "origin/main was unexpectedly fetched for a non-milestone issue",
      );
    } finally {
      await fx.cleanup();
    }
  },
);
