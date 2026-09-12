/**
 * The "ported" rung (Issue #2023).
 *
 * Real git for everything that asks history a question — whether a branch
 * ever carried a byte-identical version of a file — because a stub of git
 * answers none of that honestly. The shape and stage parsing are pure and
 * tested as such.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyConflictShape,
  decidePorted,
  DEFAULT_SHAPE_THRESHOLDS,
  describeConflictShape,
  isWrongBaseShape,
  parseStageBlobs,
  readStageBlobs,
  resolvePortedPaths,
} from "../lib/milestone_conflict_ported.ts";
import {
  climbConflictLadder,
  listUnmergedPaths,
  type MilestoneConflictAgentRequest,
} from "../lib/milestone_conflict_ladder.ts";
import type { FileDecision } from "../lib/milestone_conflict_triage.ts";
import type { DeterministicConflictReport } from "../lib/dependency_conflict_apply.ts";

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

Deno.test("classifyConflictShape - counts files, add/add pairs and their directories", () => {
  const shape = classifyConflictShape([
    { path: "src/a.ts", hasBase: true },
    { path: "src/b.ts", hasBase: false },
    { path: "src/c.ts", hasBase: false },
    { path: "web/d.ts", hasBase: false },
    { path: "README.md", hasBase: false },
  ]);
  assertEquals(shape, { files: 5, addAdd: 4, addAddDirectories: 3 });
  assertEquals(
    describeConflictShape(shape),
    "5 conflicted file(s), 4 add/add across 3 directories",
  );
});

Deno.test("isWrongBaseShape - too many files, or add/add in more than one directory", () => {
  assertEquals(
    isWrongBaseShape({ files: 3, addAdd: 0, addAddDirectories: 0 }),
    false,
  );
  assertEquals(
    isWrongBaseShape({ files: 21, addAdd: 0, addAddDirectories: 0 }),
    true,
  );
  assertEquals(
    isWrongBaseShape({ files: 4, addAdd: 3, addAddDirectories: 1 }),
    false,
    "one directory of add/add pairs is one feature written twice",
  );
  assertEquals(
    isWrongBaseShape({ files: 4, addAdd: 3, addAddDirectories: 2 }),
    true,
  );
  assertEquals(
    isWrongBaseShape({ files: 2, addAdd: 0, addAddDirectories: 0 }, {
      maxFiles: 1,
      maxAddAddDirectories: 1,
    }),
    true,
  );
  assertEquals(DEFAULT_SHAPE_THRESHOLDS, {
    maxFiles: 20,
    maxAddAddDirectories: 1,
  });
});

Deno.test("parseStageBlobs - one entry per path, the blob of each stage", () => {
  const out = [
    "100644 aaaa 1\tseed.ts",
    "100644 bbbb 2\tseed.ts",
    "100644 cccc 3\tseed.ts",
    "100644 dddd 2\ta/one.ts",
    "100644 eeee 3\ta/one.ts",
    "",
  ].join("\n");
  const stages = parseStageBlobs(out);
  assertEquals(stages.get("seed.ts"), {
    base: "aaaa",
    ours: "bbbb",
    theirs: "cccc",
  });
  assertEquals(stages.get("a/one.ts"), { ours: "dddd", theirs: "eeee" });
});

// ---------------------------------------------------------------------------
// Real git
// ---------------------------------------------------------------------------

async function git(args: string[], cwd: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = new TextDecoder();
  if (out.code !== 0 && !args.includes("merge")) {
    throw new Error(`git ${args.join(" ")}: ${decode.decode(out.stderr)}`);
  }
  return decode.decode(out.stdout);
}

async function write(dir: string, path: string, text: string): Promise<void> {
  const slash = path.lastIndexOf("/");
  if (slash > 0) {
    await Deno.mkdir(`${dir}/${path.slice(0, slash)}`, { recursive: true });
  }
  await Deno.writeTextFile(`${dir}/${path}`, text);
}

async function commitAll(dir: string, message: string): Promise<string> {
  await git(["add", "-A"], dir);
  await git(["commit", "-q", "-m", message], dir);
  return (await git(["rev-parse", "HEAD"], dir)).trim();
}

interface Fixture {
  dir: string;
  cleanup: () => Promise<void>;
  conflicted: string[];
}

/**
 * The squash-rewrite shape (Issue #2023).
 *
 * The milestone made three commits (two new files, one edit). Another
 * milestone carried the same content to `main` as one squash, so no patch is
 * equivalent; `main` then edited two of those files. Merging `main` into the
 * milestone conflicts on both — an add/add pair and a content conflict —
 * although `main`'s versions contain the milestone's byte for byte, one
 * commit back. The milestone also has genuinely new work of its own.
 */
