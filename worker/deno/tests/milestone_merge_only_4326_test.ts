/**
 * The merge-only bindings a milestone sync runs with when the ephemeral cargo
 * root is over budget (Issue #4326).
 *
 * Part one checks the bindings on their own, over real temp-dir trees: a tree
 * with a Cargo project takes the merge-only path, and a tree without one keeps
 * its own checks. Part two runs `syncMilestoneBranchWithDefault` against real
 * git throughout — a bare remote, a clone, a milestone branch and a default
 * branch that has moved on. The assertions that matter at runtime: a
 * conflict-free merge in a cargo tree lands without the repository's build
 * (`UNGATED`), a Deno-only tree still runs its own gate, and a conflicted merge
 * is neither pushed nor charged.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { syncMilestoneBranchWithDefault } from "../lib/git_pull.ts";
import { judgeSyncFailure } from "../lib/milestone_branch_sync.ts";
import {
  MERGE_ONLY_NO_BUILD,
  type MergeOnlyBindings,
  mergeOnlyBindings,
  type MergeOnlyDeps,
} from "../lib/milestone_merge_only.ts";
import {
  findTypeCheckProjects,
  type MergeGateFn,
  type MergeGateOutcome,
} from "../lib/milestone_merge_gate.ts";
import type {
  MilestoneConflictAgentFn,
  MilestoneConflictAgentRequest,
} from "../lib/milestone_conflict_ladder.ts";

const REASON =
  "ephemeral cargo root over budget (test reading) (Issue #3178); the merge " +
  "lands without the repository's build and the repository's CI builds it " +
  "(Issue #4326)";
const MILESTONE = "milestone/4326-merge-only";

const CARGO_TOML = '[package]\nname = "fixture"\nversion = "0.0.0"\n' +
  'edition = "2021"\n';
const DENO_JSON = "{}\n";

/** The outcome an injected repository gate reports. */
const PASSED: MergeGateOutcome = {
  status: "passed",
  detail: "stub: the repository's own check passed",
  output: "",
};

// ---------------------------------------------------------------------------
// Part one: the bindings
// ---------------------------------------------------------------------------

/** The bindings for a reason; fails the test when there are none. */
function bindingsFor(
  reason: string,
  realAgent?: MilestoneConflictAgentFn,
  deps?: MergeOnlyDeps,
): MergeOnlyBindings {
  const bindings = mergeOnlyBindings(reason, realAgent, deps);
  assert(bindings !== undefined, "a reason must give bindings");
  return bindings;
}

/** A gate stub that records the directory it was asked about. */
function recordingGate(outcome: MergeGateOutcome) {
  const calls: string[] = [];
  const gate: MergeGateFn = (dir) => {
    calls.push(dir);
    return Promise.resolve(outcome);
  };
  return { gate, calls };
}

/** An agent stub that records the requests it was handed. */
function recordingAgent() {
  const calls: MilestoneConflictAgentRequest[] = [];
  const agent: MilestoneConflictAgentFn = (request) => {
    calls.push(request);
    return Promise.resolve({
      ok: true as const,
      value: { terminated: true },
    });
  };
  return { agent, calls };
}

/**
 * Run `body` in a fresh temp directory holding the given files, removed after.
 * The directory is a real tree, so the real project detection runs on it.
 */
