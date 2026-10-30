/**
 * Tests for keeping an issue open when a run leaves part of it undone and the
 * issue states no criteria heading the criteria parser reads (Issue #4477).
 *
 * An issue that lists its requirements under `## Wanted` has no criteria as far
 * as `extractAcceptanceCriteria` is concerned, so the closure gate does not
 * apply to it. A run that leaves part of such an issue undone must still hold
 * the issue open. The mechanism is the `missing` entry the run writes in its own
 * summary's `## Acceptance Criteria` block: `findMissingCriteria` reads it, and
 * `assemblePrBody` rewrites the closing keyword to `Part of #N`.
 *
 * Part A runs that path on real inputs. Part B pins the prompt wording that
 * tells the run to write such an entry, and that the criteria-less case has no
 * reviewer marker.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import {
  extractAcceptanceCriteria,
  validateAcceptanceClosure,
} from "../lib/acceptance_criteria_gate.ts";
import { findMissingCriteria } from "../lib/missing_criterion_close_guard.ts";
import { validateIndependentReview } from "../lib/independent_review_gate.ts";
import { assemblePrBody } from "../lib/pr_body_sync.ts";
import { flat, flatWholeFile, section } from "./support/markdown_docs.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

const ISSUE_NUMBER = 123;

/** An issue whose requirements sit under a heading the parser does not read. */
const WANTED_ISSUE = [
  "## Summary",
  "",
  "Add a dark-mode toggle to the settings page.",
  "",
  "## Wanted",
  "",
  "- Add a dark-mode toggle to the settings page",
  "- Persist the choice for each user",
  "",
].join("\n");

/** The one entry the run writes for the part it leaves undone. */
const MISSING_ENTRY =
  "**missing** — Persist the choice for each user — reason: needs an owner's choice of storage";

/** A summary that leaves part of the issue undone: `Part of`, no `reviewer:`. */
const PART_SUMMARY = [
  "## Summary",
  "",
  `Added the dark-mode toggle to the settings page. Part of #${ISSUE_NUMBER}.`,
  "",
  "## Acceptance Criteria",
  "",
  `- ${MISSING_ENTRY}`,
  "",
].join("\n");

/** A summary with no closure block that closes the issue outright. */
const CLOSING_SUMMARY = [
  "## Summary",
  "",
  `Added the dark-mode toggle to the settings page. Closes #${ISSUE_NUMBER}.`,
  "",
].join("\n");

/** Any closing keyword for the issue, as GitHub honours them. */
const CLOSING_KEYWORD_FOR_ISSUE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#123\b/i;

async function loadIssue(): Promise<string> {
  const result = await loadPrompt("issue", PROMPTS_DIR);
  assertEquals(result.ok, true, "issue failed to load");
  if (!result.ok) throw new Error("issue failed to load");
  return result.value;
}

async function loadPrFeedback(): Promise<string> {
  const result = await loadPrompt("pr_feedback", PROMPTS_DIR);
  assertEquals(result.ok, true, "pr_feedback failed to load");
  if (!result.ok) throw new Error("pr_feedback failed to load");
  return result.value;
}

Deno.test("criteria-less issue - the issue states no criteria the parser reads (Issue #4477)", () => {
  assertEquals(extractAcceptanceCriteria(WANTED_ISSUE), []);
});

Deno.test("criteria-less issue - a missing entry in the summary holds the issue open (Issue #4477)", () => {
  assertEquals(findMissingCriteria(PART_SUMMARY), [MISSING_ENTRY]);

  const closure = validateAcceptanceClosure({
    issueBody: WANTED_ISSUE,
    prSummaryContent: PART_SUMMARY,
  });
  assertEquals(closure.applicable, false);
  assertEquals(closure.valid, true);

  const review = validateIndependentReview({
    issueBody: WANTED_ISSUE,
    prSummaryContent: PART_SUMMARY,
  });
  assertEquals(review.problems, []);
  assertEquals(review.valid, true);

  const body = assemblePrBody({
    summaryContent: PART_SUMMARY,
    issueNumber: ISSUE_NUMBER,
    extraSections: "",
    footer: "",
    summaryDigest: "a".repeat(64),
    subAgentTier: undefined,
  });
  assertStringIncludes(body, `Part of #${ISSUE_NUMBER}`);
  assertStringIncludes(body, `## Not closing #${ISSUE_NUMBER}`);
  assertEquals(CLOSING_KEYWORD_FOR_ISSUE.test(body), false);
});

Deno.test("criteria-less issue - the same issue still closes when the summary has no missing entry (Issue #4477)", () => {
  assertEquals(findMissingCriteria(CLOSING_SUMMARY), []);

  const body = assemblePrBody({
    summaryContent: CLOSING_SUMMARY,
    issueNumber: ISSUE_NUMBER,
    extraSections: "",
    footer: "",
    summaryDigest: "a".repeat(64),
    subAgentTier: undefined,
  });
  assertStringIncludes(body, `Closes #${ISSUE_NUMBER}`);
  assertEquals(body.includes("## Not closing"), false);
});

Deno.test("issue prompt - the closure section names the criteria-less case without the old rule (Issue #4477)", async () => {
  const text = await loadIssue();
  const closure = flat(section(text, "Issue Closure in PR Summary"));

  assertEquals(
    closure.includes("or the issue states no criteria."),
    false,
    "the closure section must not say a criteria-less issue needs no block",
  );
  assertStringIncludes(closure, "states no criteria heading");
  assertStringIncludes(closure, "missing");
  assertStringIncludes(closure, `Part of #{{ISSUE_NUMBER}}`);
});

Deno.test("issue prompt - the criteria-less bullet tells the run to record each undone part (Issue #4477)", async () => {
  const text = await loadIssue();
  const body = flatWholeFile(text);

  assertStringIncludes(
    body,
    "An issue with no acceptance-criteria heading needs no block, unless you leave part of it undone",
  );
  assertStringIncludes(
    body,
    "no reviewer provenance marker and no `reviewer:` field",
  );
});

Deno.test("pr_feedback prompt - the criteria-less case is named in the close-guard rule (Issue #4477)", async () => {
  const text = await loadPrFeedback();
  assertStringIncludes(
    flatWholeFile(text),
    "When the issue states no criteria heading",
  );
});
