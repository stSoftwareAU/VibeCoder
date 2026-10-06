/**
 * Tests for change-request quote extraction and staleness checking
 * (Issue #3244).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type ChangeRequestFinding,
  extractQuotedSpans,
  findStaleQuotes,
  isPrSummaryPath,
  normaliseForQuoteMatch,
  parseChangeRequestFindings,
  summaryFilesNamedBy,
} from "../lib/change_request_quotes.ts";
import { measureGrowth } from "./support/growth.ts";

// ---------------------------------------------------------------------------
// isPrSummaryPath
// ---------------------------------------------------------------------------

Deno.test("isPrSummaryPath - matches a PR summary, rejects lookalikes", () => {
  assert(isPrSummaryPath("docs/archive/pr-summaries/pr-summary-7.md"));
  assert(!isPrSummaryPath("docs/archive/pr-summaries/pr-summary-7.txt"));
  assert(!isPrSummaryPath("docs/archive/pr-summaries/pr-summary-abc.md"));
  assert(!isPrSummaryPath("CODING-STANDARDS.md"));
});

// ---------------------------------------------------------------------------
// parseChangeRequestFindings
// ---------------------------------------------------------------------------

const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-3232.md";
const STALE_QUOTE_SENTENCE =
  'so pinning "each" would be a vacuous pin per **A new test must go ' +
  "red without its change**";

/** Built in the exact `reviewBody` shape from `review_log.ts` (Issue #3244). */
const REVIEW_BODY = [
  `**\`${SUMMARY_PATH}:146\`**: Line 146 still says "${STALE_QUOTE_SENTENCE}".`,
  "",
  "**Fix:** Rewrite line 146 so it no longer claims the pin is vacuous.",
  "",
  '**`CODING-STANDARDS.md`**: The absolute-claim rule misses "every" and ' +
  '"all".',
  "",
  "This PR fixes the drift check gating issue so that review-fix pushes to " +
  "test and doc files get a model pass too.",
].join("\n");

Deno.test("parseChangeRequestFindings - strips a trailing :line, and excludes the Fix text and closing summary", () => {
  const findings = parseChangeRequestFindings(REVIEW_BODY);
  assertEquals(findings.length, 2);

  assertEquals(findings[0]!.file, SUMMARY_PATH);
  assert(findings[0]!.problem.includes(STALE_QUOTE_SENTENCE));
  assert(!findings[0]!.problem.includes("Rewrite line 146"));

  assertEquals(findings[1]!.file, "CODING-STANDARDS.md");
  assert(findings[1]!.problem.includes("absolute-claim rule"));
  assert(!findings[1]!.problem.includes("This PR fixes the drift check"));
});

Deno.test("parseChangeRequestFindings - an empty rest-of-line after the header, problem continues on the next line", () => {
  const body = [
    "**`CODING-STANDARDS.md`**:",
    "The absolute-claim rule is broken because it misses several documented " +
    "edge cases in this finding.",
    "",
    "**Fix:** tidy it up.",
  ].join("\n");
  const findings = parseChangeRequestFindings(body);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.file, "CODING-STANDARDS.md");
  assertEquals(
    findings[0]!.problem,
    "The absolute-claim rule is broken because it misses several " +
      "documented edge cases in this finding.",
  );
});

Deno.test("parseChangeRequestFindings - a **Fix:** line directly after the problem with no blank line stops the problem there", () => {
  const body = [
    "**`a.md`**: Problem starts here and keeps going for a while.",
    "**Fix:** Do the fix right now.",
  ].join("\n");
  const findings = parseChangeRequestFindings(body);
  assertEquals(findings.length, 1);
  assertEquals(
    findings[0]!.problem,
    "Problem starts here and keeps going for a while.",
  );
  assert(!findings[0]!.problem.includes("Do the fix"));
});

Deno.test("parseChangeRequestFindings - the next finding header directly after the problem with no blank line starts a new finding", () => {
  const body = [
    "**`a.md`**: Problem one text goes here for a while.",
    "**`b.md`**: Problem two text goes here as well.",
  ].join("\n");
  const findings = parseChangeRequestFindings(body);
  assertEquals(findings.length, 2);
  assertEquals(findings[0]!.file, "a.md");
  assertEquals(findings[0]!.problem, "Problem one text goes here for a while.");
  assertEquals(findings[1]!.file, "b.md");
  assertEquals(
    findings[1]!.problem,
    "Problem two text goes here as well.",
  );
});

