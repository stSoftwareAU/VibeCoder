/**
 * Round trip for every scrub trigger (Issue #4210).
 *
 * A model's copy of fenced text is the bytes between the fence markers. It
 * is never stored as the raw original. The closure-met check must accept
 * that copy and the raw copy alike. Summary claim correction must accept a
 * verbatim raw reply and refuse a reply that adds scrub artefacts.
 *
 * Uses Australian English throughout (behaviour, artefact).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
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
  applyFlaggedSentenceReplacements,
  CORRECTED_SUMMARY_CLOSE,
  CORRECTED_SUMMARY_OPEN,
  parseCorrectedSummary,
} from "../lib/summary_claim_correction.ts";
import {
  SCRUB_TRIGGER_CORPUS,
  syntheticGithubToken,
} from "./support/scrub_trigger_corpus.ts";

/** Lib modules this table covers. The completeness check imports this list. */
export const ECHO_TABLE_MODULES: readonly string[] = [
  "closure_met_check.ts",
  "summary_claim_correction.ts",
];

const BOUNDARY_ID = "0123456789ab";
const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-4210.md";
const SENTENCE_FILE = "manual.md";

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

function correctedReply(body: string): string {
  return `${CORRECTED_SUMMARY_OPEN}\n${body}\n${CORRECTED_SUMMARY_CLOSE}`;
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

  Deno.test(`summary echo ${row.name}: verbatim raw is accepted and an artefact echo is refused`, () => {
    const original = row.raw;
    const accepted = parseCorrectedSummary(correctedReply(original), original);
    assert(accepted.ok, row.name);
    assertEquals(accepted.value, `${original}\n`);
    assertEquals(original, row.raw);

    const echo = fencedBody(original);
    const echoed = parseCorrectedSummary(correctedReply(echo), original);
    if (echo !== original) {
      assert(!echoed.ok, `${row.name}: artefact reply was accepted`);
      assertStringIncludes(
        echoed.error.message,
        "introduces prompt-scrubbing artefacts",
      );
      assertEquals(original, row.raw);
    } else {
      assert(
        echoed.ok,
        `${row.name}: an original that already holds its artefacts was refused`,
      );
      assertEquals(echoed.value, `${original}\n`);
    }
  });

  Deno.test(`summary replacement ${row.name}: added artefacts throw, held artefacts do not`, () => {
    const echo = fencedBody(row.raw);
    const findings = [{
      file: SENTENCE_FILE,
      sentence: row.raw,
      reason: "the head differs",
    }];
    const contents = new Map([[SENTENCE_FILE, row.raw]]);
    const reply = (text: string) =>
      JSON.stringify({ replacements: [{ index: 1, text }] });
    if (echo !== row.raw) {
      assertThrows(
        () => applyFlaggedSentenceReplacements(reply(echo), findings, contents),
        Error,
        "prompt-scrubbing artefacts",
      );
      assertEquals(contents.get(SENTENCE_FILE), row.raw);
    } else {
      const replaced = applyFlaggedSentenceReplacements(
        reply(echo),
        findings,
        contents,
      );
      assertEquals(replaced.get(SENTENCE_FILE), row.raw);
    }
    if (row.alreadyHoldsScrubArtefact) {
      const kept = applyFlaggedSentenceReplacements(
        reply("｛｛Y｝｝"),
        findings,
        contents,
      );
      assertEquals(kept.get(SENTENCE_FILE), "｛｛Y｝｝");
    }
  });
}

Deno.test("secret row: a reply cannot restore the redacted token", () => {
  const row = SCRUB_TRIGGER_CORPUS.find((entry) =>
    entry.name === "secret-token"
  );
  assert(row);
  const secret = row.raw;
  const echo = fencedBody(secret);
  assertEquals(echo, REDACTION_PLACEHOLDER);
  assertEquals(echo.includes(secret), false);

  const restored = parseCorrectedSummary(correctedReply(echo), secret);
  assert(!restored.ok);
  assertEquals(restored.error.message.includes(secret), false);
  assertStringIncludes(
    restored.error.message,
    "introduces prompt-scrubbing artefacts",
  );

  const verbatim = parseCorrectedSummary(correctedReply(secret), secret);
  assert(verbatim.ok);
  assertEquals(verbatim.value, `${secret}\n`);
  assertEquals(verbatim.value.includes(REDACTION_PLACEHOLDER), false);
});

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

  assertThrows(
    () =>
      applyFlaggedSentenceReplacements(
        JSON.stringify({ replacements: [{ index: 1, text: "safe text" }] }),
        [{ file: "left.md", sentence: left, reason: "the head differs" }],
        new Map([["left.md", right]]),
      ),
    Error,
    "Flagged sentence is no longer locatable",
  );
});
