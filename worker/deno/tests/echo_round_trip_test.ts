/**
 * Round trip for every scrub trigger (Issue #4210).
 *
 * A model's copy of fenced text is the bytes between the fence markers. It
 * is never stored as the raw original. The closure-met check and the caller
 * check must accept that copy and the raw copy alike.
 *
 * Uses Australian English throughout (behaviour, artefact).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CallerCheckState,
  type CallerGapFinding,
  callerGapFindings,
  type CallerVerdict,
  renderCallerCheckSection,
} from "../lib/caller_checks.ts";
import {
  type ClosureEntryVerdict,
  type ClosureGapFinding,
  closureGapFindings,
  renderClosureEntriesSection,
} from "../lib/closure_met_check.ts";
import {
  createPromptDelimiters,
  fenceUntrustedIssueText,
  scrubUntrustedText,
} from "../lib/prompt_delimiter.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";
import {
  SCRUB_TRIGGER_CORPUS,
  syntheticGithubToken,
} from "./support/scrub_trigger_corpus.ts";

/** Lib modules this table covers. The completeness check imports this list. */
export const ECHO_TABLE_MODULES: readonly string[] = [
  "caller_checks.ts",
  "closure_met_check.ts",
];

const BOUNDARY_ID = "0123456789ab";
const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-4210.md";

const PLAIN = SCRUB_TRIGGER_CORPUS.find((row) => row.name === "plain-text");
if (!PLAIN) throw new Error("corpus is missing the plain-text control");

function met(criterion: string): ClosureEntryVerdict {
  return { criterion, verdict: "met", note: "" };
}

function controlFindings(): ClosureGapFinding[] {
  return closureGapFindings(
    [{ criterion: PLAIN!.raw }],
    [met(PLAIN!.raw)],
    SUMMARY_PATH,
  );
}

/** The text a model copies out of an untrusted fence. Not the raw original. */
function fencedBody(raw: string): string {
  const lines = fenceUntrustedIssueText(raw, "Untrusted data", BOUNDARY_ID);
  const delimiters = createPromptDelimiters(BOUNDARY_ID);
  const start = lines.indexOf(delimiters.untrustedStart);
  const end = lines.indexOf(delimiters.untrustedEnd);
  if (start < 0 || end <= start) {
    throw new Error("untrusted fence markers were not rendered");
  }
  return lines.slice(start + 1, end).join("\n");
}

/** The criterion line rendered inside the closure fence, list number included. */
function fencedCriterionLine(raw: string): string {
  const rendered = renderClosureEntriesSection(
    [{ criterion: raw }],
    BOUNDARY_ID,
  );
  const delimiters = createPromptDelimiters(BOUNDARY_ID);
  const start = rendered.indexOf(delimiters.untrustedStart);
  const end = rendered.indexOf(delimiters.untrustedEnd);
  if (start < 0 || end <= start) {
    throw new Error("closure fence markers were not rendered");
  }
  const line = rendered
    .slice(start + delimiters.untrustedStart.length, end)
    .split("\n")
    .find((entry) => /^\d+\. /.test(entry));
  if (!line) throw new Error("closure fence has no criterion line");
  return line;
}

const CALLER_AT = "lib/caller.ts:2";
const HELPER_AT = "lib/helper.ts:1";
const CALLER_LINE = /^- `(.*)` \(defined at `(.*)`\): caller `(.*)`$/;

function callerVerdict(symbol: string, caller: string): CallerVerdict {
  return { symbol, caller, verdict: "unchanged", note: "reads only the sign" };
}

/** The `[symbol, caller]` copies the model reads out of the caller fence. */
function fencedCallerCopies(
  state: CallerCheckState,
): Array<{ symbol: string; caller: string }> {
  const rendered = renderCallerCheckSection(state, BOUNDARY_ID);
  const delimiters = createPromptDelimiters(BOUNDARY_ID);
  const start = rendered.indexOf(delimiters.untrustedStart);
  const end = rendered.indexOf(delimiters.untrustedEnd);
  if (start < 0 || end <= start) {
    throw new Error("caller fence markers were not rendered");
  }
  const copies: Array<{ symbol: string; caller: string }> = [];
  for (
    const line of rendered.slice(start + 1, end).join("\n").split("\n")
  ) {
    const match = CALLER_LINE.exec(line);
    if (match) copies.push({ symbol: match[1]!, caller: match[3]! });
  }
  return copies;
}

function callerControlFindings(): CallerGapFinding[] {
  return callerGapFindings(
    {
      expected: [{
        symbol: PLAIN!.raw,
        definedAt: HELPER_AT,
        caller: CALLER_AT,
      }],
      notes: [],
    },
    [callerVerdict(PLAIN!.raw, CALLER_AT)],
  );
}

function assertNoCallerGap(findings: readonly CallerGapFinding[]): void {
  for (const finding of findings) {
    assertEquals(
      finding.problem.includes("no verdict was reported"),
      false,
      finding.problem,
    );
  }
}

