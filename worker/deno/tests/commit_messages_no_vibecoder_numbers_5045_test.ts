/**
 * Regression tests for Issue #5045: commit messages the worker writes into
 * target repos carry no VibeCoder issue number. GitHub links a bare `#<n>`
 * against the target repo, so a VibeCoder citation points at an unrelated
 * issue there. The target's own PR and issue numbers stay.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildConflictMergeCommitMessage } from "../lib/pr_merge_conflict_processor.ts";
import { buildCiFixCommitMessage } from "../lib/pr_ci_processor.ts";
import { buildFeedbackFinaliseCommitMessage } from "../lib/pr_feedback_processor.ts";
import { buildSpellingFixCommitMessage } from "../lib/pr_spelling_processor.ts";
import { buildSummaryRecoveryCommitMessage } from "../lib/summary_rule_gate_retry.ts";
import { buildBodyLimitRecoveryCommitMessage } from "../lib/pr_body_length.ts";
import { buildPrePushRecoveryCommitMessage } from "../lib/pre_push_gate_retry.ts";
import { buildScreenshotRecoveryCommitMessage } from "../lib/screenshot_gate_retry.ts";

const PR = 3378;
const ISSUE = 77;
const CHECK = "ci / test";
const ATTEMPTS = ["final-mile", "push-recovery-retry"] as const;

/** Every `#<n>` left once the target's own numbers are removed. */
function strayNumbers(message: string, own: number[]): string[] {
  let rest = message;
  for (const n of own) {
    rest = rest.replace(new RegExp(`#${n}(?!\\d)`, "g"), "");
  }
  return rest.match(/#\d+/g) ?? [];
}

const subject = (message: string): string => message.split("\n")[0] ?? "";

Deno.test("buildConflictMergeCommitMessage - cites no VibeCoder issue number (Issue #5045)", () => {
  const msg = buildConflictMergeCommitMessage("main", "issue-77");
  assertEquals(strayNumbers(msg, []), []);
  assertEquals(subject(msg), "Merge main into issue-77");
});

Deno.test("buildCiFixCommitMessage - cites no VibeCoder issue number, keeps the PR's own (Issue #5045)", () => {
  for (const attempt of ATTEMPTS) {
    const msg = buildCiFixCommitMessage(CHECK, PR, attempt);
    assertEquals(strayNumbers(msg, [PR]), [], msg);
    assertStringIncludes(msg, "#3378");
    assertEquals(subject(msg), "Fix CI failure: ci / test");
  }
});

Deno.test("buildFeedbackFinaliseCommitMessage - cites no VibeCoder issue number, keeps the PR's own (Issue #5045)", () => {
  for (const attempt of ATTEMPTS) {
    const msg = buildFeedbackFinaliseCommitMessage(PR, attempt);
    assertEquals(strayNumbers(msg, [PR]), [], msg);
    assertStringIncludes(msg, "#3378");
    assertEquals(subject(msg), "Address PR #3378 feedback");
  }
});

Deno.test("buildSpellingFixCommitMessage - cites no VibeCoder issue number, keeps the PR's own (Issue #5045)", () => {
  for (const attempt of ATTEMPTS) {
    const msg = buildSpellingFixCommitMessage(CHECK, PR, attempt);
    assertEquals(strayNumbers(msg, [PR]), [], msg);
    assertStringIncludes(msg, "#3378");
    assertEquals(subject(msg), "Fix spelling check failures: ci / test");
  }
});

Deno.test("buildSummaryRecoveryCommitMessage - cites no VibeCoder issue number, keeps the issue's own (Issue #5045)", () => {
  const msg = buildSummaryRecoveryCommitMessage(ISSUE);
  assertEquals(strayNumbers(msg, [ISSUE]), [], msg);
  assertStringIncludes(msg, "#77");
  assertEquals(subject(msg), "docs: close out the PR summary for #77");
});

Deno.test("buildBodyLimitRecoveryCommitMessage - cites no VibeCoder issue number, keeps the issue's own (Issue #5045)", () => {
  const msg = buildBodyLimitRecoveryCommitMessage(ISSUE);
  assertEquals(strayNumbers(msg, [ISSUE]), [], msg);
  assertStringIncludes(msg, "#77");
  assertEquals(subject(msg), "docs: shorten PR summary for #77");
});

Deno.test("buildPrePushRecoveryCommitMessage - cites no VibeCoder issue number, keeps the issue's own (Issue #5045)", () => {
  const msg = buildPrePushRecoveryCommitMessage(ISSUE);
  assertEquals(strayNumbers(msg, [ISSUE]), [], msg);
  assertStringIncludes(msg, "#77");
  assertEquals(subject(msg), "fix: pre-push gate findings for #77");
});

Deno.test("buildScreenshotRecoveryCommitMessage - cites no VibeCoder issue number, keeps the issue's own (Issue #5045)", () => {
  const msg = buildScreenshotRecoveryCommitMessage(ISSUE);
  assertEquals(strayNumbers(msg, [ISSUE]), [], msg);
  assertStringIncludes(msg, "#77");
  assertEquals(subject(msg), "docs: screenshot evidence for #77");
});
