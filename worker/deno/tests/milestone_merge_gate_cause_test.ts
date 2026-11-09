/**
 * The merge gate names why it failed a merged tree (Issue #4847).
 *
 * A refusal used to read the same whatever happened: a check that ran and
 * rejected the tree, a check that timed out, a check that could not start, a
 * tree that could not be read and a toolchain too old for the tree. Each is now
 * tagged with a {@link MergeGateCause}, so the sync charges only a verdict on
 * the tree and not an infrastructure fault.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkMergedTree,
  isMergeGateCause,
  MERGE_GATE_UNVERIFIED_CAUSES,
  mergeGateFailureCause,
  mergeGateFailureError,
  type MergeGateOutcome,
  MILESTONE_MERGE_GATE_ERROR,
  spawnTypeCheck,
  type TypeCheckProject,
} from "../lib/milestone_merge_gate.ts";
import {
  GateAccountUnavailable,
  type runRepositoryCommand,
} from "../lib/untrusted_gate_spawn.ts";

/** The rustc refusal the existing toolchain-gap test uses (Issue #3255). */
const TOOLCHAIN_TOO_OLD = "error: rustc 1.98.0 is not supported by the " +
  "following packages:\n" +
  "  neat_ai_discovery@0.74.279 requires rustc 1.99\n".repeat(3);

/** A Deno project with a repository-defined check, in a fresh directory. */
async function denoTree(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "issue-4847-cause-" });
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({ tasks: { check: "deno check" } }),
  );
  return dir;
}

/** A Cargo project, in a fresh directory. */
async function cargoTree(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "issue-4847-cargo-" });
  await Deno.writeTextFile(
    `${dir}/Cargo.toml`,
    '[package]\nname = "x"\nversion = "0.1.0"\n',
  );
  return dir;
}

/** Runs the gate over one tree with the injected runner and no cargo build. */
function gateOver(
  dir: string,
  runner: Parameters<typeof checkMergedTree>[1],
): Promise<MergeGateOutcome> {
  return checkMergedTree(dir, runner, () => Promise.resolve(false));
}

Deno.test("checkMergedTree - a check that runs and rejects the tree is tree-check-failed (Issue #4847)", async () => {
  const dir = await denoTree();
  try {
    const outcome = await gateOver(
      dir,
      () =>
        Promise.resolve({
          code: 1,
          output: "error: TS2304 [ERROR]: Cannot find name 'x'.",
        }),
    );
    assertEquals(outcome.status, "failed", outcome.detail);
    assertEquals(outcome.cause, "tree-check-failed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkMergedTree - a Deno check that times out is check-timed-out, not a verdict on the tree (Issue #4847)", async () => {
  const dir = await denoTree();
  try {
    const outcome = await gateOver(
      dir,
      () =>
        Promise.resolve({
          code: 124,
          output: "Type check timed out after 300000ms",
          timedOut: true,
        }),
    );
    assertEquals(outcome.status, "failed", outcome.detail);
    assertEquals(outcome.cause, "check-timed-out");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkMergedTree - a runner that throws is check-could-not-run (Issue #4847)", async () => {
  const dir = await denoTree();
  try {
    const outcome = await gateOver(dir, () => {
      throw new Error("deno: command not found");
    });
    assertEquals(outcome.status, "failed", outcome.detail);
    assertEquals(outcome.cause, "check-could-not-run");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkMergedTree - a check the runner reports as unrunnable is check-could-not-run (Issue #4847)", async () => {
  const dir = await denoTree();
  try {
    const outcome = await gateOver(
      dir,
      () =>
        Promise.resolve({
          code: 1,
          output: "spawn deno ENOENT",
          unrunnable: true,
        }),
    );
    assertEquals(outcome.status, "failed", outcome.detail);
    assertEquals(outcome.cause, "check-could-not-run");
    assertStringIncludes(outcome.detail, "could not be run");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkMergedTree - a tree that cannot be read is tree-unreadable (Issue #4847)", async () => {
  const outcome = await gateOver(
    "/nonexistent-path-for-issue-4847",
    () => Promise.resolve({ code: 0, output: "" }),
  );
  assertEquals(outcome.status, "failed", outcome.detail);
  assertEquals(outcome.cause, "tree-unreadable");
});

Deno.test("checkMergedTree - a host rustc older than the tree needs is rust-toolchain-too-old (Issue #4847)", async () => {
  const dir = await cargoTree();
  try {
    const outcome = await gateOver(
      dir,
      () => Promise.resolve({ code: 101, output: TOOLCHAIN_TOO_OLD }),
    );
    assertEquals(outcome.status, "failed", outcome.detail);
    assertEquals(outcome.cause, "rust-toolchain-too-old");
    assert(outcome.toolchainGap !== undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("spawnTypeCheck - a spawn failure that is not an account refusal is unrunnable, not an account refusal (Issue #4847)", async () => {
  const dir = await denoTree();
  try {
    const project: TypeCheckProject = { dir, args: ["check"], kind: "deno" };
    const run: typeof runRepositoryCommand = () =>
      Promise.resolve({ ok: false as const, error: new Error("spawn failed") });
    const result = await spawnTypeCheck(project, run);
    assertEquals(result.unrunnable, true);
    assertEquals(result.accountUnavailable, undefined);
    assertEquals(result.code, 1);
    assertStringIncludes(result.output, "spawn failed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("spawnTypeCheck - an account refusal sets accountUnavailable and never unrunnable (Issue #4847)", async () => {
  const dir = await denoTree();
  try {
    const project: TypeCheckProject = { dir, args: ["check"], kind: "deno" };
    const run: typeof runRepositoryCommand = () =>
      Promise.resolve({
        ok: false as const,
        error: new GateAccountUnavailable("no account for the checkout"),
      });
    const result = await spawnTypeCheck(project, run);
    assertEquals(result.accountUnavailable, "no account for the checkout");
    assertEquals(result.unrunnable, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mergeGateFailureCause - round-trips the cause the gate named (Issue #4847)", () => {
  const err = mergeGateFailureError("milestone/x", "main", {
    status: "failed",
    detail: "deno task check in /w/deno timed out",
    output: "",
    cause: "check-timed-out",
  });
  assertEquals(mergeGateFailureCause(err), "check-timed-out");
});

Deno.test("mergeGateFailureCause - an error with no cause, or not a refusal, has none (Issue #4847)", () => {
  const bare = mergeGateFailureError("milestone/x", "main", {
    status: "failed",
    detail: "d",
    output: "",
  });
  assertEquals(mergeGateFailureCause(bare), undefined);
  assertEquals(
    mergeGateFailureCause(new Error("refusing to merge unrelated histories")),
    undefined,
  );
});

Deno.test("mergeGateFailureCause - rejects a forged cause that is not a known value (Issue #4847)", () => {
  const forged = Object.assign(new Error("forged"), {
    name: MILESTONE_MERGE_GATE_ERROR,
    gateCause: "../etc/passwd",
  });
  assertEquals(mergeGateFailureCause(forged), undefined);
  assertEquals(isMergeGateCause("../etc/passwd"), false);
});

Deno.test("MERGE_GATE_UNVERIFIED_CAUSES - every cause but tree-check-failed means the tree was not verified (Issue #4847)", () => {
  assertEquals(MERGE_GATE_UNVERIFIED_CAUSES.has("tree-check-failed"), false);
  for (
    const cause of [
      "check-timed-out",
      "check-could-not-run",
      "tree-unreadable",
      "rust-toolchain-too-old",
    ] as const
  ) {
    assertEquals(MERGE_GATE_UNVERIFIED_CAUSES.has(cause), true, cause);
  }
});
