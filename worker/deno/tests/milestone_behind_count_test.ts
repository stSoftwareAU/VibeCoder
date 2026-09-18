/**
 * Tests for `milestone_behind_count.ts` (Issue #2309).
 *
 * The number that decides the sweep's pass order. What matters is that it
 * counts the right direction — commits the default branch carries that the
 * milestone branch does not — and that every way git can refuse to answer
 * comes back as that refusal rather than as a zero, which would quietly sort
 * an unmeasurable branch as level.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Result } from "../types.ts";
import type { GitCommandOutput } from "../lib/git_timeout.ts";
import { measureMilestoneBehindCount } from "../lib/milestone_behind_count.ts";

/** A git result that succeeded with no output. */
const OK_OUTPUT: Result<GitCommandOutput> = {
  ok: true,
  value: { code: 0, stdout: "", stderr: "" },
};

Deno.test("measureMilestoneBehindCount - fetches the tracking ref, then counts default..milestone", async () => {
  const gitCalls: string[][] = [];
  const countCalls: string[][] = [];

  const result = await measureMilestoneBehindCount({
    milestoneBranch: "milestone/2298-merge-conflicts",
    defaultBranch: "main",
    cwd: "/clones/VibeCoder",
    gitFn: (args) => {
      gitCalls.push([...args]);
      return Promise.resolve(OK_OUTPUT);
    },
    countFn: (baseRef, ref) => {
      countCalls.push([baseRef, ref]);
      return Promise.resolve({ ok: true, value: 5 });
    },
  });

  assertEquals(result, { ok: true, value: 5 });
  // Issue #211: the tracking ref is named explicitly, so a narrowed clone
  // still has `origin/<milestone>` for the count to read.
  assertEquals(gitCalls.length, 1);
  assertStringIncludes(
    gitCalls[0]!.join(" "),
    "+refs/heads/milestone/2298-merge-conflicts:" +
      "refs/remotes/origin/milestone/2298-merge-conflicts",
  );
  // `base..ref` counts what `ref` carries beyond `base`, so the milestone
  // branch is the base: the answer is how far behind it is.
  assertEquals(countCalls, [[
    "origin/milestone/2298-merge-conflicts",
    "origin/main",
  ]]);
});

Deno.test("measureMilestoneBehindCount - a fetch that could not run is returned, not counted", async () => {
  let counted = false;

  const result = await measureMilestoneBehindCount({
    milestoneBranch: "milestone/x",
    defaultBranch: "main",
    cwd: "/clones/VibeCoder",
    gitFn: () =>
      Promise.resolve({ ok: false, error: new Error("git timed out") }),
    countFn: () => {
      counted = true;
      return Promise.resolve({ ok: true, value: 0 });
    },
  });

  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error.message, "git timed out");
  assertEquals(counted, false, "an unfetched ref is never counted");
});

Deno.test("measureMilestoneBehindCount - a non-zero fetch names the exit code and git's own stderr", async () => {
  const result = await measureMilestoneBehindCount({
    milestoneBranch: "milestone/gone",
    defaultBranch: "main",
    cwd: "/clones/VibeCoder",
    gitFn: () =>
      Promise.resolve({
        ok: true,
        value: {
          code: 128,
          stdout: "",
          stderr: "fatal: couldn't find remote ref milestone/gone\n",
        },
      }),
    countFn: () => Promise.resolve({ ok: true, value: 0 }),
  });

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "exited 128");
    assertStringIncludes(result.error.message, "couldn't find remote ref");
  }
});

Deno.test("measureMilestoneBehindCount - a fetch with no output still says which branch and code", async () => {
  const result = await measureMilestoneBehindCount({
    milestoneBranch: "milestone/quiet",
    defaultBranch: "main",
    cwd: "/clones/VibeCoder",
    gitFn: () =>
      Promise.resolve({
        ok: true,
        value: { code: 1, stdout: "", stderr: "   " },
      }),
    countFn: () => Promise.resolve({ ok: true, value: 0 }),
  });

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "milestone/quiet");
    assertStringIncludes(result.error.message, "(no output)");
  }
});

Deno.test("measureMilestoneBehindCount - a count git refused is passed through unchanged", async () => {
  const refusal = new Error("git rev-list --count exited 128");

  const result = await measureMilestoneBehindCount({
    milestoneBranch: "milestone/x",
    defaultBranch: "main",
    cwd: "/clones/VibeCoder",
    gitFn: () => Promise.resolve(OK_OUTPUT),
    countFn: () => Promise.resolve({ ok: false, error: refusal }),
  });

  assertEquals(result, { ok: false, error: refusal });
});

Deno.test("measureMilestoneBehindCount - a level branch reports zero, not a failure", async () => {
  const result = await measureMilestoneBehindCount({
    milestoneBranch: "milestone/level",
    defaultBranch: "main",
    cwd: "/clones/VibeCoder",
    gitFn: () => Promise.resolve(OK_OUTPUT),
    countFn: () => Promise.resolve({ ok: true, value: 0 }),
  });

  assertEquals(result, { ok: true, value: 0 });
});
