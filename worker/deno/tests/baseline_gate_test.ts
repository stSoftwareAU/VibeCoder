/**
 * Tests for the generic baseline-aware quality-gate bypass (Issue #2604).
 *
 * Covers:
 *   - Per-check key extraction (mermaid/markdownlint).
 *   - `collectDiffableGateFindings` flattening of injected runners.
 *   - `decideGateBypass` cases:
 *       * pure carryover → bypass,
 *       * new finding → no bypass,
 *       * non-diffable failing check present → no bypass,
 *       * failing diffable check with zero parsed findings → no bypass
 *         (parser-drift guard),
 *       * empty baseline → no bypass.
 *   - `formatCarryoverFindings` output.
 *
 * (Shellcheck was removed as a diffable check with worker-side shellcheck —
 * Issue #3129; the docs prompt-version check went with prompt versioning
 * itself — Issue #844.)
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  collectDiffableGateFindings,
  decideGateBypass,
  formatCarryoverFindings,
  type GenericFinding,
  markdownlintFinding,
  mermaidFinding,
} from "../lib/baseline_gate.ts";

// ---------------------------------------------------------------------------
// Key extraction — position-insensitive
// ---------------------------------------------------------------------------

Deno.test("mermaidFinding - key is mermaid|file|type|error and is line-insensitive", () => {
  const a = mermaidFinding({
    file: "d.md",
    startLine: 3,
    type: "sequenceDiagram",
    error: "participant Loop",
  });
  const b = mermaidFinding({
    file: "d.md",
    startLine: 99,
    type: "sequenceDiagram",
    error: "participant Loop",
  });
  assertEquals(a.key, "mermaid|d.md|sequenceDiagram|participant Loop");
  assertEquals(a.key, b.key);
  assertEquals(a.check, "mermaid");
});

Deno.test("markdownlintFinding - key is markdownlint|file|rule|message", () => {
  const v = markdownlintFinding({
    file: "x.md",
    line: 5,
    rule: "MD056",
    message: "table count",
  });
  assertEquals(v.key, "markdownlint|x.md|MD056|table count");
  assertEquals(v.check, "markdownlint");
  assertStringIncludes(v.display, "x.md:5 MD056");
});

// ---------------------------------------------------------------------------
// collectDiffableGateFindings — flattens all injected runners
// ---------------------------------------------------------------------------

Deno.test("collectDiffableGateFindings - flattens mermaid/markdownlint", async () => {
  const findings = await collectDiffableGateFindings("/repo", {
    mermaid: () =>
      Promise.resolve({
        status: "FAILED",
        output: "",
        failures: [{
          file: "d.md",
          startLine: 3,
          type: "flowchart",
          error: "bad",
        }],
        filesScanned: 1,
        blocksScanned: 1,
      }),
    markdownlint: () =>
      Promise.resolve({
        status: "FAILED",
        output: "",
        violations: [{ file: "x.md", line: 5, rule: "MD056", message: "tbl" }],
        filesChecked: 1,
      }),
  });
  assertEquals(findings.length, 2);
  assertEquals(findings.map((f) => f.check).sort(), [
    "markdownlint",
    "mermaid",
  ]);
});

Deno.test("collectDiffableGateFindings - all checks clean contributes no findings", async () => {
  const findings = await collectDiffableGateFindings("/repo", {
    mermaid: () =>
      Promise.resolve({
        status: "PASSED",
        output: "",
        failures: [],
        filesScanned: 0,
        blocksScanned: 0,
      }),
    markdownlint: () =>
      Promise.resolve({
        status: "PASSED",
        output: "",
        violations: [],
        filesChecked: 0,
      }),
  });
  assertEquals(findings.length, 0);
});

// ---------------------------------------------------------------------------
// decideGateBypass
// ---------------------------------------------------------------------------

Deno.test("decideGateBypass - pure carryover (mermaid) → bypass", () => {
  const m = mermaidFinding({
    file: "d.md",
    startLine: 3,
    type: "sequenceDiagram",
    error: "participant Loop",
  });
  const decision = decideGateBypass([m], [m], ["mermaid"]);
  assertEquals(decision.bypass, true);
  assertEquals(decision.reason, "bypassed");
  assertEquals(decision.preExisting.length, 1);
  assertEquals(decision.newFindings.length, 0);
});

Deno.test("decideGateBypass - new finding → no bypass (the hole-fix)", () => {
  // markdownlint has carryover, but mermaid is NEW — must not bypass.
  const md = markdownlintFinding({
    file: "x.md",
    line: 5,
    rule: "MD056",
    message: "table count",
  });
  const newMermaid = mermaidFinding({
    file: "d.md",
    startLine: 3,
    type: "flowchart",
    error: "boom",
  });
  const decision = decideGateBypass(
    [md],
    [md, newMermaid],
    ["markdownlint", "mermaid"],
  );
  assertEquals(decision.bypass, false);
  assertEquals(decision.reason, "new_findings");
  assertEquals(decision.newFindings.length, 1);
  assertEquals(decision.newFindings[0]?.check, "mermaid");
});

Deno.test("decideGateBypass - non-diffable failing check present → no bypass", () => {
  const m = mermaidFinding({
    file: "d.md",
    startLine: 3,
    type: "flowchart",
    error: "x",
  });
  const decision = decideGateBypass([m], [m], ["mermaid", "deno tests"]);
  assertEquals(decision.bypass, false);
  assertEquals(decision.reason, "non_diffable_failing");
});

Deno.test("decideGateBypass - failing diffable check with zero parsed findings → no bypass (parser drift)", () => {
  // markdownlint reported FAILED but produced no structured violations
  // (e.g. the runner died) — we cannot account for the failure, so the
  // bypass must not fire even though mermaid has pure carryover.
  const m = mermaidFinding({
    file: "d.md",
    startLine: 3,
    type: "flowchart",
    error: "x",
  });
  const decision = decideGateBypass(
    [m],
    [m],
    ["mermaid", "markdownlint"],
  );
  assertEquals(decision.bypass, false);
  assertEquals(decision.reason, "unparsed_failing_check");
});

Deno.test("decideGateBypass - empty baseline → no bypass (no carryover to credit)", () => {
  const m = mermaidFinding({
    file: "d.md",
    startLine: 3,
    type: "flowchart",
    error: "x",
  });
  const decision = decideGateBypass([], [m], ["mermaid"]);
  assertEquals(decision.bypass, false);
  assertEquals(decision.reason, "new_findings");
});

Deno.test("decideGateBypass - empty baseline AND empty current → no bypass", () => {
  const decision = decideGateBypass([], [], ["mermaid"]);
  // mermaid failing but zero current mermaid findings → parser-drift guard.
  assertEquals(decision.bypass, false);
  assertEquals(decision.reason, "unparsed_failing_check");
});

// ---------------------------------------------------------------------------
// formatCarryoverFindings
// ---------------------------------------------------------------------------

Deno.test("formatCarryoverFindings - empty findings returns empty string", () => {
  assertEquals(formatCarryoverFindings([]), "");
});

Deno.test("formatCarryoverFindings - lists each new finding with its check tag", () => {
  const findings: GenericFinding[] = [
    markdownlintFinding({
      file: "x.md",
      line: 5,
      rule: "MD056",
      message: "table count",
    }),
    mermaidFinding({
      file: "d.md",
      startLine: 3,
      type: "flowchart",
      error: "boom",
    }),
  ];
  const prompt = formatCarryoverFindings(findings);
  assertStringIncludes(prompt, "[markdownlint] x.md:5 MD056");
  assertStringIncludes(prompt, "[mermaid] d.md:3 (flowchart): boom");
  assertStringIncludes(prompt, "Please fix only these new findings");
});
