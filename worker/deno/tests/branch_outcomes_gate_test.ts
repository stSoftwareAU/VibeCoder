/**
 * Unit tests for the PR-summary branch-outcomes gate (Issue #3147).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildBranchOutcomesGateComment,
  lookupTestsAtHead,
  namedTestPaths,
  parseBranchOutcomes,
  validateBranchOutcomes,
} from "../lib/branch_outcomes_gate.ts";
import { assertLinearGrowth } from "./support/growth.ts";

const FOO_TS = "worker/deno/lib/foo.ts";

// ---------------------------------------------------------------------------
// parseBranchOutcomes
// ---------------------------------------------------------------------------

Deno.test("parseBranchOutcomes - bold paragraph header with a list parses entries", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- `worker/deno/lib/foo.ts:42` — error — `worker/deno/tests/foo_test.ts::rejects bad input`\n" +
      "- `worker/deno/lib/foo.ts:48` — success — `worker/deno/tests/foo_test.ts::accepts good input`\n",
  );
  assert(record.present);
  assertEquals(record.noneDeclared, false);
  assertEquals(record.entries.length, 2);
  assertStringIncludes(record.entries[0]!, "worker/deno/lib/foo.ts:42");
  assertStringIncludes(record.entries[1]!, "worker/deno/lib/foo.ts:48");
});

Deno.test("parseBranchOutcomes - header as a list item with nested entries does not swallow a sibling bullet", () => {
  const record = parseBranchOutcomes(
    "- Branch outcomes:\n" +
      "  - entry one\n" +
      "  - entry two\n" +
      "- Docs sweep — section: none\n",
  );
  assert(record.present);
  assertEquals(record.entries, ["entry one", "entry two"]);
});

Deno.test("parseBranchOutcomes - markdown heading form with following list parses", () => {
  const record = parseBranchOutcomes(
    "#### Branch outcomes\n" +
      "- entry one\n" +
      "- entry two\n",
  );
  assert(record.present);
  assertEquals(record.entries, ["entry one", "entry two"]);
});

Deno.test("parseBranchOutcomes - continuation lines are joined onto the previous entry", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- `worker/deno/lib/foo.ts:42` — error —\n" +
      "  `worker/deno/tests/foo_test.ts::rejects bad input`\n",
  );
  assert(record.present);
  assertEquals(record.entries.length, 1);
  assertStringIncludes(
    record.entries[0]!,
    "worker/deno/tests/foo_test.ts::rejects bad input",
  );
});

Deno.test("parseBranchOutcomes - 'none added' is recognised as an honest negative", () => {
  const record = parseBranchOutcomes("**Branch outcomes:** none added\n");
  assert(record.present);
  assert(record.noneDeclared);
  assertEquals(record.entries, []);
});

// PR #3160 review (sixth round): `isNoneBody` (then `startsWithNone`) matched
// any body starting with the word `none`, so a body with real content after
// it — a list reference, or a named test — was wrongly treated as an honest
// negative and its region was never scanned for a named test.
Deno.test("parseBranchOutcomes - 'none added this round; ...' is not an honest negative", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:** none added this round; the earlier rounds' arms:\n",
  );
  assertEquals(record.noneDeclared, false);
});

Deno.test("parseBranchOutcomes - 'none added; existing <test> covers it' is not an honest negative", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:** none added; existing worker/deno/tests/gone_test.ts covers it\n",
  );
  assertEquals(record.noneDeclared, false);
});

Deno.test("parseBranchOutcomes - a later header is still collected", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:** none added\n\n" +
      "**Branch outcomes:**\n- entry one\n",
  );
  assert(record.present);
  assertEquals(record.noneDeclared, false);
  assertEquals(record.entries, ["entry one"]);
});

Deno.test("parseBranchOutcomes - absent header reports not present", () => {
  const record = parseBranchOutcomes("## Summary\n\nFixed the thing.\n");
  assertEquals(record.present, false);
});

// PR #3160 review (seventh round): `none added.` (a full stop instead of a
// semicolon) and `none:` must both still be recognised as the honest `none`
// negative — `NONE_BODY_RE`'s `[.:;!]*` punctuation suffix had no test.
Deno.test("parseBranchOutcomes - 'none added.' with a full stop is an honest negative", () => {
  const record = parseBranchOutcomes("**Branch outcomes:** none added.\n");
  assert(record.noneDeclared);
});

Deno.test("parseBranchOutcomes - 'none:' with a colon is an honest negative", () => {
  const record = parseBranchOutcomes("**Branch outcomes:** none:\n");
  assert(record.noneDeclared);
});

// PR #3160 review (seventh round), finding 1(b): an honest `none`/`none
// added` header must not hide a real list that follows it — the region
// after the header is scanned for a named test path regardless of the
// header's own honest body.
Deno.test("validateBranchOutcomes - 'none added.' followed by a refreshed list still names the invented test", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:** none added.\n" +
      "\n" +
      "The earlier rounds' arms, refreshed to the head:\n" +
      `- ${INVENTED}\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, [INVENTED]);
});

// Issue #3340 fix was incomplete for heading-form headers (PR #3372 review):
// `collectEntries`'s deeper-heading skip ran before the header check, so a
// real `### Branch outcomes` reached mid-scan was treated as a skippable
// grouping heading rather than a header in its own right, and its own
// region — prose citing a test — was never scanned.
Deno.test("validateBranchOutcomes - a deeper heading-form header after a prose mention still names the invented test", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "## Test Plan\n" +
      "`Branch outcomes:` is mentioned here, with no list yet.\n" +
      "\n" +
      "### Branch outcomes\n" +
      "\n" +
      `Citing \`${INVENTED}\` as the test that reaches it.\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, [INVENTED]);
});

// ---------------------------------------------------------------------------
// Section-boundary heading depth (PR #3160 review, seventh round): the
// boundary that ends a Branch-outcomes scan is relative to the heading
// enclosing the header, not a fixed depth.
// ---------------------------------------------------------------------------

// Finding 1(a): a `### path/to/file.ts` grouping heading directly under a
// `## Test Plan` section is only one level deeper than its enclosing
// section. A fixed level-3 cutoff wrongly treated it as a boundary and
// stopped the scan before the list it grouped.
Deno.test("validateBranchOutcomes - a level-3 grouping heading under a level-2 section still names the invented test", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "## Test Plan\n" +
      "**Branch outcomes:** grouped by file:\n" +
      "### worker/deno/lib/foo.ts\n" +
      `- ${INVENTED}\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, [INVENTED]);
});

// Under a level-1 enclosing section, a level-2 heading is a grouping
// sub-heading (deeper than the enclosing level), not a boundary — the list
// beneath it is still found.
Deno.test("validateBranchOutcomes - a level-2 heading under a level-1 section does not end the scan", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "# Overview\n" +
      "**Branch outcomes:** grouped by section:\n" +
      "## Next\n" +
      `- ${INVENTED}\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, [INVENTED]);
});

// The same level-1 enclosing section's own boundary still fires: a second
// level-1 heading is a genuine new section and must end the scan, so an
// unrelated path named after it is never swept in.
Deno.test("validateBranchOutcomes - a second level-1 heading ends the scan under a level-1 section", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "# Overview\n" +
      "**Branch outcomes:** none added\n" +
      "# Another Section\n" +
      `- ${INVENTED}\n`,
    testsAtHead: new Set<string>(),
  });
  assert(result.valid);
  assertEquals(result.missingTests, []);
});

// ---------------------------------------------------------------------------
// Heading-form header's own-level boundary (PR #3160 review, eighth round):
// `boundaryLevel` used to come from the heading ABOVE the header, so a
// heading-form header's own level never ended its own section — a sibling
// heading at the header's own level was wrongly treated as a deeper grouping
// sub-heading and skipped, letting an empty list soak up the next section's
// bullets. These two reproduce the review's exact layouts (a) and (b)
// against the regression; both were wrongly `valid: true` before the fix.
// ---------------------------------------------------------------------------

Deno.test("validateBranchOutcomes - an empty level-3 heading-form header followed by a sibling section still blocks", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["worker/deno/lib/foo.ts"],
    prSummaryContent: "# PR Summary\n" +
      "## Test Plan\n" +
      "- ran the suite\n" +
      "### Branch outcomes\n" +
      "### Manual checks\n" +
      "- clicked the button locally\n" +
      "## Evidence\n",
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "names no outcomes");
});

Deno.test("validateBranchOutcomes - an empty level-2 heading-form header under a level-1 title still blocks", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["worker/deno/lib/foo.ts"],
    prSummaryContent: "# PR Summary\n" +
      "## Branch outcomes\n" +
      "## Evidence\n" +
      "- screenshot attached\n",
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "names no outcomes");
});

// Isolates line 195's `lastHeadingLevel = ownLevel` update: a heading-form
// header's own level must carry forward as the "nearest heading above" for a
// LATER, inline header — otherwise that later header's boundary falls back
// to the stale level from before the heading-form header, and a sibling
// heading one level deeper than it is wrongly treated as a grouping
// sub-heading, sweeping an unrelated section's citation in as this header's
// own. Deleting line 195 alone (boundaryLevel's own-level fix left intact)
// turns this green test red: `missingTests` gains the invented path.
Deno.test("validateBranchOutcomes - a later inline header's boundary tracks the heading-form header's own level", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "## Test Plan\n" +
      "### Branch outcomes\n" +
      "- first entry\n" +
      "\n" +
      "**Branch outcomes:** second mention\n" +
      "### Sibling\n" +
      `- ${INVENTED}\n`,
    testsAtHead: new Set<string>(),
  });
  assert(result.valid);
  assertEquals(result.missingTests, []);
});

// Isolates `collectEntries`' own dynamic boundary (branch_outcomes_gate.ts,
// the `lvl <= boundaryLevel` check inside `collectEntries`) from
// `scanRegionText`'s copy of the same check: the header's body is empty, so
// "names no outcomes" depends only on `entries` being non-empty — `scanText`
// also finds the same citation here, but that is never consulted once
// `entries` is non-empty, so this flips only when `collectEntries`' own stop
// is the one that is wrong (PR #3160 review, eighth round).
Deno.test("validateBranchOutcomes - a level-3 grouping heading under a level-2 section still fills entries", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "## Test Plan\n" +
      "**Branch outcomes:**\n" +
      "### worker/deno/lib/foo.ts\n" +
      "- worker/deno/tests/foo_test.ts::case\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
  assertEquals(result.record.entries, [
    "worker/deno/tests/foo_test.ts::case",
  ]);
});

// Isolates `scanRegionText`'s own dynamic boundary from `collectEntries`'
// copy: a markdown table row is never collected into `entries` (confirmed
// by the sibling table test above), so this citation can only be found via
// `scanText` — `collectEntries` contributes nothing here either way, so
// this flips only when `scanRegionText`'s own stop is the one that is wrong.
Deno.test("validateBranchOutcomes - a level-3 grouping heading under a level-2 section still fills scanText", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "## Test Plan\n" +
      "**Branch outcomes:** two arms added, grouped by file:\n" +
      "### worker/deno/lib/foo.ts\n" +
      "\n" +
      "| Outcome | Test |\n" +
      "| --- | --- |\n" +
      `| success | ${INVENTED} |\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, [INVENTED]);
});

// ---------------------------------------------------------------------------
// collectEntries arms (PR #3160 fifth review round): each of the three
// branches below passed all 173 gate-related tests when mutated alone, so
// none was actually pinned.
// ---------------------------------------------------------------------------

// Pins the `continue` at the "entries.length === 0" fallthrough: a prose
// line between two blank lines, with no entries yet, must not stop the scan
// before a later list. Mutating it to `break` loses "entry one".
Deno.test("parseBranchOutcomes - prose between two blank lines does not stop the scan before a later list", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:** header text\n" +
      "\n" +
      "some prose line\n" +
      "\n" +
      "- entry one\n",
  );
  assertEquals(record.entries, ["entry one"]);
});

// Pins the `&& wrapping` guard: once a blank line has been seen, prose with
// no list anywhere must not be captured into the body, or a header with
// trailing prose and no real list wrongly looks non-empty.
Deno.test("validateBranchOutcomes - a bare heading with blank-separated prose and no list blocks", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "#### Branch outcomes\n\ntrailing prose with no list\n",
    testsAtHead: new Set(),
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "names no outcomes");
});

// Pins the `!sawBlank &&` guard: prose after the list's blank line must not
// be merged onto the last entry.
Deno.test("parseBranchOutcomes - prose after a blank line is not merged into the last entry", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- entry one\n" +
      "\n" +
      "trailing prose not part of entry one\n",
  );
  assertEquals(record.entries, ["entry one"]);
});

// PR #3160 review (sixth round): `sawBlank = false;` inside the list-marker
// branch had no test. Without it, a loose list's blank-line-separated entry
// loses the continuation line that immediately follows it, because `sawBlank`
// is left `true` from the earlier blank line.
Deno.test("parseBranchOutcomes - a continuation line after a loose list item joins the newest entry", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- a\n" +
      "\n" +
      "- b\n" +
      "  cont\n",
  );
  assertEquals(record.entries, ["a", "b cont"]);
});

// PR #3160 review (sixth round): `indent > headerIndent` in the continuation
// branch had no test. Without it, an unindented "lazy" line following a
// list-item header's nested entry is wrongly merged onto that entry instead
// of ending the scan.
Deno.test("parseBranchOutcomes - an unindented lazy line is not joined onto a list-item header's entry", () => {
  const record = parseBranchOutcomes(
    "- Branch outcomes:\n" +
      "  - entry one\n" +
      "lazy sibling text\n",
  );
  assertEquals(record.entries, ["entry one"]);
});

// ---------------------------------------------------------------------------
// scanRegionText boundaries — the new text-only scan `namedTestPaths` also
// reads (below) must stay scoped to the header it belongs to, or it
// attributes an unrelated later mention to the wrong (or no) header.
// ---------------------------------------------------------------------------

Deno.test("parseBranchOutcomes - a later Branch outcomes header is parsed on its own, so its region is scanned", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:** first arm, no test named yet.\n" +
      "\n" +
      "**Branch outcomes:** none added\n" +
      "Unrelated later prose mentions worker/deno/tests/unrelated_test.ts only in passing.\n",
  );
  // On base, the first header's collectEntries swallowed the second header,
  // so its region was never scanned (Issue #3340). A `none added` header's
  // own region is still scanned (PR #3160, seventh round).
  assertEquals(namedTestPaths(record), ["worker/deno/tests/unrelated_test.ts"]);
  // The first header's own scan still stops at the second header (the
  // `BRANCH_OUTCOMES_PREFIX_RE` check in `scanRegionText`) rather than
  // swallowing its "none added" body — without that stop, `scanText` would
  // start with the second header's own words (PR #3372 review).
  assert(!record.scanText.includes("none added"));
});

Deno.test("parseBranchOutcomes - the test-path scan stops at the next markdown heading", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:** first arm, no test named yet.\n" +
      "## Unrelated section\n" +
      "Mentions worker/deno/tests/unrelated_test.ts only in passing.\n",
  );
  assertEquals(namedTestPaths(record), []);
});

// PR #3160 review (seventh round), finding 2(4): `scanRegionText`'s header
// stop checks both the inline (`BRANCH_OUTCOMES_PREFIX_RE`) and heading
// (`BRANCH_OUTCOMES_HEADING_RE`) forms of a later `Branch outcomes` header.
// Only the inline half had a test; a later *heading-form* header, deeper
// than the enclosing boundary (so the generic heading-level stop does not
// fire first), must still end the first header's own scan.
Deno.test("parseBranchOutcomes - the test-path scan stops at a later heading-form header, even when deeper than the boundary", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:** grouped by file:\n" +
      "- outcome one\n" +
      "\n" +
      "#### Branch outcomes\n" +
      "unrelated-marker-xyz\n",
  );
  // The first header's own scan still stops at "#### Branch outcomes" and
  // never includes "unrelated-marker-xyz". That text now appears in
  // `scanText` regardless, because the heading-form header is a real
  // `Branch outcomes` header: the outer loop in `parseBranchOutcomes` parses
  // it on its own and scans ITS region too (PR #3372 review fixes
  // `collectEntries` treating it as a skippable grouping heading instead).
  assertEquals(record.scanText, "outcome one unrelated-marker-xyz");
});

// PR #3160 review (seventh round), finding 2(3): the `inlineMatch &&`
// conjunct of the `headerIndent` ternary had no test. A header that is both
// a list item and a heading (`- ## Branch outcomes`) is heading-form
// (`inlineMatch` is null), so its `headerIndent` must stay `-1` regardless
// of the line itself matching `LIST_MARKER_RE`. Dropping the conjunct would
// give it the line's own indent (0), wrongly ending the scan at the first
// top-level list item instead of collecting it.
Deno.test("parseBranchOutcomes - a list-item heading-form header still collects a following top-level entry", () => {
  const record = parseBranchOutcomes(
    "- ## Branch outcomes\n" +
      "- entry one\n",
  );
  assertEquals(record.entries, ["entry one"]);
});

// ---------------------------------------------------------------------------
// namedTestPaths
// ---------------------------------------------------------------------------

Deno.test("namedTestPaths - path:line and path::name forms both resolve to the test path", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- worker/deno/lib/foo.ts:42 — error — worker/deno/tests/foo_test.ts:42\n" +
      "- worker/deno/lib/foo.ts:48 — success — worker/deno/tests/foo_test.ts::accepts good input\n",
  );
  assertEquals(namedTestPaths(record), ["worker/deno/tests/foo_test.ts"]);
});

Deno.test("namedTestPaths - URLs are ignored", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- see https://example.com/foo_test.ts for background — worker/deno/tests/foo_test.ts::case\n",
  );
  assertEquals(namedTestPaths(record), ["worker/deno/tests/foo_test.ts"]);
});

Deno.test("namedTestPaths - non-test paths are not returned", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- worker/deno/lib/foo.ts:42 — error (no test named)\n",
  );
  assertEquals(namedTestPaths(record), []);
});

Deno.test("namedTestPaths - duplicate citations are deduplicated", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- worker/deno/tests/foo_test.ts::a — worker/deno/tests/foo_test.ts::b\n",
  );
  assertEquals(namedTestPaths(record), ["worker/deno/tests/foo_test.ts"]);
});

// PR #3160 review: the `./` strip (normaliseToken) and the leading-`/` skips
// had no test — removing all three left 45/45 pre-existing tests green.
Deno.test("namedTestPaths - a ./-prefixed citation is normalised, dropping the ./", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- success — ./worker/deno/tests/foo_test.ts::case\n",
  );
  assertEquals(namedTestPaths(record), ["worker/deno/tests/foo_test.ts"]);
});

Deno.test("namedTestPaths - an absolute-path token is not returned", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- success — /worker/deno/tests/foo_test.ts::case\n",
  );
  assertEquals(namedTestPaths(record), []);
});

// PR #3160 fourth review round: a `.//`-prefixed citation only becomes an
// absolute path (`/worker/...`) after normaliseToken's `./` strip, so it
// reaches the post-normalisation `token.startsWith("/")` skip and nothing
// else. This is the one case that pins that skip on its own.
Deno.test("namedTestPaths - a .//-prefixed citation normalises to an absolute path and is dropped", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- success — .//worker/deno/tests/foo_test.ts::case\n",
  );
  assertEquals(namedTestPaths(record), []);
});

// ---------------------------------------------------------------------------
// Fail-open caps (PR #3160 review): MAX_ENTRIES, MAX_TOKEN_CHARS and
// MAX_NAMED_TEST_PATHS had no test either.
// ---------------------------------------------------------------------------

Deno.test("parseBranchOutcomes - more than 100 entries are capped at 100", () => {
  const lines = Array.from(
    { length: 105 },
    (_, i) => `- worker/deno/tests/foo_test.ts::case${i}`,
  ).join("\n");
  const record = parseBranchOutcomes(`**Branch outcomes:**\n${lines}\n`);
  assertEquals(record.entries.length, 100);
});

// PR #3160 review (fifth round): the single-header case above stays at 100
// whichever of the two MAX_ENTRIES checks is removed, because the other one
// still applies — neither was pinned on its own. Two headers whose lists are
// each under 100 (so collectEntries' own list can never hit a per-call cap)
// but together exceed it isolates parseBranchOutcomes' own copy-loop cap.
Deno.test("parseBranchOutcomes - MAX_ENTRIES caps the combined total across two headers, not just one list", () => {
  const listOf60 = (offset: number) =>
    Array.from(
      { length: 60 },
      (_, i) => `- worker/deno/tests/foo_test.ts::case${offset + i}`,
    ).join("\n");
  const record = parseBranchOutcomes(
    `**Branch outcomes:**\n${listOf60(0)}\n` +
      `#### Branch outcomes\n${listOf60(60)}\n`,
  );
  assertEquals(record.entries.length, 100);
});

Deno.test("namedTestPaths - a token over 300 chars is skipped", () => {
  const longPath = `worker/deno/tests/${"a".repeat(300)}_test.ts`;
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      `- success — ${longPath}::case — also worker/deno/tests/foo_test.ts::case\n`,
  );
  assertEquals(namedTestPaths(record), ["worker/deno/tests/foo_test.ts"]);
});

Deno.test("namedTestPaths - more than 50 named test paths are capped at 50", () => {
  const entries = Array.from(
    { length: 60 },
    (_, i) => `- worker/deno/tests/foo${i}_test.ts::case`,
  ).join("\n");
  const record = parseBranchOutcomes(`**Branch outcomes:**\n${entries}\n`);
  assertEquals(namedTestPaths(record).length, 50);
});

// ---------------------------------------------------------------------------
// validateBranchOutcomes
// ---------------------------------------------------------------------------

Deno.test("validateBranchOutcomes - missing list blocks when the diff changes code", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "## Summary\n\nDid a thing.\n",
    testsAtHead: new Set(),
  });
  assert(result.applicable);
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "no `Branch outcomes:` list");
});

Deno.test("validateBranchOutcomes - a test absent from testsAtHead blocks and is named in missingTests", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- success — worker/deno/tests/missing_test.ts::does not exist\n",
    testsAtHead: new Set(["worker/deno/tests/other_test.ts"]),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, ["worker/deno/tests/missing_test.ts"]);
});

// PR #3160 review: the missing-test message must say paths are checked
// relative to the repository root, or a run that self-checked with
// `git ls-files <path>` from a subdirectory (e.g. `worker/deno`) is blocked
// with no clue why its own check passed.
Deno.test("validateBranchOutcomes - the missing-test message names the repository-root requirement", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- success — worker/deno/tests/missing_test.ts::does not exist\n",
    testsAtHead: new Set(["worker/deno/tests/other_test.ts"]),
  });
  assertStringIncludes(result.problems[0]!, "repository root");
});

Deno.test("validateBranchOutcomes - testsAtHead null with named tests blocks (fail closed)", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- success — worker/deno/tests/foo_test.ts::case\n",
    testsAtHead: null,
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "could not confirm");
});

Deno.test("validateBranchOutcomes - all named tests present passes", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- success — worker/deno/tests/foo_test.ts::case\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
  assertEquals(result.missingTests, []);
});

// An inline (same-line) body — no list follows the header — is the one shape
// that only `namedTestPaths`' body arm reaches (PR #3160 review): a one-line
// `Branch outcomes:` summary naming a test that does not exist must still be
// caught, or the gate's own invented-test case (VibeCoder#3132) slips through.
Deno.test("validateBranchOutcomes - an inline body naming a missing test blocks (Issue #3160)", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent:
      "**Branch outcomes:** `src/foo.ts:12` — error — `worker/deno/tests/made_up_test.ts::x`\n",
    testsAtHead: new Set(["worker/deno/tests/other_test.ts"]),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, ["worker/deno/tests/made_up_test.ts"]);
});

Deno.test("validateBranchOutcomes - an inline body naming an existing test passes (Issue #3160)", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent:
      "**Branch outcomes:** `src/foo.ts:12` — error — `worker/deno/tests/foo_test.ts::x`\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
  assertEquals(result.missingTests, []);
});

const INVENTED = "worker/deno/tests/invented_test.ts";

Deno.test("validateBranchOutcomes - a wrapped inline entry still names the invented test", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:** the new arm is reached by\n" +
      `${INVENTED}\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, [INVENTED]);
});

Deno.test("validateBranchOutcomes - prose that wraps before the list still names the invented test", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent:
      "**Branch outcomes:** list in its Test Plan. Each line names path:line, the\n" +
      "test that reaches it.\n" +
      `- ${INVENTED}::name — flip red\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, [INVENTED]);
});

Deno.test("validateBranchOutcomes - an earlier Branch outcomes bullet does not hide a later list", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "- Branch outcomes: see the Test Plan.\n" +
      "## Test Plan\n" +
      "**Branch outcomes:**\n" +
      `- ${INVENTED}::name — flip red\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, [INVENTED]);
});

// PR #3160 fifth review round: a header with inline text but zero collected
// entries let an invented test slip through in three ordinary layouts —
// each blocked `namedTestPaths` from ever seeing the citation named below
// the header, even though the empty-header-body form of the same layout was
// already blocked.

Deno.test("validateBranchOutcomes - a Test Plan bullet header with sibling bullets still names the invented test", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "- **Branch outcomes:** each new arm and its test:\n" +
      `- ${INVENTED}::case — flip red\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, [INVENTED]);
});

Deno.test("validateBranchOutcomes - a markdown table naming the test still names the invented test", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:** two arms added, both tested:\n" +
      "\n" +
      "| Outcome | Test |\n" +
      "| --- | --- |\n" +
      `| success | ${INVENTED} |\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, [INVENTED]);
});

Deno.test("validateBranchOutcomes - a loose list broken by an indented paragraph still names the invented test", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- first outcome, success\n" +
      "\n" +
      "  an indented paragraph describing more about the first outcome\n" +
      `- ${INVENTED}::case — flip red\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, [INVENTED]);
});

// PR #3160 review (sixth round): a header with inline text and zero
// collected entries also slipped an invented test through in two more
// ordinary layouts a sub-heading grouping, and a "none added this round"
// body that still carries a real list — both let `missingTests` stay empty
// because `collectEntries`/`scanRegionText` stopped at the sub-heading, or
// `startsWithNone` (now `isNoneBody`) skipped the header's region outright.

// Isolates `collectEntries`' own deeper-heading skip (`branch_outcomes_gate.ts:257`)
// from `scanRegionText`'s copy of the same fix: a heading-form header has an
// empty inline `body`, so the "names no outcomes" check depends only on
// `entries` — `scanText` (which `scanRegionText` still populates even under
// the old stop-at-any-heading bug) cannot paper over a wrongly-empty
// `entries` here.
Deno.test("validateBranchOutcomes - a heading-form header with a deep grouping sub-heading still finds its list", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "#### Branch outcomes\n" +
      "\n" +
      "##### worker/deno/lib/foo.ts\n" +
      "- worker/deno/tests/foo_test.ts::case\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
  assertEquals(result.missingTests, []);
});

// Isolates `scanRegionText`'s own deeper-heading skip (`branch_outcomes_gate.ts:216`)
// from `collectEntries`' copy of the same fix: a markdown table's rows are
// never collected into `entries` (fifth PR #3160 review round), so this
// citation can only be found via `scanText` — `collectEntries` contributes
// nothing here either way.
Deno.test("validateBranchOutcomes - a sub-heading before a markdown table still names the invented test", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:** two arms added, both tested:\n" +
      "\n" +
      "#### worker/deno/lib/foo.ts\n" +
      "\n" +
      "| Outcome | Test |\n" +
      "| --- | --- |\n" +
      `| success | ${INVENTED} |\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, [INVENTED]);
});

Deno.test("validateBranchOutcomes - a sub-heading grouping between the header and its list still names the invented test", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent:
      "**Branch outcomes:** every arm this diff adds, grouped by file:\n" +
      "\n" +
      "#### worker/deno/lib/foo.ts\n" +
      `- ${INVENTED}\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, [INVENTED]);
});

Deno.test("validateBranchOutcomes - a 'none added this round' header followed by a list still names the invented test", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent:
      "**Branch outcomes:** none added this round; the earlier rounds' arms:\n" +
      `- ${INVENTED}\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, [INVENTED]);
});

Deno.test("validateBranchOutcomes - a 'none added; existing <test> covers it' body naming an invented test blocks", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent:
      `**Branch outcomes:** none added; existing ${INVENTED} covers it\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, [INVENTED]);
});

// PR #3160 review (sixth round): the `bodyExtra` push
// (`branch_outcomes_gate.ts:183`) had no test — a bare header followed
// directly by a wrapped prose line (no list) relies on it to avoid the
// "names no outcomes" block. Both a real citation and an honest "none added"
// on the wrapped line must still pass.

Deno.test("validateBranchOutcomes - a bare header followed by a wrapped prose line naming an existing test passes", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:**\n" +
      "The arm at foo.ts:12 is reached by worker/deno/tests/foo_test.ts::case\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
  assertEquals(result.missingTests, []);
});

Deno.test("validateBranchOutcomes - a bare header followed by 'none added' on the next line passes", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:**\nnone added\n",
    testsAtHead: new Set<string>(),
  });
  assert(result.valid);
});

Deno.test("validateBranchOutcomes - 'none added' passes", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:** none added\n",
    testsAtHead: new Set(),
  });
  assert(result.valid);
});

Deno.test("validateBranchOutcomes - an empty list blocks", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:**\n\n## Next heading\n",
    testsAtHead: new Set(),
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "names no outcomes");
});

Deno.test("validateBranchOutcomes - a bare placeholder blocks", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:** tbd\n",
    testsAtHead: new Set(),
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "bare placeholder");
});

Deno.test("validateBranchOutcomes - a non-code diff (docs + test files only) is not applicable", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["README.md", "worker/deno/tests/foo_test.ts"],
    prSummaryContent: "## Summary\n",
    testsAtHead: new Set(),
  });
  assertEquals(result.applicable, false);
  assert(result.valid);
});

Deno.test("validateBranchOutcomes - changedFiles null is applicable (fail closed)", () => {
  const result = validateBranchOutcomes({
    changedFiles: null,
    prSummaryContent: "## Summary\n",
    testsAtHead: new Set(),
  });
  assert(result.applicable);
  assertEquals(result.valid, false);
});

// Issue #3340: a hard-wrapped prose line that happens to start with the
// `Branch outcomes:` prefix (e.g. quoting the rule itself) must not read as
// the header and swallow or hide the real header that follows it.

Deno.test("validateBranchOutcomes - a prose mention read as a header does not hide the real header's inline citation", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "## Test Plan\n" +
      "I grepped the diff for the nouns the rule governs:\n" +
      '`Branch outcomes:`, "example" and "helper doc comment".\n' +
      `**Branch outcomes:** lib/foo.ts:12 error arm → ${INVENTED}, flipped red.\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, [INVENTED]);
});

Deno.test("validateBranchOutcomes - a prose mention separated by a blank line still does not hide the real header's inline citation", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "## Test Plan\n" +
      "I grepped the diff for the nouns the rule governs:\n" +
      '`Branch outcomes:`, "example" and "helper doc comment".\n' +
      "\n" +
      `**Branch outcomes:** lib/foo.ts:12 error arm → ${INVENTED}, flipped red.\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, [INVENTED]);
});

Deno.test("validateBranchOutcomes - a list-item header nested under a prose mention still names the invented test", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "## Test Plan\n" +
      "**Branch outcomes:** grouped below\n" +
      "\n" +
      "- lib/a.ts:3 ok arm → worker/deno/tests/real_test.ts\n" +
      `  - **Branch outcomes:** lib/b.ts:9 error arm → ${INVENTED}\n`,
    testsAtHead: new Set(["worker/deno/tests/real_test.ts"]),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, [INVENTED]);
});

Deno.test("validateBranchOutcomes - a prose mention read as a header does not hide the real header's valid citation", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "## Test Plan\n" +
      "I grepped the diff for the nouns the rule governs:\n" +
      '`Branch outcomes:`, "example" and "helper doc comment".\n' +
      "**Branch outcomes:** lib/foo.ts:12 error arm → worker/deno/tests/real_test.ts, flipped red.\n",
    testsAtHead: new Set(["worker/deno/tests/real_test.ts"]),
  });
  assert(result.valid);
  assert(result.namedTests.includes("worker/deno/tests/real_test.ts"));
});

Deno.test("parseBranchOutcomes - a prose mention read as a header does not hide the real header's inline body", () => {
  const record = parseBranchOutcomes(
    "## Test Plan\n" +
      "I grepped the diff for the nouns the rule governs:\n" +
      '`Branch outcomes:`, "example" and "helper doc comment".\n' +
      `**Branch outcomes:** lib/foo.ts:12 error arm → ${INVENTED}, flipped red.\n`,
  );
  assertStringIncludes(record.body, "lib/foo.ts:12");
});

Deno.test("buildBranchOutcomesGateComment - names the problem and the required shape", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "## Summary\n",
    testsAtHead: new Set(),
  });
  const comment = buildBranchOutcomesGateComment(result);
  assertStringIncludes(comment, "Branch outcomes not recorded");
  assertStringIncludes(comment, "none added");
  assertStringIncludes(comment, "repository root");
});

// ---------------------------------------------------------------------------
// Hostile input (Issue #3147, CODING-STANDARDS "Guard super-linearity by
// behaviour first") — a behaviour assertion, not a wall-clock threshold. A
// quadratic parse would make this test exceed Deno's own test timeout rather
// than merely run slowly, which is the only signal this test needs.
// ---------------------------------------------------------------------------

Deno.test("parseBranchOutcomes - a 100k-char hostile line returns a bounded, well-formed result", () => {
  const hostileEntry = "a.a.a.".repeat(20_000); // ~120k chars, no newline
  const content = `**Branch outcomes:**\n- ${hostileEntry}\n`;
  const record = parseBranchOutcomes(content);
  assert(record.present);
  assertEquals(record.entries.length, 1);
  assert(record.entries[0]!.length <= 4_000);
});

Deno.test("parseBranchOutcomes - a long run of spaces in the inline body returns a bounded result", () => {
  const spaces = " ".repeat(100_000);
  const content = `**Branch outcomes:**${spaces}none added\n`;
  const record = parseBranchOutcomes(content);
  assert(record.present);
});

Deno.test(
  "parseBranchOutcomes - a heading line with a long trailing space run scales linearly (PR #3160 review)",
  () => {
    // `## Branch outcomes` + N spaces + a trailing `x` is the shape that
    // makes two adjacent `\s*` around the optional `:?` backtrack: the run
    // of spaces matches both `\s*`s in every split, and `x` never lets the
    // `$` anchor succeed. Run this against the unfixed
    // `/^#{1,6}\s*branch\s+outcomes\s*:?\s*$/i` first to see it hang.
    const buildSummary = (chars: number) =>
      `## Branch outcomes${" ".repeat(chars)}x\n`;

    const result = assertLinearGrowth(
      "branch-outcomes heading trailing-space scan",
      buildSummary,
      (input) => parseBranchOutcomes(input),
      { baseChars: 25_000 },
    );

    // The trailing `x` means the heading never matches, so the header is
    // never found at all.
    assertEquals(result.present, false);
  },
);

// ---------------------------------------------------------------------------
// lookupTestsAtHead
// ---------------------------------------------------------------------------

Deno.test("lookupTestsAtHead - empty paths returns an empty set without calling git", async () => {
  let called = false;
  const runGit = () => {
    called = true;
    return Promise.resolve({
      ok: true as const,
      value: { code: 0, stdout: "", stderr: "" },
    });
  };
  const result = await lookupTestsAtHead([], runGit);
  assertEquals(result, new Set());
  assertEquals(called, false);
});

Deno.test("lookupTestsAtHead - a failed git invocation returns null", async () => {
  const runGit = () =>
    Promise.resolve({ ok: false as const, error: new Error("spawn failed") });
  const result = await lookupTestsAtHead(
    ["worker/deno/tests/foo_test.ts"],
    runGit,
  );
  assertEquals(result, null);
});

Deno.test("lookupTestsAtHead - a non-zero exit returns null", async () => {
  const runGit = () =>
    Promise.resolve({
      ok: true as const,
      value: { code: 128, stdout: "", stderr: "fatal: bad object HEAD" },
    });
  const result = await lookupTestsAtHead(
    ["worker/deno/tests/foo_test.ts"],
    runGit,
  );
  assertEquals(result, null);
});

Deno.test("lookupTestsAtHead - parses stdout lines into the returned set", async () => {
  const runGit = () =>
    Promise.resolve({
      ok: true as const,
      value: {
        code: 0,
        stdout:
          "worker/deno/tests/foo_test.ts\nworker/deno/tests/bar_test.ts\n",
        stderr: "",
      },
    });
  const result = await lookupTestsAtHead(
    ["worker/deno/tests/foo_test.ts", "worker/deno/tests/bar_test.ts"],
    runGit,
  );
  assertEquals(
    result,
    new Set(["worker/deno/tests/foo_test.ts", "worker/deno/tests/bar_test.ts"]),
  );
});

// ---------------------------------------------------------------------------
// unreached admissions (Issue #3288)
// ---------------------------------------------------------------------------

Deno.test("validateBranchOutcomes - a GRQ-shape admission blocks and names the label", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `crates/app/src/handler.rs:2022` — minimum hold blocks — " +
      "**no test reaches it**: flipped the guard, `cargo test --workspace` " +
      "stayed green\n",
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  const problem = result.problems.find((p) => p.includes("admits no test"))!;
  assertStringIncludes(problem, "admits no test reaches");
  assertEquals(result.unreachedEntries, ["crates/app/src/handler.rs:2022"]);
});

Deno.test("validateBranchOutcomes - the same GRQ input with only the admission replaced is valid", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `crates/app/src/handler.rs:2022` — minimum hold blocks — " +
      "flipped the guard, test went red\n",
    testsAtHead: new Set<string>(),
  });
  assert(result.valid);
  assertEquals(result.unreachedEntries, []);
});

Deno.test("validateBranchOutcomes - a covered entry naming the test and a red flip is valid", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `crates/app/src/handler.rs:2022` — guard — " +
      "`worker/deno/tests/foo_test.ts::rejects bad input` — flipped to " +
      "success, test went red\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
  assertEquals(result.unreachedEntries, []);
});

Deno.test("validateBranchOutcomes - a mixed list of 3 flags exactly the strong and weak entries", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `crates/app/src/handler.rs:2022` — no test reaches it: flipped the " +
      "guard, stayed green\n" +
      "- `crates/app/src/other.rs` — guard — removing the check left the " +
      "suite green\n" +
      "- `worker/deno/tests/foo_test.ts::case` — flipped, went red\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assertEquals(result.valid, false);
  assertEquals(result.unreachedEntries, [
    "crates/app/src/handler.rs:2022",
    "crates/app/src/other.rs — guard — removing the check left the suite green",
  ]);
  for (const problem of result.problems) {
    assertEquals(problem.includes("worker/deno/tests/foo_test.ts"), false);
  }
});

// Evasion variants — each must block.
const EVASION_VARIANTS: Array<{ name: string; entry: string }> = [
  { name: "no tests reach it", entry: "`crates/x.ts:1` — no tests reach it" },
  {
    name: "No test covers the fallback",
    entry: "`crates/x.ts:2` — No test covers the fallback",
  },
  {
    name: "not reached by any test",
    entry: "`crates/x.ts:3` — not reached by any test",
  },
  {
    name: "flipping it never went red",
    entry: "`crates/x.ts:4` — flipping it never went red",
  },
  {
    name: "didn’t go red (curly apostrophe)",
    entry: "`crates/x.ts:5` — didn’t go red",
  },
  { name: "unreached", entry: "`crates/x.ts:6` — unreached" },
  { name: "untested", entry: "`crates/x.ts:7` — untested" },
  {
    name: "VibeCoder#3257 shape",
    entry: "`crates/x.ts:8` — unreachable through findTestPlanClaimProblems, " +
      "which skips it first; flipping it left the suite green",
  },
  {
    name: "path-citing entry with a strong phrase",
    entry: "`worker/deno/tests/foo_test.ts::prefix only` checks the prefix, " +
      "so no test reaches the fallback",
  },
  {
    name: "never turned red",
    entry: "`crates/x.ts:10` — flipping it never turned red",
  },
  {
    name: "no test went red",
    entry: "`crates/x.ts:11` — no test went red",
  },
  {
    name: "does not go red when flipped",
    entry: "`crates/x.ts:12` — does not go red when flipped",
  },
  {
    name: "did not turn the suite red",
    entry: "`crates/x.ts:13` — did not turn the suite red",
  },
];

for (const { name, entry } of EVASION_VARIANTS) {
  Deno.test(`validateBranchOutcomes - evasion variant blocks: ${name}`, () => {
    const result = validateBranchOutcomes({
      changedFiles: [FOO_TS],
      prSummaryContent: `**Branch outcomes:**\n- ${entry}\n`,
      testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
    });
    assertEquals(result.valid, false, name);
    assert(
      result.problems.some((p) => p.includes("admits no test reaches")),
      name,
    );
  });
}

Deno.test("validateBranchOutcomes - an admission on an indented continuation line blocks", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `crates/x.ts:9` — guard —\n" +
      "  no test reaches it\n",
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

Deno.test("validateBranchOutcomes - an admission in a markdown table row blocks via uncapturedLines", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:** two arms added:\n" +
      "\n" +
      "| Outcome | Test |\n" +
      "| --- | --- |\n" +
      "| success | no test reaches the edge case |\n",
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

Deno.test("validateBranchOutcomes - an admission after 'none added.' on a following line blocks", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:** none added.\n" +
      "\n" +
      "Actually, the guard added here: no test reaches the new branch.\n",
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

Deno.test("validateBranchOutcomes - an inline-body admission blocks", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "Branch outcomes: `lib/x.ts:3` — no test reaches it\n",
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

Deno.test("validateBranchOutcomes - a 101st entry admission after 100 covered entries blocks", () => {
  const covered = Array.from(
    { length: 100 },
    (_, i) => `- worker/deno/tests/foo_test.ts::case${i}, flipped, went red`,
  ).join("\n");
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      `${covered}\n` +
      "- `crates/y.ts:5` — no test reaches it\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

// Look-alikes — each must stay valid.
Deno.test("validateBranchOutcomes - a Rust covered entry with a blanked inline-test-name is valid", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `crates/a.rs:10` — error — `handler::tests::rejects` — flipped, " +
      "went red; the rest of the suite stayed green\n",
    testsAtHead: new Set<string>(),
  });
  assert(result.valid);
});

Deno.test("validateBranchOutcomes - a path-citing entry mentioning an unrelated 'stayed green' is valid", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `worker/deno/tests/foo_test.ts::x` — unchanged base behaviour; " +
      "other suites stayed green\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
});

Deno.test("validateBranchOutcomes - a code-span test name containing the admission phrase is blanked and valid", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `worker/deno/tests/foo_test.ts::flags an entry no test reaches` " +
      "— flipped, went red\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
});

Deno.test("validateBranchOutcomes - past-tense 'had no test reaching it' is valid", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- had no test reaching it; added " +
      "`worker/deno/tests/foo_test.ts::y`, flipped, went red\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
});

Deno.test("validateBranchOutcomes - 'no test -x' prefix look-alike is valid", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- no test -x → violation — `worker/deno/tests/foo_test.ts::z` — " +
      "flipped, went red\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
});

// Corpus look-alikes (review round 1 & 2): a `docs/archive/pr-summaries/`
// corpus run found the loose negated-red pattern ("negation, up to 3 words,
// red") firing on genuinely COVERED entries where the negation governs an
// unrelated word, not the red flip itself. The citation sits BEFORE the
// "flipped to ..., (test) went red" phrase, exactly as the real corpus
// entries are shaped — putting it between the negation and "red" instead
// (review round 1's mistake) made the look-alike pass under the OLD loose
// regex too, so it proved nothing.
const CORPUS_RED_LOOKALIKES: Array<{ name: string; entry: string }> = [
  {
    name: "pr-summary-3223.md:178 'never add'",
    entry: "`worker/deno/lib/x.ts:1` — outcome — " +
      "`worker/deno/tests/foo_test.ts::x` — flipped to never add, test " +
      "went red",
  },
  {
    name: "pr-summary-3244.md:126 'no split'",
    entry: "`worker/deno/lib/x.ts:2` — outcome — " +
      "`worker/deno/tests/foo_test.ts::x` — flipped to no split, test " +
      "went red",
  },
  {
    name: "pr-summary-3255.md:109 'No gap'",
    entry: "No gap: `worker/deno/tests/foo_test.ts::runGateWithRepair - " +
      "verifies the repair`. Flipped: red.",
  },
  {
    name: "pr-summary-3257.md:80 'never attach'",
    entry: "`worker/deno/lib/x.ts:3` — outcome — " +
      "`worker/deno/tests/foo_test.ts::x` — flipped to never attach, test " +
      "went red",
  },
  {
    name: "pr-summary-3257.md:124 'never blocked'",
    entry: "`worker/deno/lib/x.ts:4` — outcome — " +
      "`worker/deno/tests/foo_test.ts::x` — flipped to never blocked, each " +
      "went red",
  },
];

// Review round 2: a corpus entry lists several backticked test names after
// one path-carrying span, e.g. `, \`completion - ...\`, \`completion - ...\``
// — only the FIRST span is `path::name`-shaped; the later bare spans are
// prose/test names, not the entry's own words, and must be blanked outright
// rather than left to trip the strong regex (pr-summary-3257.md:124 shape).
Deno.test("validateBranchOutcomes - a bare later span naming a behaviour 'no test covers' is blanked and valid (pr-summary-3257.md:124 shape)", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `worker/deno/tests/foo_test.ts::a`, " +
      "`completion - a Test Plan bullet citing a behaviour no test covers " +
      "blocks; the recovery quotes a covered behaviour and the PR is " +
      "raised` — flipped to never blocked, each went red\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
});

// Documented look-alike: a backticked admission is CODE, not the entry's own
// prose, so it is blanked and never read as an admission — the admission
// must be in the entry's own words (bold is fine, a code span is not).
Deno.test("validateBranchOutcomes - a backticked whole-admission span is not treated as an admission (documented look-alike)", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `crates/x.ts:1` — guard — `no test reaches it`\n",
    testsAtHead: new Set<string>(),
  });
  assert(result.valid);
});

// A whitespace-free span (a bare path, `path:line`, identifier) is left
// unchanged by blanking, so it still works as the admitting unit's LABEL.
Deno.test("validateBranchOutcomes - a bare path:line span stays a label after blanking", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `crates/app/src/handler.rs:2022` — minimum hold blocks — " +
      "**no test reaches it**: flipped the guard, `cargo test " +
      "--workspace` stayed green\n",
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.unreachedEntries, ["crates/app/src/handler.rs:2022"]);
});

// The GRQ case's whitespace-bearing command span (`cargo test --workspace`)
// is blanked, but the entry's own "no test reaches it" prose still blocks.
Deno.test("validateBranchOutcomes - the GRQ case still blocks with the command span blanked", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `crates/app/src/handler.rs:2022` — minimum hold blocks — " +
      "**no test reaches it**: flipped the guard, `cargo test " +
      "--workspace` stayed green\n",
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

for (const { name, entry } of CORPUS_RED_LOOKALIKES) {
  Deno.test(`validateBranchOutcomes - corpus look-alike is valid: ${name}`, () => {
    const result = validateBranchOutcomes({
      changedFiles: [FOO_TS],
      prSummaryContent: `**Branch outcomes:**\n- ${entry}\n`,
      testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
    });
    assert(result.valid, name);
  });
}

// Exemption.
Deno.test("validateBranchOutcomes - exempt (untestable) with a real reason is valid", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `crates/z.rs:1` — timeout guard — exempt (untestable): the timeout " +
      "branch needs a real thirty-minute wall clock\n",
    testsAtHead: new Set<string>(),
  });
  assert(result.valid);
});

Deno.test("validateBranchOutcomes - exempt (out of scope) with a real reason is valid", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `crates/z.rs:2` — retry path — exempt (out of scope): issue #1234 " +
      "owns the retry path\n",
    testsAtHead: new Set<string>(),
  });
  assert(result.valid);
});

Deno.test("validateBranchOutcomes - exempt (untestable) with no reason blocks with the exemption problem, not the admission one", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `crates/z.rs:3` — timeout guard — exempt (untestable):\n",
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assert(
    result.problems.some((p) =>
      p.includes("marked exempt but gives no reason")
    ),
  );
  assert(!result.problems.some((p) => p.includes("admits no test reaches")));
  assertEquals(result.unreachedEntries, []);
});

Deno.test("validateBranchOutcomes - exempt (later) is not an exemption and the admission still blocks", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `crates/z.rs:4` — exempt (later): reasons reasons reasons — no " +
      "test reaches it\n",
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

Deno.test("buildBranchOutcomesGateComment - names the exempt clause", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "## Summary\n",
    testsAtHead: new Set(),
  });
  const comment = buildBranchOutcomesGateComment(result);
  assertStringIncludes(comment, "exempt (untestable): <reason>");
});

// ---------------------------------------------------------------------------
// Hostile growth (Issue #3288) — one per new pattern.
// ---------------------------------------------------------------------------

Deno.test("validateBranchOutcomes - a long run of 'left ' then a non-matching char scales linearly", () => {
  const buildSummary = (chars: number) =>
    `**Branch outcomes:**\n- ${"left ".repeat(chars)}x\n`;
  assertLinearGrowth(
    "branch-outcomes 'left ...x' weak-admission scan",
    buildSummary,
    (input) =>
      validateBranchOutcomes({
        changedFiles: [FOO_TS],
        prSummaryContent: input,
        testsAtHead: new Set(),
      }),
    { baseChars: 4_000 },
  );
});

Deno.test("validateBranchOutcomes - a long run of 'never ' then a non-matching char scales linearly", () => {
  const buildSummary = (chars: number) =>
    `**Branch outcomes:**\n- ${"never ".repeat(chars)}x\n`;
  assertLinearGrowth(
    "branch-outcomes 'never ...x' negated-red scan",
    buildSummary,
    (input) =>
      validateBranchOutcomes({
        changedFiles: [FOO_TS],
        prSummaryContent: input,
        testsAtHead: new Set(),
      }),
    { baseChars: 4_000 },
  );
});

Deno.test("validateBranchOutcomes - a long run of 'no ' then a non-matching char scales linearly", () => {
  const buildSummary = (chars: number) =>
    `**Branch outcomes:**\n- ${"no ".repeat(chars)}x\n`;
  assertLinearGrowth(
    "branch-outcomes 'no ...x' strong-admission scan",
    buildSummary,
    (input) =>
      validateBranchOutcomes({
        changedFiles: [FOO_TS],
        prSummaryContent: input,
        testsAtHead: new Set(),
      }),
    { baseChars: 4_000 },
  );
});

Deno.test("validateBranchOutcomes - 'exempt (' then a long run of spaces then 'x' scales linearly", () => {
  const buildSummary = (chars: number) =>
    `**Branch outcomes:**\n- exempt (${" ".repeat(chars)}x\n`;
  assertLinearGrowth(
    "branch-outcomes 'exempt (...x' scan",
    buildSummary,
    (input) =>
      validateBranchOutcomes({
        changedFiles: [FOO_TS],
        prSummaryContent: input,
        testsAtHead: new Set(),
      }),
    { baseChars: 4_000 },
  );
});

Deno.test("validateBranchOutcomes - a long line of repeated '`a::' scales linearly (blanking)", () => {
  const buildSummary = (chars: number) =>
    "**Branch outcomes:**\n- " + "`a::".repeat(chars) + "x\n";
  assertLinearGrowth(
    "branch-outcomes citation-blanking scan",
    buildSummary,
    (input) =>
      validateBranchOutcomes({
        changedFiles: [FOO_TS],
        prSummaryContent: input,
        testsAtHead: new Set(),
      }),
    { baseChars: 4_000 },
  );
});

Deno.test("validateBranchOutcomes - a long run of 'stay' words then a non-matching char scales linearly", () => {
  const buildSummary = (chars: number) =>
    `**Branch outcomes:**\n- ${"stay ".repeat(chars)}x\n`;
  assertLinearGrowth(
    "branch-outcomes 'stay ...x' weak-admission scan",
    buildSummary,
    (input) =>
      validateBranchOutcomes({
        changedFiles: [FOO_TS],
        prSummaryContent: input,
        testsAtHead: new Set(),
      }),
    { baseChars: 4_000 },
  );
});

// ---------------------------------------------------------------------------
// PR #3312 review: the PR's own `Branch outcomes:` list (pr-summary-3288.md)
// admitted four reachable outcomes had no test. These four close that gap.
// ---------------------------------------------------------------------------

// branch_outcomes_gate.ts:398 — an entry line cut by capEntry is not counted
// as captured, so its full (uncapped) text still reaches the admission check
// via uncapturedLines. Flip `entryLines.push(...)` to always `[j]` and this
// goes green: the capped `entries[]` text loses "no test reaches it" past
// MAX_ENTRY_CHARS, and marking the line captured removes it from
// uncapturedLines too, so neither copy carries the admission any more.
Deno.test("validateBranchOutcomes - an admission past the entry-length cap still blocks (capEntry truncation)", () => {
  const padding = "pad ".repeat(1_020); // > MAX_ENTRY_CHARS (4,000) once joined
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      `- \`${FOO_TS}:1\` — guard — ${padding}no test reaches it\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

// branch_outcomes_gate.ts:409 — the same cap, but for a CONTINUATION line
// joined onto the previous entry. Flip `entryLines[lastIndex]!.push(j)` to
// run unconditionally and this goes green the same way.
Deno.test("validateBranchOutcomes - an admission on a continuation line past the entry-length cap still blocks", () => {
  const padding = "pad ".repeat(1_020);
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      `- \`${FOO_TS}:1\` — guard —\n` +
      `  ${padding}no test reaches it\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

// branch_outcomes_gate.ts:596 — a `path::name` span keeps only the part
// before `::`, even when the name after it contains spaces: the path
// survives blanking and clears the unrelated "stayed green" wording
// elsewhere in the entry. Flip the `sep >= 0` branch to also blank the whole
// span on whitespace and this goes red: the path is lost, so nothing clears
// the weak "stayed green" admission.
Deno.test("validateBranchOutcomes - a path::name span with spaces keeps the path and stays valid", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      `- \`worker/deno/tests/foo_test.ts::name with spaces\` — other suites ` +
      "stayed green\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
  assertEquals(result.unreachedEntries, []);
});

// branch_outcomes_gate.ts:750 — an admitting entry with no `path:line` token
// gets a fallback label: its first 80 characters, `…`-suffixed. Flip the cut
// to never truncate and this goes red: the label is the full untruncated
// text instead.
Deno.test("validateBranchOutcomes - a long admitting entry with no path:line gets an 80-character label ending in '…'", () => {
  const prose = "x".repeat(90) + " this change admits no test reaches it";
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: `**Branch outcomes:**\n- ${prose}\n`,
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assertEquals(result.unreachedEntries.length, 1);
  const label = result.unreachedEntries[0]!;
  assertEquals(label.length, 81);
  assert(label.endsWith("…"));
  assertEquals(label.slice(0, 80), prose.slice(0, 80));
});

// ---------------------------------------------------------------------------
// PR #3312 review: cross-line backtick pairing (VibeCoder#3132-style defect,
// still present for a span wrapped across a hard-wrapped line).
// ---------------------------------------------------------------------------

// blankLineCitationNames used to pair backticks one RAW line at a time, so a
// span opened on one line and closed on the next was never recognised as a
// span at all — the pairing on the next line started fresh, and the
// entry's own admission prose that followed the wrapped span sat inside
// what the gate (wrongly) read as a still-open code span.
Deno.test("validateBranchOutcomes - an admission after a backtick span wrapped onto the next line still blocks", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `crates/app/src/handler.rs:2022` — minimum hold in `check_min_hold(ctx,\n" +
      "  now)` — **no test reaches it**: flipping the guard left `cargo test " +
      "--workspace` green\n",
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

// The reverse must also hold: a wrapped `path::name` test-name span whose
// wrapped half contains an admission phrase must still be blanked (the
// phrase is the test's NAME, not the entry's own prose), so the entry stays
// valid.
Deno.test("validateBranchOutcomes - a wrapped path::name test name containing an admission phrase is blanked and valid", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `worker/deno/tests/foo_test.ts::flags an entry no test\n" +
      "  reaches` — flipped, went red\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
});

// PR #3312 review, round 5: the header's own line and the wrap line it
// continues onto were recorded as two separate bodyLineIndexGroups entries
// for an INLINE body (no list), so backtick pairing restarted on the wrap
// line — a span opened on the header line (`` `cargo test ``) and closed on
// the wrap line (`` --workspace` ``) was never recognised as one span, so
// the admission prose between its close and the next span was wrongly read
// as still inside an open span and blanked away.
Deno.test("validateBranchOutcomes - an admission after a backtick span wrapped across the inline body's own line break still blocks", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "## Test Plan\n\n" +
      "**Branch outcomes:** `worker/deno/lib/foo.ts:42` — error — checked " +
      "with `cargo test\n--workspace` and no test reaches it — see " +
      "`deno task test`\n",
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
  assertEquals(result.unreachedEntries, ["worker/deno/lib/foo.ts:42"]);
});

// ---------------------------------------------------------------------------
// PR #3312 review: recordsRedFlip's bare `\bred\b` check cleared a weak
// admission on ordinary ways of saying "no test went red" that happen to
// mention the word 'red' without the negation governing a go/turn verb
// directly — real wording plausible in a PR summary, not in EVASION_VARIANTS.
// ---------------------------------------------------------------------------

const RED_LOOKALIKE_EVASIONS: Array<{ name: string; entry: string }> = [
  {
    name: "not red (no verb between)",
    entry: "`crates/x.ts:20` — flipping it left the suite green, not red",
  },
  {
    name: "instead of turning it red",
    entry: "`crates/x.ts:21` — flipping it kept the suite green instead of " +
      "turning it red",
  },
  {
    name: "never red (no verb between)",
    entry: "`crates/x.ts:22` — untested: flipped, stayed green, never red",
  },
  {
    name: "a red test is still to add",
    entry: "`crates/x.ts:23` — untested; a test that goes red is still to add",
  },
];

for (const { name, entry } of RED_LOOKALIKE_EVASIONS) {
  Deno.test(`validateBranchOutcomes - red-lookalike evasion blocks: ${name}`, () => {
    const result = validateBranchOutcomes({
      changedFiles: [FOO_TS],
      prSummaryContent: `**Branch outcomes:**\n- ${entry}\n`,
      testsAtHead: new Set<string>(),
    });
    assertEquals(result.valid, false, name);
    assert(
      result.problems.some((p) => p.includes("admits no test reaches")),
      name,
    );
  });
}

// A genuine (unnegated) red flip right beside a negation elsewhere in the
// sentence must still clear the admission — the new patterns must not
// over-strip a legitimate "went red".
Deno.test("validateBranchOutcomes - an unrelated negation beside a genuine red flip is still valid", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `crates/x.ts:24` — not a special case — flipped, test went red\n",
    testsAtHead: new Set<string>(),
  });
  assert(result.valid);
});

// ---------------------------------------------------------------------------
// PR #3312 review, round 3: a backticked `` `Branch outcomes:` `` header no
// longer needs special handling at all — the admission check blanks test
// citations straight from the raw lines the real (single) parse already
// attributed to each entry, so there is no second, independently-parsed
// "blanked record" whose header can vanish and need a fail-closed message.
// ---------------------------------------------------------------------------

Deno.test("validateBranchOutcomes - a backticked header still runs the admission check", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "## Test Plan\n\n`Branch outcomes:`\n" +
      "- `crates/app/src/handler.rs:2022` — guard — no test reaches it: " +
      "flipping it left the suite green\n",
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

// A plain (non-backticked) header behaves identically.
Deno.test("validateBranchOutcomes - a plain-text header still runs the admission check", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "## Test Plan\n\nBranch outcomes:\n" +
      "- `crates/app/src/handler.rs:2022` — guard — no test reaches it: " +
      "flipping it left the suite green\n",
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

// ---------------------------------------------------------------------------
// PR #3312 review, round 2: backtick pairing used to reset only at blank
// lines, so a tight list (no blank line between items — how this repo's own
// lists, including this file's, are written) was ONE paragraph. A stray
// (odd) backtick in one item flipped which segments counted as "inside a
// span" for every later item, so a genuine admission in a later item could
// be blanked away by an unrelated pairing accident earlier in the list.
// ---------------------------------------------------------------------------

Deno.test("validateBranchOutcomes - a stray backtick in one tight-list item does not blank an admission in a later item", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `worker/deno/lib/foo.ts:10` — splits on the ` character — " +
      "`worker/deno/tests/foo_test.ts::splits` — flipped, test went red\n" +
      "- `worker/deno/lib/foo.ts:20` — error path — no test reaches it — " +
      "`cargo test --workspace` stayed green\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assertEquals(result.valid, false);
  assertEquals(result.unreachedEntries, ["worker/deno/lib/foo.ts:20"]);
});

// The same stray backtick directly above the header no longer matters at
// all: header identification comes from one parse only, so a stray
// backtick elsewhere in the document cannot affect it.
Deno.test("validateBranchOutcomes - a stray backtick in prose above the header still runs the real admission check", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent:
      "Testing here with a stray ` backtick that never closes.\n" +
      "**Branch outcomes:**\n" +
      "- `worker/deno/lib/foo.ts:10` — error path — no test reaches it\n",
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

// ---------------------------------------------------------------------------
// PR #3312 review, round 3: the round-2 "same shape" fail-closed check
// compared entry/uncaptured-line counts between the real parse and an
// independent re-parse of a separately blanked copy of the document.
// Blanking changed those counts for reasons that were never a real line
// merge — a line that was only a whitespace-containing code span blanked to
// an empty string and vanished from the blanked scan, and a backtick-quoted
// mid-prose mention of the header phrase read as a header before blanking
// but not after — so honest summaries were blocked with a misleading
// "merged two lines" message. The fix blanks test citations straight from
// the raw lines the real (single) parse already attributed to each unit, so
// there is no second parse to disagree with.
// ---------------------------------------------------------------------------

// The exact shape (a backtick span straddling a line break inside a nested
// list-form header) that used to trip the removed count-mismatch check — it
// no longer falsely blocks, because there is nothing to compare shapes with.
Deno.test("validateBranchOutcomes - a backtick span straddling a line break no longer falsely blocks (PR #3312 review, round 3)", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "  - Branch outcomes:\n" +
      "   - `worker/deno/lib/foo.ts:1` — outcome admits `open span here\n" +
      " closes` more text\n",
    testsAtHead: new Set<string>(),
  });
  assert(result.valid);
});

// A scanned line that is only a code span containing whitespace (a quoted
// assertion) used to blank to an empty string and vanish from the blanked
// scan, tripping the (now removed) count-mismatch check.
Deno.test("validateBranchOutcomes - none added followed by a code-span-only uncaptured line is valid", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "## Test Plan\n\n- Branch outcomes: none added.\n" +
      "- Removed from a test:\n" +
      "  `assertEquals(a, b);`\n",
    testsAtHead: new Set<string>(),
  });
  assert(result.valid);
});

// Same defect, a different shape: a list followed by a blank line and then a
// quoted shell command as its own uncaptured line.
Deno.test("validateBranchOutcomes - a list followed by a backticked command line is valid", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `worker/deno/lib/foo.ts:42` — error — " +
      "`worker/deno/tests/foo_test.ts::rejects bad input` — went red\n\n" +
      "`cd worker/deno && deno task test`\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
});

// A hard-wrapped sentence whose SECOND line starts with a backtick-quoted
// mention of the header phrase ("...the nouns the rule governs:
// `flatWholeFile`,\n`Branch outcomes:`, ...") reads as a genuine header in
// the raw parse (stripDecoration drops the backticks, and the line now
// starts with "Branch outcomes:") but not once that span is blanked — this
// exact shape, verbatim from `docs/archive/pr-summaries/pr-summary-3249.md`,
// blocked under the old two-parse design even though the summary ends with
// an honest `none added`.
Deno.test("validateBranchOutcomes - a wrapped line starting with a backticked Branch-outcomes mention does not false-block an honest 'none added' (pr-summary-3249.md shape)", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "## Test Plan\n\n" +
      "I grepped for the nouns the rule governs: `flatWholeFile`,\n" +
      '`Branch outcomes:`, "example" and "helper doc comment".\n\n' +
      "Nothing needed changing.\n\n" +
      "Branch outcomes: none added\n",
    testsAtHead: new Set<string>(),
  });
  assert(result.valid);
});

// ---------------------------------------------------------------------------
// PR #3312 review, round 4: backtick pairing still broke across a line wrap
// in two shapes the round-3 fix did not cover. (a) Each uncaptured line was
// blanked on its own (`blankedUnitText(lines, [idx])`), so a span opened on
// one uncaptured line and closed on the next re-paired from scratch on the
// second line, reading the entry's own prose between the close and the next
// span as still "inside a span" and blanking it away. (b) `blankedUnitText`
// still ran the removed per-document `blankTestCitationNames` over one
// entry's own joined lines, which reset pairing at every non-indented line —
// a "lazy" (unindented) continuation line the parser folds into the entry
// was therefore re-paired on its own, with the same effect.
// ---------------------------------------------------------------------------

// (a) An honest "none added" followed by wrapped uncaptured prose: the
// admission sits after the close of a span that opens on one line and
// closes on the next.
Deno.test("validateBranchOutcomes - an admission in wrapped prose after 'none added' blocks (PR #3312 review, round 4)", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "## Test Plan\n\n**Branch outcomes:** none added.\n\n" +
      "The guard at `worker/deno/lib/foo.ts:9` was checked with `deno task\n" +
      "test` but no test reaches it, see `cargo test -p x`.\n",
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

// (a) The same wrapped-span mis-pairing in a sibling bullet that
// `collectEntries` stops short of (the header is itself a list item, so its
// sibling bullet at the header's own indent ends the nested list and is
// scanned as uncaptured text instead of a second entry).
Deno.test("validateBranchOutcomes - an admission in a wrapped sibling-bullet span blocks (PR #3312 review, round 4)", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "- Branch outcomes:\n" +
      "  - `worker/deno/lib/foo.ts:1` — covered — " +
      "`worker/deno/tests/foo_test.ts::ok` — flipped, test went red\n" +
      "- `worker/deno/lib/foo.ts:2` — error — checked with `cargo test\n" +
      "  --workspace` and no test reaches it — see `deno task test`\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

// (b) A lazy (unindented) continuation line the parser folds onto the
// previous entry (the header is an inline, non-list paragraph, so any
// continuation line satisfies `indent > headerIndent`) must still pair its
// backticks with the entry's own first line.
Deno.test("validateBranchOutcomes - an admission on a lazy unindented continuation blocks (PR #3312 review, round 4)", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `worker/deno/lib/foo.ts:42` — error — " +
      "`worker/deno/tests/foo_test.ts::rejects\n" +
      "an unreadable file` — no test reaches it; ran `deno task test`\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

// The shared-unit grouping (`groupUncapturedIndices`, Issue #3356) must reset at a GAP in the index sequence (a
// blank line between two uncaptured regions) even when neither side is a
// list-marker line: an unclosed backtick in the first uncaptured paragraph
// must not flip parity for the second. Without the gap reset, the two
// paragraphs would be joined as one unit and the dangling backtick would
// swallow the real admission as a false "closed span containing
// whitespace".
Deno.test("validateBranchOutcomes - a stray backtick in one uncaptured paragraph does not blank an admission in a later, blank-line-separated paragraph (PR #3312 review, round 4)", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `worker/deno/lib/foo.ts:1` — covered — " +
      "`worker/deno/tests/foo_test.ts::ok` — flipped, test went red\n\n" +
      "stray `\n\n" +
      "see `worker/deno/lib/foo.ts:3`: no test reaches it, ran " +
      "`deno task test`\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

// The shared-unit grouping (`groupUncapturedIndices`, Issue #3356) must also reset at a list-marker line even when
// it is index-consecutive with the previous uncaptured line: the same
// unclosed-backtick parity flip, but via adjacency rather than a blank-line
// gap, so the two reset conditions are each independently exercised.
Deno.test("validateBranchOutcomes - a stray backtick in uncaptured prose does not blank an admission in the immediately following uncaptured bullet (PR #3312 review, round 4)", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `worker/deno/lib/foo.ts:1` — covered — " +
      "`worker/deno/tests/foo_test.ts::ok` — flipped, test went red\n\n" +
      "stray `\n" +
      "- here is `worker/deno/lib/foo.ts:2`: no test reaches it, ran " +
      "`cargo test`\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

// The reverse of (a): a wrapped `path::name` test name in uncaptured prose
// after a list, whose wrapped half happens to contain an admission phrase,
// must still be blanked (it is the test's NAME, not the entry's own prose).
Deno.test("validateBranchOutcomes - a wrapped test name in prose after a list stays valid (PR #3312 review, round 4)", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- `worker/deno/lib/foo.ts:1` — covered — " +
      "`worker/deno/tests/foo_test.ts::ok` — flipped, test went red\n\n" +
      "See also `worker/deno/tests/foo_test.ts::flags an entry no test\n" +
      "reaches` for the pattern.\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
});

// ---------------------------------------------------------------------------
// PR #3312 review, round 6: an admission a hard wrap splits across two
// physical lines was never matched, because uncaptured text was split back
// into one unit PER LINE after blanking — a phrase whose words straddle the
// line break is never one string for `admitsUnreached` to test. The fix
// checks each uncaptured paragraph as one joined unit instead. A second,
// independent defect: a header's own inline body was joined with every
// OTHER header's body into one string, so a test citation in one header
// could clear a weak admission in a different header's body.
// ---------------------------------------------------------------------------

Deno.test("validateBranchOutcomes - a strong admission hard-wrapped across a line break in prose after a list blocks (PR #3312 review, round 6)", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "## Test Plan\n\n**Branch outcomes:**\n\n" +
      "- `worker/deno/lib/foo.ts:42` — error — " +
      "`worker/deno/tests/foo_test.ts::rejects` — flipped, test went red\n\n" +
      "The fail-open guard at `worker/deno/lib/foo.ts:50` is new too, but " +
      "no test\nreaches it yet.\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
  assert(result.unreachedEntries.includes("worker/deno/lib/foo.ts:50"));
});

// The "left ... green" admission word ("left") and its completion ("green")
// sit on opposite sides of the break, with the (blanked-to-empty) shell
// command between them — splitting back into one unit PER LINE leaves
// neither half holding both words, exactly the review's own example.
Deno.test("validateBranchOutcomes - a weak admission hard-wrapped across a line break after 'none added.' blocks (PR #3312 review, round 6)", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:** none added.\n\n" +
      "The guard at `worker/deno/lib/foo.ts:9` is new; flipping it left\n" +
      "`cargo test --workspace` green.\n",
    testsAtHead: new Set<string>(),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

// Table rows must stay separate units even once uncaptured paragraphs are
// joined: merging all four rows into one paragraph would let row 1's test
// citation and red flip clear row 2's bare "untested" admission, since
// `admitsUnreached` returns early once a unit contains any test path or red
// flip at all.
Deno.test("validateBranchOutcomes - an admission in one markdown table row still blocks when a neighbouring row carries a test citation (PR #3312 review, round 6)", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "**Branch outcomes:** two arms added:\n" +
      "\n" +
      "| Outcome | Test |\n" +
      "| --- | --- |\n" +
      "| ok | `worker/deno/tests/foo_test.ts::ok` — flipped, went red |\n" +
      "| edge | untested |\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
});

Deno.test("validateBranchOutcomes - a test citation in one Branch-outcomes header does not clear a weak admission in another header (PR #3312 review, round 6)", () => {
  const result = validateBranchOutcomes({
    changedFiles: [FOO_TS],
    prSummaryContent: "## Test Plan\n\n" +
      "**Branch outcomes:** `worker/deno/lib/foo.ts:42` — error — untested\n\n" +
      "## Later\n\n" +
      "**Branch outcomes:** `worker/deno/lib/foo.ts:50` — ok — " +
      "`worker/deno/tests/foo_test.ts` flipped, went red\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assertEquals(result.valid, false);
  assert(result.problems.some((p) => p.includes("admits no test reaches")));
  assertEquals(result.unreachedEntries, ["worker/deno/lib/foo.ts:42"]);
});

Deno.test("lookupTestsAtHead - invokes git with --literal-pathspecs ls-tree -r --name-only HEAD --", async () => {
  let seenArgs: string[] = [];
  const runGit = (args: string[]) => {
    seenArgs = args;
    return Promise.resolve({
      ok: true as const,
      value: { code: 0, stdout: "", stderr: "" },
    });
  };
  await lookupTestsAtHead(["worker/deno/tests/foo_test.ts"], runGit);
  assertEquals(
    seenArgs,
    [
      "--literal-pathspecs",
      "ls-tree",
      "-r",
      "--name-only",
      "HEAD",
      "--",
      "worker/deno/tests/foo_test.ts",
    ],
  );
});