async function squashRewrite(): Promise<Fixture & { squash: string }> {
  const dir = await Deno.makeTempDir({ prefix: "issue-2023-squash-" });
  await git(["init", "-q", "--initial-branch=main", "."], dir);
  await git(["config", "user.email", "t@example.com"], dir);
  await git(["config", "user.name", "Test"], dir);
  await write(dir, "seed.ts", "export const v = 1;\n");
  await commitAll(dir, "Seed");
  await git(["checkout", "-q", "-b", "milestone/2023"], dir);
  await write(dir, "a/one.ts", "export const one = 1;\n");
  await commitAll(dir, "Add one (#1)");
  await write(dir, "b/two.ts", "export const two = 2;\n");
  await commitAll(dir, "Add two (#2)");
  await write(dir, "seed.ts", "export const v = 2;\n");
  await commitAll(dir, "Bump seed (#3)");
  await write(dir, "c/three.ts", "export const three = 3;\n");
  await commitAll(dir, "Add three (#4)");

  await git(["checkout", "-q", "main"], dir);
  await write(dir, "a/one.ts", "export const one = 1;\n");
  await write(dir, "b/two.ts", "export const two = 2;\n");
  await write(dir, "seed.ts", "export const v = 2;\n");
  const squash = await commitAll(
    dir,
    "Squash of the milestone via another milestone",
  );
  await write(dir, "a/one.ts", "export const one = 11;\n");
  await commitAll(dir, "Main edits one");
  await write(dir, "seed.ts", "export const v = 3;\n");
  await commitAll(dir, "Main bumps seed again");

  await git(["checkout", "-q", "milestone/2023"], dir);
  await git(["merge", "main", "--no-edit"], dir); // conflicts, by design
  const conflicted =
    (await git(["diff", "--name-only", "--diff-filter=U"], dir))
      .trim().split("\n").filter(Boolean).sort();
  return {
    dir,
    squash,
    conflicted,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => {}),
  };
}

Deno.test("readStageBlobs - an add/add path has no base stage; a content conflict does", async () => {
  const fx = await squashRewrite();
  try {
    assertEquals(fx.conflicted, ["a/one.ts", "seed.ts"]);
    const stages = await readStageBlobs(fx.conflicted, { cwd: fx.dir });
    assert(stages.ok);
    assertEquals(stages.value.get("a/one.ts")?.base, undefined, "add/add");
    assert(stages.value.get("seed.ts")?.base, "content conflict has a base");
    assert(
      stages.value.get("a/one.ts")?.ours &&
        stages.value.get("a/one.ts")?.theirs,
    );
  } finally {
    await fx.cleanup();
  }
});

Deno.test("decidePorted - main's history carries the milestone's exact version, so main's version is taken (Issue #2023)", async () => {
  const fx = await squashRewrite();
  try {
    const stages = await readStageBlobs(fx.conflicted, { cwd: fx.dir });
    assert(stages.ok);
    for (const path of fx.conflicted) {
      const verdict = await decidePorted(
        path,
        stages.value.get(path)!,
        "HEAD",
        "main",
        {
          cwd: fx.dir,
        },
      );
      assertEquals(verdict.kind, "theirs", path);
      if (verdict.kind === "theirs") {
        // `--find-object` names the newest commit that introduced or replaced
        // the blob; either is proof main carried the milestone's version.
        const onMain =
          (await git(["log", "--format=%H", "main", "--", path], fx.dir))
            .trim().split("\n");
        assert(
          onMain.includes(verdict.carriedBy),
          `${path}: carried by a main commit`,
        );
      }
    }
  } finally {
    await fx.cleanup();
  }
});

