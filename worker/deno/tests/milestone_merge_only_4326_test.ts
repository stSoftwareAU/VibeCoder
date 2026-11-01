/**
 * The merge-only bindings a milestone sync runs with when the ephemeral cargo
 * root is over budget (Issue #4326).
 *
 * Part one checks the bindings on their own, over real temp-dir trees: a tree
 * with a Cargo project takes the merge-only path, and a tree without one keeps
 * its own checks. Part two runs `syncMilestoneBranchWithDefault` against real
 * git throughout — a bare remote, a clone, a milestone branch and a default
 * branch that has moved on. The assertions that matter at runtime: a
 * conflict-free merge in a cargo-only tree lands without the cargo build
 * (`UNGATED`), so does a conflict the deterministic rules settle, a Deno-only
 * tree still runs its own gate, and a conflict that needs the agent is not
 * pushed. The first over-budget cycle is not charged; the next one is.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { syncMilestoneBranchWithDefault } from "../lib/git_pull.ts";
import {
  CARGO_BUDGET_AGENT_WITHHELD,
  escalateRepeatedRefusal,
  judgeSyncFailure,
} from "../lib/milestone_branch_sync.ts";
import {
  type MergeOnlyBindings,
  mergeOnlyBindings,
  type MergeOnlyDeps,
  syncWithMergeOnlyBindings,
} from "../lib/milestone_merge_only.ts";
import { MilestoneConflictEscalation } from "../lib/milestone_conflict_triage.ts";
import {
  checkMergedTree,
  findTypeCheckProjects,
  type MergeGateFn,
  type MergeGateOutcome,
} from "../lib/milestone_merge_gate.ts";
import { verifyResolvedTree } from "../lib/milestone_resolution_gate.ts";
import type {
  MilestoneConflictAgentFn,
  MilestoneConflictAgentRequest,
} from "../lib/milestone_conflict_ladder.ts";

const REASON =
  "ephemeral cargo root over budget (55.3 GB free, floor 46.0 GB + headroom " +
  "25.0 GB) — pruned 0.0 GB of idle target dirs and 15.7 GB is still short, " +
  "so cargo builds wait for CI (Issue #3178 budget; Issue #4326 skip); cargo " +
  "builds wait for CI; Deno projects keep their normal checks (Issue #4326)";
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
    const agentFn = bindingsFor(REASON, real.agent).agentFn;
    assert(agentFn, "a Deno-only tree keeps the granted agent");
    const result = await agentFn(request);
    assert(result.ok, "the real agent's result is returned");
    assertEquals(result.value.terminated, true);
    assertEquals(real.calls, [request]);
  });
});

Deno.test("mergeOnlyBindings - a withheld grant hands the sync no agent, and the ledger says the cycle budget deferred it (Issue #4326)", async () => {
  const handed: Array<MilestoneConflictAgentFn | undefined> = [];
  await syncWithMergeOnlyBindings({
    syncFn: (_branch, _base, _options, _repo, _merge, _resolution, agent) => {
      handed.push(agent);
      return Promise.resolve({ ok: true, value: { message: "no conflict" } });
    },
    milestoneBranch: MILESTONE,
    defaultBranch: "main",
    options: { cwd: "." },
    repo: "owner/repo",
    mergeOnly: REASON,
    agentFn: undefined,
    logger: undefined,
  });
  assertEquals(handed, [undefined]);
  const conclusion = judgeSyncFailure(
    new MilestoneConflictEscalation(
      "no resolution agent was available to this sync",
      [{
        path: "src/lib.rs",
        reason: "no resolution agent was available to this sync (Issue #1777)",
        oursExports: [],
        theirsExports: [],
        oursTests: [],
        theirsTests: [],
        onlyOursTests: [],
        onlyTheirsTests: [],
      }],
      [],
      "b".repeat(40),
    ),
    false,
  );
  assertEquals(conclusion.outcome, "not-charged");
  assertEquals(conclusion.reason, "agent deferred: cycle budget");
  // Issue #4517: a cycle-budget deferral is not a refusal, so it is never counted.
  assertEquals(conclusion.refusal, undefined);
});

Deno.test("mergeOnlyBindings - a tree with a Cargo.toml is detected as cargo (Issue #4326)", async () => {
  await withTree({ "Cargo.toml": CARGO_TOML }, async (dir) => {
    const projects = await findTypeCheckProjects(dir);
    assertEquals(projects.map((p) => p.kind), ["cargo"]);
  });
});

Deno.test("mergeOnlyBindings - a cargo-only tree delegates with cargo disabled (Issue #4326)", async () => {
  await withTree({ "Cargo.toml": CARGO_TOML }, async (dir) => {
    const bindings = bindingsFor(REASON);
    const merged = await bindings.mergeGate(dir);
    assertEquals(merged.status, "skipped");
    assertStringIncludes(merged.detail, REASON);
    assertEquals(merged.output, "");
    assertEquals(merged.landUnverified, undefined);
    const resolved = await bindings.resolutionGate(dir);
    assertEquals(resolved.status, "skipped");
    assertEquals(resolved.landUnverified, true);
    assertEquals(resolved.output, "");
    assertStringIncludes(resolved.detail, REASON);
  });
});

Deno.test("mergeOnlyBindings - a cargo tree withholds the agent, and no over-budget cycle is ever charged (Issue #4326)", async () => {
  await withTree({ "Cargo.toml": CARGO_TOML }, async (dir) => {
    const real = recordingAgent();
    const agentFn = bindingsFor(REASON, real.agent).agentFn;
    assert(agentFn, "a granted agent is wrapped, not dropped");
    const result = await agentFn(requestIn(dir));
    assert(!result.ok, "a cargo tree withholds the granted agent");
    assertStringIncludes(result.error.message, CARGO_BUDGET_AGENT_WITHHELD);
    assertStringIncludes(result.error.message, REASON);
    assertEquals(real.calls, []);
    const first = judgeSyncFailure(
      new MilestoneConflictEscalation(
        result.error.message,
        [{
          path: "src/lib.rs",
          reason: `agent: ${result.error.message}`,
          oursExports: [],
          theirsExports: [],
          oursTests: [],
          theirsTests: [],
          onlyOursTests: [],
          onlyTheirsTests: [],
        }],
        [],
        "b".repeat(40),
      ),
      true,
    );
    assertEquals(first.outcome, "not-charged");
    // Not a refusal: a cargo withhold never counts toward the ceiling (Issue #4588).
    assertEquals(first.refusal, undefined);
    // The branch waits for the host's disk; it never climbs to the roll-back.
    const second = escalateRepeatedRefusal(first, 1);
    assertEquals(second.outcome, "not-charged");
    assertEquals(second.exhaust, undefined);
  });
});

Deno.test("mergeOnlyBindings - a tree whose projects cannot be listed cannot bypass resolution verification (Issue #4326)", async () => {
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
    assertEquals(merged.status, "passed");
    const resolved = await bindings.resolutionGate(dir);
    assertEquals(resolved.status, "failed");
    assertEquals(resolved.landUnverified, undefined);
    const agentFn = bindings.agentFn;
    assert(agentFn, "an unlistable tree still wraps a granted agent");
    const agent = await agentFn(requestIn(dir));
    assert(!agent.ok, "an unlistable tree withholds the agent");
    assertStringIncludes(agent.error.message, CARGO_BUDGET_AGENT_WITHHELD);

    assertEquals(check.calls, [dir]);
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

Deno.test("merge-only e2e - a conflict the agent would have to resolve is not pushed, and the withhold is never charged (Issue #4326)", async () => {
  // Both sides change the same line, so no rule decides it: the ladder reaches
  // the agent rung, which a cargo tree withholds. The first cycle is a
  // refusal that waits, uncharged, for the host.
  const f = await fixture({
    milestone: ["shared.txt", "a\nMILESTONE\nc\n"],
    main: ["shared.txt", "a\nMAIN\nc\n"],
  });
  try {
    const before = await remoteSha(f.remote, MILESTONE);
    const real = recordingAgent();
    const bindings = bindingsFor(REASON, real.agent);

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
    assertEquals(conclusion.outcome, "not-charged");
    assertEquals(conclusion.reason, CARGO_BUDGET_AGENT_WITHHELD);
    // Not a refusal: the withhold never counts toward the ceiling (Issue #4588).
    assertEquals(conclusion.refusal, undefined);
    // Never climbs: the branch waits for the host's disk.
    assertEquals(
      escalateRepeatedRefusal(conclusion, 1).outcome,
      "not-charged",
    );
    assertEquals(real.calls, []);
    assertEquals(await remoteSha(f.remote, MILESTONE), before);
    assertEquals(await mergeInProgress(f.clone), false);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("merge-only e2e - a conflict the worker resolves lands unverified: UNGATED, the milestone carries main's lines (Issue #4326)", async () => {
  // Main keeps the milestone's line and adds one: the triage takes main's side
  // as a superset, so the worker resolves it with no agent. The resolution
  // gate cannot afford the build, so the resolution lands with the UNGATED note
  // rather than waiting for a cycle with budget.
  const f = await fixture({
    milestone: ["shared.txt", "a\nB\nc\n"],
    main: ["shared.txt", "a\nB\nB2\nc\n"],
  });
  try {
    const before = await remoteSha(f.remote, MILESTONE);
    const verificationTasks: string[] = [];
    const bindings = bindingsFor(REASON, undefined, {
      verifyResolvedTree: (dir, _runner, typed, now, skip) =>
        verifyResolvedTree(
          dir,
          (task) => {
            verificationTasks.push(task.kind);
            return Promise.resolve({ code: 0, output: "" });
          },
          typed,
          now,
          skip,
        ),
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
      `expected the resolved merge to land, got: ${
        result.ok ? "ok" : result.error.message
      }`,
    );
    assertStringIncludes(result.value.message, "UNGATED");
    assertStringIncludes(result.value.message, REASON);
    assertEquals(result.value.conflict?.resolution, "auto");
    assertEquals(result.value.conflict?.unverified, true);
    assertEquals(verificationTasks, [], "no cargo verification build was run");
    const after = await remoteSha(f.remote, MILESTONE);
    assert(after !== before, "the milestone branch must have moved");
    assertEquals(
      await git(["show", `${MILESTONE}:shared.txt`], f.clone),
      "a\nB\nB2\nc",
    );
    assertEquals(await mergeInProgress(f.clone), false);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("merge-only e2e - control: the same resolved conflict is refused by a skipped resolution gate that does not land unverified (Issue #4326)", async () => {
  // Without `landUnverified` a skipped resolution is a refusal (Issue #1559),
  // so the landing above is the flag's doing and nothing else's.
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
      () =>
        Promise.resolve({
          status: "skipped" as const,
          detail: "control: nothing verified the resolution",
          output: "",
        }),
      bindings.agentFn,
    );

    assert(!result.ok, "a skipped resolution without the flag must not land");
    assertEquals(judgeSyncFailure(result.error, true).outcome, "not-charged");
    assertEquals(await remoteSha(f.remote, MILESTONE), before);
    assertEquals(await mergeInProgress(f.clone), false);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("mergeOnlyBindings - mixed trees keep Deno checks and suites while skipping cargo (PR #4343)", async () => {
  for (const layout of ["shared", "siblings", "cargo-root", "deno-root"]) {
    for (const failure of ["none", "check", "unit"]) {
      await withTree({}, async (dir) => {
        const denoDir = ["siblings", "cargo-root"].includes(layout)
          ? `${dir}/web`
          : dir;
        const cargoDir = ["siblings", "deno-root"].includes(layout)
          ? `${dir}/engine`
          : dir;
        await Deno.mkdir(denoDir, { recursive: true });
        await Deno.mkdir(cargoDir, { recursive: true });
        await Deno.writeTextFile(`${cargoDir}/Cargo.toml`, CARGO_TOML);
        await Deno.writeTextFile(
          `${denoDir}/deno.json`,
          JSON.stringify({
            tasks: { check: "deno check main.ts", "test:unit": "deno test" },
          }),
        );
        const checks: string[] = [];
        const units: string[] = [];
        const bindings = bindingsFor(REASON, undefined, {
          checkMergedTree: (path, _runner, skip) =>
            checkMergedTree(path, (project) => {
              checks.push(project.kind);
              return Promise.resolve({
                code: failure === "check" ? 1 : 0,
                output: "type check",
              });
            }, skip),
          verifyResolvedTree: (path, _runner, typed, now, skip) =>
            verifyResolvedTree(
              path,
              (task) => {
                units.push(task.kind);
                return Promise.resolve({
                  code: failure === "unit" ? 1 : 0,
                  output: "unit suite",
                });
              },
              typed,
              now,
              skip,
            ),
        });
        const merged = await bindings.mergeGate(dir);
        assertEquals(merged.status, failure === "check" ? "failed" : "passed");
        const resolved = await bindings.resolutionGate(dir);
        assertEquals(resolved.status, failure === "none" ? "passed" : "failed");
        assertEquals(resolved.landUnverified, undefined);
        assertEquals(checks, ["deno", "deno"], "cargo is never checked");
        assertEquals(
          units,
          failure === "check" ? [] : ["deno"],
          "cargo is never tested",
        );
      });
    }
  }
});

Deno.test("merge-only e2e - a failing Deno check in a mixed tree refuses the push (PR #4343)", async () => {
  const f = await fixture({
    milestone: ["deno.json", DENO_JSON],
    main: ["default.txt", "new default"],
  });
  try {
    const before = await remoteSha(f.remote, MILESTONE);
    const checked: string[] = [];
    const bindings = bindingsFor(REASON, undefined, {
      checkMergedTree: (dir, _runner, skip) =>
        checkMergedTree(dir, (project) => {
          checked.push(project.kind);
          return Promise.resolve({ code: 1, output: "broken Deno code" });
        }, skip),
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
    assertEquals(result.ok, false);
    assertEquals(checked, ["deno"]);
    assertEquals(await remoteSha(f.remote, MILESTONE), before);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("merge-only e2e - root Cargo cannot hide a failing nested Deno resolution suite (PR #4343)", async () => {
  const f = await fixture({
    milestone: ["shared.txt", "a\nB\nc\n"],
    main: ["shared.txt", "a\nB\nB2\nc\n"],
  });
  try {
    await Deno.mkdir(`${f.clone}/web`);
    await Deno.writeTextFile(
      `${f.clone}/web/deno.json`,
      JSON.stringify({
        tasks: { check: "deno check main.ts", "test:unit": "deno test" },
      }),
    );
    await git(["add", "web/deno.json"], f.clone);
    await git(["commit", "-m", "nested Deno project"], f.clone);
    await git(["push", "origin", MILESTONE], f.clone);
    const before = await remoteSha(f.remote, MILESTONE);
    const checked: string[] = [];
    const tested: string[] = [];
    const bindings = bindingsFor(REASON, undefined, {
      checkMergedTree: (dir, _runner, skip) =>
        checkMergedTree(dir, (project) => {
          checked.push(project.kind);
          return Promise.resolve({ code: 0, output: "" });
        }, skip),
      verifyResolvedTree: (dir, _runner, typed, now, skip) =>
        verifyResolvedTree(
          dir,
          (task) => {
            tested.push(task.kind);
            return Promise.resolve({
              code: 1,
              output: "nested Deno regression",
            });
          },
          typed,
          now,
          skip,
        ),
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
    assertEquals(result.ok, false, "the resolved conflict must not be pushed");
    assert(checked.length > 0, "the nested Deno check must run");
    assert(checked.every((kind) => kind === "deno"), "cargo stays skipped");
    assert(tested.length > 0, "the failing nested Deno suite must run");
    assert(tested.every((kind) => kind === "deno"), "cargo stays skipped");
    assertEquals(await remoteSha(f.remote, MILESTONE), before);
    assertEquals(await mergeInProgress(f.clone), false);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});
