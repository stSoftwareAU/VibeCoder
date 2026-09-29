/**
 * The three branch sync points, over real repositories (Issue #2809).
 *
 * Work start, PR raise and pre-merge each bring a branch up to its target.
 * Every git command is recorded through `GIT_TRACE`, so each test asserts
 * over what actually ran: the sync happened, in order, by merge and a plain
 * push — never a rebase or a force-push.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { createFeatureBranchFromBase } from "../lib/git_branch.ts";
import {
  ensurePrMergeable,
  syncMilestoneBranchWithDefault,
} from "../lib/git_pull.ts";
import { pushUnpushedCommits } from "../lib/git_push.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import type { GitRunner } from "../lib/branch_currency.ts";
import { mergeOntoBase, syncBranchesForPrRaise } from "../lib/pr_raise_sync.ts";
import {
  type CiStatusResult,
  directMergePr,
  enforcePreMergeRequirements,
  type PreMergeGateFn,
} from "../lib/direct_merge.ts";
import type { PRBranchStateBatchResult } from "../lib/pr_branch_state.ts";
import type { Result } from "../types.ts";
import {
  isForcedPush,
  recordedPushes,
  recordedRebase,
  startGitTrace,
} from "./support/git_trace.ts";

const MILESTONE = "milestone/m";
const FEATURE = "issue-1-x";

/** Run git with extra env, failing loudly on a non-zero exit. */
async function git(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<string> {
  const result = await runGitCommand(args, { cwd, env });
  if (!result.ok) throw result.error;
  if (result.value.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.value.stderr}`);
  }
  return result.value.stdout.trim();
}

async function commitFile(cwd: string, file: string, content: string) {
  await Deno.writeTextFile(`${cwd}/${file}`, content);
  await git(["add", file], cwd);
  await git(["commit", "-m", `Change ${file}`], cwd);
}

/** A bare remote holding `main` and `milestone/m`, plus a seeding clone. */
interface Fixture {
  root: string;
  remote: string;
  seed: string;
  clone: (name: string) => Promise<string>;
}

async function setup(): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "sync_points_" });
  const remote = `${root}/remote.git`;
  await Deno.mkdir(remote);
  await git(["init", "--bare"], remote);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], remote);

  const clone = async (name: string): Promise<string> => {
    const path = `${root}/${name}`;
    await git(["clone", remote, path], root);
    await git(["config", "user.name", name], path);
    await git(["config", "user.email", `${name}@example.com`], path);
    await git(["config", "commit.gpgsign", "false"], path);
    return path;
  };

  const seed = await clone("seed");
  await git(["checkout", "-B", "main"], seed);
  await commitFile(seed, "README.md", "# Test\n");
  await git(["push", "origin", "main"], seed);
  await git(["checkout", "-b", MILESTONE], seed);
  await commitFile(seed, "m.txt", "milestone\n");
  await git(["push", "origin", MILESTONE], seed);
  return { root, remote, seed, clone };
}

/** The feature branch, pushed from `origin/milestone/m` with one commit. */
async function featureClone(fx: Fixture): Promise<string> {
  const worker = await fx.clone("worker");
  await git(["checkout", "-b", FEATURE, `origin/${MILESTONE}`], worker);
  await commitFile(worker, "feature.txt", "feature\n");
  await git(["push", "-u", "origin", FEATURE], worker);
  return worker;
}

/** The tip of `branch` on the remote. */
function remoteTip(fx: Fixture, branch: string): Promise<string> {
  return git(["rev-parse", `refs/heads/${branch}`], fx.remote);
}

/** Whether `ancestor` is in the history of the remote `branch`. */
async function remoteContains(
  fx: Fixture,
  branch: string,
  ancestor: string,
): Promise<boolean> {
  const result = await runGitCommand(
    ["merge-base", "--is-ancestor", ancestor, `refs/heads/${branch}`],
    { cwd: fx.remote },
  );
  return result.ok && result.value.code === 0;
}

// =============================================================================
// Work start
// =============================================================================

Deno.test("sync point 1, work start: the feature branch starts at the current origin/<target> head", async () => {
  const fx = await setup();
  const trace = await startGitTrace();
  try {
    const worker = await fx.clone("worker");
    // The target moves after the worker cloned: its local refs are stale.
    await commitFile(fx.seed, "m2.txt", "later\n");
    await git(["push", "origin", MILESTONE], fx.seed);
    const tip = await remoteTip(fx, MILESTONE);

    const created = await createFeatureBranchFromBase(FEATURE, MILESTONE, {
      cwd: worker,
      env: trace.env,
    });

    assert(created.ok, created.ok ? "" : created.error.message);
    assertEquals(await git(["rev-parse", FEATURE], worker), tip);
    assertEquals(await git(["branch", "--show-current"], worker), FEATURE);
    assertEquals((await recordedPushes(trace)).filter(isForcedPush), []);
    assertEquals(await recordedRebase(trace), false);
  } finally {
    await trace.dispose();
    await Deno.remove(fx.root, { recursive: true });
  }
});

// =============================================================================
// PR raise
// =============================================================================

const passGate = () =>
  Promise.resolve({ status: "passed" as const, detail: "stub", output: "" });

Deno.test("sync point 2, PR raise: the milestone syncs with default before the feature syncs with the milestone, by merge and plain push", async () => {
  const fx = await setup();
  const trace = await startGitTrace();
  try {
    const worker = await featureClone(fx);
    const msync = await fx.clone("msync");
    // The default branch moves on: the milestone, and so the feature, is behind.
    await git(["checkout", "main"], fx.seed);
    await commitFile(fx.seed, "main2.txt", "default moved\n");
    await git(["push", "origin", "main"], fx.seed);
    const mainTip = await remoteTip(fx, "main");

    const runGit: GitRunner = (args, options) =>
      runGitCommand(args, { ...options, env: trace.env });
    const outcome = await syncBranchesForPrRaise({
      branch: FEATURE,
      baseBranch: MILESTONE,
      milestoneBranch: MILESTONE,
      runGit,
      cwd: worker,
      sharedClonePath: msync,
      syncMilestone: async () => {
        const synced = await syncMilestoneBranchWithDefault(
          MILESTONE,
          "main",
          { cwd: msync, env: trace.env },
          undefined,
          passGate,
        );
        if (!synced.ok) throw synced.error;
        return { status: "synced", detail: synced.value.message };
      },
      log: () => {},
      warn: () => {},
    });
    assertEquals(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assertEquals(outcome.milestone?.status, "synced");
    assertEquals(outcome.currency.kind, "updated");

    const pushed = await pushUnpushedCommits(FEATURE, {
      cwd: worker,
      env: trace.env,
    });
    assert(pushed.ok, pushed.ok ? "" : pushed.error.message);

    // Order: the milestone push lands before the feature merges the milestone.
    const commands = await trace.commands();
    const milestonePush = commands.findIndex((argv) =>
      argv[0] === "push" && argv.includes(MILESTONE)
    );
    // The feature's merge is the one run while the feature branch is checked out.
    let checkedOut = "";
    const featureMerge = commands.findIndex((argv) => {
      if (argv[0] === "checkout") checkedOut = argv[argv.length - 1] ?? "";
      return argv[0] === "merge" && checkedOut === FEATURE &&
        argv.includes(`origin/${MILESTONE}`);
    });
    assert(milestonePush >= 0, "the milestone branch was never pushed");
    assert(featureMerge >= 0, "the feature branch never merged the milestone");
    assert(
      milestonePush < featureMerge,
      "the feature synced before the milestone did",
    );

    const pushes = await recordedPushes(trace);
    assert(pushes.some((argv) => argv.includes(FEATURE)));
    assertEquals(pushes.filter(isForcedPush), []);
    assertEquals(await recordedRebase(trace), false);
    assert(await remoteContains(fx, MILESTONE, mainTip));
    assert(await remoteContains(fx, FEATURE, mainTip));
  } finally {
    await trace.dispose();
    await Deno.remove(fx.root, { recursive: true });
  }
});

/** A git runner answering from a script; records every argv. */
function fakeGit(
  answer: (args: string[]) => { code: number; stdout?: string },
  calls: string[][],
): GitRunner {
  return (args) => {
    calls.push(args);
    const { code, stdout = "" } = answer(args);
    return Promise.resolve({ ok: true, value: { code, stdout, stderr: "" } });
  };
}

Deno.test("sync point 2, PR raise: a dirty shared clone skips the milestone sync rather than resetting work", async () => {
  const calls: string[][] = [];
  let synced = false;
  const warnings: string[] = [];
  const outcome = await syncBranchesForPrRaise({
    branch: FEATURE,
    baseBranch: MILESTONE,
    milestoneBranch: MILESTONE,
    runGit: fakeGit(
      (args) =>
        args[0] === "status" ? { code: 0, stdout: " M wip.ts\n" } : { code: 1 },
      calls,
    ),
    cwd: "/shared",
    sharedClonePath: "/shared",
    syncMilestone: () => {
      synced = true;
      return Promise.resolve({ status: "synced", detail: "" });
    },
    log: () => {},
    warn: (message) => warnings.push(message),
  });

  assertEquals(synced, false);
  assertEquals(outcome.kind, "ok");
  if (outcome.kind === "ok") assertEquals(outcome.milestone?.status, "skipped");
  assertEquals(warnings.length, 1);
});

Deno.test("sync point 2, PR raise: a feature branch that cannot be checked out again after the sync is refused", async () => {
  const calls: string[][] = [];
  const outcome = await syncBranchesForPrRaise({
    branch: FEATURE,
    baseBranch: MILESTONE,
    milestoneBranch: MILESTONE,
    runGit: fakeGit(
      (args) => args[0] === "checkout" ? { code: 1 } : { code: 0 },
      calls,
    ),
    cwd: "/shared",
    sharedClonePath: "/shared",
    syncMilestone: () => Promise.resolve({ status: "level", detail: "" }),
    log: () => {},
    warn: () => {},
  });

  assertEquals(outcome.kind, "refused");
  // Refused before any currency fetch: the PR must not go from the wrong branch.
  assertEquals(calls.some((argv) => argv[0] === "fetch"), false);
});

Deno.test("sync point 2, PR raise: a conflicting merge is aborted and leaves the branch exactly as it was", async () => {
  const fx = await setup();
  try {
    const worker = await featureClone(fx);
    await commitFile(worker, "m.txt", "feature side\n");
    await git(["checkout", MILESTONE], fx.seed);
    await commitFile(fx.seed, "m.txt", "milestone side\n");
    await git(["push", "origin", MILESTONE], fx.seed);
    await git(["fetch", "origin", MILESTONE], worker);
    const before = await git(["rev-parse", "HEAD"], worker);

    const merged = await mergeOntoBase({
      branch: FEATURE,
      baseRef: `origin/${MILESTONE}`,
      runGit: runGitCommand,
      cwd: worker,
    });

    assertEquals(merged.ok, false);
    assertEquals(await git(["rev-parse", "HEAD"], worker), before);
    assertEquals(await git(["status", "--porcelain"], worker), "");
    const merging = await runGitCommand(
      ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
      { cwd: worker },
    );
    assert(merging.ok && merging.value.code !== 0, "MERGE_HEAD survived");
  } finally {
    await Deno.remove(fx.root, { recursive: true });
  }
});

// =============================================================================
// Pre-merge
// =============================================================================

function ciStub(status: CiStatusResult["status"], headSha: string) {
  return (): Promise<Result<CiStatusResult>> =>
    Promise.resolve({ ok: true, value: { status, headSha } });
}

function branchStub(behindBy: number) {
  return (
    _repo: string,
    prs: { number: number }[],
  ): Promise<PRBranchStateBatchResult> =>
    Promise.resolve({
      ok: true,
      states: new Map(
        prs.map((pr) => [pr.number, {
          aheadBy: 1,
          behindBy,
          mergeable: "MERGEABLE",
        }]),
      ),
      callCount: 1,
    } as PRBranchStateBatchResult);
}

/** Answers the gate's ref read and `directMergePr`'s guard; records merges. */
function ghMock(merges: string[][]) {
  return (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (args[0] === "pr" && args[1] === "merge") {
      merges.push(args);
      return Promise.resolve("Merged");
    }
    if (joined.includes("--jq .baseRefName")) return Promise.resolve(MILESTONE);
    if (joined.includes(".default_branch")) return Promise.resolve("main");
    if (joined.includes("baseRefName,headRefName")) {
      return Promise.resolve(JSON.stringify({
        baseRefName: MILESTONE,
        headRefName: FEATURE,
        isCrossRepository: false,
      }));
    }
    return Promise.reject(new Error(`unexpected gh call: ${joined}`));
  };
}

Deno.test("sync point 3, pre-merge: a PR behind its target is synced by merge and plain push, and merges only once CI is green on the synced head", async () => {
  const fx = await setup();
  const trace = await startGitTrace();
  try {
    const worker = await featureClone(fx);
    const staleHead = await git(["rev-parse", "HEAD"], worker);
    await git(["checkout", MILESTONE], fx.seed);
    await commitFile(fx.seed, "m2.txt", "milestone moved\n");
    await git(["push", "origin", MILESTONE], fx.seed);
    const milestoneTip = await remoteTip(fx, MILESTONE);

    const synced = await ensurePrMergeable("o/r", 1, FEATURE, MILESTONE, {
      cwd: worker,
      env: trace.env,
    });

    assert(synced.ok, synced.ok ? "" : synced.error.message);
    const pushes = await recordedPushes(trace);
    assert(pushes.some((argv) => argv.includes(FEATURE)), "no feature push");
    assertEquals(pushes.filter(isForcedPush), []);
    assertEquals(await recordedRebase(trace), false);
    assert(await remoteContains(fx, FEATURE, milestoneTip));
    assert(await remoteContains(fx, FEATURE, staleHead));
    const syncedHead = await remoteTip(fx, FEATURE);
    assert(syncedHead !== staleHead);

    // The gate, fed each state the PR passes through after the sync.
    const gate = (
      ci: ReturnType<typeof ciStub>,
      behindBy: number,
    ): PreMergeGateFn =>
    (repo, pr, gh, options) =>
      enforcePreMergeRequirements(
        repo,
        pr,
        gh,
        {
          ...options,
          decideMilestoneBaseFn: () =>
            Promise.resolve({ decision: "allow", reason: "route-open" }),
          fetchHeadRecency: () =>
            Promise.resolve({ headSha: syncedHead, committedAtMs: 0 }),
          nowMs: () => 10 ** 13,
        },
        ci,
        branchStub(behindBy),
      );
    const merges: string[][] = [];
    const gh = ghMock(merges);
    const attempt = (ci: ReturnType<typeof ciStub>, behindBy = 0) =>
      directMergePr("o/r", 1, gh, gate(ci, behindBy));

    const blockedBy = async (
      ci: ReturnType<typeof ciStub>,
      behindBy = 0,
    ) => {
      const result = await attempt(ci, behindBy);
      assert(result.ok, result.ok ? "" : result.error.message);
      return result.value.merged ? "merged" : result.value.blocked;
    };

    // Still behind: refused, whatever CI says.
    assertEquals(
      await blockedBy(ciStub("passed", syncedHead), 1),
      "behind_target",
    );
    // Synced, but CI has not finished on the synced head.
    assertEquals(
      await blockedBy(ciStub("pending", syncedHead)),
      "checks_pending",
    );
    assertEquals(
      await blockedBy(ciStub("failed", syncedHead)),
      "checks_failed",
    );
    // A green result for the pre-sync head says nothing about the synced one.
    assertEquals(await blockedBy(ciStub("passed", staleHead)), "head_moved");
    assertEquals(merges, []);

    // Green on the synced head: merged, pinned to exactly that commit.
    assertEquals(await blockedBy(ciStub("passed", syncedHead)), "merged");
    assertEquals(merges.length, 1);
    const mergeArgs = merges[0] ?? [];
    const pin = mergeArgs.indexOf("--match-head-commit");
    assert(pin >= 0, "the merge was not pinned to a head commit");
    assertEquals(mergeArgs[pin + 1], syncedHead);
  } finally {
    await trace.dispose();
    await Deno.remove(fx.root, { recursive: true });
  }
});
