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
  collapseRepeatedLines,
  detectRustToolchainGap,
  findTypeCheckProjects,
  isMergeGateFailure,
  mergeGateFailureError,
  type TypeCheckProject,
} from "../lib/milestone_merge_gate.ts";
import { assertLinearGrowth } from "./support/growth.ts";

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

Deno.test("checkMergedTree - a repo with no project of either kind is skipped, not run (Issues #974, #2138)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/README.md`, "# nothing to verify with\n");
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

Deno.test("findTypeCheckProjects - a Cargo workspace is a project checked with cargo, locked when a lockfile is committed (Issue #2138)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      `${dir}/Cargo.toml`,
      '[workspace]\nmembers = ["crates/a"]\n',
    );
    await writeFile(`${dir}/crates/a/Cargo.toml`, '[package]\nname = "a"\n');
    const unlocked = await findTypeCheckProjects(dir);
    assertEquals(unlocked.length, 1, "the member is covered by --workspace");
    assertEquals(unlocked[0]!.kind, "cargo");
    assertEquals(unlocked[0]!.args, ["check", "--workspace", "--all-targets"]);

    await writeFile(`${dir}/Cargo.lock`, "# Cargo.lock\n");
    const locked = await findTypeCheckProjects(dir);
    assertEquals(locked[0]!.args, [
      "check",
      "--workspace",
      "--all-targets",
      "--locked",
    ]);
  });
});

Deno.test("checkMergedTree - a Cargo tree is verified with cargo check through the runner (Issue #2138)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/Cargo.toml`, '[package]\nname = "x"\n');
    const seen: string[] = [];
    const passed = await checkMergedTree(dir, (project) => {
      seen.push(`${project.kind} ${project.args.join(" ")}`);
      return Promise.resolve({ code: 0, output: "Finished" });
    });
    assertEquals(passed.status, "passed");
    assertEquals(seen, ["cargo check --workspace --all-targets"]);
    assertStringIncludes(passed.detail, "cargo check --workspace");

    const failed = await checkMergedTree(dir, () =>
      Promise.resolve({
        code: 101,
        output: "error[E0425]: cannot find value `synapse` in this scope",
      }));
    assertEquals(failed.status, "failed");
    assertStringIncludes(failed.output, "E0425");
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

Deno.test("checkMergedTree - a host rustc older than the tree's rust-version is named as a toolchain gap, not an ordinary failure (Issue #3255)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/Cargo.toml`, '[package]\nname = "x"\n');
    const repeatedLine = "  neat_ai_discovery@0.74.279 requires rustc 1.99\n";
    const output = "error: rustc 1.98.0 is not supported by the following " +
      "packages:\n" + repeatedLine.repeat(40);
    const outcome = await checkMergedTree(
      dir,
      () => Promise.resolve({ code: 101, output }),
    );
    assertEquals(outcome.status, "failed");
    assertStringIncludes(outcome.detail, "rustc 1.98.0");
    assertStringIncludes(outcome.detail, "1.99");
    assertStringIncludes(outcome.detail, "container/tools.json");
    assertEquals(outcome.toolchainGap, {
      installed: "1.98.0",
      required: "1.99",
      packages: ["neat_ai_discovery@0.74.279"],
    });
    assertStringIncludes(
      outcome.output,
      "neat_ai_discovery@0.74.279 requires rustc 1.99 (×40)",
    );
  });
});

Deno.test("checkMergedTree - an ordinary cargo failure carries no toolchain gap (Issue #3255)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/Cargo.toml`, '[package]\nname = "x"\n');
    const outcome = await checkMergedTree(dir, () =>
      Promise.resolve({
        code: 101,
        output: "error[E0425]: cannot find value `synapse` in this scope",
      }));
    assertEquals(outcome.status, "failed");
    assertEquals(outcome.toolchainGap, undefined);
    assertEquals(
      outcome.detail,
      "cargo check --workspace --all-targets in " +
        `${dir} failed (exit 101)`,
    );
  });
});

/**
 * Cargo's refusal when only dependencies are too new: it appends the
 * `cargo update --precise` hint (`local_incompatible` false in cargo's
 * `ops/cargo_compile/mod.rs`), so a `Cargo.lock` change can fix it.
 */
const DEPENDENCY_ONLY_REFUSAL =
  "error: rustc 1.98.0 is not supported by the following package:\n" +
  "  some_dep@2.1.0 requires rustc 1.99\n" +
  "Either upgrade rustc or select compatible dependency versions with\n" +
  "`cargo update <name>@<current-ver> --precise <compatible-ver>`\n" +
  "where `<compatible-ver>` is the latest version supporting rustc 1.98.0\n";

