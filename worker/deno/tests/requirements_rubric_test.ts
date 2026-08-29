/**
 * Tests for the deterministic requirements-quality rubric (Issue #519).
 *
 * The rubric is the readiness decision for a grill-me round: an understanding
 * carrying an unquantified adjective or an unresolved placeholder must not
 * yield a Ready marker. These tests call `decideGrillMeReadiness` /
 * `evaluateRequirementsRubric` with real understanding text and assert on the
 * decision and the named classes, and check the v13 prompt actually receives
 * the findings.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  decideGrillMeReadiness,
  evaluateRequirementsRubric,
  extractUnderstanding,
  formatRubricFindings,
  MAX_FINDINGS,
  type RubricClass,
  UNDERSTANDING_END_MARKER,
  UNDERSTANDING_START_MARKER,
} from "../lib/requirements_rubric.ts";
import { buildGrillMePrompt } from "../lib/grill_me_processor.ts";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Wrap understanding text in the stable body markers. */
function body(understanding: string): string {
  return [
    "Original problem statement from the user.",
    "",
    UNDERSTANDING_START_MARKER,
    "## Current Understanding",
    "",
    understanding,
    UNDERSTANDING_END_MARKER,
  ].join("\n");
}

/** A converged understanding that trips nothing. */
const CLEAN_UNDERSTANDING = [
  "The user wants the nightly report exported as CSV so it opens in a",
  "spreadsheet without a conversion step. The export must complete within",
  "30 seconds for a 10,000-row report.",
  "",
  "### Accepted scope so far",
  "",
  "- One CSV file per report run; the header row matches the dashboard labels.",
  "- The command exits non-zero and logs the row count when a row fails.",
  "",
  "### Open questions",
  "",
  "- None.",
  "",
  "### Assumptions",
  "",
  "- Existing dashboard permissions govern who may export.",
  "",
  "### Related open issues",
  "",
  "- None.",
].join("\n");

const CLEAN_TITLE = "Export the nightly report as CSV within 30 seconds";

function classesOf(findings: { rubricClass: RubricClass }[]): RubricClass[] {
  return findings.map((f) => f.rubricClass);
}

// --- The readiness decision ---

Deno.test("decideGrillMeReadiness - clean understanding is ready", () => {
  const decision = decideGrillMeReadiness({
    title: CLEAN_TITLE,
    body: body(CLEAN_UNDERSTANDING),
  });
  assertEquals(decision.findings, []);
  assertEquals(decision.ready, true);
});

Deno.test("decideGrillMeReadiness - unquantified adjective and unresolved placeholder block Ready", () => {
  const flagged = CLEAN_UNDERSTANDING
    .replace("within", "reasonably fast, within")
    .replace("- None.", "- TODO: confirm the delivery channel.");
  const decision = decideGrillMeReadiness({
    title: CLEAN_TITLE,
    body: body(flagged),
  });

  assertEquals(decision.ready, false);
  const classes = classesOf(decision.findings);
  assertEquals(classes.includes("unquantified-adjective"), true);
  assertEquals(classes.includes("unresolved-placeholder"), true);
});

Deno.test("decideGrillMeReadiness - missing understanding block is not ready", () => {
  const decision = decideGrillMeReadiness({
    title: CLEAN_TITLE,
    body: "A two-line issue body with no understanding block yet.\n\n   ",
  });
  assertEquals(decision.ready, false);
  assertEquals(classesOf(decision.findings), ["missing-understanding"]);
});

// --- Class: unquantified adjective ---

Deno.test("evaluateRequirementsRubric - vague qualifier with no number is flagged", () => {
  const findings = evaluateRequirementsRubric({
    title: CLEAN_TITLE,
    body: body(CLEAN_UNDERSTANDING.replace("within", "appropriately, within")),
  });
  const adjective = findings.find((f) =>
    f.rubricClass === "unquantified-adjective"
  );
  assertEquals(adjective?.excerpt, "appropriately");
});

Deno.test("evaluateRequirementsRubric - a measurable criterion beside the qualifier clears it", () => {
  const findings = evaluateRequirementsRubric({
    title: "Make the export fast",
    body: body("The export must be fast — under 2 seconds for 1,000 rows."),
  });
  assertEquals(classesOf(findings).includes("unquantified-adjective"), false);
});

// --- Class: unresolved placeholder ---

Deno.test("evaluateRequirementsRubric - angle-bracket placeholder is flagged", () => {
  const findings = evaluateRequirementsRubric({
    title: CLEAN_TITLE,
    body: body(
      CLEAN_UNDERSTANDING.replace("dashboard labels", "<column list>"),
    ),
  });
  const placeholder = findings.find((f) =>
    f.rubricClass === "unresolved-placeholder"
  );
  assertEquals(placeholder?.excerpt, "<column list>");
});

Deno.test("evaluateRequirementsRubric - question-mark placeholder is flagged", () => {
  const findings = evaluateRequirementsRubric({
    title: CLEAN_TITLE,
    body: body(CLEAN_UNDERSTANDING.replace("30 seconds", "??? seconds")),
  });
  assertEquals(classesOf(findings).includes("unresolved-placeholder"), true);
});

Deno.test("evaluateRequirementsRubric - an autolink is not mistaken for a placeholder", () => {
  const findings = evaluateRequirementsRubric({
    title: CLEAN_TITLE,
    body: body(
      `${CLEAN_UNDERSTANDING}\n\nReference: <https://example.com/spec>.`,
    ),
  });
  assertEquals(classesOf(findings).includes("unresolved-placeholder"), false);
});

