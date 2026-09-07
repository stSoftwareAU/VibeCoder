/**
 * The gate an automatic conflict resolution must pass (Issue #1559).
 *
 * A resolution the worker made itself is verified the way a human's would be:
 * the merged tree must pass the repository's own check, its manifest check and
 * its unit suite. A tree nothing could verify is not a verified tree, so the
 * gate reports `skipped` and the sync refuses to push on it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  RESOLUTION_GATE_TASKS,
  type ResolutionTask,
  verifyResolvedTree,
} from "../lib/milestone_resolution_gate.ts";

async function tree(tasks: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "issue-1559-gate-" });
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({ tasks }, null, 2),
  );
  return dir;
}

Deno.test("verifyResolvedTree - runs the repo's check, manifest check and unit suite", async () => {
  const dir = await tree({
    check: "deno check",
    "check:manifests": "deno run check_manifests.ts",
    "test:unit": "deno run unit_test_runner.ts",
    lint: "deno lint",
  });
  const ran: string[] = [];
  try {
    const outcome = await verifyResolvedTree(dir, (task: ResolutionTask) => {
      ran.push(task.task);
      return Promise.resolve({ code: 0, output: "" });
    });

    assertEquals(outcome.status, "passed");
    assertEquals(ran, ["check", "check:manifests", "test:unit"]);
    assertStringIncludes(outcome.detail, "check:manifests");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("verifyResolvedTree - falls back to the 'test' task when there is no unit task", async () => {
  const dir = await tree({ check: "deno check", test: "deno test" });
  const ran: string[] = [];
  try {
    const outcome = await verifyResolvedTree(dir, (task: ResolutionTask) => {
      ran.push(task.task);
      return Promise.resolve({ code: 0, output: "" });
    });

    assertEquals(outcome.status, "passed");
    assertEquals(ran, ["check", "test"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("verifyResolvedTree - a failing task fails the gate and carries its output", async () => {
  const dir = await tree({ check: "deno check", "test:unit": "deno test" });
  try {
    const outcome = await verifyResolvedTree(
      dir,
      (task: ResolutionTask) =>
        Promise.resolve(
          task.task === "test:unit"
            ? { code: 1, output: "FAILED tests/spawn_test.ts" }
            : { code: 0, output: "" },
        ),
    );

    assertEquals(outcome.status, "failed");
    assertStringIncludes(outcome.detail, "test:unit");
    assertStringIncludes(outcome.output, "FAILED tests/spawn_test.ts");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("verifyResolvedTree - a task that cannot be run fails rather than passing", async () => {
  const dir = await tree({ check: "deno check" });
  try {
    const outcome = await verifyResolvedTree(dir, () => {
      throw new Error("deno is not on PATH");
    });

    assertEquals(outcome.status, "failed");
    assertStringIncludes(outcome.output, "deno is not on PATH");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("verifyResolvedTree - a tree with no verifiable task is skipped, never passed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1559-gate-" });
  try {
    const outcome = await verifyResolvedTree(
      dir,
      () => Promise.resolve({ code: 0, output: "" }),
    );

    assertEquals(outcome.status, "skipped");
    assertStringIncludes(outcome.detail, "no");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("verifyResolvedTree - an unreadable tree fails rather than being skipped", async () => {
  const outcome = await verifyResolvedTree(
    "/nonexistent/issue-1559",
    () => Promise.resolve({ code: 0, output: "" }),
  );

  assertEquals(outcome.status, "failed");
});

Deno.test("RESOLUTION_GATE_TASKS - names the three checks the issue requires", () => {
  assert(RESOLUTION_GATE_TASKS.includes("check"));
  assert(RESOLUTION_GATE_TASKS.includes("check:manifests"));
  assert(
    RESOLUTION_GATE_TASKS.includes("test:unit") ||
      RESOLUTION_GATE_TASKS.includes("test"),
  );
});
