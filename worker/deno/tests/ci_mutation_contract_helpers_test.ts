/**
 * Pins the shared workflow-text helpers that `ci_cargo_checks.ts` still uses
 * after Issue #5095 retired the mutation contract probe.
 *
 * Uses Australian English throughout (behaviour, recognised, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  isNonFailing,
  logicalLines,
  triggersOn,
} from "../lib/ci_mutation_contract.ts";

Deno.test("triggersOn: push and pull_request_target do not count as pull_request", () => {
  assertEquals(triggersOn({ on: "push" }, "pull_request"), false);
  assertEquals(
    triggersOn({ on: "pull_request_target" }, "pull_request"),
    false,
  );
  assertEquals(
    triggersOn({ on: ["push", "pull_request_target"] }, "pull_request"),
    false,
  );
});

Deno.test("triggersOn: a string, array or mapping trigger naming pull_request counts", () => {
  assertEquals(triggersOn({ on: "pull_request" }, "pull_request"), true);
  assertEquals(
    triggersOn({ on: ["push", "pull_request"] }, "pull_request"),
    true,
  );
  assertEquals(
    triggersOn({ on: { push: null, pull_request: null } }, "pull_request"),
    true,
  );
});

Deno.test("triggersOn: a YAML 1.1 boolean `true` key is read as the trigger", () => {
  // YAML 1.1 reads a bare `on` key as boolean true; the parser may yield
  // either key, and the trigger must still be recognised.
  assertEquals(
    triggersOn({ true: { pull_request: null } }, "pull_request"),
    true,
  );
});

Deno.test("triggersOn: a trigger that is neither string, array nor mapping does not count", () => {
  assertEquals(triggersOn({ on: 5 }, "pull_request"), false);
  assertEquals(triggersOn({ on: null }, "pull_request"), false);
});

Deno.test("isNonFailing: each no-op tail on a cargo mutants line is non-failing", () => {
  const tails = [
    "|| true",
    "||true",
    "|| :",
    "|| exit 0",
    "|| /bin/true",
    "|| true;",
    "|| true ;",
  ];
  for (const tail of tails) {
    assertEquals(isNonFailing(`cargo mutants ${tail}`), true, `tail: ${tail}`);
  }
});

Deno.test("isNonFailing: cargo mutants followed by || true is non-failing", () => {
  assertEquals(isNonFailing("cargo mutants --in-place || true"), true);
});

Deno.test("isNonFailing: a no-op tail after a comment marker does not make a line non-failing", () => {
  // In shell the `|| true` sits inside the comment, so the step still fails.
  assertEquals(isNonFailing("cargo mutants # || true"), false);
});

Deno.test("isNonFailing: a trailing || true after an && chain is non-failing", () => {
  // `(cargo mutants && echo done) || true` exits 0 whether or not mutants fails.
  assertEquals(isNonFailing("cargo mutants && echo done || true"), true);
});

Deno.test("isNonFailing: a no-op tail on a different command does not exempt the line", () => {
  assertEquals(isNonFailing('echo "|| true" ; cargo mutants'), false);
});

Deno.test("logicalLines: a line continuation joins cargo and mutants", () => {
  assertEquals(
    logicalLines(["cargo \\", "  mutants --in-place"].join("\n")),
    ["cargo mutants --in-place"],
  );
});

Deno.test("logicalLines: a line continuation into a no-op tail is non-failing", () => {
  const lines = logicalLines(["cargo mutants \\", "  || true"].join("\n"));
  assertEquals(lines, ["cargo mutants || true"]);
  assertEquals(isNonFailing(lines[0] ?? ""), true);
});

Deno.test("continued workflow lines have linear growth", () => {
  // Output-based guard: a super-linear implementation would take far longer
  // than the test budget on this input, and a wrong one would fail the exact
  // comparison below. No wall-clock timing is used.
  const count = 40000;
  const run = "a \\\n".repeat(count) + "b";
  assertEquals(logicalLines(run), [
    Array.from({ length: count }, () => "a").concat("b").join(" "),
  ]);

  const longLine = "a".repeat(50000) + "!";
  assertEquals(isNonFailing(longLine), false);
});
