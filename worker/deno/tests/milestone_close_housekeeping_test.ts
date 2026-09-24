/**
 * Milestone-close housekeeping (Issue #2338).
 *
 * Every test drives the real module against a real git clone, a real linked
 * worktree and a real on-disk stream session record, with only `gh` faked —
 * the behaviours under test (a worktree that refuses removal because it holds
 * uncommitted work, a branch whose commits are not on any remote) are git's,
 * and a mocked git would assert the mock rather than the sweep.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  childIssueBranchNumber,
  milestoneCloseStatePath,
  parseClosedMilestones,
  sweepClosedMilestones,
} from "../lib/milestone_close_housekeeping.ts";
import {
  saveStreamSession,
  streamSessionPath,
} from "../lib/resume_state_store.ts";

const REPO = "owner/demo";
const MILESTONE_TITLE = "#2319 session resume";
const MILESTONE_BRANCH = "milestone/2319-session-resume";
const CHILD_BRANCH = "issue-77-do-the-thing";
const CHILD_NUMBER = 77;

/** Run git, failing loud so a broken fixture never masquerades as a pass. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(out.stdout);
  if (!out.success) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
  return stdout;
}

interface Fixture {
  workDir: string;
  repoPath: string;
  worktreePath: string;
  cleanup: () => Promise<void>;
}

/**
 * A work root holding a bare "origin", a clone of it carrying the milestone
 * branch and one child issue branch (both pushed), and a lane worktree with
 * the milestone branch checked out.
 */
async function makeFixture(): Promise<Fixture> {
  // Canonical path: on macOS the temp dir sits under `/var`, a symlink to
  // `/private/var`, and `git worktree list` reports the resolved path — so an
  // unresolved fixture path never equals the path the sweep logs.
  const workDir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "milestone-close-" }),
  );
  const remote = `${workDir}/origin.git`;
  await Deno.mkdir(remote, { recursive: true });
  await git(remote, "init", "--bare", "--initial-branch=main", ".");

  const repoPath = `${workDir}/demo`;
  await git(workDir, "clone", remote, repoPath);
  await git(repoPath, "config", "user.email", "test@example.com");
  await git(repoPath, "config", "user.name", "Test");
  await Deno.writeTextFile(`${repoPath}/README.md`, "# demo\n");
  await git(repoPath, "add", "README.md");
  await git(repoPath, "commit", "-m", "initial");
  await git(repoPath, "push", "origin", "main");

  for (const branch of [MILESTONE_BRANCH, CHILD_BRANCH]) {
    await git(repoPath, "checkout", "-b", branch, "main");
    await Deno.writeTextFile(
      `${repoPath}/${branch.replace(/\//g, "_")}`,
      "x\n",
    );
    await git(repoPath, "add", "-A");
    await git(repoPath, "commit", "-m", `work on ${branch}`);
    await git(repoPath, "push", "origin", branch);
  }
  await git(repoPath, "checkout", "main");

  const worktreePath = `${workDir}/worktrees/s1/demo`;
  await Deno.mkdir(`${workDir}/worktrees/s1`, { recursive: true });
  await git(repoPath, "worktree", "add", worktreePath, MILESTONE_BRANCH);

  return {
    workDir,
    repoPath,
    worktreePath,
    cleanup: () => Deno.remove(workDir, { recursive: true }),
  };
}

/** A `gh` stub serving one closed milestone with one child issue. */
function makeGh(calls: string[][] = []): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    calls.push(args);
    const endpoint = args[args.length - 1] ?? "";
    if (endpoint.includes("/milestones")) {
      return Promise.resolve(
        JSON.stringify([{ number: 9, title: MILESTONE_TITLE }]),
      );
    }
    if (endpoint.includes("/issues")) {
      return Promise.resolve(JSON.stringify([{ number: CHILD_NUMBER }]));
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
}