Deno.test("resolvePortedPaths - settles every ported path from main, stages it, and leaves the milestone's own work alone", async () => {
  const fx = await squashRewrite();
  try {
    const logs: string[] = [];
    const outcome = await resolvePortedPaths({
      paths: fx.conflicted,
      options: { cwd: fx.dir },
      milestoneBranch: "milestone/2023",
      defaultBranch: "main",
      thresholds: { maxFiles: 1, maxAddAddDirectories: 5 },
      log: (m) => logs.push(m),
    });
    assertEquals(outcome.undecided, []);
    assertEquals(outcome.resolved.map((r) => `${r.path}:${r.side}`).sort(), [
      "a/one.ts:theirs",
      "seed.ts:theirs",
    ]);
    assertEquals(outcome.shape, { files: 2, addAdd: 1, addAddDirectories: 1 });
    const unmerged = await listUnmergedPaths({ cwd: fx.dir });
    assert(unmerged.ok);
    assertEquals(unmerged.value, []);
    assertEquals(
      await Deno.readTextFile(`${fx.dir}/a/one.ts`),
      "export const one = 11;\n",
    );
    assertEquals(
      await Deno.readTextFile(`${fx.dir}/seed.ts`),
      "export const v = 3;\n",
    );
    assertEquals(
      await Deno.readTextFile(`${fx.dir}/c/three.ts`),
      "export const three = 3;\n",
      "the milestone's own new work is untouched",
    );
    assert(
      logs.some((l) => l.includes("wrong-base shape")),
      "the shape is logged",
    );
    assert(logs.some((l) => l.includes("ported rule settled 2 of 2")));
  } finally {
    await fx.cleanup();
  }
});

