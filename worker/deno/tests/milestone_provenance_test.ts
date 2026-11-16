/**
 * Tests for the shared `Part of #N` provenance lines (Issue #4967, Issue #5058).
 *
 * The full rollup and the partial rollup both render their anchored `Part of`
 * lines through `milestoneProvenanceLines`, so these cases pin the ordering,
 * the cap and the exclusions both bodies rely on. Literal expected values.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { milestoneProvenanceLines } from "../lib/milestone_provenance.ts";
import { MILESTONE_PROVENANCE_MAX_CHILDREN } from "../lib/governing_issue_limits.ts";

Deno.test("milestoneProvenanceLines - the parent comes first, then children ascending and deduplicated (Issue #5058)", () => {
  assertEquals(
    milestoneProvenanceLines("#42 Retry policy", [81, 77, 77, 42, 9]),
    ["Part of #42", "Part of #9", "Part of #77", "Part of #81"],
  );
});

Deno.test("milestoneProvenanceLines - a title with no leading #N gives children only (Issue #5058)", () => {
  assertEquals(
    milestoneProvenanceLines("Deadlock Breaker", [81, 77]),
    ["Part of #77", "Part of #81"],
  );
  assertEquals(
    milestoneProvenanceLines("Retry #42", [77]),
    ["Part of #77"],
  );
});

Deno.test("milestoneProvenanceLines - a title whose leading number is zero gives no parent (Issue #5058)", () => {
  assertEquals(milestoneProvenanceLines("#0 Nope", []), []);
});

Deno.test("milestoneProvenanceLines - the cap keeps only the lowest MILESTONE_PROVENANCE_MAX_CHILDREN children (Issue #5058)", () => {
  const numbers = Array.from(
    { length: MILESTONE_PROVENANCE_MAX_CHILDREN + 3 },
    (_, i) => 100 + i,
  ).reverse();
  const lines = milestoneProvenanceLines("Deadlock Breaker", numbers);
  assertEquals(lines.length, MILESTONE_PROVENANCE_MAX_CHILDREN);
  assertEquals(lines[0], "Part of #100");
  assertEquals(
    lines[lines.length - 1],
    `Part of #${99 + MILESTONE_PROVENANCE_MAX_CHILDREN}`,
  );
  assertEquals(
    lines.includes(`Part of #${100 + MILESTONE_PROVENANCE_MAX_CHILDREN}`),
    false,
  );
});

Deno.test("milestoneProvenanceLines - the cap does not count the parent (Issue #5058)", () => {
  const numbers = Array.from(
    { length: MILESTONE_PROVENANCE_MAX_CHILDREN + 1 },
    (_, i) => 100 + i,
  );
  const lines = milestoneProvenanceLines("#42 Retry policy", numbers);
  assertEquals(lines[0], "Part of #42");
  assertEquals(lines.length, MILESTONE_PROVENANCE_MAX_CHILDREN + 1);
});

Deno.test("milestoneProvenanceLines - the tracking issue is excluded from the parent and the children (Issue #5058)", () => {
  assertEquals(
    milestoneProvenanceLines("#42 Retry policy", [42, 55, 99], 99),
    ["Part of #42", "Part of #55"],
  );
});

Deno.test("milestoneProvenanceLines - a parent equal to the tracking issue is not repeated (Issue #5058)", () => {
  assertEquals(
    milestoneProvenanceLines("#42 Retry policy", [77], 42),
    ["Part of #77"],
  );
});

Deno.test("milestoneProvenanceLines - zero, negative, fractional, unsafe and NaN numbers are rejected (Issue #5058)", () => {
  assertEquals(
    milestoneProvenanceLines("Deadlock Breaker", [
      0,
      -3,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      5,
    ]),
    ["Part of #5"],
  );
});

Deno.test("milestoneProvenanceLines - no numbers and no parent gives no lines (Issue #5058)", () => {
  assertEquals(milestoneProvenanceLines("Deadlock Breaker", []), []);
});