/** Local branch names in the clone. */
async function localBranches(repoPath: string): Promise<string[]> {
  const out = await git(
    repoPath,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  );
  return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("childIssueBranchNumber - reads the issue number off an issue branch", () => {
  assertEquals(childIssueBranchNumber("issue-77-do-the-thing"), 77);
  assertEquals(childIssueBranchNumber("issue-5"), 5);
  assertEquals(childIssueBranchNumber("milestone/2319-thing"), null);
  assertEquals(childIssueBranchNumber("issues-77-x"), null);
  assertEquals(childIssueBranchNumber("issue-x-77"), null);
});

Deno.test("parseClosedMilestones - reads concatenated --paginate pages", () => {
  const raw = '[{"number":1,"title":"a"}][{"number":2,"title":"b"}]';
  assertEquals(parseClosedMilestones(raw), [
    { number: 1, title: "a" },
    { number: 2, title: "b" },
  ]);
  assertEquals(parseClosedMilestones(""), []);
});

Deno.test("parseClosedMilestones - throws on unreadable output rather than reading it as none", () => {
  assertThrows(
    () => parseClosedMilestones("not json"),
    Error,
    "not a JSON array",
  );
  assertThrows(
    () => parseClosedMilestones('{"message":"Not Found"}'),
    Error,
  );
});

Deno.test("sweepClosedMilestones - removes the worktree, branches and stream session of a closed milestone", async () => {
  const fx = await makeFixture();
  try {
    await saveStreamSession(fx.workDir, {
      repo: REPO,
      milestoneTitle: MILESTONE_TITLE,
    }, { providerId: "claude", sessionId: "abc" });
    const sessionPath = streamSessionPath(fx.workDir, {
      repo: REPO,
      milestoneTitle: MILESTONE_TITLE,
    });
    assert(await exists(sessionPath), "fixture must write a stream session");

    const logs: string[] = [];
    const result = await sweepClosedMilestones(
      { repo: REPO, workDir: fx.workDir, repoPath: fx.repoPath },
      { gh: makeGh(), log: (m) => logs.push(m) },
    );

    assertEquals(result.failures, []);
    assertEquals(result.swept, [MILESTONE_TITLE]);
    assertEquals(await exists(fx.worktreePath), false);
    assertEquals(await exists(sessionPath), false);
    const branches = await localBranches(fx.repoPath);
    assertEquals(branches.includes(MILESTONE_BRANCH), false);
    assertEquals(branches.includes(CHILD_BRANCH), false);
    assertEquals(branches.includes("main"), true);

    const healing = logs.filter((l) => l.startsWith("SELF-HEALING: "));
    assert(
      healing.every((l) =>
        l.includes(`for closed milestone ${MILESTONE_TITLE}`)
      ),
      `every removal names the milestone: ${healing.join(" | ")}`,
    );
    assert(
      healing.some((l) => l.includes(fx.worktreePath)),
      "the removed worktree is logged",
    );
    assert(
      healing.some((l) => l.includes(MILESTONE_BRANCH)),
      "the removed milestone branch is logged",
    );
    assert(
      healing.some((l) => l.includes(CHILD_BRANCH)),
      "the removed child issue branch is logged",
    );
    assert(
      healing.some((l) => l.includes("stream session")),
      "the removed stream session is logged",
    );
  } finally {
    await fx.cleanup();
  }
});

Deno.test("sweepClosedMilestones - a swept milestone is never listed or swept again", async () => {
  const fx = await makeFixture();
  try {
    const calls: string[][] = [];
    const gh = makeGh(calls);
    await sweepClosedMilestones(
      { repo: REPO, workDir: fx.workDir, repoPath: fx.repoPath },
      { gh, log: () => {} },
    );
    const callsAfterFirst = calls.length;

    const logs: string[] = [];
    const second = await sweepClosedMilestones(
      { repo: REPO, workDir: fx.workDir, repoPath: fx.repoPath },
      { gh, log: (m) => logs.push(m) },
    );

    assertEquals(second.considered, []);
    assertEquals(second.swept, []);
    assertEquals(second.removed, []);
    assert(second.listedFromCache, "the short TTL serves the second scan");
    assertEquals(calls.length, callsAfterFirst, "no further gh calls");
    assertEquals(logs.filter((l) => l.startsWith("SELF-HEALING: ")), []);

    // The swept title is persisted, so a cache expiry does not revive it.
    const state = JSON.parse(
      await Deno.readTextFile(milestoneCloseStatePath(fx.workDir, REPO)),
    );
    assertEquals(state.swept, [MILESTONE_TITLE]);

    const third = await sweepClosedMilestones(
      {
        repo: REPO,
        workDir: fx.workDir,
        repoPath: fx.repoPath,
        listingTtlMs: 0,
      },
      { gh, log: () => {} },
    );
    assertEquals(third.considered, []);
    assertEquals(third.listedFromCache, false);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("sweepClosedMilestones - skips a worktree holding uncommitted work", async () => {
  const fx = await makeFixture();
  try {
    await Deno.writeTextFile(`${fx.worktreePath}/scratch.txt`, "unsaved\n");

    const logs: string[] = [];
    const result = await sweepClosedMilestones(
      { repo: REPO, workDir: fx.workDir, repoPath: fx.repoPath },
      { gh: makeGh(), log: (m) => logs.push(m) },
    );

    assertEquals(await exists(fx.worktreePath), true);
    assert(
      (await localBranches(fx.repoPath)).includes(MILESTONE_BRANCH),
      "the branch the skipped worktree holds stays too",
    );
    assert(
      result.skipped.some((s) => s.includes(fx.worktreePath)),
      `the worktree is recorded as skipped: ${result.skipped.join(" | ")}`,
    );
    assert(
      logs.some((l) =>
        l === `SELF-HEALING: skipped ${fx.worktreePath} (uncommitted work)`
      ),
      `the documented skip line is logged: ${logs.join(" | ")}`,
    );
    assertEquals(result.failures, []);
    // The child branch carries no uncommitted work, so it still goes.
    assertEquals(
      (await localBranches(fx.repoPath)).includes(CHILD_BRANCH),
      false,
    );
  } finally {
    await fx.cleanup();
  }
});

Deno.test("sweepClosedMilestones - skips a branch whose commits are on no remote", async () => {
  const fx = await makeFixture();
  try {
    // A commit made only locally on the child branch: unpushed work.
    await git(fx.repoPath, "checkout", CHILD_BRANCH);
    await Deno.writeTextFile(`${fx.repoPath}/unpushed.txt`, "local only\n");
    await git(fx.repoPath, "add", "-A");
    await git(fx.repoPath, "commit", "-m", "unpushed work");
    await git(fx.repoPath, "checkout", "main");

    const logs: string[] = [];
    const result = await sweepClosedMilestones(
      { repo: REPO, workDir: fx.workDir, repoPath: fx.repoPath },
      { gh: makeGh(), log: (m) => logs.push(m) },
    );

    assert(
      (await localBranches(fx.repoPath)).includes(CHILD_BRANCH),
      "the unpushed branch survives",
    );
    assert(
      logs.some((l) =>
        l === `SELF-HEALING: skipped ${CHILD_BRANCH} (unpushed work)`
      ),
      `the documented skip line is logged: ${logs.join(" | ")}`,
    );
    assertEquals(result.failures, []);
    assertEquals(await exists(fx.worktreePath), false);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("sweepClosedMilestones - a failed removal is logged, never swept, and retried next scan", async () => {
  const fx = await makeFixture();
  try {
    const logs: string[] = [];
    const failing = await sweepClosedMilestones(
      { repo: REPO, workDir: fx.workDir, repoPath: fx.repoPath },
      {
        gh: makeGh(),
        log: (m) => logs.push(m),
        git: (args, cwd) =>
          args[0] === "worktree" && args[1] === "remove"
            ? Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "fatal: could not remove",
            })
            : realGit(args, cwd),
      },
    );

    assert(failing.failures.length > 0, "the failure is reported");
    assertEquals(failing.swept, [], "a milestone with a failure is not swept");
    assert(
      logs.some((l) =>
        l.startsWith("SELF-HEALING: failed to remove") &&
        l.includes(MILESTONE_TITLE)
      ),
      `the failure is logged loud: ${logs.join(" | ")}`,
    );
    assertEquals(await exists(fx.worktreePath), true);

    // Next scan, with the removal working again: the milestone is retried.
    const retry = await sweepClosedMilestones(
      { repo: REPO, workDir: fx.workDir, repoPath: fx.repoPath },
      { gh: makeGh(), log: () => {} },
    );
    assertEquals(retry.considered, [MILESTONE_TITLE]);
    assertEquals(retry.failures, []);
    assertEquals(retry.swept, [MILESTONE_TITLE]);
    assertEquals(await exists(fx.worktreePath), false);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("sweepClosedMilestones - sweeps worktrees and branches with no stream session on disk (enable_session_resume off)", async () => {
  const fx = await makeFixture();
  try {
    const sessionPath = streamSessionPath(fx.workDir, {
      repo: REPO,
      milestoneTitle: MILESTONE_TITLE,
    });
    assertEquals(
      await exists(sessionPath),
      false,
      "with session resume off no stream record exists",
    );

    const result = await sweepClosedMilestones(
      { repo: REPO, workDir: fx.workDir, repoPath: fx.repoPath },
      { gh: makeGh(), log: () => {} },
    );

    assertEquals(result.failures, []);
    assertEquals(result.swept, [MILESTONE_TITLE]);
    assertEquals(await exists(fx.worktreePath), false);
    assertEquals(
      (await localBranches(fx.repoPath)).sort(),
      ["main"],
    );
    assertEquals(
      result.removed.some((r) => r.includes("stream session")),
      false,
      "no stream session is reported removed when none existed",
    );
  } finally {
    await fx.cleanup();
  }
});

Deno.test("sweepClosedMilestones - a gh listing failure is reported, not thrown", async () => {
  const fx = await makeFixture();
  try {
    const result = await sweepClosedMilestones(
      { repo: REPO, workDir: fx.workDir, repoPath: fx.repoPath },
      {
        gh: () => Promise.reject(new Error("gh exploded")),
        log: () => {},
      },
    );
    assertEquals(result.considered, []);
    assert(
      result.errors.some((e) => e.includes("gh exploded")),
      `the failure is surfaced: ${result.errors.join(" | ")}`,
    );
    assertEquals(await exists(fx.worktreePath), true);
  } finally {
    await fx.cleanup();
  }
});

/** The production git seam, used by the partial-failure test for every other command. */
async function realGit(
  args: readonly string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command("git", {
    args: [...args],
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