Deno.test("detectRustToolchainGap - a dependency-only refusal is not a gap: cargo names a Cargo.lock remedy (Issue #3255 review)", () => {
  assertEquals(detectRustToolchainGap(DEPENDENCY_ONLY_REFUSAL), undefined);
});

Deno.test("checkMergedTree - a dependency-only rustc refusal stays an ordinary, repairable failure (Issue #3255 review)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/Cargo.toml`, '[package]\nname = "x"\n');
    const outcome = await checkMergedTree(
      dir,
      () => Promise.resolve({ code: 101, output: DEPENDENCY_ONLY_REFUSAL }),
    );
    assertEquals(outcome.status, "failed");
    assertEquals(outcome.toolchainGap, undefined);
    assertEquals(
      outcome.detail,
      "cargo check --workspace --all-targets in " +
        `${dir} failed (exit 101)`,
    );
  });
});

Deno.test("detectRustToolchainGap - a header and a requirement line together report the installed and required versions (Issue #3255)", () => {
  const gap = detectRustToolchainGap(
    "error: rustc 1.70.0 is not supported by the following packages:\n" +
      "  foo@1.2.3 requires rustc 1.80\n",
  );
  assertEquals(gap, {
    installed: "1.70.0",
    required: "1.80",
    packages: ["foo@1.2.3"],
  });
});

Deno.test("detectRustToolchainGap - a requirement line without a header leaves installed undefined (Issue #3255)", () => {
  const gap = detectRustToolchainGap("foo@1.2.3 requires rustc 1.80\n");
  assertEquals(gap, {
    installed: undefined,
    required: "1.80",
    packages: ["foo@1.2.3"],
  });
});

Deno.test("detectRustToolchainGap - the highest required version wins, and packages are deduplicated in first-seen order (Issue #3255)", () => {
  const gap = detectRustToolchainGap(
    "foo@1.0.0 requires rustc 1.75\n" +
      "bar@2.0.0 requires rustc 1.90\n" +
      "foo@1.0.0 requires rustc 1.75\n" +
      "baz@3.0.0 requires rustc 1.80\n",
  );
  assertEquals(gap?.required, "1.90");
  assertEquals(gap?.packages, ["foo@1.0.0", "bar@2.0.0", "baz@3.0.0"]);
});

Deno.test("detectRustToolchainGap - a malformed requirement line (no version, no package) is not a gap (Issue #3255)", () => {
  assertEquals(detectRustToolchainGap("foo requires rustc\n"), undefined);
  assertEquals(detectRustToolchainGap("requires rustc 1.99\n"), undefined);
});

Deno.test("detectRustToolchainGap - empty output is not a gap (Issue #3255)", () => {
  assertEquals(detectRustToolchainGap(""), undefined);
});

Deno.test("detectRustToolchainGap - a hostile header-shaped line returns in linear time (Issue #3255)", () => {
  assertLinearGrowth(
    "detectRustToolchainGap over a long near-header line",
    (chars) => "error: rustc " + "1.".repeat(Math.floor(chars / 2)) + "x",
    (line) => detectRustToolchainGap(line),
    { baseChars: 10_000 },
  );
});

Deno.test("detectRustToolchainGap - a hostile requirement-shaped line returns in linear time (Issue #3255)", () => {
  assertLinearGrowth(
    "detectRustToolchainGap over a long near-requirement line",
    (chars) =>
      "a@" + "b".repeat(Math.floor(chars / 2)) + " requires rustc " +
      "1.".repeat(Math.floor(chars / 2)) + "!",
    (line) => detectRustToolchainGap(line),
    { baseChars: 10_000 },
  );
});

Deno.test("detectRustToolchainGap - a hostile line with no space at all still returns (Issue #3255)", () => {
  assertLinearGrowth(
    "detectRustToolchainGap over a long package-shaped line with no space",
    (chars) => "@".repeat(chars) + "!",
    (line) => detectRustToolchainGap(line),
    { baseChars: 10_000 },
  );
});

Deno.test("collapseRepeatedLines - consecutive duplicates collapse, non-consecutive duplicates do not, single lines are unchanged (Issue #3255)", () => {
  assertEquals(
    collapseRepeatedLines("a\na\na\nb\na"),
    "a (×3)\nb\na",
  );
  assertEquals(collapseRepeatedLines("x\ny\nz"), "x\ny\nz");
  assertEquals(collapseRepeatedLines("only one line"), "only one line");
});
