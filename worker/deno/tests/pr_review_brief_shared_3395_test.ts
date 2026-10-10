/**
 * The fleet reviewer and the pre-PR verifier share one review brief
 * (Issue #3395). A test fails if the two diverge: the template's fields are
 * exactly the ones the callers fill, SKILL.md links the brief rather than
 * carrying a copy of its rules, and the verifier's prompt carries every rule.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildPrePrVerifierPrompt,
  renderReviewBrief,
  REVIEW_BRIEF_FIELDS,
} from "../lib/pre_pr_verifier.ts";

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));

const TEMPLATE = await read("../../../prompts/pr_review_brief/prompt.md");
const SKILL = await read(
  "../../../.claude/skills/review-fleet-prs/SKILL.md",
);

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const BODY = TEMPLATE.replace(/^\s*<!--[\s\S]*?-->\s*/, "");

const RULE_LINES = BODY.split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length >= 40 && !l.includes("{{"));

// SKILL.md with blockquote prefixes removed and whitespace collapsed.
const SKILL_FLAT = collapse(SKILL.replace(/^\s*>\s?/gm, ""));

Deno.test("the template's placeholders are exactly the fields the callers fill", () => {
  const found = new Set(
    [...BODY.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]),
  );
  assertEquals([...found].sort(), [...REVIEW_BRIEF_FIELDS].sort());
  assert(RULE_LINES.length > 20);
});

Deno.test("SKILL.md links the shared brief and names every field", () => {
  assertStringIncludes(SKILL, "prompts/pr_review_brief/prompt.md");
  for (const field of REVIEW_BRIEF_FIELDS) {
    assertStringIncludes(SKILL, `{{${field}}}`);
  }
});

Deno.test("SKILL.md carries no copy of the brief's rules", () => {
  const copied = RULE_LINES.filter((l) => SKILL_FLAT.includes(collapse(l)));
  assertEquals(copied, []);
});

Deno.test("the verifier prompt carries every rule of the brief, fully rendered", () => {
  const prompt = buildPrePrVerifierPrompt({
    template: TEMPLATE,
    repo: "owner/repo",
    issueNumber: 3395,
    issueTitle: "Title",
    issueBody: "Body",
    checkoutPath: "/tmp/checkout",
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    summaryPath: "docs/archive/pr-summaries/pr-summary-3395.md",
    changedFiles: ["a.ts"],
  });
  const flat = collapse(prompt);
  const missing = RULE_LINES.filter((l) => !flat.includes(collapse(l)));
  assertEquals(missing, []);
  assert(!prompt.includes("{{"));
  // The renderer alone leaves nothing unfilled either.
  const rendered = renderReviewBrief(TEMPLATE, {
    REVIEW_CONTEXT: "c",
    NO_TEST_ADDED_NOTE: "n",
    TEST_CHANGES: "t",
    PREVIOUS_FINDINGS: "p",
  });
  assert(!rendered.includes("{{"));
});
