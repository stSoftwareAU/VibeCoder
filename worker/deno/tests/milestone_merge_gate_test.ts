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
  CARGO_MERGE_GATE_TIMEOUT_MS,
  checkMergedTree,
  collapseRepeatedLines,
  detectCargoRegistryGap,
  detectRemoteModuleGap,
  detectRustToolchainGap,
  findTypeCheckProjects,
  isCargoOfflineRegistryGap,
  isMergeGateFailure,
  MERGE_GATE_TIMEOUT_MS,
  mergeGateFailureError,
  spawnTypeCheck,
  type TypeCheckProject,
  typeCheckTimeoutMs,
  withCargoOffline,
} from "../lib/milestone_merge_gate.ts";
import type { runRepositoryCommand } from "../lib/untrusted_gate_spawn.ts";
import { CARGO_BUILD_SKIPPED_FOR_MERGE } from "../lib/heavy_build_gate.ts";
import {
  assertOnlyAllowlistedNames,
  makeAgentReachableTempDir,
  NAMES_PROBE,
  runGateInChild,
} from "./support/gate_child_env.ts";
import { assertLinearGrowth } from "./support/growth.ts";

/** Write a file, creating its parent directory. */
async function writeFile(path: string, contents: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, contents);
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  // A checkout the dropped `agent` account can use (Issue #4733).
  const dir = await makeAgentReachableTempDir("issue-974-");
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

Deno.test("checkMergedTree - cargo is not run when the disk budget skips it, and the merge is not failed (Issue #4326)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      `${dir}/Cargo.toml`,
      '[package]\nname = "demo"\nversion = "0.1.0"\n',
    );
    let ran = 0;
    const outcome = await checkMergedTree(
      dir,
      () => {
        ran++;
        return Promise.resolve({ code: 1, output: "cargo must not run" });
      },
      () => Promise.resolve(true),
    );
    assertEquals(ran, 0, "the ephemeral cargo build must not start");
    assertEquals(outcome.status, "skipped");
    assertEquals(outcome.cargoSkipped, true);
    assertStringIncludes(outcome.detail, CARGO_BUILD_SKIPPED_FOR_MERGE);
  });
});

Deno.test("checkMergedTree - a mixed tree passes its Deno check and does not claim cargo passed (Issue #4326)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/deno.json`, "{}\n");
    await writeFile(
      `${dir}/Cargo.toml`,
      '[package]\nname = "demo"\nversion = "0.1.0"\n',
    );
    const kinds: string[] = [];
    const outcome = await checkMergedTree(
      dir,
      (project) => {
        kinds.push(project.kind);
        return Promise.resolve({ code: 0, output: "" });
      },
      () => Promise.resolve(true),
    );
    assertEquals(kinds, ["deno"]);
    assertEquals(outcome.status, "passed");
    assertEquals(outcome.cargoSkipped, true);
    assertEquals(outcome.detail.includes("cargo check"), false);
    assertStringIncludes(outcome.detail, CARGO_BUILD_SKIPPED_FOR_MERGE);
  });
});

// ---------------------------------------------------------------------------
// Issue #4786 — a cargo check that hits its time limit is left to CI, not
// refused: a timeout on a cold ephemeral target says nothing about the
// resolution
// ---------------------------------------------------------------------------

Deno.test("checkMergedTree - a cargo check that times out is left to CI, not failed (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      `${dir}/Cargo.toml`,
      '[package]\nname = "demo"\nversion = "0.1.0"\n',
    );
    const outcome = await checkMergedTree(
      dir,
      () =>
        Promise.resolve({
          code: 124,
          timedOut: true,
          output: "Type check timed out after 300000ms",
        }),
      () => Promise.resolve(false),
    );
    assertEquals(outcome.status, "skipped", outcome.detail);
    assertEquals(outcome.cargoSkipped, true);
    assertStringIncludes(outcome.detail, "timed out");
    assertStringIncludes(outcome.detail, "left to CI (Issue #4786)");
    assertStringIncludes(outcome.detail, CARGO_BUILD_SKIPPED_FOR_MERGE);
  });
});

Deno.test("checkMergedTree - a mixed tree whose cargo check times out passes its Deno half and names the timeout (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/deno.json`, "{}\n");
    await writeFile(
      `${dir}/Cargo.toml`,
      '[package]\nname = "demo"\nversion = "0.1.0"\n',
    );
    const outcome = await checkMergedTree(
      dir,
      (project) =>
        Promise.resolve(
          project.kind === "cargo"
            ? { code: 124, timedOut: true, output: "" }
            : { code: 0, output: "" },
        ),
      () => Promise.resolve(false),
    );
    assertEquals(outcome.status, "passed", outcome.detail);
    assertEquals(outcome.cargoSkipped, true);
    assertStringIncludes(outcome.detail, "deno check");
    assertStringIncludes(outcome.detail, "timed out");
    assertStringIncludes(outcome.detail, "left to CI (Issue #4786)");
  });
});

