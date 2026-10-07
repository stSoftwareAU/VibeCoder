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
