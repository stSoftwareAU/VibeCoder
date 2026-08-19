/**
 * Tests for security_fix_diff.ts — machine-checkable diff evidence collection
 * for the security-fix gate (Issue #3652).
 *
 * Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import { collectSecurityFixDiff } from "../lib/security_fix_diff.ts";

Deno.test("collectSecurityFixDiff - collects changed files and test-file diff", async () => {
  const calls: string[][] = [];
  const git = (args: string[]): Promise<string> => {
    calls.push([...args]);
    if (args.includes("--name-only")) {
      return Promise.resolve(
        "worker/deno/lib/foo.ts\nworker/deno/tests/foo_test.ts\n",
      );
    }
    return Promise.resolve('+Deno.test("rejects injection", () => {});\n');
  };

  const diff = await collectSecurityFixDiff(git, "main");

  assertEquals(diff !== null, true);
  assertEquals(diff!.changedFiles, [
    "worker/deno/lib/foo.ts",
    "worker/deno/tests/foo_test.ts",
  ]);
  assertEquals(diff!.testDiffText.includes("rejects injection"), true);
  // The second call restricts the diff to the changed test files only.
  assertEquals(calls[1]!.includes("worker/deno/tests/foo_test.ts"), true);
  assertEquals(calls[1]!.includes("worker/deno/lib/foo.ts"), false);
});

Deno.test("collectSecurityFixDiff - falls back to the local branch ref", async () => {
  const refsTried: string[] = [];
  const git = (args: string[]): Promise<string> => {
    if (args.includes("--name-only")) {
      const ref = args.find((a) => a.includes("...")) ?? "";
      refsTried.push(ref);
      if (ref.startsWith("origin/")) {
        return Promise.reject(new Error("unknown revision origin/main"));
      }
      return Promise.resolve("tests/a_test.ts\n");
    }
    return Promise.resolve("+added\n");
  };

  const diff = await collectSecurityFixDiff(git, "main");

  assertEquals(refsTried, ["origin/main...HEAD", "main...HEAD"]);
  assertEquals(diff!.changedFiles, ["tests/a_test.ts"]);
});

Deno.test("collectSecurityFixDiff - returns null when no ref resolves (fail loud)", async () => {
  const git = (_args: string[]): Promise<string> =>
    Promise.reject(new Error("unknown revision"));

  const diff = await collectSecurityFixDiff(git, "main");
  assertEquals(diff, null);
});

Deno.test("collectSecurityFixDiff - returns null for an empty base branch", async () => {
  let called = false;
  const git = (_args: string[]): Promise<string> => {
    called = true;
    return Promise.resolve("");
  };

  assertEquals(await collectSecurityFixDiff(git, "  "), null);
  assertEquals(called, false);
});

Deno.test("collectSecurityFixDiff - no test files means an empty test diff, no second git call", async () => {
  const calls: string[][] = [];
  const git = (args: string[]): Promise<string> => {
    calls.push([...args]);
    return Promise.resolve("worker/deno/lib/foo.ts\n");
  };

  const diff = await collectSecurityFixDiff(git, "main");

  assertEquals(diff!.changedFiles, ["worker/deno/lib/foo.ts"]);
  assertEquals(diff!.testDiffText, "");
  assertEquals(calls.length, 1);
});

Deno.test("collectSecurityFixDiff - tolerates a failing diff body command", async () => {
  const git = (args: string[]): Promise<string> => {
    if (args.includes("--name-only")) return Promise.resolve("tests/a_test.ts");
    return Promise.reject(new Error("diff too large"));
  };

  const diff = await collectSecurityFixDiff(git, "main");
  // File list still collected; the empty body simply cannot satisfy the
  // identifier assertion, so the gate blocks rather than passing silently.
  assertEquals(diff!.changedFiles, ["tests/a_test.ts"]);
  assertEquals(diff!.testDiffText, "");
});
