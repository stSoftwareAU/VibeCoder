/**
 * The merge-only bindings a milestone sync runs with when the ephemeral cargo
 * root is over budget (Issue #4326).
 *
 * Part one checks the three bindings on their own. Part two runs
 * `syncMilestoneBranchWithDefault` against real git throughout — a bare
 * remote, a clone, a milestone branch and a default branch that has moved on.
 * The assertions that matter at runtime: a conflict-free merge lands without
 * the repository's build (`UNGATED`), and a conflicted merge is neither pushed
 * nor charged.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { syncMilestoneBranchWithDefault } from "../lib/git_pull.ts";
import { judgeSyncFailure } from "../lib/milestone_branch_sync.ts";
import {
  type MergeOnlyBindings,
  mergeOnlyBindings,
} from "../lib/milestone_merge_only.ts";
import type { MergeGateFn } from "../lib/milestone_merge_gate.ts";
import type { MilestoneConflictAgentRequest } from "../lib/milestone_conflict_ladder.ts";

const REASON =
  "ephemeral cargo root over budget (test reading) (Issue #3178); the merge " +
  "lands without the repository's build and the repository's CI builds it " +
  "(Issue #4326)";
const MILESTONE = "milestone/4326-merge-only";

// ---------------------------------------------------------------------------
// Part one: the bindings
// ---------------------------------------------------------------------------

/** The bindings for a reason; fails the test when there are none. */
function bindingsFor(reason: string): MergeOnlyBindings {
  const bindings = mergeOnlyBindings(reason);
  assert(bindings !== undefined, "a reason must give bindings");
  return bindings;
}

Deno.test("mergeOnlyBindings - no reason means no bindings: the build runs as usual", () => {
  assertEquals(mergeOnlyBindings(undefined), undefined);
});

Deno.test("mergeOnlyBindings - the merge gate reports skipped, carrying the reason (Issue #4326)", async () => {
  const outcome = await bindingsFor(REASON).mergeGate(".");
  assertEquals(outcome.status, "skipped");
  assertStringIncludes(outcome.detail, REASON);
});

Deno.test("mergeOnlyBindings - the resolution gate reports failed, carrying the reason (Issue #4326)", async () => {
  const outcome = await bindingsFor(REASON).resolutionGate(".");
  assertEquals(outcome.status, "failed");
  assertStringIncludes(outcome.detail, REASON);
});

Deno.test("mergeOnlyBindings - the agent reports the provider unavailable, carrying the reason (Issue #4326)", async () => {
  const request = {
    conflictedFiles: ["shared.txt"],
    milestoneBranch: MILESTONE,
    defaultBranch: "main",
    workDir: ".",
  } satisfies MilestoneConflictAgentRequest;
  const result = await bindingsFor(REASON).agentFn(request);
  assert(result.ok, "the agent binding returns an ok result");
  assertEquals(result.value.terminated, false);
  assertStringIncludes(result.value.providerUnavailable ?? "", REASON);
});

// ---------------------------------------------------------------------------
// Part two: real git
// ---------------------------------------------------------------------------

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

interface Fixture {
  root: string;
  remote: string;
  clone: string;
}

/**
 * A remote whose `main` and the milestone branch share a seed, `shared.txt`
 * holding `a`, `b`, `c` lines. Each side then commits its own change: the
 * milestone first, then `main` moves on. The clone is left on the milestone
 * branch, as the sync expects.
 */
async function fixture(sides: {
  milestone: [file: string, text: string];
  main: [file: string, text: string];
}): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "milestone-merge-only-4326-" });
  const remote = `${root}/remote.git`;
  const clone = `${root}/clone`;

  await git(["init", "--bare", "-b", "main", remote], root);
  await git(["clone", remote, clone], root);
  await git(["config", "user.email", "t@example.com"], clone);
  await git(["config", "user.name", "Test"], clone);
  await git(["config", "commit.gpgsign", "false"], clone);

  await Deno.writeTextFile(`${clone}/shared.txt`, "a\nb\nc\n");
  await git(["add", "."], clone);
  await git(["commit", "-m", "seed"], clone);
  await git(["push", "-u", "origin", "main"], clone);

  await git(["checkout", "-b", MILESTONE], clone);
  await Deno.writeTextFile(
    `${clone}/${sides.milestone[0]}`,
    sides.milestone[1],
  );
  await git(["add", "-A"], clone);
  await git(["commit", "-m", "milestone work"], clone);
  await git(["push", "-u", "origin", MILESTONE], clone);

  await git(["checkout", "main"], clone);
  await Deno.writeTextFile(`${clone}/${sides.main[0]}`, sides.main[1]);
  await git(["add", "-A"], clone);
  await git(["commit", "-m", "default branch moves on"], clone);
  await git(["push", "origin", "main"], clone);

  await git(["checkout", MILESTONE], clone);
  return { root, remote, clone };
}

