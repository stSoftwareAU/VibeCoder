/**
 * The gate an automatic conflict resolution must pass (Issue #1559).
 *
 * A resolution the worker made itself is verified the way a human's would be:
 * the merged tree must pass the repository's own Issue #974 type check, its
 * manifest check and its unit suite. A tree nothing could verify is not a
 * verified tree, so the gate reports `skipped` and the sync refuses to push
 * on it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  RESOLUTION_GATE_BUDGET_MS,
  type ResolutionTask,
  resolutionTasksFor,
  verifyResolvedTree,
} from "../lib/milestone_resolution_gate.ts";
import type {
  MergeGateFn,
  MergeGateOutcome,
} from "../lib/milestone_merge_gate.ts";

const passingTypeCheck: MergeGateFn = () =>
  Promise.resolve({
    status: "passed" as const,
    detail: "deno task check passed",
    output: "",
  });

async function tree(tasks: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "issue-1559-gate-" });
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({ tasks }, null, 2),
  );
  return dir;
}

/** Run the gate over a temporary tree and clean it up afterwards. */
async function gate(
  tasks: Record<string, string>,
  runner: (task: ResolutionTask) => Promise<{ code: number; output: string }>,
  options: {
    typeCheck?: MergeGateFn;
    clock?: () => number;
    manifest?: boolean;
  } = {},
): Promise<{ outcome: MergeGateOutcome; dir: string }> {
  const dir = options.manifest === false
    ? await Deno.makeTempDir({ prefix: "issue-1559-gate-" })
    : await tree(tasks);
  try {
    return {
      outcome: await verifyResolvedTree(
        dir,
        runner,
        options.typeCheck ?? passingTypeCheck,
        options.clock,
      ),
      dir,
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("resolutionTasksFor - the manifest check and one unit suite, most specific first", () => {
  assertEquals(
    resolutionTasksFor(["check", "check:manifests", "test:unit", "test"]),
    ["check:manifests", "test:unit"],
    "the type check is the Issue #974 gate's, not this one's, and `test` yields to `test:unit`",
  );
  assertEquals(resolutionTasksFor(["check", "test"]), ["test"]);
  assertEquals(resolutionTasksFor(["lint", "fmt"]), []);
});

Deno.test("verifyResolvedTree - runs the repo's type check, manifest check and unit suite", async () => {
  const ran: string[] = [];
  const { outcome } = await gate(
    {
      check: "deno check",
      "check:manifests": "deno run check_manifests.ts",
      "test:unit": "deno run unit_test_runner.ts",
      lint: "deno lint",
    },
    (task) => {
      ran.push(task.task);
      return Promise.resolve({ code: 0, output: "" });
    },
  );

  assertEquals(outcome.status, "passed");
  assertEquals(ran, ["check:manifests", "test:unit"]);
  assertStringIncludes(outcome.detail, "deno task check passed");
  assertStringIncludes(outcome.detail, "check:manifests");
});

Deno.test("verifyResolvedTree - falls back to the 'test' task when there is no unit task", async () => {
  const ran: string[] = [];
  const { outcome } = await gate(
    { check: "deno check", test: "deno test" },
    (task) => {
      ran.push(task.task);
      return Promise.resolve({ code: 0, output: "" });
    },
  );

  assertEquals(outcome.status, "passed");
  assertEquals(ran, ["test"]);
});

Deno.test("verifyResolvedTree - a failing task fails the gate and carries its output", async () => {
  const { outcome } = await gate(
    { check: "deno check", "test:unit": "deno test" },
    (task) =>
      Promise.resolve(
        task.task === "test:unit"
          ? { code: 1, output: "FAILED tests/spawn_test.ts" }
          : { code: 0, output: "" },
      ),
  );

  assertEquals(outcome.status, "failed");
  assertStringIncludes(outcome.detail, "test:unit");
  assertStringIncludes(outcome.output, "FAILED tests/spawn_test.ts");
});

Deno.test("verifyResolvedTree - a failing Issue #974 type check fails the gate before anything else runs", async () => {
  const ran: string[] = [];
  const { outcome } = await gate(
    { check: "deno check", "test:unit": "deno test" },
    (task) => {
      ran.push(task.task);
      return Promise.resolve({ code: 0, output: "" });
    },
    {
      typeCheck: () =>
        Promise.resolve({
          status: "failed" as const,
          detail: "deno task check failed (exit 1)",
          output: "TS2304",
        }),
    },
  );

  assertEquals(outcome.status, "failed");
  assertEquals(ran, [], "nothing runs on a tree that does not compile");
  assertStringIncludes(outcome.output, "TS2304");
});

Deno.test("verifyResolvedTree - a tree the type check skipped is skipped, never passed", async () => {
  const { outcome } = await gate(
    { "test:unit": "deno test" },
    () => Promise.resolve({ code: 0, output: "" }),
    {
      typeCheck: () =>
        Promise.resolve({
          status: "skipped" as const,
          detail: "no deno.json(c) — the merged tree was not type-checked",
          output: "",
        }),
    },
  );

  assertEquals(outcome.status, "skipped");
  assertStringIncludes(outcome.detail, "Issue #974");
});

Deno.test("verifyResolvedTree - a tree with no unit suite is skipped: nothing ran the cases", async () => {
  const { outcome } = await gate(
    { check: "deno check", lint: "deno lint" },
    () => Promise.resolve({ code: 0, output: "" }),
  );

  assertEquals(
    outcome.status,
    "skipped",
    "a type check alone does not show a dropped implementation",
  );
  assertStringIncludes(outcome.detail, "test:unit");
});

Deno.test("verifyResolvedTree - a task that cannot be run fails rather than passing", async () => {
  const { outcome } = await gate(
    { "test:unit": "deno test" },
    () => {
      throw new Error("deno is not on PATH");
    },
  );

  assertEquals(outcome.status, "failed");
  assertStringIncludes(outcome.output, "deno is not on PATH");
});

Deno.test("verifyResolvedTree - a verification that outruns its budget fails, it does not pass", async () => {
  // The clock jumps past the whole budget between the type check and the
  // first task, so no task can start.
  let calls = 0;
  const clock = () => (calls++ === 0 ? 0 : RESOLUTION_GATE_BUDGET_MS + 1);
  const ran: string[] = [];
  const { outcome } = await gate(
    { check: "deno check", "test:unit": "deno test" },
    (task) => {
      ran.push(task.task);
      return Promise.resolve({ code: 0, output: "" });
    },
    { clock },
  );

  assertEquals(outcome.status, "failed");
  assertEquals(ran, []);
  assertStringIncludes(outcome.detail, "budget");
});

Deno.test("verifyResolvedTree - each task is given only the budget that is left", async () => {
  const budgets: number[] = [];
  let ticks = 0;
  const clock = () => ticks++ * 1000;
  await gate(
    {
      check: "deno check",
      "check:manifests": "deno run check_manifests.ts",
      "test:unit": "deno test",
    },
    (task) => {
      budgets.push(task.timeoutMs);
      return Promise.resolve({ code: 0, output: "" });
    },
    { clock },
  );

  assertEquals(budgets.length, 2);
  assertEquals(
    budgets[1]! < budgets[0]!,
    true,
    "the second task gets what the first left",
  );
});

Deno.test("verifyResolvedTree - an unreadable tree fails rather than being skipped", async () => {
  const outcome = await verifyResolvedTree(
    "/nonexistent/issue-1559",
    () => Promise.resolve({ code: 0, output: "" }),
    passingTypeCheck,
  );

  assertEquals(outcome.status, "failed");
});

// ---------------------------------------------------------------------------
// Issue #2138 — a Cargo workspace is verified with cargo, not skipped
// ---------------------------------------------------------------------------

Deno.test("verifyResolvedTree - a Cargo tree runs cargo test --workspace as its unit suite (Issue #2138)", async () => {
  // NEAT-AI-Ockham: a Rust repo whose auto-resolved merge was refused every
  // cycle because the gate only knew `deno task`.
  const dir = await Deno.makeTempDir({ prefix: "issue-2138-gate-" });
  try {
    await Deno.writeTextFile(`${dir}/Cargo.toml`, '[package]\nname = "x"\n');
    await Deno.writeTextFile(`${dir}/Cargo.lock`, "# Cargo.lock\n");
    const seen: ResolutionTask[] = [];
    const outcome = await verifyResolvedTree(
      dir,
      (task) => {
        seen.push(task);
        return Promise.resolve({ code: 0, output: "test result: ok" });
      },
      passingTypeCheck,
    );
    assertEquals(outcome.status, "passed", outcome.detail);
    assertEquals(seen.length, 1);
    assertEquals(seen[0]!.kind, "cargo");
    assertEquals(seen[0]!.args, ["test", "--workspace", "--locked"]);
    assertStringIncludes(outcome.detail, "cargo test --workspace --locked in");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("verifyResolvedTree - a Cargo tree whose tests fail is refused with the output (Issue #2138)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2138-gate-" });
  try {
    await Deno.writeTextFile(`${dir}/Cargo.toml`, '[package]\nname = "x"\n');
    const outcome = await verifyResolvedTree(
      dir,
      () =>
        Promise.resolve({
          code: 101,
          output: "test prune::bias ... FAILED\ntest result: FAILED. 1 failed",
        }),
      passingTypeCheck,
    );
    assertEquals(outcome.status, "failed");
    assertStringIncludes(outcome.detail, "cargo test --workspace in");
    assertStringIncludes(outcome.output, "prune::bias");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// A repository whose suite runs through `quality.sh` (Issue #2388)
//
// Live incident: a monitored repository's tests run through `./quality.sh`
// (`node --test …` then `deno test …`) and its `deno.json` names no test task.
// The gate reported `skipped`, the sync treated that as a refusal it does not
// charge to the branch, and every issue of the milestone was claimed and
// dropped once an hour — ~150 times in a day — over a conflict the worker had
// already resolved correctly.
// ---------------------------------------------------------------------------

/** A tree with a `deno.json` and, optionally, a `quality.sh` beside it. */
async function gateWithQualityScript(
  tasks: Record<string, string>,
  runner: (task: ResolutionTask) => Promise<{ code: number; output: string }>,
  withScript = true,
): Promise<MergeGateOutcome> {
  const dir = await tree(tasks);
  try {
    if (withScript) {
      await Deno.writeTextFile(`${dir}/quality.sh`, "#!/bin/bash\nexit 0\n");
    }
    return await verifyResolvedTree(dir, runner, passingTypeCheck);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("verifyResolvedTree - no test task but a quality.sh: the script is the unit suite and the tree passes (Issue #2388)", async () => {
  const ran: ResolutionTask[] = [];
  const outcome = await gateWithQualityScript(
    { check: "deno check", lint: "deno lint" },
    (task) => {
      ran.push(task);
      return Promise.resolve({ code: 0, output: "" });
    },
  );

  assertEquals(outcome.status, "passed");
  assertEquals(ran.map((t) => t.kind), ["script"]);
  assertEquals(ran[0]?.args, ["quality.sh"]);
  assertStringIncludes(outcome.detail, "quality.sh");
});

Deno.test("verifyResolvedTree - a failing quality.sh refuses the resolution with its output (Issue #2388)", async () => {
  const outcome = await gateWithQualityScript(
    { check: "deno check" },
    () => Promise.resolve({ code: 1, output: "not ok 3 - dropped case" }),
  );

  assertEquals(outcome.status, "failed");
  assertStringIncludes(outcome.detail, "quality.sh");
  assertStringIncludes(outcome.output, "dropped case");
});

Deno.test("verifyResolvedTree - a repository with a test task runs the task, not quality.sh as well (Issue #2388)", async () => {
  const ran: ResolutionTask[] = [];
  const outcome = await gateWithQualityScript(
    { check: "deno check", test: "deno test" },
    (task) => {
      ran.push(task);
      return Promise.resolve({ code: 0, output: "" });
    },
  );

  assertEquals(outcome.status, "passed");
  assertEquals(ran.map((t) => t.kind), ["deno"]);
});

Deno.test("verifyResolvedTree - no test task and no quality.sh is still skipped (Issue #2388)", async () => {
  const outcome = await gateWithQualityScript(
    { check: "deno check" },
    () => Promise.resolve({ code: 0, output: "" }),
    false,
  );

  assertEquals(outcome.status, "skipped");
  assertStringIncludes(outcome.detail, "quality.sh");
});

Deno.test("verifyResolvedTree - quality.sh gets only the budget that is left; none left fails, never passes (Issue #2388)", async () => {
  const dir = await tree({ check: "deno check" });
  try {
    await Deno.writeTextFile(`${dir}/quality.sh`, "#!/bin/bash\nexit 0\n");
    let ticks = 0;
    // The clock is read once for the deadline, then jumps past it.
    const clock = () => (ticks++ === 0 ? 0 : RESOLUTION_GATE_BUDGET_MS + 1);
    let called = false;
    const outcome = await verifyResolvedTree(
      dir,
      () => {
        called = true;
        return Promise.resolve({ code: 0, output: "" });
      },
      passingTypeCheck,
      clock,
    );
    assertEquals(outcome.status, "failed");
    assertEquals(called, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