Deno.test("checkMergedTree - a cargo check that exits 124 without the timeout flag is still failed (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      `${dir}/Cargo.toml`,
      '[package]\nname = "demo"\nversion = "0.1.0"\n',
    );
    const outcome = await checkMergedTree(
      dir,
      () => Promise.resolve({ code: 124, output: "x" }),
      () => Promise.resolve(false),
    );
    assertEquals(outcome.status, "failed", outcome.detail);
    assertEquals(outcome.cargoSkipped, undefined);
  });
});

Deno.test("checkMergedTree - a cargo compile failure (exit 101) is still failed (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      `${dir}/Cargo.toml`,
      '[package]\nname = "demo"\nversion = "0.1.0"\n',
    );
    const outcome = await checkMergedTree(
      dir,
      () =>
        Promise.resolve({
          code: 101,
          output: "error[E0425]: cannot find value `x` in this scope",
        }),
      () => Promise.resolve(false),
    );
    assertEquals(outcome.status, "failed", outcome.detail);
    assertStringIncludes(outcome.detail, "failed (exit 101)");
  });
});

Deno.test("checkMergedTree - a Deno check that times out is still failed (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/deno.json`, "{}\n");
    const outcome = await checkMergedTree(
      dir,
      () => Promise.resolve({ code: 124, timedOut: true, output: "" }),
      () => Promise.resolve(false),
    );
    assertEquals(outcome.status, "failed", outcome.detail);
    assertEquals(outcome.cargoSkipped, undefined);
  });
});

Deno.test("checkMergedTree - a mixed tree whose Deno check fails is failed even when its cargo check times out (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/deno.json`, "{}\n");
    await writeFile(
      `${dir}/Cargo.toml`,
      '[package]\nname = "demo"\nversion = "0.1.0"\n',
    );
    const outcome = await checkMergedTree(
      dir,
      (project) =>
        Promise.resolve(
          project.kind === "cargo"
            ? { code: 124, timedOut: true, output: "" }
            : { code: 1, output: "error: TS2304 Cannot find name 'x'." },
        ),
      () => Promise.resolve(false),
    );
    assertEquals(outcome.status, "failed", outcome.detail);
    assertStringIncludes(outcome.detail, "deno check");
    assertStringIncludes(outcome.detail, "failed (exit 1)");
  });
});