// ---------------------------------------------------------------------------
// extractQuotedSpans
// ---------------------------------------------------------------------------

Deno.test("extractQuotedSpans - the VibeCoder#3236 problem text, literally", () => {
  const text =
    'Line 146 still says "so pinning \\"each\\" would be a vacuous pin per ' +
    "**A new test must go red without its change**\". The Summary's round-1 " +
    "paragraph still says the drift test's phrase lists pin \"no … is " +
    'missed" and "X, Y and Z are the …" "(not \\"each\\", which ' +
    "`drift-pins-on-base` showed was already present on base in all three " +
    'sections)".';

  const spans = extractQuotedSpans(text);

  assert(
    spans.includes(
      'so pinning "each" would be a vacuous pin per **A new test must go ' +
        "red without its change**",
    ),
  );
  assert(
    spans.includes(
      '(not "each", which `drift-pins-on-base` showed was already present ' +
        "on base in all three sections)",
    ),
  );
  // The short ellipsis-split fragments never clear the 4-word floor.
  assert(!spans.some((s) => s === "no" || s === "is missed"));
});

Deno.test("extractQuotedSpans - curly double quotes", () => {
  const spans = extractQuotedSpans(
    "The doc says “the baseline timings are recorded here for review” and " +
      "nothing else.",
  );
  assertEquals(spans, ["the baseline timings are recorded here for review"]);
});

Deno.test("extractQuotedSpans - straight single quotes containing an apostrophe", () => {
  const spans = extractQuotedSpans(
    "It says 'the PR's own change rule is broken here' in the text.",
  );
  assertEquals(spans, ["the PR's own change rule is broken here"]);
});

Deno.test("extractQuotedSpans - curly single quotes containing an apostrophe", () => {
  const spans = extractQuotedSpans(
    "It says ‘the PR’s own change rule is broken here’ in the text.",
  );
  assertEquals(spans, ["the PR’s own change rule is broken here"]);
});

Deno.test("extractQuotedSpans - an ellipsis-truncated quote yields the fragment before the ellipsis", () => {
  const spans = extractQuotedSpans(
    'It says "gives the reasoning: the baseline timings, the per-minute ' +
      'rates, the break-even wall clock…" here.',
  );
  assertEquals(spans, [
    "gives the reasoning: the baseline timings, the per-minute rates, " +
    "the break-even wall clock",
  ]);
});

Deno.test("extractQuotedSpans - a plain apostrophe is never mistaken for a quote opener", () => {
  const spans = extractQuotedSpans(
    "the PR's summary isn't wrong at all here",
  );
  assertEquals(spans, []);
});

Deno.test("extractQuotedSpans - a 3-word quote never clears the 4-word floor", () => {
  const spans = extractQuotedSpans('"just three words" is here');
  assertEquals(spans, []);
});

Deno.test("extractQuotedSpans - a quote whose opener and closer are on different lines yields nothing", () => {
  const spans = extractQuotedSpans(
    'this opens "across a line\nand closes here" nope',
  );
  assertEquals(spans, []);
});

Deno.test('extractQuotedSpans - an escaped \\" outside a span opens one, closed by a bare quote', () => {
  const spans = extractQuotedSpans(
    'pin \\"the lists pin every phrase here" now',
  );
  assertEquals(spans, ["the lists pin every phrase here"]);
});

Deno.test("extractQuotedSpans - a nested “ inside a curly-double span is kept literally", () => {
  const spans = extractQuotedSpans(
    "“the editor noted “temporary” fixes should not ship” end.",
  );
  assertEquals(spans, ["the editor noted “temporary"]);
});

Deno.test("extractQuotedSpans - a single-quote opener at the very start of the text", () => {
  const spans = extractQuotedSpans(
    "'this opening quote starts the text right here' and more.",
  );
  assertEquals(spans, ["this opening quote starts the text right here"]);
});

