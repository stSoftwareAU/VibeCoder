/**
 * Tests for lib/branch_currency.ts — bring a branch up to date before the PR.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  ensureBranchCurrent,
  measureBranchDrift,
} from "../lib/branch_currency.ts";
import type { Result } from "../types.ts";

/** A git runner that answers from a table and records what it was asked. */
// deno-lint-ignore no-explicit-any
function fakeGit(answers: Record<string, any>, calls: string[][] = []) {
  // deno-lint-ignore no-explicit-any
  const runGit = (args: string[]): Promise<any> => {
    calls.push(args);
    const key = args.join(" ");
    const hit = Object.entries(answers).find(([k]) => key.startsWith(k));
    return Promise.resolve(
      hit ? hit[1] : OK(""),
    );
  };
  return { runGit, calls };
}

const OK = (
  stdout: string,
): Result<{ code: number; stdout: string; stderr: string }> => ({
  ok: true,
  value: { code: 0, stdout, stderr: "" },
});

Deno.test("measureBranchDrift - reads behind and ahead from one rev-list", async () => {
  const git = fakeGit({ "rev-list": OK("3\t5\n") });
  const drift = await measureBranchDrift(
    "feature",
    "origin/main",
    git.runGit,
  );
  assertEquals(drift.ok && drift.value, { behind: 3, ahead: 5 });
  // One call, not two: the ordinary current case must stay cheap.
  assertEquals(git.calls.length, 1);
  assertEquals(git.calls[0]?.slice(0, 4), [
    "rev-list",
    "--left-right",
    "--count",
    "origin/main...feature",
  ]);
});

Deno.test("measureBranchDrift - unparseable output is an error, never a guess", async () => {
  const drift = await measureBranchDrift(
    "feature",
    "origin/main",
    fakeGit({ "rev-list": OK("not numbers") }).runGit,
  );
  assertEquals(drift.ok, false);
});

Deno.test("ensureBranchCurrent - a current branch is left alone and never rebased", async () => {
  let rebased = false;
  const outcome = await ensureBranchCurrent({
    branch: "feature",
    baseBranch: "main",
    runGit: fakeGit({ "rev-list": OK("0\t2\n") }).runGit,
    rebase: () => {
      rebased = true;
      return Promise.resolve({ ok: true as const, value: {} });
    },
  });
  assertEquals(outcome.kind, "already-current");
  assertEquals(rebased, false, "a current branch is never rebased");
});

Deno.test("ensureBranchCurrent - a behind branch is brought forward before the PR", async () => {
  // The whole point: CI then runs once, on the state that will merge, instead
  // of once on the stale head and again after something updates the branch.
  const lines: string[] = [];
  let rebasedOnto = "";
  const outcome = await ensureBranchCurrent({
    branch: "feature",
    baseBranch: "milestone/foo",
    runGit: fakeGit({ "rev-list": OK("4\t1\n") }).runGit,
    rebase: (o) => {
      rebasedOnto = o.baseRef;
      return Promise.resolve({ ok: true as const, value: {} });
    },
    log: (m) => lines.push(m),
  });
  assertEquals(outcome.kind, "updated");
  assertEquals(outcome.kind === "updated" && outcome.behind, 4);
  assertEquals(rebasedOnto, "origin/milestone/foo");
  assertEquals(lines.length, 1);
});

Deno.test("ensureBranchCurrent - the base is fetched first, or the comparison is stale", async () => {
  // Comparing against a stale remote-tracking ref reports a behind branch as
  // current, which defeats the entire purpose.
  const git = fakeGit({ "rev-list": OK("0\t1\n") });
  await ensureBranchCurrent({
    branch: "feature",
    baseBranch: "main",
    runGit: git.runGit,
    rebase: () => Promise.resolve({ ok: true as const, value: {} }),
  });
  assertEquals(git.calls[0], ["fetch", "origin", "main"]);
});

Deno.test("ensureBranchCurrent - a conflicting branch is declined, not force-resolved", async () => {
  // Content that genuinely diverged belongs to the conflict ladder, with its
  // own rungs and audit trail. A silent rebase that picks a side is the one
  // outcome worse than an extra CI run.
  const outcome = await ensureBranchCurrent({
    branch: "feature",
    baseBranch: "main",
    runGit: fakeGit({ "rev-list": OK("2\t3\n") }).runGit,
    rebase: () =>
      Promise.resolve({
        ok: false as const,
        error: new Error("cherry-pick conflict"),
      }),
  });
  assertEquals(outcome.kind, "declined");
});

Deno.test("ensureBranchCurrent - an unreadable comparison proceeds unchanged", async () => {
  // Never fail the caller: an extra CI run is a cost, a blocked PR is a fault.
  const failing = await ensureBranchCurrent({
    branch: "feature",
    baseBranch: "main",
    runGit: fakeGit({
      "rev-list": { ok: false, error: new Error("bad revision") },
    }).runGit,
    rebase: () => Promise.resolve({ ok: true as const, value: {} }),
  });
  assertEquals(failing.kind, "unknown");

  const unfetchable = await ensureBranchCurrent({
    branch: "feature",
    baseBranch: "main",
    runGit: fakeGit({
      "fetch": { ok: false, error: new Error("network down") },
    }).runGit,
    rebase: () => Promise.resolve({ ok: true as const, value: {} }),
  });
  assertEquals(unfetchable.kind, "unknown");
});
