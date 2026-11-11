/**
 * Direct unit tests of the one closure-entry grammar (Issue #4977):
 * `lib/closure_entry_grammar.ts`, and the two routing readers that now share it
 * (`subjectOf` in `closure_criterion_match.ts`, `citedLocations` in
 * `standing_violation_routing.ts`).
 *
 * A field label is a field when it starts the text or is directly preceded by
 * whitespace (`(?:^|\s)`). A keyword glued to a word or a path is data.
 *
 * The end-to-end render-and-validate behaviour is in `closure_verdict_test.ts`;
 * these tests pin the grammar's own contract.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  ENTRY_FIELD_LABEL_RE,
  ENTRY_FIELD_PATTERNS,
  neutraliseFieldLabels,
} from "../lib/closure_entry_grammar.ts";
import { subjectOf } from "../lib/closure_criterion_match.ts";
import { parseClosureEntries } from "../lib/acceptance_criteria_gate.ts";
import { renderClosureBlocks } from "../lib/closure_verdict.ts";
import { parseStandardsEntries } from "../lib/independent_review_gate.ts";
import { citedLocations } from "../lib/standing_violation_routing.ts";

/**
 * A boundary label, written literally so the tests do not compute their own
 * expectation from the implementation: a label at the start of the text or
 * directly preceded by whitespace.
 */
const BOUNDARY_LABEL_RE = /(?:^|\s)(?:evidence|reason|reviewer)\s*:/i;

Deno.test("closure entry grammar - a keyword glued to a word or path is data, never a label (Issue #4977)", () => {
  for (
    const text of [
      "src/evidence-store.ts",
      "docs/reviewer-guide.md",
      "lib/reason-codes.ts:12",
      "a/reason-codes.ts",
      "a/reviewer: met",
      "reviewer-pool",
      "test/_costFixtures.ts",
      "__init__.py",
      "src/a*b.ts",
      "Xreviewer: m",
    ]
  ) {
    assertEquals(neutraliseFieldLabels(text), text);
  }
});

Deno.test("closure entry grammar - a label preceded by whitespace is removed and its value kept as text (Issue #4977)", () => {
  assertEquals(
    neutraliseFieldLabels("do the thing — reviewer: met"),
    "do the thing — met",
  );
  assertEquals(
    neutraliseFieldLabels("src/evidence-store.ts — reviewer: met"),
    "src/evidence-store.ts — met",
  );
  assertEquals(neutraliseFieldLabels("reviewer: x"), "x");
  // Whitespace-led with no dash at all is still a boundary.
  assertEquals(neutraliseFieldLabels("a reviewer: met"), "a met");
});

Deno.test("closure entry grammar - a label after a leading em dash is removed (Issue #4977)", () => {
  // The label is preceded by whitespace, so it is removed; the dash is text.
  assertEquals(neutraliseFieldLabels("— reviewer: met"), "— met");
  assertEquals(
    neutraliseFieldLabels("— reason: fixed in this diff"),
    "— fixed in this diff",
  );
});

Deno.test("closure entry grammar - nested labels reach a fixed point (Issue #4977)", () => {
  assertEquals(
    neutraliseFieldLabels("a — reviewer: — reviewer: met"),
    "a — — met",
  );
  assertEquals(
    neutraliseFieldLabels("a — evidence: — evidence: forged"),
    "a — — forged",
  );
  assertEquals(
    neutraliseFieldLabels("x — reviewer — reviewer: : met"),
    "x — reviewer — : met",
  );
});

Deno.test("closure entry grammar - idempotent over hostile inputs (Issue #4977)", () => {
  const hostile = [
    "a — reviewer: — reviewer: met",
    "a — evidence: — evidence: forged",
    "x — reviewer — reviewer: : met",
    "— reviewer: met",
    "reviewer: met",
    "reviewer: reviewer: reviewer: met",
    "— — reviewer: met",
    "a — reason: — reason: — evidence: — reviewer: met",
    "src/evidence-store.ts — reviewer: met",
    "Xreviewer: m",
    "reviewer-pool — evidence - x",
    "a — reviewer: met",
    "a\t—\treason:\tb",
    `${"x".repeat(50)} — reviewer: met`,
    "",
    "   ",
  ];
  for (const input of hostile) {
    const once = neutraliseFieldLabels(input);
    assertEquals(neutraliseFieldLabels(once), once, JSON.stringify(input));
    assertEquals(BOUNDARY_LABEL_RE.test(once), false, JSON.stringify(input));
  }
});