Deno.test("extractQuotedSpans - a single quote mid-word never opens a span", () => {
  const spans = extractQuotedSpans(
    "we don't think this closes the span here' after all.",
  );
  assertEquals(spans, []);
});

Deno.test("extractQuotedSpans - a duplicated span is returned once", () => {
  const spans = extractQuotedSpans(
    '"the same long quoted sentence appears twice here" and then later ' +
      '"the same long quoted sentence appears twice here" again.',
  );
  assertEquals(spans, ["the same long quoted sentence appears twice here"]);
});

// ---------------------------------------------------------------------------
// normaliseForQuoteMatch
// ---------------------------------------------------------------------------

Deno.test("normaliseForQuoteMatch - a line-wrapped, bold/backtick, curly-quoted sentence still matches its plain form", () => {
  const wrapped =
    "**Subjectless** entries are\n“ignored”, per `checkRule`'s contract.";
  const plain = 'subjectless entries are "ignored", per checkrule\'s contract.';
  assertEquals(normaliseForQuoteMatch(wrapped), normaliseForQuoteMatch(plain));
});

// ---------------------------------------------------------------------------
// findStaleQuotes / summaryFilesNamedBy
// ---------------------------------------------------------------------------

const STILL_PRESENT_SUMMARY = `## Summary

Closes #3236.

${STALE_QUOTE_SENTENCE}.

## Test Plan

- Added a test.
`;

const REWRITTEN_SUMMARY = `## Summary

Closes #3236.

Pinning is no longer vacuous because every section now requires its own entry.

## Test Plan

- Added a test.
`;

const ROUND_2_SUMMARY = `## Summary

Closes #3236.

${STALE_QUOTE_SENTENCE}.

PR-feedback round 2: the pin is no longer vacuous — see the updated test.

## Test Plan

- Added a test.
`;

function finding(file: string, problem: string): ChangeRequestFinding {
  return { file, problem };
}

/** `STALE_QUOTE_SENTENCE` with its own embedded quotes escaped, as a model
 * reply quoting it inside a bigger quoted span would write it. */
const ESCAPED_STALE_QUOTE_SENTENCE = STALE_QUOTE_SENTENCE.replace(
  /"/g,
  '\\"',
);

Deno.test("findStaleQuotes - the quoted sentence still present is reported stale", () => {
  const findings = [
    finding(
      SUMMARY_PATH,
      `Line 146 still says "${ESCAPED_STALE_QUOTE_SENTENCE}".`,
    ),
  ];
  const { stale, unchecked } = findStaleQuotes(
    findings,
    new Map([[SUMMARY_PATH, STILL_PRESENT_SUMMARY]]),
  );
  assertEquals(unchecked, []);
  assertEquals(stale.length, 1);
  assertEquals(stale[0]!.file, SUMMARY_PATH);
  assertEquals(stale[0]!.quote, STALE_QUOTE_SENTENCE);
});

Deno.test("findStaleQuotes - a rewritten summary reports no stale quotes", () => {
  const findings = [
    finding(
      SUMMARY_PATH,
      `Line 146 still says "${ESCAPED_STALE_QUOTE_SENTENCE}".`,
    ),
  ];
  const { stale, unchecked } = findStaleQuotes(
    findings,
    new Map([[SUMMARY_PATH, REWRITTEN_SUMMARY]]),
  );
  assertEquals(stale, []);
  assertEquals(unchecked, []);
});

Deno.test("findStaleQuotes - the VibeCoder#3236 shape (old sentence kept, round-2 correction appended below) is still stale", () => {
  const findings = [
    finding(
      SUMMARY_PATH,
      `Line 146 still says "${ESCAPED_STALE_QUOTE_SENTENCE}".`,
    ),
  ];
  const { stale } = findStaleQuotes(
    findings,
    new Map([[SUMMARY_PATH, ROUND_2_SUMMARY]]),
  );
  assertEquals(stale.length, 1);
});

