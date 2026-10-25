/**
 * Mechanical last resort for an over-long pull request body (Issue #4359).
 *
 * The summarise turn is covered by the completion-phase test. These pin the
 * cut itself: gate sections and the worker marker stay, and the result fits.
 *
 * Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { GITHUB_ISSUE_BODY_MAX_CHARS } from "../lib/idle_task_body_limit.ts";
import {
  assessPrBodyLength,
  degradePrBodyToGitHubLimit,
  PR_BODY_LENGTH_DEGRADATION_NOTE,
} from "../lib/pr_body_length.ts";
import { WORKER_PR_MARKER_PREFIX } from "../lib/pr_body.ts";

const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-4359.md";

Deno.test("degradePrBodyToGitHubLimit - leaves a short body unchanged (Issue #4359)", () => {
  const body = `## Summary\n\nFits.\n\n---\n\n🤖 Processed by: worker\n${WORKER_PR_MARKER_PREFIX}4359 -->`;
  const result = degradePrBodyToGitHubLimit(body, {
    summaryPath: SUMMARY_PATH,
    issueNumber: 4359,
  });
  assertEquals(result.degraded, false);
  assertEquals(result.body, body);
});

Deno.test("degradePrBodyToGitHubLimit - keeps gate blocks, the worker marker and the summary link (Issue #4359)", () => {
  const standards = [
    "## Standards Review",
    "",
    '<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->',
    "",
    "- **clean** — the length cut keeps this block",
  ].join("\n");
  const filler = "LENGTH-FILLER-4359\n".repeat(4000);
  const body = [
    "## Summary",
    "",
    filler,
    "",
    "Closes #4359.",
    "",
    standards,
    "",
    "---",
    "",
    "🤖 Processed by: worker",
    `${WORKER_PR_MARKER_PREFIX}4359 -->`,
  ].join("\n");
  assert(body.length > GITHUB_ISSUE_BODY_MAX_CHARS);

  const result = degradePrBodyToGitHubLimit(body, {
    summaryPath: SUMMARY_PATH,
    issueNumber: 4359,
  });

  assertEquals(result.degraded, true);
  assert(result.body.length <= GITHUB_ISSUE_BODY_MAX_CHARS);
  assertStringIncludes(result.body, PR_BODY_LENGTH_DEGRADATION_NOTE);
  assertStringIncludes(result.body, SUMMARY_PATH);
  assertStringIncludes(result.body, "vibe-standards-review");
  assertStringIncludes(result.body, `${WORKER_PR_MARKER_PREFIX}4359 -->`);
  assertStringIncludes(result.body, "Closes #4359");
});

Deno.test("assessPrBodyLength - asks before it cuts, and the prompt does not carry the summary (Issue #4359)", () => {
  const filler = "LENGTH-FILLER-4359\n".repeat(4000);
  const body = `${filler}\n\n---\n\n🤖 Processed by: worker\n${WORKER_PR_MARKER_PREFIX}4359 -->`;
  const asked = assessPrBodyLength({
    body,
    summaryLength: filler.length,
    issueNumber: 4359,
    retryAttempted: false,
  });
  assertEquals(asked.action, "ask");
  if (asked.action !== "ask") return;
  assertStringIncludes(asked.prompt, SUMMARY_PATH);
  assertStringIncludes(asked.prompt, String(GITHUB_ISSUE_BODY_MAX_CHARS));
  assert(!asked.prompt.includes("LENGTH-FILLER-4359"));

  const cut = assessPrBodyLength({
    body,
    summaryLength: filler.length,
    issueNumber: 4359,
    retryAttempted: true,
  });
  assertEquals(cut.action, "degrade");
  if (cut.action !== "degrade") return;
  assert(cut.body.length <= GITHUB_ISSUE_BODY_MAX_CHARS);
});
