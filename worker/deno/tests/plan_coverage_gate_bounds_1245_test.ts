/**
 * Regression tests for the quadratic separator match in the plan-coverage
 * gate (Issue #1245).
 *
 * `SEPARATOR_RE` was `/^\s{0,3}\|[\s:|-]*-[\s:|-]*\|?\s*$/` — two adjacent
 * quantified classes that both contain `-`, so a run of dashes had
 * exponentially many ways to split between them and cost grew quadratically
 * (measured here: 118 ms at 8 000 dashes, 2.5 s at 32 000, 11.7 s at 64 000).
 * `extractCoverageTable()` runs that pattern over every line of every
 * candidate — each comment on the planning parent plus the issue body — and a
 * comment body is writable by any account on a public repository, so one
 * 64 KB comment stalled the planning close-out path, on every planning close.
 *
 * **Two shapes, not one.** A first rewrite killed the dash-run split but kept
 * a `\s*\|?\s*$` tail, which is the same defect in whitespace: `|-` followed
 * by 64 000 spaces still cost 4.2 s. Both shapes are measured below, because
 * a guard that only knows the payload from the report cannot catch the one
 * the fix introduces.
 *
 * Three guards, matching the halves of the fix:
 *   - the growth checks, which time the same work at N and 4N and fail only
 *     when the cost grew faster than the input (`assertLinearGrowth`, the
 *     ratio shape `CODING-STANDARDS.md` requires — an absolute millisecond
 *     budget is flaky across fleet hosts, a same-work ratio is not);
 *   - the scan cap, asserted behaviourally: a candidate past
 *     `MAX_COVERAGE_SCAN_CHARS` is rejected rather than scanned, and the gate
 *     says so out loud rather than silently treating it as table-free.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  extractCoverageTable,
  MAX_COVERAGE_SCAN_CHARS,
  runPlanCoverageGate,
} from "../lib/plan_coverage_gate.ts";
import type { Logger } from "../types.ts";
import { assertLinearGrowth } from "./support/growth.ts";

/** A minimal, compliant coverage table. */
const COMPLIANT_TABLE = `## Plan Coverage

| Ask | Covered by | Notes |
| --- | --- | --- |
| Cap the candidate | #101 | |
`;

/** The fleet login the comment-author gate trusts (Issue #1244). */
const FLEET_LOGIN = "vibe-bot";

/** Records warnings so the loud-skip path can be asserted. */
function makeRecordingLogger(): Pick<Logger, "info" | "warn"> & {
  warnings: string[];
} {
  const warnings: string[] = [];
  return {
    warnings,
    info: () => {},
    warn: (message: string) => void warnings.push(message),
  };
}

/**
 * The adversarial payload: a pipe, a run of `n` dashes, then a character that
 * cannot appear in a separator row, so the match must fail. A second line
 * follows because `extractCoverageTable` only inspects a line when one
 * follows it.
 */
function dashRun(n: number): string {
  return `|${"-".repeat(n)}x\n| trailing |`;
}

/** The same payload in whitespace: one dash, then a run of `n` spaces. */
function spaceTail(n: number): string {
  return `|-${" ".repeat(n)}x\n| trailing |`;
}

Deno.test("extractCoverageTable - a hostile dash run scales linearly (Issue #1245)", () => {
  // Pre-fix: 8 000 dashes cost ~118 ms and 32 000 cost ~2.5 s — quadratic, far
  // past the 2x slack a linear rule is allowed.
  const rows = assertLinearGrowth(
    "plan-coverage separator match, dash run",
    (chars) => dashRun(chars),
    (input) => extractCoverageTable(input),
    { baseChars: 8_000 },
  );
  assertEquals(rows, null, "a dash run is not a coverage table");
});

Deno.test("extractCoverageTable - a hostile whitespace tail scales linearly (Issue #1245)", () => {
  // The shape the first rewrite missed: adjacent `\s*` runs either side of an
  // optional closing pipe cost 4.2 s on 64 000 spaces.
  const rows = assertLinearGrowth(
    "plan-coverage separator match, whitespace tail",
    (chars) => spaceTail(chars),
    (input) => extractCoverageTable(input),
    { baseChars: 8_000 },
  );
  assertEquals(rows, null, "a whitespace run is not a coverage table");
});

Deno.test("extractCoverageTable - a candidate past the scan cap is rejected, not scanned (Issue #1245)", () => {
  const padding = "filler line\n".repeat(
    Math.ceil(MAX_COVERAGE_SCAN_CHARS / 12),
  );
  const oversized = `${COMPLIANT_TABLE}\n${padding}`;
  assert(
    oversized.length > MAX_COVERAGE_SCAN_CHARS,
    "the fixture must exceed the cap to exercise it",
  );

  assertEquals(
    extractCoverageTable(oversized),
    null,
    "a candidate past the cap must be rejected before any line is matched",
  );
  // The same table under the cap is still found, so it is the cap that
  // rejected the blob and not the parser.
  assertEquals(extractCoverageTable(COMPLIANT_TABLE)?.length, 1);
});

Deno.test("extractCoverageTable - every markdown alignment form still separates a table (Issue #1245)", () => {
  for (
    const separator of [
      "| --- | --- | --- |",
      "|---|---|---|",
      "| :--- | ---: | :---: |",
      "   | - | - | - |",
      "| --- | --- | ---",
    ]
  ) {
    const markdown = `| Ask | Covered by | Notes |\n${separator}\n` +
      `| Cap the candidate | #101 | |\n`;
    const rows = extractCoverageTable(markdown);
    assertEquals(
      rows?.length,
      1,
      `the separator "${separator}" is no longer recognised`,
    );
    assertEquals(rows?.[0]?.coveredBy, "#101");
  }
});

Deno.test("runPlanCoverageGate - an oversized comment is skipped loudly and a real table still decides (Issue #1245)", async () => {
  const logger = makeRecordingLogger();
  const oversized = `|${"-".repeat(MAX_COVERAGE_SCAN_CHARS + 10)}x`;

  const verdict = await runPlanCoverageGate({
    repo: "owner/repo",
    parentIssueNumber: 42,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify({
        body: "",
        // Newest first once reversed: the hostile comment, then the real one.
        // Both carry the fleet author the #1244 gate requires, so this test
        // exercises the scan cap rather than the author check (Issue #1358).
        comments: [
          { body: COMPLIANT_TABLE, author: { login: FLEET_LOGIN } },
          { body: oversized, author: { login: FLEET_LOGIN } },
        ],
      })),
    logger,
    authorOptions: { fleetAuthors: [FLEET_LOGIN] },
  });

  assertEquals(verdict.passed, true, "the genuine table still decides");
  assertEquals(verdict.rowCount, 1);
  assert(
    logger.warnings.some((w) => w.includes("oversized")),
    "skipping a candidate must be reported, never silent",
  );
});