/** The commit a branch points at in the remote. */
function remoteSha(remote: string, branch: string): Promise<string> {
  return git(["rev-parse", `refs/heads/${branch}`], remote);
}

/** Is a merge half-done in the clone? */
async function mergeInProgress(clone: string): Promise<boolean> {
  try {
    await Deno.stat(`${clone}/.git/MERGE_HEAD`);
    return true;
  } catch {
    return false;
  }
}

/** A gate that refuses everything, as the control's stand-in for the build. */
const refusingGate: MergeGateFn = () =>
  Promise.resolve({
    status: "failed",
    detail: "control: the repository's build refused the merged tree",
    output: "",
  });

Deno.test("merge-only e2e - a conflict-free merge lands unverified: UNGATED, and the milestone carries main's commit (Issue #4326)", async () => {
  const f = await fixture({
    milestone: ["milestone.txt", "milestone work\n"],
    main: ["default.txt", "moved on\n"],
  });
  try {
    const before = await remoteSha(f.remote, MILESTONE);
    const mainTip = await remoteSha(f.remote, "main");
    const bindings = bindingsFor(REASON);

    const result = await syncMilestoneBranchWithDefault(
      MILESTONE,
      "main",
      { cwd: f.clone },
      undefined,
      bindings.mergeGate,
      bindings.resolutionGate,
      bindings.agentFn,
    );

    assert(
      result.ok,
      `expected the merge to land, got: ${
        result.ok ? "ok" : result.error.message
      }`,
    );
    assertStringIncludes(result.value.message, "UNGATED");
    const after = await remoteSha(f.remote, MILESTONE);
    assert(after !== before, "the milestone branch must have moved");
    await git(["merge-base", "--is-ancestor", mainTip, after], f.remote);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("merge-only e2e - control: the same clean merge is refused by a failing gate, so the bypass is the gate's own (Issue #4326)", async () => {
  const f = await fixture({
    milestone: ["milestone.txt", "milestone work\n"],
    main: ["default.txt", "moved on\n"],
  });
  try {
    const before = await remoteSha(f.remote, MILESTONE);

    const result = await syncMilestoneBranchWithDefault(
      MILESTONE,
      "main",
      { cwd: f.clone },
      undefined,
      refusingGate,
      refusingGate,
    );

    assertEquals(result.ok, false, "a failing gate must refuse the merge");
    assertEquals(await remoteSha(f.remote, MILESTONE), before);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("merge-only e2e - a conflict the agent would have to resolve is not pushed and not charged (Issue #4326)", async () => {
  // Both sides change the same line, so no rule decides it: the ladder reaches
  // the agent rung, which the merge-only binding reports as unavailable.
  const f = await fixture({
    milestone: ["shared.txt", "a\nMILESTONE\nc\n"],
    main: ["shared.txt", "a\nMAIN\nc\n"],
  });
  try {
    const before = await remoteSha(f.remote, MILESTONE);
    const bindings = bindingsFor(REASON);

    const result = await syncMilestoneBranchWithDefault(
      MILESTONE,
      "main",
      { cwd: f.clone },
      undefined,
      bindings.mergeGate,
      bindings.resolutionGate,
      bindings.agentFn,
    );

    assert(!result.ok, "a conflicted merge must not land");
    const conclusion = judgeSyncFailure(result.error, true);
    assertEquals(conclusion.outcome, "disrupted");
    assertEquals(await remoteSha(f.remote, MILESTONE), before);
    assertEquals(await mergeInProgress(f.clone), false);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("merge-only e2e - a conflict the worker resolves is judged by the resolution gate, not pushed (Issue #4326)", async () => {
  // Main keeps the milestone's line and adds one: the triage takes main's side
  // as a superset, so the worker resolves it and the resolution gate decides.
  const f = await fixture({
    milestone: ["shared.txt", "a\nB\nc\n"],
    main: ["shared.txt", "a\nB\nB2\nc\n"],
  });
  try {
    const before = await remoteSha(f.remote, MILESTONE);
    const bindings = bindingsFor(REASON);

    const result = await syncMilestoneBranchWithDefault(
      MILESTONE,
      "main",
      { cwd: f.clone },
      undefined,
      bindings.mergeGate,
      bindings.resolutionGate,
      bindings.agentFn,
    );

    assert(!result.ok, "a resolved conflict the gate refuses must not land");
    const conclusion = judgeSyncFailure(result.error, true);
    assertEquals(conclusion.outcome, "not-charged");
    assertEquals(await remoteSha(f.remote, MILESTONE), before);
    assertEquals(await mergeInProgress(f.clone), false);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});
