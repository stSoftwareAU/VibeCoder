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
  workflowHygieneFinding,
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

Deno.test("workflowHygieneFinding - key is workflow hygiene|file|kind|detail and is line-insensitive (Issue #1641)", () => {
  const a = workflowHygieneFinding({
    file: ".github/workflows/ci.yml",
    line: 12,
    kind: "version-comment-drift",
    detail: "actions/checkout@34e11487 annotated v4 here, v4.3.1 in deploy.yml",
  });
  const b = workflowHygieneFinding({
    ...{
      file: ".github/workflows/ci.yml",
      line: 40,
      kind: "version-comment-drift",
      detail:
        "actions/checkout@34e11487 annotated v4 here, v4.3.1 in deploy.yml",
    },
  });
  assertEquals(a.check, "workflow hygiene");
  assertEquals(
    a.key,
    "workflow hygiene|.github/workflows/ci.yml|version-comment-drift|" +
      "actions/checkout@34e11487 annotated v4 here, v4.3.1 in deploy.yml",
  );
  assertEquals(a.key, b.key, "the line is not part of the identity");
  assertStringIncludes(a.display, ".github/workflows/ci.yml:12");
  assertStringIncludes(a.display, "version-comment-drift");
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
    workflowHygiene: () =>
      Promise.resolve({
        violations: [{
          file: ".github/workflows/ci.yml",
          line: 9,
          kind: "missing-strict-mode",
          detail: "multi-line run block does not start with set -euo pipefail",
        }],
        filesScanned: 1,
      }),
  });
  assertEquals(findings.length, 3);
  assertEquals(findings.map((f) => f.check).sort(), [
    "markdownlint",
    "mermaid",
    "workflow hygiene",
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
    workflowHygiene: () => Promise.resolve({ violations: [], filesScanned: 0 }),
  });
  assertEquals(findings.length, 0);
});

// ---------------------------------------------------------------------------
// decideGateBypass — workflow hygiene (Issue #1641)
// ---------------------------------------------------------------------------

const DRIFT = workflowHygieneFinding({
  file: ".github/workflows/deno-quality.yml",
  line: 21,
  kind: "version-comment-drift",
  detail: "actions/checkout@34e11487 annotated v4 here, v4.3.1 in gitleaks.yml",
});
const STRICT = workflowHygieneFinding({
  file: ".github/workflows/deploy.yml",
  line: 30,
  kind: "missing-strict-mode",
  detail: "multi-line run block does not start with set -euo pipefail",
});

Deno.test("decideGateBypass - pre-existing workflow-hygiene findings alone → bypass (Issue #1641)", () => {
  // GRQ-FX-validation#119: every violation was on Develop before the run.
  const d = decideGateBypass([DRIFT, STRICT], [DRIFT, STRICT], [
    "workflow hygiene",
  ]);
  assertEquals(d.bypass, true);
  assertEquals(d.reason, "bypassed");
  assertEquals(d.preExisting.length, 2);
  assertEquals(d.newFindings.length, 0);
});

Deno.test("decideGateBypass - a hygiene finding the run introduced → no bypass, named alone (Issue #1641)", () => {
  const d = decideGateBypass([DRIFT], [DRIFT, STRICT], ["workflow hygiene"]);
  assertEquals(d.bypass, false);
  assertEquals(d.reason, "new_findings");
  assertEquals(d.newFindings.map((f) => f.key), [STRICT.key]);
  const prompt = formatCarryoverFindings(d.newFindings);
  assertStringIncludes(
    prompt,
    "[workflow hygiene] .github/workflows/deploy.yml:30",
  );
  assertEquals(
    prompt.includes("deno-quality.yml"),
    false,
    "the carry-over is not named",
  );
});

Deno.test("decideGateBypass - a failing hygiene check with no parsed hygiene findings → no bypass (parser drift)", () => {
  const d = decideGateBypass([DRIFT], [], ["workflow hygiene"]);
  assertEquals(d.bypass, false);
  assertEquals(d.reason, "unparsed_failing_check");
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
