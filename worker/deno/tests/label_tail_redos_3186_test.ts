/**
 * Every labelled-field and list-item regex in the closure and reproduction
 * gates gets its own hostile case (Issue #3186).
 *
 * The patterns ended in a greedy `(.*)$`. `.` does not cross a lone `\r`, so
 * when one sits before the end of the text the tail cannot reach `$` and the
 * engine backtracks over everything it took. Two shapes made that quadratic:
 *
 *   - an unanchored label (`reason:`, `evidence:`) repeated along one line:
 *     the search restarts at every occurrence and each restart rescans to the
 *     end of the line;
 *   - an anchored label or list marker followed by a run of spaces: `\s*` (or
 *     `\s+`) and `(.*)` can split the run in every possible way.
 *
 * The patterns, all in agent-written PR summaries:
 *
 *   - `reproduction_status_gate.ts` — `REASON_RE` and the three
 *     `FIELD_PATTERNS` (`symptom`, `status`, `test`), 200 000-char scan cap.
 *     Measured against the unfixed patterns, a 32 000-char line cost about
 *     0.24 s (repeated `reason:`) and 0.85 s (padded `symptom:`); at the cap,
 *     roughly 8 s and 30 s per call.
 *   - `acceptance_criteria_gate.ts` — `LABEL_PATTERNS.evidence`,
 *     `LABEL_PATTERNS.reason` and `LIST_ITEM_RE`, no scan cap.
 *   - `independent_review_gate.ts` — `LIST_ITEM_RE`, the same list-marker tail
 *     as the closure gate's (200 000-char cap).
 *
 * The fix reads each value with `[^\n]*` and no `$`: the tail can never fail,
 * so the first label that has a separator wins and nothing backtracks. A value
 * after a lone `\r` is now read rather than silently dropped, which is the
 * observable difference these cases assert. Text sits between the last label
 * and the `\r` because `\s*` matches `\r`: a label directly before it would
 * still match on the unfixed pattern, after the quadratic search.
 *
 * Nothing here reads a clock (CODING-STANDARDS.md, "Guard super-linearity by
 * behaviour first"). Each case feeds the hostile line and asserts what the
 * parser produces, so a rewrite cannot buy speed by dropping the match.
 *
 * Uses Australian English throughout (behaviour, recognise).
 */

import { assert, assertEquals } from "@std/assert";
import { parseClosureEntries } from "../lib/acceptance_criteria_gate.ts";
import { parseSpecEntries } from "../lib/independent_review_gate.ts";
import { parseReproductionBlock } from "../lib/reproduction_status_gate.ts";

/**
 * Long enough that each unfixed pattern took 7–36 s here, short enough to stay
 * inside the 200 000-char scan caps.
 */
const RUN = 190_000;

/** `label` repeated along one line until it fills `RUN` characters. */
function repeated(label: string): string {
  return label.repeat(Math.floor(RUN / label.length));
}

/** A run of spaces, a lone `\r`, then text: the tail cannot reach `$`. */
const PADDED_TAIL = `${" ".repeat(RUN)}value\rafter`;

Deno.test("3186 - reproduction reason: a line repeating the label is read from its first occurrence", () => {
  const block = parseReproductionBlock(
    `## Reproduction\n- status: partial\n- ${
      repeated("reason: ")
    }end\rno CI runner`,
  );
  assertEquals(block.status, "partial");
  assert(
    block.reason.startsWith("reason: reason:"),
    "value starts after the first label",
  );
  assert(
    block.reason.endsWith("end\rno CI runner"),
    "value runs past the lone CR",
  );
});

Deno.test("3186 - reproduction symptom field: a padded value with a lone CR is read", () => {
  const block = parseReproductionBlock(
    `## Reproduction\n- symptom:${PADDED_TAIL}`,
  );
  assertEquals(block.present, true);
  assertEquals(block.symptom, "value\rafter");
});

Deno.test("3186 - reproduction status field: a padded value with a lone CR is read", () => {
  const block = parseReproductionBlock(
    `## Reproduction\n- status:${" ".repeat(RUN)}verified\rafter`,
  );
  assertEquals(block.status, "verified");
});

Deno.test("3186 - reproduction test field: a padded value with a lone CR is read", () => {
  const block = parseReproductionBlock(
    `## Reproduction\n- test:${PADDED_TAIL}`,
  );
  assertEquals(block.regressionTest, "value\rafter");
});

Deno.test("3186 - closure evidence label: a line repeating the label is filled", () => {
  const entries = parseClosureEntries(
    `## Acceptance Criteria\n- met\n  ${repeated("evidence: ")}end\rthe test`,
  );
  assertEquals(entries.map((e) => [e.status, e.hasEvidence]), [["met", true]]);
});

Deno.test("3186 - closure reason label: a line repeating the label is filled", () => {
  const entries = parseClosureEntries(
    `## Acceptance Criteria\n- missing\n  ${
      repeated("reason: ")
    }end\rout of scope`,
  );
  assertEquals(entries.map((e) => [e.status, e.hasReason]), [[
    "missing",
    true,
  ]]);
});

Deno.test("3186 - closure list item: a padded item with a lone CR is still an entry", () => {
  const entries = parseClosureEntries(
    `## Acceptance Criteria\n-${
      " ".repeat(RUN)
    }met — evidence: the test\rafter`,
  );
  assertEquals(entries.map((e) => [e.status, e.hasEvidence]), [["met", true]]);
});

Deno.test("3186 - independent-review list item: a padded item with a lone CR is still an entry", () => {
  const entries = parseSpecEntries(
    `## Acceptance Criteria\n-${
      " ".repeat(RUN)
    }met — evidence: the test\rafter`,
  );
  assertEquals(entries.map((e) => [e.status, e.hasEvidence]), [["met", true]]);
});
