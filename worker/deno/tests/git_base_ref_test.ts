/**
 * Tests for git_base_ref.ts — resolving a base branch to a ref this clone can
 * compare against (Issue #106).
 *
 * The regression that motivated it: a milestone base present only as
 * `origin/<base>` made `git log <base>..HEAD` fail (exit 128), which the change
 * detector silently read as "no commits" and escalated the run as analysis-only.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type GitRunner,
  resolveComparableBaseRef,
} from "../lib/git_base_ref.ts";
import type { Result } from "../types.ts";

/** Build a runner whose behaviour is decided per-command by `handler`. */
function runnerFrom(
  handler: (
    args: string[],
  ) => { code: number; stdout?: string; stderr?: string },
): GitRunner {
  return (
    args: string[],
  ): Promise<Result<{ code: number; stdout: string; stderr: string }>> => {
    const r = handler(args);
    return Promise.resolve({
      ok: true,
      value: { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" },
    });
  };
}

/** A `rev-parse --verify` call for `ref` (the resolver's existence probe). */
function isVerifyOf(args: string[], ref: string): boolean {
  return args[0] === "rev-parse" && args.includes(`${ref}^{commit}`);
}

const SHA = "a".repeat(40);

Deno.test("resolveComparableBaseRef - uses the local branch when it resolves", async () => {
  const runner = runnerFrom((args) =>
    isVerifyOf(args, "main") ? { code: 0, stdout: SHA } : { code: 1 }
  );
  const result = await resolveComparableBaseRef(runner, "main");
  assert(result.ok);
  assertEquals(result.value, "main");
});

Deno.test("resolveComparableBaseRef - falls back to origin/<base> when local is absent (the milestone case)", async () => {
  const milestone = "milestone/4136-promotion-gate";
  const runner = runnerFrom((args) => {
    if (isVerifyOf(args, milestone)) return { code: 1 }; // local absent
    if (isVerifyOf(args, `origin/${milestone}`)) {
      return { code: 0, stdout: SHA };
    }
    return { code: 1 };
  });
  const result = await resolveComparableBaseRef(runner, milestone);
  assert(result.ok);
  assertEquals(result.value, `origin/${milestone}`);
});

Deno.test("resolveComparableBaseRef - fetches the base then resolves origin/<base>", async () => {
  const milestone = "milestone/4136-promotion-gate";
  let fetched = false;
  const runner = runnerFrom((args) => {
    if (args[0] === "fetch") {
      fetched = true;
      return { code: 0 };
    }
    if (isVerifyOf(args, milestone)) return { code: 1 };
    // origin/<base> only resolves AFTER the fetch.
    if (isVerifyOf(args, `origin/${milestone}`)) {
      return fetched ? { code: 0, stdout: SHA } : { code: 1 };
    }
    return { code: 1 };
  });
  const result = await resolveComparableBaseRef(runner, milestone);
  assert(result.ok);
  assertEquals(result.value, `origin/${milestone}`);
  assert(fetched, "the resolver fetched the base before resolving it");
});

Deno.test("resolveComparableBaseRef - errors when the base cannot be produced at all", async () => {
  const runner = runnerFrom(() => ({ code: 1 })); // nothing resolves, fetch no-op
  const result = await resolveComparableBaseRef(runner, "ghost-branch");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "ghost-branch");
    assertStringIncludes(result.error.message, "origin/ghost-branch");
  }
});

Deno.test("resolveComparableBaseRef - a non-zero exit on the verify is not treated as resolved", async () => {
  // Guards the exact bug shape: a failing rev-parse (code 128) must NOT count
  // as the ref existing just because the command ran.
  const runner = runnerFrom((args) =>
    isVerifyOf(args, "main")
      ? { code: 128, stderr: "fatal: bad revision" }
      : { code: 1 }
  );
  const result = await resolveComparableBaseRef(runner, "main");
  assertEquals(result.ok, false);
});