Deno.test("findTypeCheckProjects - toolchain coverage cannot hide a nested project of the other kind (PR #4343)", async () => {
  for (const rootKind of ["cargo", "deno"]) {
    await withTempDir(async (dir) => {
      const cargoDir = rootKind === "cargo" ? dir : `${dir}/engine`;
      const denoDir = rootKind === "deno" ? dir : `${dir}/web`;
      await writeFile(
        `${cargoDir}/Cargo.toml`,
        '[workspace]\nmembers = ["member"]\n',
      );
      await writeFile(
        `${cargoDir}/member/Cargo.toml`,
        '[package]\nname = "member"\n',
      );
      await writeFile(`${denoDir}/deno.json`, "{}");
      await writeFile(`${denoDir}/member/deno.json`, "{}");
      const projects = await findTypeCheckProjects(dir);
      assertEquals(
        projects.map((p) => ({ kind: p.kind, dir: p.dir })),
        rootKind === "cargo"
          ? [{ kind: "cargo", dir }, { kind: "deno", dir: denoDir }]
          : [{ kind: "deno", dir }, { kind: "cargo", dir: cargoDir }],
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Issue #4422 — a host with no route to a remote module host is an environment
// fault, not a bad resolution
// ---------------------------------------------------------------------------

const ESM_UNREACHABLE_URL =
  "https://esm.sh/react@19.2.8/es2022/jsx-runtime.mjs";

/** What `deno task test` prints on a host with no route to esm.sh. */
const ESM_UNREACHABLE_OUTPUT = [
  `Download ${ESM_UNREACHABLE_URL}`,
  `error: Import '${ESM_UNREACHABLE_URL}' failed.`,
  `    0: error sending request for url (${ESM_UNREACHABLE_URL}): client error (Connect): unsuccessful tunnel`,
  "    1: client error (Connect)",
  "    2: unsuccessful tunnel",
  "    at https://esm.sh/react@19.2.8/jsx-runtime?target=es2022:2:15",
].join("\n");

Deno.test("detectRemoteModuleGap - an import that failed to connect names its URL and the cause line (Issue #4422)", () => {
  const gap = detectRemoteModuleGap(ESM_UNREACHABLE_OUTPUT);
  assertEquals(gap?.url, ESM_UNREACHABLE_URL);
  assertStringIncludes(gap!.cause, "error sending request for url");
});

Deno.test("detectRemoteModuleGap - an import that returned 404 is an ordinary failure, not a gap (Issue #4422)", () => {
  assertEquals(
    detectRemoteModuleGap(
      "Download https://esm.sh/x\n" +
        "error: Import 'https://esm.sh/x' failed, not found.\n" +
        "    at file:///work/test.ts:1:1\n",
    ),
    undefined,
  );
});

Deno.test("detectRemoteModuleGap - a bad certificate on a fetched import is an ordinary failure, not a gap (Issue #4422)", () => {
  assertEquals(
    detectRemoteModuleGap(
      "error: Import 'https://esm.sh/x' failed.\n" +
        "    0: invalid peer certificate: UnknownIssuer\n",
    ),
    undefined,
  );
});

Deno.test("detectRemoteModuleGap - connection words with no import failure are not a gap (Issue #4422)", () => {
  assertEquals(
    detectRemoteModuleGap(
      "    0: error sending request for url (https://esm.sh/x)\n" +
        "    1: unsuccessful tunnel\n",
    ),
    undefined,
  );
});

Deno.test("detectRemoteModuleGap - a cause line before the import line is not a gap (Issue #4422)", () => {
  assertEquals(
    detectRemoteModuleGap(
      "    0: unsuccessful tunnel\n" +
        "error: Import 'https://esm.sh/x' failed.\n",
    ),
    undefined,
  );
});

Deno.test("detectRemoteModuleGap - a 200000-character line is capped and the output is still read correctly (Issue #4422)", () => {
  const hostile = "' ".repeat(100_000);
  assertEquals(hostile.length, 200_000);
  const gap = detectRemoteModuleGap(`${hostile}\n${ESM_UNREACHABLE_OUTPUT}`);
  assertEquals(gap?.url, ESM_UNREACHABLE_URL);
  assertEquals(detectRemoteModuleGap(hostile), undefined);
});

/** The probe module: the real spawnTypeCheck runs inside `checkMergedTree`. */
const MERGE_PROBE = `import { checkMergedTree } from ${
  JSON.stringify(
    new URL("../lib/milestone_merge_gate.ts", import.meta.url).href,
  )
};
console.log("OUTCOME " + JSON.stringify(await checkMergedTree(Deno.args[0]!)));
`;

Deno.test("checkMergedTree - the repository's own check sees only the allowlisted environment (Issue #4659)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      `${dir}/deno.json`,
      JSON.stringify({ tasks: { check: NAMES_PROBE } }),
    );
    // The default runner, inside a child process that holds a parent credential.
    const outcome = await runGateInChild(MERGE_PROBE, dir);
    assertEquals(outcome.status, "failed", outcome.output);
    assertOnlyAllowlistedNames(outcome.output);
  });
});
Deno.test("detectRemoteModuleGap - a 50000-line output is read in linear time to the right result (Issue #4422)", () => {
  const filler = Array.from({ length: 50_000 }, () => "    at frame");
  const gap = detectRemoteModuleGap(
    [...filler, ...ESM_UNREACHABLE_OUTPUT.split("\n")].join("\n"),
  );
  assertEquals(gap?.url, ESM_UNREACHABLE_URL);
  // The same volume of connection words with no import failure is no gap.
  const noImport = Array.from(
    { length: 50_000 },
    () => "    0: unsuccessful tunnel",
  );
  assertEquals(detectRemoteModuleGap(noImport.join("\n")), undefined);
});

Deno.test("checkMergedTree - the repository's own check is refused when its manifest is a symbolic link (Issue #4659)", async () => {
  await withTempDir(async (dir) => {
    // The default runner probes the manifests it is handed; a link in their
    // place could choose which account runs the repository's code.
    await writeFile(`${dir}/real.json`, JSON.stringify({ tasks: {} }));
    await Deno.symlink(`${dir}/real.json`, `${dir}/deno.json`);
    const outcome = await checkMergedTree(dir);
    assertEquals(outcome.status, "failed", outcome.output);
    assert(
      outcome.output.includes("is a symbolic link"),
      `expected the symbolic-link refusal, got: ${outcome.output}`,
    );
  });
});

// A timed-out cargo check leaves its compiled crates in the target, so the one
// retry resumes and can verify a tree whose only check is cargo (Issue #4786).
const CARGO_ONLY_MANIFEST = '[package]\nname = "demo"\nversion = "0.1.0"\n';

Deno.test("checkMergedTree - a cargo-only tree whose cargo check finishes on the retry is passed, not skipped (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/Cargo.toml`, CARGO_ONLY_MANIFEST);
    let runs = 0;
    const outcome = await checkMergedTree(
      dir,
      () => {
        runs++;
        return Promise.resolve(
          runs === 1
            ? { code: 124, timedOut: true, output: "timed out" }
            : { code: 0, output: "" },
        );
      },
      () => Promise.resolve(false),
    );
    assertEquals(runs, 2);
    assertEquals(outcome.status, "passed", outcome.detail);
    assertEquals(outcome.cargoSkipped, undefined);
    assertEquals(outcome.detail.includes("left to CI"), false);
  });
});

