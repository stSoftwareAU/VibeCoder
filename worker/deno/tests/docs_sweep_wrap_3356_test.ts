/**
 * Docs-sweep entries are read per Markdown logical unit (Issue #3356).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { validateDocsSweep } from "../lib/docs_sweep_gate.ts";

const CHANGED = ["worker/deno/lib/foo.ts"];

function run(prSummaryContent: string) {
  return validateDocsSweep({ changedFiles: CHANGED, prSummaryContent });
}

Deno.test("hard-wrapped key split from its value is read (pr-summary-3092 shape)", () => {
  const result = run(
    "- **Docs sweep**: grep: reportSummaryRuleBlock, degraded-run guard,\n" +
      "  assessDegradedDelivery; section:\n" +
      "  docs/workflows/issue-processing.md#️-a-degraded-run-never-closes-an-issue-as-complete\n",
  );
  assert(result.valid, result.problems.join("; "));
  assertEquals(
    result.line.section,
    "docs/workflows/issue-processing.md#️-a-degraded-run-never-closes-an-issue-as-complete",
  );
});

Deno.test("placeholder wrapped onto the next line is still a bare placeholder", () => {
  const result = run(
    "**Docs sweep** — grep: `retryLimit`; section:\nnone\n",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems.join("\n"), "bare placeholder");
});

Deno.test("a following table row carrying section: is not part of the entry", () => {
  const result = run(
    "**Docs sweep** — grep: `retryLimit`; no hits\n| Field | section: docs/x.md#y |\n",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems.join("\n"), "names no `section:`");
});

Deno.test("a following HTML comment carrying section: is not part of the entry", () => {
  const result = run(
    "**Docs sweep** — grep: `retryLimit`; no hits\n<!-- section: docs/x.md#y -->\n",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems.join("\n"), "names no `section:`");
});

Deno.test("a fenced example is not the entry", () => {
  const fenced =
    "```markdown\n**Docs sweep** — grep: `x`; section: `docs/a.md#b`\n```\n";
  const alone = run(fenced);
  assertEquals(alone.valid, false);
  assertEquals(alone.line.present, false);
  assertStringIncludes(alone.problems.join("\n"), "no `Docs sweep` line");

  const withReal = run(
    fenced + "\n**Docs sweep** — grep: `y`; section: `docs/c.md#d`\n",
  );
  assert(withReal.valid, withReal.problems.join("; "));
  assertEquals(withReal.line.section, "docs/c.md#d");
});