Deno.test("resolvePortedPaths - the symmetric case: the milestone carried main's exact version and moved on, so ours is taken", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2023-sym-" });
  try {
    await git(["init", "-q", "--initial-branch=main", "."], dir);
    await git(["config", "user.email", "t@example.com"], dir);
    await git(["config", "user.name", "Test"], dir);
    await write(dir, "seed.ts", "export const v = 1;\n");
    await commitAll(dir, "Seed");
    await git(["checkout", "-q", "-b", "milestone/2023"], dir);
    await write(dir, "seed.ts", "export const v = 5;\n");
    await commitAll(dir, "Milestone takes main's future value");
    await write(dir, "seed.ts", "export const v = 6;\n");
    await commitAll(dir, "Milestone moves on");
    await git(["checkout", "-q", "main"], dir);
    await write(dir, "seed.ts", "export const v = 5;\n");
    await commitAll(dir, "Main lands the same value");
    await git(["checkout", "-q", "milestone/2023"], dir);
    await git(["merge", "main", "--no-edit"], dir);
    const outcome = await resolvePortedPaths({
      paths: ["seed.ts"],
      options: { cwd: dir },
      milestoneBranch: "milestone/2023",
      defaultBranch: "main",
    });
    assertEquals(outcome.resolved.map((r) => r.side), ["ours"]);
    assertEquals(
      await Deno.readTextFile(`${dir}/seed.ts`),
      "export const v = 6;\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("resolvePortedPaths - a genuine rival design is left undecided and unmerged", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2023-rival-" });
  try {
    await git(["init", "-q", "--initial-branch=main", "."], dir);
    await git(["config", "user.email", "t@example.com"], dir);
    await git(["config", "user.name", "Test"], dir);
    await write(dir, "seed.ts", "export const v = 1;\n");
    await commitAll(dir, "Seed");
    await git(["checkout", "-q", "-b", "milestone/2023"], dir);
    await write(dir, "seed.ts", "export const v = 2;\n");
    await commitAll(dir, "Milestone design");
    await git(["checkout", "-q", "main"], dir);
    await write(dir, "seed.ts", "export const v = 9;\n");
    await commitAll(dir, "Main's rival design");
    await git(["checkout", "-q", "milestone/2023"], dir);
    await git(["merge", "main", "--no-edit"], dir);
    const outcome = await resolvePortedPaths({
      paths: ["seed.ts"],
      options: { cwd: dir },
      milestoneBranch: "milestone/2023",
      defaultBranch: "main",
    });
    assertEquals(outcome.resolved, []);
    assertEquals(outcome.undecided.length, 1);
    assertStringIncludes(
      outcome.undecided[0]!.reason,
      "neither branch's history",
    );
    const unmerged = await listUnmergedPaths({ cwd: dir });
    assert(unmerged.ok);
    assertEquals(unmerged.value, ["seed.ts"], "nothing was staged");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("resolvePortedPaths - an unsafe branch name is refused before any git runs", async () => {
  const fx = await squashRewrite();
  try {
    const outcome = await resolvePortedPaths({
      paths: fx.conflicted,
      options: { cwd: fx.dir },
      milestoneBranch: "--upload-pack=evil",
      defaultBranch: "main",
    });
    assertEquals(outcome.resolved, []);
    assertEquals(outcome.undecided.length, 2);
    const unmerged = await listUnmergedPaths({ cwd: fx.dir });
    assert(unmerged.ok);
    assertEquals(unmerged.value, fx.conflicted);
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// In the ladder
// ---------------------------------------------------------------------------

const rulesDeferEverything = (
  options: { conflictedFiles: readonly string[] },
): Promise<DeterministicConflictReport> =>
  Promise.resolve({
    resolved: [],
    deferred: options.conflictedFiles.map((path) => ({
      path,
      reason: "no deterministic rule handles this file",
    })),
  });

function undecided(paths: readonly string[]): FileDecision[] {
  return paths.map((path) => ({
    path,
    case: "rival-designs",
    action: "escalate",
    reason: "neither side contains the other",
  }));
}

Deno.test("climbConflictLadder - the ported rung settles a squash rewrite before the agent is asked (Issue #2023)", async () => {
  const fx = await squashRewrite();
  try {
    const agentRequests: MilestoneConflictAgentRequest[] = [];
    const outcome = await climbConflictLadder({
      escalations: undecided(fx.conflicted),
      options: { cwd: fx.dir },
      milestoneBranch: "milestone/2023",
      defaultBranch: "main",
      applyRulesFn: rulesDeferEverything,
      agentFn: (request) => {
        agentRequests.push(request);
        return Promise.resolve({ ok: true, value: { terminated: false } });
      },
    });
    assertEquals(agentRequests, [], "the agent rung was never reached");
    assertEquals(outcome.escalations, []);
    assertEquals(outcome.resolved.map((d) => d.path).sort(), fx.conflicted);
    assert(
      outcome.resolved.every((d) =>
        d.rung === "ported" && d.action === "resolved"
      ),
    );
    assertStringIncludes(
      outcome.resolved[0]!.reason,
      "'main' already carried this exact version",
    );
  } finally {
    await fx.cleanup();
  }
});

Deno.test("climbConflictLadder - what the ported rung cannot prove goes to the agent, narrowed to those paths (Issue #2023)", async () => {
  const fx = await squashRewrite();
  try {
    // A third conflicted path nobody's history explains.
    const agentRequests: MilestoneConflictAgentRequest[] = [];
    const outcome = await climbConflictLadder({
      escalations: undecided([...fx.conflicted, "d/rival.ts"]),
      options: { cwd: fx.dir },
      milestoneBranch: "milestone/2023",
      defaultBranch: "main",
      applyRulesFn: rulesDeferEverything,
      portedFn: (request) =>
        Promise.resolve({
          shape: {
            files: request.paths.length,
            addAdd: 1,
            addAddDirectories: 1,
          },
          resolved: request.paths
            .filter((p) => p !== "d/rival.ts")
            .map((path) => ({
              path,
              side: "theirs" as const,
              carriedBy: fx.squash,
            })),
          undecided: [{
            path: "d/rival.ts",
            reason: "neither branch's history carries it",
          }],
        }),
      agentFn: (request) => {
        agentRequests.push(request);
        return Promise.resolve({ ok: true, value: { terminated: false } });
      },
    });
    assertEquals(agentRequests.length, 1);
    assertEquals(agentRequests[0]!.conflictedFiles, ["d/rival.ts"]);
    assertEquals(
      outcome.resolved.filter((d) => d.rung === "ported").map((d) => d.path)
        .sort(),
      fx.conflicted,
    );
  } finally {
    await fx.cleanup();
  }
});