Deno.test("checkMergedTree - a cargo check that fails to compile on the retry is failed (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/Cargo.toml`, CARGO_ONLY_MANIFEST);
    let runs = 0;
    const outcome = await checkMergedTree(
      dir,
      () => {
        runs++;
        return Promise.resolve(
          runs === 1
            ? { code: 124, timedOut: true, output: "timed out" }
            : { code: 101, output: "error[E0425]: cannot find value `x`" },
        );
      },
      () => Promise.resolve(false),
    );
    assertEquals(runs, 2);
    assertEquals(outcome.status, "failed", outcome.detail);
    assertStringIncludes(outcome.detail, "failed (exit 101)");
  });
});

Deno.test("checkMergedTree - a cargo check that times out twice is retried once, then left to CI (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/Cargo.toml`, CARGO_ONLY_MANIFEST);
    let runs = 0;
    const outcome = await checkMergedTree(
      dir,
      () => {
        runs++;
        return Promise.resolve({ code: 124, timedOut: true, output: "" });
      },
      () => Promise.resolve(false),
    );
    assertEquals(runs, 2);
    assertEquals(outcome.status, "skipped", outcome.detail);
    assertEquals(outcome.cargoSkipped, true);
    assertEquals(outcome.landUnverified, undefined);
  });
});

Deno.test("checkMergedTree - a Deno check that times out is not retried (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/deno.json`, "{}\n");
    let runs = 0;
    await checkMergedTree(
      dir,
      () => {
        runs++;
        return Promise.resolve({ code: 124, timedOut: true, output: "" });
      },
      () => Promise.resolve(false),
    );
    assertEquals(runs, 1);
  });
});

/**
 * A fake command runner (Issue #4787): records the limit it was handed and
 * answers with the given reply, in the shape the real runner returns.
 */
function recordingRun(
  limits: number[],
  reply: { code: number; stdout: string; stderr: string; timedOut: boolean },
): typeof runRepositoryCommand {
  return (_executable, _args, options) => {
    limits.push(options.timeoutMs);
    return Promise.resolve({
      ok: true as const,
      value: { success: reply.code === 0, ...reply },
    });
  };
}

Deno.test("checkMergedTree - a cargo check the real runner reports as timed out is retried once, then left to CI (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/Cargo.toml`, CARGO_ONLY_MANIFEST);
    const limits: number[] = [];
    const outcome = await checkMergedTree(
      dir,
      (project) =>
        spawnTypeCheck(
          project,
          recordingRun(limits, {
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: true,
          }),
        ),
      () => Promise.resolve(false),
    );
    assertEquals(limits, [
      CARGO_MERGE_GATE_TIMEOUT_MS,
      CARGO_MERGE_GATE_TIMEOUT_MS,
    ]);
    assert(outcome.status !== "failed", outcome.detail);
    assertEquals(outcome.cargoSkipped, true);
    assertStringIncludes(outcome.detail, "left to CI (Issue #4786)");
  });
});

// ---------------------------------------------------------------------------
// Issue #4786 — a cargo check that cannot reach its crate registry is a host
// fault: it is retried once offline, from the local cargo cache, and left to CI
// if the registry is still unreachable. Any other failure is not retried.
// ---------------------------------------------------------------------------

/** The connection-class cause the host printed in the Issue #4786 report. */
const REGISTRY_CAUSE =
  "[6] Could not resolve hostname (Could not resolve host: index.crates.io)";

/** cargo's retry warning, one per attempt, as in the Issue #4786 report. */
const REGISTRY_RETRY_WARNINGS = [
  `warning: spurious network error (3 tries remaining): ${REGISTRY_CAUSE}`,
  `warning: spurious network error (2 tries remaining): ${REGISTRY_CAUSE}`,
  `warning: spurious network error (1 try remaining): ${REGISTRY_CAUSE}`,
];

/** The verbatim `cargo check` refusal from Issue #4786 (exit 101). */
const REGISTRY_GAP_OUTPUT = [
  ...REGISTRY_RETRY_WARNINGS,
  ...REGISTRY_RETRY_WARNINGS,
  ...REGISTRY_RETRY_WARNINGS,
  "error: failed to get `jiff` as a dependency of package `grq-policy v0.1.0 (/home/vibe/auto-issue-work/GRQ-AutoTrader/crates/policy)`",
  "",
  "Caused by:",
  "  failed to load source for dependency `jiff`",
  "",
  "Caused by:",
  "  unable to update registry `crates-io`",
  "",
  "Caused by:",
  "  download of config.json failed",
  "",
  "Caused by:",
  `  ${REGISTRY_CAUSE}`,
].join("\n");

/** Cargo check --offline --locked with an empty Cargo home on this host. */
const OFFLINE_MISSING_CRATE_OUTPUT = [
  "error: no matching package named `jiff` found",
  "location searched: crates.io index",
  "required by package `offline-probe v0.1.0 (/tmp/offline-probe)`",
  "note: offline mode (via `--offline`) can sometimes cause surprising resolution failures",
  "help: if this error is too confusing you may wish to retry without `--offline`",
].join("\n");

