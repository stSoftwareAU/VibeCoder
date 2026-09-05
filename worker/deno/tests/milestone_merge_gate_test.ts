/**
 * Tests for the milestone merge type-check gate (Issue #974).
 *
 * The `main` → `milestone/<name>` sync pushed whatever the merge produced,
 * so a resolution that dropped live wiring reached the branch and nothing
 * downstream noticed. These tests cover the gate itself: locating the
 * repository's own type check, running it against the merged tree, and the
 * typed refusal the sync raises when the tree does not compile.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildMergeGateEscalationComment,
  checkMergedTree,
  findTypeCheckProjects,
  isMergeGateFailure,
  mergeGateFailureError,
  type TypeCheckProject,
} from "../lib/milestone_merge_gate.ts";

/** Write a file, creating its parent directory. */
async function writeFile(path: string, contents: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, contents);
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "issue-974-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("findTypeCheckProjects - prefers the repo's own `check` task (Issue #974)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      `${dir}/deno.json`,
      JSON.stringify({ tasks: { check: "deno check '**/*.ts'" } }),
    );
    const projects = await findTypeCheckProjects(dir);
    assertEquals(projects.length, 1, "a root deno.json is one project");
    assertEquals(projects[0]!.dir, dir);
    assertEquals(projects[0]!.args, ["task", "check"]);
  });
});

Deno.test("findTypeCheckProjects - reads a `check` task out of a commented deno.jsonc (Issue #974)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      `${dir}/deno.jsonc`,
      `{\n  // the repo's own gate\n  "tasks": { "check": "deno check" }\n}\n`,
    );
    const projects = await findTypeCheckProjects(dir);
    assertEquals(projects[0]!.args, ["task", "check"]);
  });
});

Deno.test("findTypeCheckProjects - finds a nested project and falls back to `deno check` (Issue #974)", async () => {
  await withTempDir(async (dir) => {
    // This repository's own shape: the Deno project lives in worker/deno.
    await writeFile(`${dir}/README.md`, "root\n");
    await writeFile(`${dir}/worker/deno/deno.json`, JSON.stringify({}));
    const projects = await findTypeCheckProjects(dir);
    assertEquals(projects.length, 1, "a nested deno.json is found");
    assertEquals(projects[0]!.dir, `${dir}/worker/deno`);
    assertEquals(projects[0]!.args, ["check", "**/*.ts"]);
  });
});

Deno.test("findTypeCheckProjects - finds EVERY project, not just the first (Issue #974)", async () => {
  await withTempDir(async (dir) => {
    // This repository's real shape: a one-file seed project sits beside the
    // worker. Checking whichever the filesystem happened to return first
    // would let a broken worker tree through behind a seed that always passes.
    await writeFile(`${dir}/container/deno-seed/deno.json`, JSON.stringify({}));
    await writeFile(`${dir}/worker/deno/deno.json`, JSON.stringify({}));
    const dirs = (await findTypeCheckProjects(dir)).map((p) => p.dir);
    assertEquals(
      dirs,
      [`${dir}/container/deno-seed`, `${dir}/worker/deno`],
      "both projects are checked, in a deterministic order",
    );
  });
});

Deno.test("findTypeCheckProjects - no manifest means no project (Issue #974)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/src/main.rs`, "fn main() {}\n");
    assertEquals(await findTypeCheckProjects(dir), []);
  });
});

Deno.test("checkMergedTree - a clean tree passes (Issue #974)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/deno.json`, JSON.stringify({}));
    const outcome = await checkMergedTree(
      dir,
      () => Promise.resolve({ code: 0, output: "Check file:///x.ts" }),
    );
    assertEquals(outcome.status, "passed");
    assertStringIncludes(outcome.detail, "deno check");
  });
});

Deno.test("checkMergedTree - a non-compiling tree fails and carries the output (Issue #974)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/deno.json`, JSON.stringify({}));
    const outcome = await checkMergedTree(dir, () =>
      Promise.resolve({
        code: 1,
        output: "TS2339 [ERROR]: Property 'onSlotIdle' does not exist",
      }));
    assertEquals(outcome.status, "failed");
    assertStringIncludes(outcome.output, "Property 'onSlotIdle'");
  });
});

