/**
 * Integration tests for issue-number-keyed WIP discovery (Issue #220).
 *
 * These run real `git` against a bare "remote" because the behaviour under
 * test is a remote lookup: retitling an issue changes the title-derived
 * branch name, and the pushed WIP must still be found by issue number.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type GitCommandOptions,
  type GitCommandOutput,
  runGitCommand,
} from "../lib/git_timeout.ts";
import { findResumableIssueBranch } from "../lib/git_issue_branch_resume.ts";
import type { Result } from "../types.ts";
import {
  NO_HOST_GIT_CONFIG,
  NO_HOST_HOOKS_ARGS,
} from "./support/no_host_git_config.ts";

/**
 * Run a fixture git command shut off from the host's config and hooks
 * (Issue #5309).
 */
function fixtureGit(
  args: string[],
  options: GitCommandOptions = {},
): Promise<Result<GitCommandOutput>> {
  return runGitCommand([...NO_HOST_HOOKS_ARGS, ...args], {
    ...options,
    env: { ...NO_HOST_GIT_CONFIG, ...options.env },
  });
}

/** Initialise a bare "remote" plus a working clone with one commit on main. */
async function setupRepos(tmpDir: string): Promise<string> {
  const remotePath = `${tmpDir}/remote.git`;
  const localPath = `${tmpDir}/local`;

  await Deno.mkdir(remotePath, { recursive: true });
  await fixtureGit(["init", "--bare"], { cwd: remotePath });
  await fixtureGit(["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: remotePath,
  });
  await fixtureGit(["clone", remotePath, localPath], { cwd: tmpDir });
  await fixtureGit(["config", "user.email", "test@example.com"], {
    cwd: localPath,
  });
  await fixtureGit(["config", "user.name", "Test User"], { cwd: localPath });

  await Deno.writeTextFile(`${localPath}/README.md`, "# Test Repo\n");
  await fixtureGit(["add", "README.md"], { cwd: localPath });
  await fixtureGit(["commit", "-m", "Initial commit"], { cwd: localPath });
  await fixtureGit(["push", "origin", "main"], { cwd: localPath });

  return localPath;
}

/** Push a branch carrying one WIP commit, then return to main. */
async function pushWipBranch(
  cwd: string,
  branch: string,
  file: string,
  epochSec?: number,
): Promise<void> {
  await fixtureGit(["checkout", "-b", branch, "main"], { cwd });
  await Deno.writeTextFile(`${cwd}/${file}`, `work in progress on ${branch}\n`);
  await fixtureGit(["add", file], { cwd });
  const env = epochSec === undefined ? undefined : {
    GIT_AUTHOR_DATE: `${epochSec} +0000`,
    GIT_COMMITTER_DATE: `${epochSec} +0000`,
  };
  await fixtureGit(["commit", "-m", `wip: ${branch}`], {
    cwd,
    ...(env ? { env } : {}),
  });
  await fixtureGit(["push", "origin", branch], { cwd });
  await fixtureGit(["checkout", "main"], { cwd });
  // Drop the local ref so the lookup has to go to the remote, exactly as a
  // freshly reset clone would.
  await fixtureGit(["branch", "-D", branch], { cwd });
}