Deno.test("offline cargo resolver errors require both the error and reminder", () => {
  assertEquals(detectCargoRegistryGap(OFFLINE_MISSING_CRATE_OUTPUT), undefined);
  assert(isCargoOfflineRegistryGap(OFFLINE_MISSING_CRATE_OUTPUT));
  assert(isCargoOfflineRegistryGap(
    "error: failed to select a version for the requirement `jiff`\nAs a reminder, you're using offline mode (--offline)",
  ));
  assert(isCargoOfflineRegistryGap(
    "error: failed to get `jiff`\n  attempting to make an HTTP request, but --offline was specified",
  ));
  assertEquals(
    isCargoOfflineRegistryGap("error: no matching package named `jiff` found"),
    false,
  );
  assertEquals(
    isCargoOfflineRegistryGap("note: offline mode (via `--offline`)"),
    false,
  );
  assertEquals(
    isCargoOfflineRegistryGap(
      "error[E0425]: cannot find value `x`\nnote: offline mode (via `--offline`)",
    ),
    false,
  );
});

Deno.test("detectCargoRegistryGap - the verbatim Issue #4786 refusal names the connection-class cause, not a retry warning (Issue #4786)", () => {
  assertEquals(detectCargoRegistryGap(REGISTRY_GAP_OUTPUT), {
    cause: REGISTRY_CAUSE,
  });
});

Deno.test("detectCargoRegistryGap - a spurious retry warning is the fallback cause when no other connection line exists (Issue #4786)", () => {
  assertEquals(
    detectCargoRegistryGap(
      `error: failed to get \`jiff\`\n${REGISTRY_RETRY_WARNINGS[0]}\n`,
    ),
    { cause: REGISTRY_RETRY_WARNINGS[0] },
  );
});

Deno.test("detectCargoRegistryGap - an ordinary compile error is not a registry gap (Issue #4786)", () => {
  assertEquals(
    detectCargoRegistryGap(
      "error[E0425]: cannot find value `x` in this scope\n" +
        " --> src/lib.rs:3:5\n" +
        "error: could not compile `demo` (lib) due to 1 previous error\n",
    ),
    undefined,
  );
});

Deno.test("detectCargoRegistryGap - a --locked lockfile refusal is not a registry gap (Issue #4786)", () => {
  assertEquals(
    detectCargoRegistryGap(
      "error: the lock file /work/Cargo.lock needs to be updated but --locked was passed to prevent this\n",
    ),
    undefined,
  );
});

Deno.test("detectCargoRegistryGap - a manifest parse error is not a registry gap (Issue #4786)", () => {
  assertEquals(
    detectCargoRegistryGap(
      "error: failed to parse manifest at `/work/Cargo.toml`\n\n" +
        "Caused by:\n  TOML parse error at line 1, column 1\n",
    ),
    undefined,
  );
});

Deno.test("detectCargoRegistryGap - a failed fetch with a non-network cause is not a registry gap (Issue #4786)", () => {
  assertEquals(
    detectCargoRegistryGap(
      "error: failed to get `serde` as a dependency of package `demo v0.1.0`\n\n" +
        'Caused by:\n  failed to select a version for the requirement `serde = "^9"`\n',
    ),
    undefined,
  );
});

Deno.test("detectCargoRegistryGap - a rustc-version gap is not a registry gap (Issue #4786)", () => {
  assertEquals(
    detectCargoRegistryGap(
      "error: rustc 1.70.0 is not supported by the following packages:\n" +
        "  foo@1.2.3 requires rustc 1.80\n" +
        "Either upgrade rustc or select compatible dependency versions\n",
    ),
    undefined,
  );
});

Deno.test("detectCargoRegistryGap - a registry refusal with no connection line is not a registry gap (Issue #4786)", () => {
  assertEquals(
    detectCargoRegistryGap(
      "error: failed to get `jiff` as a dependency of package `demo v0.1.0`\n\n" +
        "Caused by:\n  no matching package named `jiff` found\n",
    ),
    undefined,
  );
});

Deno.test("detectCargoRegistryGap - a 200000-character line is capped and returns undefined (Issue #4786)", () => {
  const hostile = "a".repeat(200_000) + "!";
  assertEquals(hostile.length, 200_001);
  assertEquals(detectCargoRegistryGap(hostile), undefined);
});

Deno.test("withCargoOffline - --offline goes straight after the subcommand, and is not added twice (Issue #4786)", () => {
  assertEquals(
    withCargoOffline(["check", "--workspace", "--all-targets"]),
    ["check", "--offline", "--workspace", "--all-targets"],
  );
  assertEquals(
    withCargoOffline(["test", "--workspace", "--locked"]),
    ["test", "--offline", "--workspace", "--locked"],
  );
  const once = withCargoOffline(["check", "--workspace"]);
  assertEquals(withCargoOffline(once), once);
  assertEquals(withCargoOffline([]), []);
});