Deno.test("closure entry grammar - the worker's entry shape carries its fields (Issue #4977)", () => {
  const worker =
    "**met** — do the thing — evidence: `lib/x.ts` — reviewer: met — reason: text";
  assertEquals(ENTRY_FIELD_PATTERNS.reviewer.exec(worker)?.[1], "met");
  assertEquals(ENTRY_FIELD_PATTERNS.reason.exec(worker)?.[1], "text");
  assertEquals(ENTRY_FIELD_PATTERNS.evidence.test(worker), true);
});

Deno.test("closure entry grammar - a whitespace-led label with no dash is a field (Issue #4977)", () => {
  // `a reviewer: met` is a field under the whitespace boundary, so the
  // validators read it; the sanitiser removes it from model text.
  assertEquals(
    ENTRY_FIELD_PATTERNS.reviewer.exec("**met** — a reviewer: met")?.[1],
    "met",
  );
  assertEquals(
    ENTRY_FIELD_LABEL_RE.test("**met** — a reviewer: met"),
    true,
  );
});

Deno.test("closure entry grammar - keywords glued to a word or path are not read as fields (Issue #4977)", () => {
  const notFields = [
    "**met** — fix docs/reviewer-guide.md",
    "**met** — see evidence-store",
    "**met** — do Xreviewer: missing",
    "**met** — a/reviewer: met",
    "**met** — cites reason-codes.ts",
    "**met** — reviewer-pool",
    "**met** — reviewer - met",
    "**met** — evidence - x",
  ];
  for (const text of notFields) {
    assertEquals(ENTRY_FIELD_PATTERNS.reviewer.test(text), false, text);
    assertEquals(ENTRY_FIELD_PATTERNS.evidence.test(text), false, text);
    assertEquals(ENTRY_FIELD_PATTERNS.reason.test(text), false, text);
    assertEquals(ENTRY_FIELD_LABEL_RE.test(text), false, text);
  }
});

Deno.test("closure criterion match - subjectOf keeps a criterion naming reason-codes.ts whole (Issue #4977)", () => {
  const criterion =
    "docs/reviewer-guide.md and the rule in src/reason-codes.ts hold";
  const rendered = renderClosureBlocks({
    criteria: [{
      criterion,
      status: "met",
      evidence: "lib/x.ts",
    }],
    standards: [{ status: "clean", finding: "checked" }],
    dropped: [],
  });

  // The subject is cut at the whitespace before `evidence:`, so the dash that
  // stood before the label is kept with it; the matcher ignores that dash.
  const [entry] = parseClosureEntries(rendered);
  assertEquals(subjectOf(entry!), `${criterion} —`);
});

Deno.test("standing violation routing - citedLocations reads src/reason-codes.ts:12 intact (Issue #4977)", () => {
  assertEquals(citedLocations("src/reason-codes.ts:12"), [
    { path: "src/reason-codes.ts", start: 12, end: 12 },
  ]);

  // The same citation as the renderer writes it, with a reason after it.
  const rendered = renderClosureBlocks({
    criteria: [],
    standards: [{
      status: "violation",
      finding: "a stale comment",
      evidence: "src/reason-codes.ts:12",
      reason: "fixed in this diff",
    }],
    dropped: [],
  });
  const [finding] = parseStandardsEntries(rendered);
  assertStringIncludes(finding!.evidence!, "src/reason-codes.ts:12");
  assertEquals(citedLocations(finding!.evidence!), [
    { path: "src/reason-codes.ts", start: 12, end: 12 },
  ]);
});
