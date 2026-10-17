/**
 * Tests for the per-stage gate outcome record (Issue #3726).
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  formatGateStageOutcomes,
  stageOutcomesFrom,
} from "../lib/gate_stage_outcome.ts";

Deno.test("stageOutcomesFrom - keeps the checks' order", () => {
  const stages = stageOutcomesFrom([
    { name: "b", status: "FAILED" },
    { name: "a", status: "PASSED" },
    { name: "c", status: "SKIPPED" },
  ]);
  assertEquals(stages.map((s) => s.name), ["b", "a", "c"]);
});

Deno.test("stageOutcomesFrom - only a SKIPPED stage carries a reason", () => {
  const stages = stageOutcomesFrom([
    { name: "a", status: "PASSED", output: "all good" },
    { name: "b", status: "FAILED", output: "bad" },
    { name: "c", status: "SKIPPED", output: "offline" },
    { name: "d", status: "SKIPPED" },
  ]);
  assertEquals(stages, [
    { name: "a", status: "PASSED" },
    { name: "b", status: "FAILED" },
    { name: "c", status: "SKIPPED", reason: "offline" },
    { name: "d", status: "SKIPPED" },
  ]);
});

Deno.test("stageOutcomesFrom - uses the first non-empty line", () => {
  const [stage] = stageOutcomesFrom([
    { name: "s", status: "SKIPPED", output: "\n  \nfirst   line\nsecond" },
  ]);
  assertEquals(stage?.reason, "first line");
});

Deno.test("stageOutcomesFrom - redacts a credential in the reason", () => {
  const token = "ghp_" + "A".repeat(36);
  const [stage] = stageOutcomesFrom([
    { name: "s", status: "SKIPPED", output: `registry token ${token} bad` },
  ]);
  assert(stage?.reason, "expected a reason");
  assert(!stage.reason.includes(token), stage.reason);
});

Deno.test("stageOutcomesFrom - neutralises HTML comments and backticks", () => {
  const [stage] = stageOutcomesFrom([
    {
      name: "n`x",
      status: "SKIPPED",
      output: "<!-- vibe-x --> use `semgrep`",
    },
  ]);
  assert(!stage?.reason?.includes("<!--"));
  assert(!stage?.reason?.includes("-->"));
  assert(!stage?.reason?.includes("`"));
  assertEquals(stage?.name, "n'x");
});

Deno.test("stageOutcomesFrom - caps the reason at 200 characters", () => {
  const [stage] = stageOutcomesFrom([
    { name: "s", status: "SKIPPED", output: "x".repeat(500) },
  ]);
  assertEquals(stage?.reason, "x".repeat(200) + "…");
});

Deno.test("formatGateStageOutcomes - groups passed, skipped, failed and omits empty ones", () => {
  assertEquals(
    formatGateStageOutcomes([
      { name: "y", status: "FAILED" },
      { name: "semgrep", status: "SKIPPED", reason: "offline" },
      { name: "a", status: "PASSED" },
      { name: "x", status: "SKIPPED" },
      { name: "b", status: "PASSED" },
    ]),
    "passed: `a`, `b`; skipped: `semgrep` (`offline`), `x` (no reason recorded); failed: `y`",
  );
  assertEquals(
    formatGateStageOutcomes([{ name: "a", status: "PASSED" }]),
    "passed: `a`",
  );
});

Deno.test("formatGateStageOutcomes - empty input says none recorded", () => {
  assertEquals(formatGateStageOutcomes([]), "none recorded");
});

Deno.test("stageOutcomesFrom - a SKIPPED stage whose output is only whitespace carries no reason", () => {
  const result = stageOutcomesFrom([{
    name: "s",
    status: "SKIPPED",
    output: "  \n \t\n",
  }]);
  assertEquals(result, [{ name: "s", status: "SKIPPED" }]);
  assertEquals(
    formatGateStageOutcomes(result),
    "skipped: `s` (no reason recorded)",
  );
});