async function withTree<T>(
  files: Record<string, string>,
  body: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "milestone-merge-only-tree-" });
  try {
    for (const [name, text] of Object.entries(files)) {
      await Deno.writeTextFile(`${dir}/${name}`, text);
    }
    return await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** A request whose workDir is the given tree. */
function requestIn(workDir: string): MilestoneConflictAgentRequest {
  return {
    conflictedFiles: ["shared.txt"],
    milestoneBranch: MILESTONE,
    defaultBranch: "main",
    workDir,
  };
}

Deno.test("mergeOnlyBindings - no reason means no bindings: the build runs as usual", () => {
  assertEquals(mergeOnlyBindings(undefined), undefined);
  assertEquals(mergeOnlyBindings(undefined, recordingAgent().agent), undefined);
});

Deno.test("mergeOnlyBindings - the no-build constant names the budget, so a refusal carrying it is recognisable (Issue #4326)", () => {
  assertStringIncludes(MERGE_ONLY_NO_BUILD, "no repository build was run");
});

Deno.test("mergeOnlyBindings - a tree with only a deno.json is detected as Deno, not cargo (Issue #4326)", async () => {
  await withTree({ "deno.json": DENO_JSON }, async (dir) => {
    const projects = await findTypeCheckProjects(dir);
    assertEquals(projects.map((p) => p.kind), ["deno"]);
  });
});

Deno.test("mergeOnlyBindings - a Deno-only tree: the merge gate runs the repository's own check (Issue #4326)", async () => {
  await withTree({ "deno.json": DENO_JSON }, async (dir) => {
    const check = recordingGate(PASSED);
    const verify = recordingGate(PASSED);
    const outcome = await bindingsFor(REASON, undefined, {
      checkMergedTree: check.gate,
      verifyResolvedTree: verify.gate,
    }).mergeGate(dir);
    assertEquals(outcome, PASSED);
    assertEquals(check.calls, [dir]);
    assertEquals(verify.calls, []);
  });
});

Deno.test("mergeOnlyBindings - a Deno-only tree: the resolution gate runs the repository's own verification (Issue #4326)", async () => {
  await withTree({ "deno.json": DENO_JSON }, async (dir) => {
    const check = recordingGate(PASSED);
    const verify = recordingGate({
      status: "failed",
      detail: "stub: the repository's verification refused the resolution",
      output: "",
    });
    const outcome = await bindingsFor(REASON, undefined, {
      checkMergedTree: check.gate,
      verifyResolvedTree: verify.gate,
    }).resolutionGate(dir);
    assertEquals(outcome.status, "failed");
    assertStringIncludes(outcome.detail, "stub: the repository's verification");
    assertEquals(verify.calls, [dir]);
    assertEquals(check.calls, []);
  });
});

Deno.test("mergeOnlyBindings - a Deno-only tree: the agent delegates to the real agent (Issue #4326)", async () => {
  await withTree({ "deno.json": DENO_JSON }, async (dir) => {
    const real = recordingAgent();
    const request = requestIn(dir);
    const result = await bindingsFor(REASON, real.agent).agentFn(request);
    assert(result.ok, "the real agent's result is returned");
    assertEquals(result.value.terminated, true);
    assertEquals(real.calls, [request]);
  });
});

Deno.test("mergeOnlyBindings - a Deno-only tree with no real agent: the agent reports the provider unavailable (Issue #4326)", async () => {
  await withTree({ "deno.json": DENO_JSON }, async (dir) => {
    const result = await bindingsFor(REASON).agentFn(requestIn(dir));
    assert(result.ok, "the agent binding returns an ok result");
    assertEquals(result.value.terminated, false);
    assertStringIncludes(result.value.providerUnavailable ?? "", REASON);
  });
});

Deno.test("mergeOnlyBindings - a tree with a Cargo.toml is detected as cargo (Issue #4326)", async () => {
  await withTree({ "Cargo.toml": CARGO_TOML }, async (dir) => {
    const projects = await findTypeCheckProjects(dir);
    assertEquals(projects.map((p) => p.kind), ["cargo"]);
  });
});

Deno.test("mergeOnlyBindings - a cargo tree: the merge gate skips and never runs the check (Issue #4326)", async () => {
  await withTree({ "Cargo.toml": CARGO_TOML }, async (dir) => {
    const check = recordingGate(PASSED);
    const outcome = await bindingsFor(REASON, undefined, {
      checkMergedTree: check.gate,
    }).mergeGate(dir);
    assertEquals(outcome.status, "skipped");
    assertStringIncludes(outcome.detail, REASON);
    assertEquals(check.calls, []);
  });
});

Deno.test("mergeOnlyBindings - a cargo tree: the resolution gate fails with the no-build reason and never verifies (Issue #4326)", async () => {
  await withTree({ "Cargo.toml": CARGO_TOML }, async (dir) => {
    const verify = recordingGate(PASSED);
    const outcome = await bindingsFor(REASON, undefined, {
      verifyResolvedTree: verify.gate,
    }).resolutionGate(dir);
    assertEquals(outcome.status, "failed");
    assertStringIncludes(outcome.detail, MERGE_ONLY_NO_BUILD);
    assertStringIncludes(outcome.detail, REASON);
    assertEquals(verify.calls, []);
  });
});

Deno.test("mergeOnlyBindings - a cargo tree: the agent reports the provider unavailable and never runs the real agent (Issue #4326)", async () => {
  await withTree({ "Cargo.toml": CARGO_TOML }, async (dir) => {
    const real = recordingAgent();
    const result = await bindingsFor(REASON, real.agent).agentFn(
      requestIn(dir),
    );
    assert(result.ok, "the agent binding returns an ok result");
    assertEquals(result.value.terminated, false);
    assertStringIncludes(result.value.providerUnavailable ?? "", REASON);
    assertEquals(real.calls, []);
  });
});

Deno.test("mergeOnlyBindings - a tree whose projects cannot be listed is treated as cargo, so nothing is built (Issue #4326)", async () => {
  // The listing fails on a tree that does hold a Deno project. The bindings
  // take the conservative merge-only path rather than run a build blind.
  await withTree({ "deno.json": DENO_JSON }, async (dir) => {
    const check = recordingGate(PASSED);
    const verify = recordingGate(PASSED);
    const real = recordingAgent();
    const bindings = bindingsFor(REASON, real.agent, {
      checkMergedTree: check.gate,
      verifyResolvedTree: verify.gate,
      findTypeCheckProjects: () => Promise.reject(new Error("unreadable")),
    });

    const merged = await bindings.mergeGate(dir);
    assertEquals(merged.status, "skipped");
    const resolved = await bindings.resolutionGate(dir);
    assertEquals(resolved.status, "failed");
    assertStringIncludes(resolved.detail, MERGE_ONLY_NO_BUILD);
    const agent = await bindings.agentFn(requestIn(dir));
    assert(agent.ok, "the agent binding returns an ok result");
    assertStringIncludes(agent.value.providerUnavailable ?? "", REASON);

    assertEquals(check.calls, []);
    assertEquals(verify.calls, []);
    assertEquals(real.calls, []);
  });
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
 * The project file the seed commit carries. A cargo project makes the
 * merge-only path run; a Deno-only project lets the repository's own gate run.
 */
type ProjectKind = "cargo" | "deno";

const PROJECT_FILE: Record<ProjectKind, [name: string, text: string]> = {
  cargo: ["Cargo.toml", CARGO_TOML],
  deno: ["deno.json", DENO_JSON],
};

/**
 * A remote whose `main` and the milestone branch share a seed, `shared.txt`
 * holding `a`, `b`, `c` lines, and a project file of the given kind. Each side
 * then commits its own change: the milestone first, then `main` moves on. The
 * clone is left on the milestone branch, as the sync expects.
 */
async function fixture(
  sides: {
    milestone: [file: string, text: string];
    main: [file: string, text: string];
  },
  project: ProjectKind = "cargo",
): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "milestone-merge-only-4326-" });
  const remote = `${root}/remote.git`;
  const clone = `${root}/clone`;

  await git(["init", "--bare", "-b", "main", remote], root);
  await git(["clone", remote, clone], root);
  await git(["config", "user.email", "t@example.com"], clone);
  await git(["config", "user.name", "Test"], clone);
  await git(["config", "commit.gpgsign", "false"], clone);

  await Deno.writeTextFile(`${clone}/shared.txt`, "a\nb\nc\n");
  await Deno.writeTextFile(
    `${clone}/${PROJECT_FILE[project][0]}`,
    PROJECT_FILE[project][1],
  );
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
    assertEquals(
      (await findTypeCheckProjects(f.clone)).map((p) => p.kind),
      ["cargo"],
      "the fixture must hold a cargo project so the merge-only path runs",
    );
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

Deno.test("merge-only e2e - a Deno-only tree keeps its own gate: a clean merge the gate passes lands without UNGATED (Issue #4326)", async () => {
  const f = await fixture(
    {
      milestone: ["milestone.txt", "milestone work\n"],
      main: ["default.txt", "moved on\n"],
    },
    "deno",
  );
  try {
    const before = await remoteSha(f.remote, MILESTONE);
    assertEquals(
      (await findTypeCheckProjects(f.clone)).map((p) => p.kind),
      ["deno"],
      "the fixture must hold only a Deno project",
    );
    const check = recordingGate(PASSED);
    const bindings = bindingsFor(REASON, undefined, {
      checkMergedTree: check.gate,
    });

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
    assertEquals(result.value.message.includes("UNGATED"), false);
    assertEquals(check.calls, [f.clone], "the repository's own gate ran");
    assert(
      (await remoteSha(f.remote, MILESTONE)) !== before,
      "the milestone branch must have moved",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("merge-only e2e - a Deno-only tree whose own gate refuses the clean merge is not pushed (Issue #4326)", async () => {
  const f = await fixture(
    {
      milestone: ["milestone.txt", "milestone work\n"],
      main: ["default.txt", "moved on\n"],
    },
    "deno",
  );
  try {
    const before = await remoteSha(f.remote, MILESTONE);
    const check = recordingGate({
      status: "failed",
      detail: "stub: the repository's own check refused the merged tree",
      output: "",
    });
    const bindings = bindingsFor(REASON, undefined, {
      checkMergedTree: check.gate,
    });

    const result = await syncMilestoneBranchWithDefault(
      MILESTONE,
      "main",
      { cwd: f.clone },
      undefined,
      bindings.mergeGate,
      bindings.resolutionGate,
      bindings.agentFn,
    );

    assertEquals(result.ok, false, "a refusing gate must refuse the merge");
    assertEquals(check.calls, [f.clone]);
    assertEquals(await remoteSha(f.remote, MILESTONE), before);
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