Deno.test("findStaleQuotes - a finding on a non-summary file is ignored", () => {
  const findings = [
    finding("CODING-STANDARDS.md", `Still says "${STALE_QUOTE_SENTENCE}".`),
  ];
  const { stale, unchecked } = findStaleQuotes(
    findings,
    new Map([[SUMMARY_PATH, STILL_PRESENT_SUMMARY]]),
  );
  assertEquals(stale, []);
  assertEquals(unchecked, []);
});

Deno.test("findStaleQuotes - a summary mapped to undefined is reported unchecked, not stale", () => {
  const findings = [
    finding(
      SUMMARY_PATH,
      `Line 146 still says "${ESCAPED_STALE_QUOTE_SENTENCE}".`,
    ),
  ];
  const { stale, unchecked } = findStaleQuotes(
    findings,
    new Map([[SUMMARY_PATH, undefined]]),
  );
  assertEquals(stale, []);
  assertEquals(unchecked, [SUMMARY_PATH]);
});

Deno.test("findStaleQuotes - two findings naming the same unreadable summary report it once in unchecked", () => {
  const findings = [
    finding(SUMMARY_PATH, "a"),
    finding(SUMMARY_PATH, "b"),
  ];
  const { stale, unchecked } = findStaleQuotes(
    findings,
    new Map([[SUMMARY_PATH, undefined]]),
  );
  assertEquals(stale, []);
  assertEquals(unchecked, [SUMMARY_PATH]);
});

Deno.test("findStaleQuotes - two findings quoting the same sentence in the same summary report it once", () => {
  const sentence = "the shared sentence that both findings quote right here";
  const summary = `## Summary\n\n${sentence}.\n`;
  const findings = [
    finding(SUMMARY_PATH, `Still says "${sentence}".`),
    finding(SUMMARY_PATH, `Also still says "${sentence}".`),
  ];
  const { stale, unchecked } = findStaleQuotes(
    findings,
    new Map([[SUMMARY_PATH, summary]]),
  );
  assertEquals(unchecked, []);
  assertEquals(stale.length, 1);
  assertEquals(stale[0]!.quote, sentence);
});

Deno.test("summaryFilesNamedBy - unique PR summary paths, first-seen order", () => {
  const findings = [
    finding(SUMMARY_PATH, "a"),
    finding("CODING-STANDARDS.md", "b"),
    finding(SUMMARY_PATH, "c"),
    finding("docs/archive/pr-summaries/pr-summary-1.md", "d"),
  ];
  assertEquals(summaryFilesNamedBy(findings), [
    SUMMARY_PATH,
    "docs/archive/pr-summaries/pr-summary-1.md",
  ]);
});

// ---------------------------------------------------------------------------
// Hostile inputs — one per scanning pattern, ratio assertions only.
// ---------------------------------------------------------------------------

Deno.test("extractQuotedSpans - an unclosed run of backslash-quote pairs stays linear", () => {
  const m = measureGrowth(
    (chars) => '"' + '\\"'.repeat(Math.floor(chars / 2)),
    (input) => extractQuotedSpans(input),
    { baseChars: 20_000 },
  );
  assert(!m.superLinear, `grew super-linearly: ${JSON.stringify(m)}`);
});

Deno.test("extractQuotedSpans - a long run of unclosed single-quote opener attempts stays linear", () => {
  const m = measureGrowth(
    (chars) => "\" 'a".repeat(Math.floor(chars / 4)),
    (input) => extractQuotedSpans(input),
    { baseChars: 20_000 },
  );
  assert(!m.superLinear, `grew super-linearly: ${JSON.stringify(m)}`);
});

Deno.test("parseChangeRequestFindings - an unterminated finding header stays linear", () => {
  const m = measureGrowth(
    (chars) => "**`" + "a".repeat(chars),
    (input) => parseChangeRequestFindings(input),
    { baseChars: 20_000 },
  );
  assert(!m.superLinear, `grew super-linearly: ${JSON.stringify(m)}`);
});

Deno.test("extractQuotedSpans - an unclosed run of curly double quote content stays linear", () => {
  const m = measureGrowth(
    (chars) => "“" + "a ".repeat(Math.floor(chars / 2)),
    (input) => extractQuotedSpans(input),
    { baseChars: 20_000 },
  );
  assert(!m.superLinear, `grew super-linearly: ${JSON.stringify(m)}`);
});