Deno.test("checkMergedTree - a repo with no Deno project is skipped, not run (Issue #974)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/Cargo.toml`, "[package]\n");
    let ran = false;
    const outcome = await checkMergedTree(dir, () => {
      ran = true;
      return Promise.resolve({ code: 0, output: "" });
    });
    assertEquals(outcome.status, "skipped");
    assertEquals(ran, false, "no check is spawned when there is none to run");
    assertStringIncludes(outcome.detail, "not type-checked");
  });
});

Deno.test("checkMergedTree - a check that cannot be run fails rather than passing (Issue #974)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/deno.json`, JSON.stringify({}));
    const outcome = await checkMergedTree(dir, () => {
      throw new Error("deno: command not found");
    });
    // Absence of a failure is not success — an unverifiable tree is not pushed.
    assertEquals(outcome.status, "failed");
    assertStringIncludes(outcome.output, "command not found");
  });
});

Deno.test("checkMergedTree - real `deno check` rejects a broken tree (Issue #974)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/deno.json`, JSON.stringify({}));
    await writeFile(
      `${dir}/broken.ts`,
      "const n: number = 'not a number';\nexport default n;\n",
    );
    const outcome = await checkMergedTree(dir);
    assertEquals(outcome.status, "failed");
    assertStringIncludes(outcome.output, "TS2322");
  });
});

Deno.test("checkMergedTree - real `deno check` accepts a sound tree (Issue #974)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/deno.json`, JSON.stringify({}));
    await writeFile(`${dir}/sound.ts`, "export const n: number = 1;\n");
    const outcome = await checkMergedTree(dir);
    assertEquals(outcome.status, "passed", outcome.output);
  });
});

Deno.test("mergeGateFailureError - is typed so the sync can escalate on it (Issue #974)", () => {
  const err = mergeGateFailureError("milestone/x", "main", {
    status: "failed",
    detail: "deno task check in /w/deno failed (exit 1)",
    output: "TS2339 [ERROR]: Property 'onSlotIdle' does not exist",
  });
  assert(isMergeGateFailure(err));
  assert(
    !isMergeGateFailure(new Error("refusing to merge unrelated histories")),
  );
  assertStringIncludes(err.message, "milestone/x");
  assertStringIncludes(err.message, "main");
  assertStringIncludes(err.message, "onSlotIdle");
});

Deno.test("buildMergeGateEscalationComment - names the merge and the check output (Issue #974)", () => {
  const body = buildMergeGateEscalationComment({
    repo: "owner/repo",
    milestoneBranch: "milestone/x",
    defaultBranch: "main",
    reason: "deno task check failed: TS2339 Property 'onSlotIdle'",
  });
  assertStringIncludes(body, "needs a human");
  assertStringIncludes(body, "milestone/x");
  assertStringIncludes(body, "main");
  assertStringIncludes(body, "onSlotIdle");
  assertStringIncludes(body, "not pushed");
});

Deno.test("checkMergedTree - a tree the gate cannot read fails, it is not assumed clean (Issue #974)", async () => {
  const missing = "/nonexistent-path-for-issue-974";
  const projects: TypeCheckProject[] = await findTypeCheckProjects(missing);
  assertEquals(projects, []);
  const outcome = await checkMergedTree(
    missing,
    () => Promise.resolve({ code: 0, output: "" }),
  );
  // "skipped" is the push-anyway branch — an unreadable tree must not take it.
  assertEquals(outcome.status, "failed");
  assertStringIncludes(outcome.detail, "could not be read");
});

Deno.test("checkMergedTree - every project is checked, so a passing one cannot mask a failing one (Issue #974)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/container/deno-seed/deno.json`, JSON.stringify({}));
    await writeFile(`${dir}/worker/deno/deno.json`, JSON.stringify({}));
    const seen: string[] = [];
    const outcome = await checkMergedTree(dir, (project) => {
      seen.push(project.dir);
      // The seed passes; the worker does not.
      return Promise.resolve(
        project.dir.endsWith("worker/deno")
          ? { code: 1, output: "TS2339 [ERROR]: Property 'onSlotIdle'" }
          : { code: 0, output: "" },
      );
    });
    assertEquals(outcome.status, "failed");
    assertStringIncludes(outcome.output, "onSlotIdle");
    assertEquals(seen.length, 2, "the passing project did not end the sweep");
  });
});