Deno.test("checkMergedTree - a cargo check that cannot reach its registry passes when the offline retry succeeds (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/Cargo.toml`, CARGO_ONLY_MANIFEST);
    const argv: string[][] = [];
    const outcome = await checkMergedTree(
      dir,
      (project) => {
        argv.push(project.args);
        return Promise.resolve(
          argv.length === 1
            ? { code: 101, output: REGISTRY_GAP_OUTPUT }
            : { code: 0, output: "" },
        );
      },
      () => Promise.resolve(false),
    );
    assertEquals(argv.length, 2);
    assertEquals(argv[0], ["check", "--workspace", "--all-targets"]);
    assertEquals(argv[1], [
      "check",
      "--offline",
      "--workspace",
      "--all-targets",
    ]);
    assertEquals(outcome.status, "passed", outcome.detail);
    assertEquals(outcome.cargoSkipped, undefined);
    assertStringIncludes(
      outcome.detail,
      "verified offline from the local cargo cache",
    );
    assertEquals(outcome.detail.includes("left to CI"), false);
  });
});

Deno.test("checkMergedTree - a cargo check that cannot reach its registry twice is left to CI, naming the first cause (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/Cargo.toml`, CARGO_ONLY_MANIFEST);
    let runs = 0;
    const outcome = await checkMergedTree(
      dir,
      () => {
        runs++;
        return Promise.resolve(
          runs === 1
            ? { code: 101, output: REGISTRY_GAP_OUTPUT }
            : { code: 101, output: OFFLINE_MISSING_CRATE_OUTPUT },
        );
      },
      () => Promise.resolve(false),
    );
    assertEquals(runs, 2);
    assertEquals(outcome.status, "skipped", outcome.detail);
    assertEquals(outcome.cargoSkipped, true);
    assertStringIncludes(
      outcome.detail,
      `could not reach its crate registry (${REGISTRY_CAUSE})`,
    );
    assertEquals(outcome.detail.includes("--offline was specified"), false);
    assertStringIncludes(outcome.detail, "left to CI (Issue #4786)");
    assertEquals(outcome.landUnverified, undefined);
  });
});

Deno.test("checkMergedTree - a cargo check whose offline retry is a real compile error is failed (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/Cargo.toml`, CARGO_ONLY_MANIFEST);
    let runs = 0;
    const outcome = await checkMergedTree(
      dir,
      () => {
        runs++;
        return Promise.resolve(
          runs === 1
            ? { code: 101, output: REGISTRY_GAP_OUTPUT }
            : { code: 101, output: "error[E0425]: cannot find value `x`" },
        );
      },
      () => Promise.resolve(false),
    );
    assertEquals(runs, 2);
    assertEquals(outcome.status, "failed", outcome.detail);
    assertStringIncludes(outcome.detail, "failed (exit 101)");
  });
});

Deno.test("checkMergedTree - a cargo check that fails without a registry gap is not retried (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/Cargo.toml`, CARGO_ONLY_MANIFEST);
    let runs = 0;
    const outcome = await checkMergedTree(
      dir,
      () => {
        runs++;
        return Promise.resolve({
          code: 101,
          output: "error[E0425]: cannot find value `x`",
        });
      },
      () => Promise.resolve(false),
    );
    assertEquals(runs, 1);
    assertEquals(outcome.status, "failed", outcome.detail);
  });
});

Deno.test("checkMergedTree - a mixed tree whose cargo registry is unreachable twice passes its Deno half and never offlines the Deno check (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/deno.json`, "{}\n");
    await writeFile(`${dir}/Cargo.toml`, CARGO_ONLY_MANIFEST);
    const denoArgs: string[][] = [];
    let cargoRuns = 0;
    const outcome = await checkMergedTree(
      dir,
      (project) => {
        if (project.kind === "deno") {
          denoArgs.push(project.args);
          return Promise.resolve({ code: 0, output: "" });
        }
        cargoRuns++;
        return Promise.resolve({ code: 101, output: REGISTRY_GAP_OUTPUT });
      },
      () => Promise.resolve(false),
    );
    assertEquals(cargoRuns, 2);
    assertEquals(denoArgs.length, 1);
    assertEquals(denoArgs.flat().includes("--offline"), false);
    assertEquals(outcome.status, "passed", outcome.detail);
    assertEquals(outcome.cargoSkipped, true);
    assertStringIncludes(outcome.detail, "deno check");
    assertStringIncludes(outcome.detail, "left to CI (Issue #4786)");
  });
});

Deno.test("checkMergedTree - a Deno check whose output names a registry gap is failed once, never retried offline (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/deno.json`, "{}\n");
    let runs = 0;
    const outcome = await checkMergedTree(
      dir,
      () => {
        runs++;
        return Promise.resolve({ code: 1, output: REGISTRY_GAP_OUTPUT });
      },
      () => Promise.resolve(false),
    );
    assertEquals(runs, 1);
    assertEquals(outcome.status, "failed", outcome.detail);
    assertEquals(outcome.cargoSkipped, undefined);
  });
});