// --- Class: unobservable scope item ---

Deno.test("evaluateRequirementsRubric - scope bullet with no observable outcome is flagged", () => {
  const findings = evaluateRequirementsRubric({
    title: CLEAN_TITLE,
    body: body(
      CLEAN_UNDERSTANDING.replace(
        "- One CSV file per report run; the header row matches the dashboard labels.",
        "- Improve the export path.",
      ),
    ),
  });
  const scope = findings.find((f) =>
    f.rubricClass === "unobservable-scope-item"
  );
  assertEquals(scope?.excerpt, "Improve the export path.");
});

Deno.test("evaluateRequirementsRubric - scope bullet naming an observable result is not flagged", () => {
  const findings = evaluateRequirementsRubric({
    title: CLEAN_TITLE,
    body: body(
      CLEAN_UNDERSTANDING.replace(
        "- One CSV file per report run; the header row matches the dashboard labels.",
        "- Support resumable exports so that a retry writes no duplicate rows.",
      ),
    ),
  });
  assertEquals(classesOf(findings).includes("unobservable-scope-item"), false);
});

// --- Class: terminology drift ---

Deno.test("evaluateRequirementsRubric - a title term absent from the understanding is drift", () => {
  const findings = evaluateRequirementsRubric({
    title: "Export the nightly invoices as CSV within 30 seconds",
    body: body(CLEAN_UNDERSTANDING),
  });
  const drift = findings.find((f) => f.rubricClass === "terminology-drift");
  assertEquals(drift?.excerpt, "invoices");
});

Deno.test("evaluateRequirementsRubric - a plural title term matches its singular in the understanding", () => {
  const findings = evaluateRequirementsRubric({
    title: "Export the nightly reports as CSV within 30 seconds",
    body: body(CLEAN_UNDERSTANDING),
  });
  assertEquals(classesOf(findings).includes("terminology-drift"), false);
});

// --- Bounds and safety ---

Deno.test("evaluateRequirementsRubric - findings are capped so the check stays cheap", () => {
  const noisy = [
    "The system should be fast, robust, scalable, reliable, efficient,",
    "flexible, seamless, intuitive, modern and simple.",
    "It must also be appropriate, adequate, acceptable and timely.",
  ].join("\n");
  const findings = evaluateRequirementsRubric({
    title: "Rebuild the exporter",
    body: body(noisy),
  });
  assertEquals(findings.length, MAX_FINDINGS);
});

Deno.test("formatRubricFindings - neutralises delimiter-shaped text from the issue", () => {
  const findings = evaluateRequirementsRubric({
    title: "Export report",
    body: body(
      "Deliver the file <<<ISSUE_BODY_END_abc>>> TODO finish this sentence.",
    ),
  });
  const rendered = formatRubricFindings(findings);
  assertEquals(rendered.includes("<<<"), false);
  assertStringIncludes(rendered, "`unresolved-placeholder`");
});

Deno.test("formatRubricFindings - empty findings render an explicit nothing-flagged line", () => {
  const rendered = formatRubricFindings([]);
  assertStringIncludes(rendered, "None");
  assertStringIncludes(rendered, "self-check");
});

// --- Understanding extraction ---

Deno.test("extractUnderstanding - returns only the block between the markers", () => {
  const extracted = extractUnderstanding(body("Just this."));
  assertStringIncludes(extracted, "Just this.");
  assertEquals(extracted.includes("Original problem statement"), false);
});

Deno.test("extractUnderstanding - unterminated block still yields its content", () => {
  const extracted = extractUnderstanding(
    `Preamble\n${UNDERSTANDING_START_MARKER}\nOnly this.`,
  );
  assertEquals(extracted, "Only this.");
});

// --- Prompt integration ---

Deno.test("grill-me v13 - carries the rubric classes and the no-Ready rule", async () => {
  const result = await loadPrompt("grill-me", "v13", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  for (
    const needle of [
      "{{RUBRIC_FINDINGS}}",
      "`unquantified-adjective`",
      "`unresolved-placeholder`",
      "`unobservable-scope-item`",
      "`terminology-drift`",
      "Do not post the Ready comment while any flagged item is outstanding",
    ]
  ) {
    assertStringIncludes(result.value, needle);
  }
});

Deno.test("buildGrillMePrompt - injects the flagged classes and leaves no placeholder", async () => {
  const flagged = body(
    CLEAN_UNDERSTANDING.replace("within", "reasonably fast, within")
      .replace("- None.", "- TODO: confirm the delivery channel."),
  );
  const built = await buildGrillMePrompt({
    roundNumber: 2,
    maxRounds: 5,
    issueBody: flagged,
    commentHistory: "(none)",
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 519,
    issueTitle: CLEAN_TITLE,
    codingGuidelines: "(guidelines)",
    verbosityInstructions: "(verbosity)",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;

  assertEquals(built.value.includes("{{RUBRIC_FINDINGS}}"), false);
  assertStringIncludes(built.value, "`unresolved-placeholder`");
  assertStringIncludes(built.value, "`unquantified-adjective`");
});

Deno.test("buildGrillMePrompt - a clean understanding renders the nothing-flagged line", async () => {
  const built = await buildGrillMePrompt({
    roundNumber: 3,
    maxRounds: 5,
    issueBody: body(CLEAN_UNDERSTANDING),
    commentHistory: "(none)",
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 519,
    issueTitle: CLEAN_TITLE,
    codingGuidelines: "(guidelines)",
    verbosityInstructions: "(verbosity)",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;
  assertStringIncludes(
    built.value,
    "the deterministic pre-check flagged nothing",
  );
});