async function withRepo(fn: (cwd: string) => Promise<void>): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "issue_branch_resume_" });
  try {
    await fn(await setupRepos(tmpDir));
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

Deno.test("issue #220 - a retitled issue still finds its WIP branch by number", async () => {
  await withRepo(async (cwd) => {
    await pushWipBranch(cwd, "issue-220-the-old-title", "wip.txt");

    const lookup = await findResumableIssueBranch({
      issueNumber: 220,
      baseBranch: "main",
      // The persisted pointer names the branch the first claim created …
      persistedBranch: "issue-220-the-old-title",
      // … while this claim's title now derives a different name.
      titleBranch: "issue-220-a-completely-new-title",
      options: { cwd },
    });

    assert(lookup.ok, "lookup should succeed");
    assertEquals(lookup.value.reason, "resumable");
    assertEquals(lookup.value.candidate?.branch, "issue-220-the-old-title");
    assertEquals(lookup.value.candidate?.aheadCount, 1);
  });
});

Deno.test("issue #220 - WIP is found by number even with no persisted pointer", async () => {
  await withRepo(async (cwd) => {
    await pushWipBranch(cwd, "issue-220-the-old-title", "wip.txt");

    const lookup = await findResumableIssueBranch({
      issueNumber: 220,
      baseBranch: "main",
      titleBranch: "issue-220-a-completely-new-title",
      options: { cwd },
    });

    assert(lookup.ok);
    assertEquals(lookup.value.candidate?.branch, "issue-220-the-old-title");
    assertEquals(lookup.value.considered, ["issue-220-the-old-title"]);
  });
});

Deno.test("issue #220 - no branch for the issue reports none-found", async () => {
  await withRepo(async (cwd) => {
    await pushWipBranch(cwd, "issue-999-someone-elses-work", "other.txt");

    const lookup = await findResumableIssueBranch({
      issueNumber: 220,
      baseBranch: "main",
      titleBranch: "issue-220-new-title",
      options: { cwd },
    });

    assert(lookup.ok);
    assertEquals(lookup.value.candidate, null);
    assertEquals(lookup.value.reason, "none-found");
    assertEquals(lookup.value.considered, []);
  });
});

Deno.test("issue #220 - a branch that is not ahead of base is not resumed", async () => {
  await withRepo(async (cwd) => {
    // Branch pushed at base — e.g. what a merged-and-squashed PR leaves behind.
    await fixtureGit(["push", "origin", "main:issue-220-already-merged"], {
      cwd,
    });

    const lookup = await findResumableIssueBranch({
      issueNumber: 220,
      baseBranch: "main",
      titleBranch: "issue-220-already-merged",
      options: { cwd },
    });

    assert(lookup.ok);
    assertEquals(lookup.value.candidate, null);
    assertEquals(lookup.value.reason, "not-ahead-of-base");
    assertEquals(lookup.value.considered, ["issue-220-already-merged"]);
  });
});

Deno.test("issue #220 - several candidates resolve to the most recently pushed", async () => {
  await withRepo(async (cwd) => {
    await pushWipBranch(cwd, "issue-220-older-slug", "a.txt", 1_700_000_000);
    await pushWipBranch(cwd, "issue-220-newer-slug", "b.txt", 1_700_090_000);

    const lookup = await findResumableIssueBranch({
      issueNumber: 220,
      baseBranch: "main",
      // Neither the persisted pointer nor the title matches either branch.
      titleBranch: "issue-220-third-slug",
      options: { cwd },
    });

    assert(lookup.ok);
    assertEquals(lookup.value.candidate?.branch, "issue-220-newer-slug");
    assertEquals(lookup.value.alternatives, ["issue-220-older-slug"]);
  });
});

Deno.test("issue #220 - a persisted branch outside the naming convention is still found", async () => {
  await withRepo(async (cwd) => {
    await pushWipBranch(cwd, "legacy-wip-branch", "wip.txt");

    const lookup = await findResumableIssueBranch({
      issueNumber: 220,
      baseBranch: "main",
      persistedBranch: "legacy-wip-branch",
      titleBranch: "issue-220-new-title",
      options: { cwd },
    });

    assert(lookup.ok);
    assertEquals(lookup.value.candidate?.branch, "legacy-wip-branch");
  });
});

Deno.test("issue #220 - an unreachable remote fails loud rather than reporting 'nothing to resume'", async () => {
  await withRepo(async (cwd) => {
    await fixtureGit(
      ["remote", "set-url", "origin", `${cwd}/no-such-remote.git`],
      { cwd },
    );

    const lookup = await findResumableIssueBranch({
      issueNumber: 220,
      baseBranch: "main",
      titleBranch: "issue-220-new-title",
      options: { cwd },
    });

    assertEquals(lookup.ok, false);
    if (!lookup.ok) assertStringIncludes(lookup.error.message, "ls-remote");
  });
});