Deno.test("typeCheckTimeoutMs - cargo gets the Cargo limit, Deno keeps the Deno limit, and Cargo's is the longer (Issue #4787)", () => {
  assertEquals(typeCheckTimeoutMs("cargo"), CARGO_MERGE_GATE_TIMEOUT_MS);
  assertEquals(typeCheckTimeoutMs("deno"), MERGE_GATE_TIMEOUT_MS);
  assert(CARGO_MERGE_GATE_TIMEOUT_MS > MERGE_GATE_TIMEOUT_MS);
});

Deno.test("spawnTypeCheck - each toolchain's check gets its own limit, and a timeout names that limit (Issue #4787)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/Cargo.toml`, '[package]\nname = "x"\n');
    await writeFile(`${dir}/app/deno.json`, "{}");
    const cargo: TypeCheckProject = {
      dir,
      kind: "cargo",
      args: ["check", "--workspace", "--all-targets"],
    };
    const deno: TypeCheckProject = {
      dir: `${dir}/app`,
      kind: "deno",
      args: ["task", "check"],
    };

    const cargoLimits: number[] = [];
    const cargoTimedOut = await spawnTypeCheck(
      cargo,
      recordingRun(cargoLimits, {
        code: 0,
        stdout: "",
        stderr: "",
        timedOut: true,
      }),
    );
    assertEquals(cargoLimits, [CARGO_MERGE_GATE_TIMEOUT_MS]);
    assertEquals(cargoTimedOut.code, 124);
    // The caller tells a timeout from a failing check by this flag alone
    // (Issue #4786), so the production runner must set it.
    assertEquals(cargoTimedOut.timedOut, true);
    assertStringIncludes(cargoTimedOut.output, "timed out after 900000ms");
    assert(!cargoTimedOut.output.includes("300000ms"));

    const denoLimits: number[] = [];
    const denoTimedOut = await spawnTypeCheck(
      deno,
      recordingRun(denoLimits, {
        code: 0,
        stdout: "",
        stderr: "",
        timedOut: true,
      }),
    );
    assertEquals(denoLimits, [MERGE_GATE_TIMEOUT_MS]);
    assertEquals(denoTimedOut.code, 124);
    assertEquals(denoTimedOut.timedOut, true);
    assertStringIncludes(denoTimedOut.output, "timed out after 300000ms");

    // A check that finishes inside its limit keeps its code and its output.
    const finished = await spawnTypeCheck(
      cargo,
      recordingRun([], {
        code: 101,
        stdout: "",
        stderr: "error[E0425]: cannot find value `synapse` in this scope",
        timedOut: false,
      }),
    );
    assertEquals(finished, {
      code: 101,
      output: "error[E0425]: cannot find value `synapse` in this scope",
    });
  });
});

Deno.test("spawnTypeCheck - a Deno check is read-only only when it writes nothing into its directory, a cargo check keeps the write requirement (Issue #4782)", async () => {
  const okResult = {
    ok: true as const,
    value: {
      code: 0,
      stdout: "",
      stderr: "",
      success: true,
      timedOut: false,
    },
  };
  const readOnlyFor = async (
    files: Record<string, string>,
    kind: "deno" | "cargo" = "deno",
    args: string[] = kind === "cargo" ? ["check"] : ["check", "**/*.ts"],
  ): Promise<boolean | undefined> => {
    let seen: boolean | undefined;
    const run: typeof runRepositoryCommand = (_executable, _args, options) => {
      seen = options.readOnlyCheckout;
      return Promise.resolve(okResult);
    };
    await withTempDir(async (dir) => {
      for (const [name, body] of Object.entries(files)) {
        await writeFile(`${dir}/app/${name}`, body);
      }
      await spawnTypeCheck({
        dir: `${dir}/app`,
        kind,
        args,
      }, run);
    });
    return seen;
  };
  // A committed lockfile and nothing else that writes: read-only.
  assertEquals(
    await readOnlyFor({ "deno.json": "{}", "deno.lock": "{}" }),
    true,
  );
  for (
    const [command, expected] of [
      ["deno check --frozen --lock=deno.lock '**/*.ts'", true],
      ["deno run -A gen.ts && deno check main.ts", false],
      ["deno check main.ts\ndeno task gen", false],
      ["deno check main.ts\rdeno task gen", false],
      ["deno check main.ts > output.txt", false],
      ["deno check $(touch generated.ts)", false],
      ["deno check --lock=other.lock main.ts", false],
      ["deno check '--vendor' main.ts", false],
    ] as const
  ) {
    assertEquals(
      await readOnlyFor(
        {
          "deno.json": JSON.stringify({ tasks: { check: command } }),
          "deno.lock": "{}",
        },
        "deno",
        ["task", "check"],
      ),
      expected,
      command,
    );
  }
  assertEquals(
    await readOnlyFor({
      "deno.jsonc": '{ // c\n "nodeModulesDir": "none" }',
      "deno.lock": "{}",
    }),
    true,
  );
  // No lockfile: Deno may have to write one for an npm or remote import.
  assertEquals(await readOnlyFor({ "deno.json": "{}" }), false);
  // Vendoring can create or update files in the project directory.
  assertEquals(
    await readOnlyFor({
      "deno.json": '{"vendor": true}',
      "deno.lock": "{}",
    }),
    false,
  );
  // node_modules is written for "auto" and beside a package.json.
  assertEquals(
    await readOnlyFor({
      "deno.json": '{"nodeModulesDir": "auto"}',
      "deno.lock": "{}",
    }),
    false,
  );
  assertEquals(
    await readOnlyFor({
      "deno.json": "{}",
      "deno.lock": "{}",
      "package.json": "{}",
    }),
    false,
  );
  // A manifest that cannot be parsed fails closed.
  assertEquals(
    await readOnlyFor({ "deno.json": "{ nope", "deno.lock": "{}" }),
    false,
  );
  // Cargo keeps the requirement even with a lockfile.
  assertEquals(
    await readOnlyFor({ "Cargo.toml": "", "Cargo.lock": "" }, "cargo"),
    false,
  );
});