function assertNoUnreported(findings: readonly ClosureGapFinding[]): void {
  for (const finding of findings) {
    assertEquals(
      finding.problem.includes("No verdict was reported"),
      false,
      finding.problem,
    );
  }
}

Deno.test("corpus self-test: the plain-text control is reported with no verdict gap", () => {
  const findings = controlFindings();
  assertEquals(findings, []);
  assertNoUnreported(findings);
});

for (const row of SCRUB_TRIGGER_CORPUS) {
  Deno.test(`corpus self-test: scrub ${row.scrubChanges ? "changes" : "leaves"} ${row.name}`, () => {
    const scrubbed = scrubUntrustedText(row.raw);
    assertEquals(scrubbed !== row.raw, row.scrubChanges, row.name);
    // The fence body is the model's copy. It is one scrub, not a second pass.
    assertEquals(fencedBody(row.raw), scrubbed, row.name);
    if (row.scrubChanges) {
      assertEquals(
        fencedCriterionLine(row.raw).includes(row.raw),
        false,
        row.name,
      );
    }
  });

  Deno.test(`closure echo ${row.name}: fenced and raw copies match the plain control`, () => {
    const items = [{ criterion: row.raw }];
    const echo = fencedCriterionLine(row.raw);
    const expected = controlFindings();
    for (const criterion of [echo, row.raw]) {
      const findings = closureGapFindings(
        items,
        [met(criterion)],
        SUMMARY_PATH,
      );
      assertEquals(findings, expected, row.name);
      assertNoUnreported(findings);
    }
  });

  Deno.test(`caller echo ${row.name}: fenced and raw copies match the plain control`, () => {
    const control = callerControlFindings();
    assertEquals(control, []);
    const variants = [
      { symbol: row.raw, caller: CALLER_AT },
      { symbol: "sharedHelper", caller: row.raw },
    ];
    for (const variant of variants) {
      const state: CallerCheckState = {
        expected: [{
          symbol: variant.symbol,
          definedAt: HELPER_AT,
          caller: variant.caller,
        }],
        notes: [],
      };
      const copies = fencedCallerCopies(state);
      assertEquals(copies.length, 1, row.name);
      const fenced = callerGapFindings(state, [
        callerVerdict(copies[0]!.symbol, copies[0]!.caller),
      ]);
      const raw = callerGapFindings(state, [
        callerVerdict(variant.symbol, variant.caller),
      ]);
      assertEquals(fenced, control, row.name);
      assertEquals(raw, control, row.name);
      assertNoCallerGap(fenced);
    }
  });
}

Deno.test("secret row: the redaction placeholder is not an identifier", () => {
  const left = `alpha ${syntheticGithubToken("A")}`;
  const right = `alpha ${syntheticGithubToken("B")}`;
  assertEquals(fencedBody(left), fencedBody(right));
  assertStringIncludes(fencedBody(left), REDACTION_PLACEHOLDER);

  const items = [{ criterion: left }, { criterion: right }];
  const rendered = renderClosureEntriesSection(items, BOUNDARY_ID);
  const delimiters = createPromptDelimiters(BOUNDARY_ID);
  const start = rendered.indexOf(delimiters.untrustedStart);
  const end = rendered.indexOf(delimiters.untrustedEnd);
  const lines = rendered
    .slice(start + delimiters.untrustedStart.length, end)
    .split("\n")
    .filter((entry) => /^\d+\. /.test(entry));
  assertEquals(lines.length, 2);

  const echoed = closureGapFindings(items, [met(lines[0]!)], SUMMARY_PATH);
  assertEquals(echoed.length, 1);
  assertStringIncludes(
    echoed[0]!.problem,
    "No verdict was reported for 2 of 2",
  );

  assertEquals(
    closureGapFindings(items, [met(left), met(right)], SUMMARY_PATH),
    [],
  );
});

Deno.test("caller echo secret row: the redaction placeholder is not an identifier", () => {
  const left = `alpha ${syntheticGithubToken("A")}`;
  const right = `alpha ${syntheticGithubToken("B")}`;
  const state: CallerCheckState = {
    expected: [
      { symbol: left, definedAt: HELPER_AT, caller: CALLER_AT },
      { symbol: right, definedAt: HELPER_AT, caller: CALLER_AT },
    ],
    notes: [],
  };
  const copies = fencedCallerCopies(state);
  assertEquals(copies.length, 2);
  assertEquals(copies[0], copies[1]);
  assertStringIncludes(copies[0]!.symbol, REDACTION_PLACEHOLDER);

  const echoed = callerGapFindings(state, [
    callerVerdict(copies[0]!.symbol, copies[0]!.caller),
  ]);
  assertEquals(echoed.length, 1);
  assertStringIncludes(
    echoed[0]!.problem,
    "no verdict was reported for 2 of 2",
  );

  assertEquals(
    callerGapFindings(state, [
      callerVerdict(left, CALLER_AT),
      callerVerdict(right, CALLER_AT),
    ]),
    [],
  );
});