Deno.test("spawnTypeCheck - a read-only lockfile write refusal is left to CI", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/app/deno.json`, "{}");
    await writeFile(`${dir}/app/deno.lock`, "{}");
    const project: TypeCheckProject = {
      dir: `${dir}/app`,
      kind: "deno",
      args: ["check", "mod.ts"],
    };
    const refusal =
      `error: Failed writing lockfile: Permission denied (os error 13) (for '${dir}/app/deno.lock')`;
    const run = recordingRun([], {
      code: 1,
      stdout: "",
      stderr: refusal,
      timedOut: false,
    });
    const result = await spawnTypeCheck(project, run);
    assertStringIncludes(
      result.accountUnavailable ?? "",
      "Failed writing lockfile",
    );
    const outcome = await checkMergedTree(
      dir,
      (p) => spawnTypeCheck(p, run),
      () => Promise.resolve(false),
    );
    assertEquals(outcome.status, "skipped");
    assertStringIncludes(outcome.detail, "left to CI");
    for (
      const message of [
        `error: Failed writing lockfile: Permission denied (os error 13) (for '${dir}/other/deno.lock')`,
        `error: Permission denied (os error 13) (for '${dir}/app/mod.ts')`,
        `error: Failed writing lockfile: disk full (for '${dir}/app/deno.lock')`,
      ]
    ) {
      const failure = await spawnTypeCheck(
        project,
        recordingRun([], {
          code: 1,
          stdout: "",
          stderr: message,
          timedOut: false,
        }),
      );
      assertEquals(failure.accountUnavailable, undefined);
    }
  });
});

Deno.test("checkMergedTree - a cargo-only tree skipped for the host's budget is not marked landUnverified (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/Cargo.toml`, CARGO_ONLY_MANIFEST);
    const outcome = await checkMergedTree(
      dir,
      () => Promise.resolve({ code: 0, output: "" }),
      () => Promise.resolve(true),
    );
    assertEquals(outcome.status, "skipped", outcome.detail);
    assertEquals(outcome.cargoSkipped, true);
    assertEquals(outcome.landUnverified, undefined);
  });
});

Deno.test("checkMergedTree - a cargo check that fails to compile is failed, never landUnverified (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/Cargo.toml`, CARGO_ONLY_MANIFEST);
    const outcome = await checkMergedTree(
      dir,
      () =>
        Promise.resolve({
          code: 101,
          output: "error[E0425]: cannot find value `x`",
        }),
      () => Promise.resolve(false),
    );
    assertEquals(outcome.status, "failed", outcome.detail);
    assertEquals(outcome.landUnverified, undefined);
  });
});

Deno.test("checkMergedTree - a Deno project left to CI is skipped without landUnverified (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/deno.json`, "{}\n");
    const outcome = await checkMergedTree(
      dir,
      () =>
        Promise.resolve({
          code: 1,
          output: "",
          accountUnavailable: "deno cache is read-only",
        }),
      () => Promise.resolve(false),
    );
    assertEquals(outcome.status, "skipped", outcome.detail);
    assertEquals(outcome.landUnverified, undefined);
  });
});

Deno.test("checkMergedTree - a mixed tree whose Deno half is left to CI and whose cargo half timed out is not landUnverified (Issue #4786)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(`${dir}/Cargo.toml`, CARGO_ONLY_MANIFEST);
    await writeFile(`${dir}/deno.json`, "{}\n");
    const outcome = await checkMergedTree(
      dir,
      (project) =>
        Promise.resolve(
          project.kind === "cargo"
            ? { code: 124, timedOut: true, output: "" }
            : {
              code: 1,
              output: "",
              accountUnavailable: "deno cache is read-only",
            },
        ),
      () => Promise.resolve(false),
    );
    assertEquals(outcome.status, "skipped", outcome.detail);
    assertEquals(outcome.landUnverified, undefined);
  });
});
