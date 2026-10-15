/**
 * The fleet reviewer and the pre-PR verifier share one review brief
 * (Issue #3395). A test fails if the two diverge: the template's fields are
 * exactly the ones the callers fill, SKILL.md links the brief rather than
 * carrying a copy of its rules, and the verifier's prompt carries every rule.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildPrePrVerifierPrompt,
  renderReviewBrief,
  REVIEW_BRIEF_FIELDS,
} from "../lib/pre_pr_verifier.ts";
import {
  flat,
  flatWholeFile,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const TEMPLATE = await readRepoDoc("prompts/pr_review_brief/prompt.md");
const SKILL = await readRepoDoc(".claude/skills/review-fleet-prs/SKILL.md");
const SKILL_REVIEW = section(SKILL, "1. Review");

const BODY = TEMPLATE.replace(/^\s*<!--[\s\S]*?-->\s*/, "");

const RULE_LINES = BODY.split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length >= 40 && !l.includes("{{"));

// SKILL.md with blockquote prefixes removed and whitespace collapsed.
const SKILL_FLAT = flatWholeFile(SKILL.replace(/^\s*>\s?/gm, ""));

const placeholdersOf = (body: string) =>
  [...new Set([...body.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]))]
    .sort();

Deno.test("the template's placeholders are exactly the fields the callers fill", () => {
  assertEquals(placeholdersOf(BODY), [...REVIEW_BRIEF_FIELDS].sort());
  assert(RULE_LINES.length > 20);
});

Deno.test("an extra placeholder in the template is caught", () => {
  const extra = `${TEMPLATE}\n{{EXTRA_FIELD}}\n`;
  assert(
    placeholdersOf(extra).join() !== [...REVIEW_BRIEF_FIELDS].sort().join(),
  );
  assertThrows(
    () =>
      renderReviewBrief(extra, {
        REVIEW_CONTEXT: "c",
        NO_TEST_ADDED_NOTE: "n",
        TEST_CHANGES: "t",
        PREVIOUS_FINDINGS: "p",
        REVIEW_CHECKLISTS: "r",
        CLOSURE_ENTRIES: "e",
      }),
    Error,
    "EXTRA_FIELD",
  );
});

Deno.test("SKILL.md links the shared brief and names every field", () => {
  const review = flat(SKILL_REVIEW);
  assert(review.includes("prompts/pr_review_brief/prompt.md"));
  for (const field of REVIEW_BRIEF_FIELDS) {
    assert(review.includes(`{{${field}}}`), `SKILL.md does not name ${field}`);
  }
});

Deno.test("SKILL.md carries no copy of the brief's rules", () => {
  const copied = RULE_LINES.filter((l) =>
    SKILL_FLAT.includes(flatWholeFile(l).trim())
  );
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
    reviewChecklists: "",
    closureEntries: "",
  });
  const flatPrompt = flatWholeFile(prompt);
  const missing = RULE_LINES.filter((l) =>
    !flatPrompt.includes(flatWholeFile(l).trim())
  );
  assertEquals(missing, []);
  assert(!prompt.includes("{{"));
  // The renderer alone leaves nothing unfilled either.
  const rendered = renderReviewBrief(TEMPLATE, {
    REVIEW_CONTEXT: "c",
    NO_TEST_ADDED_NOTE: "n",
    TEST_CHANGES: "t",
    PREVIOUS_FINDINGS: "p",
    REVIEW_CHECKLISTS: "r",
    CLOSURE_ENTRIES: "e",
  });
  assert(!rendered.includes("{{"));
});

Deno.test("the brief carries six fields including {{REVIEW_CHECKLISTS}}, which the renderer fills", () => {
  assertEquals(REVIEW_BRIEF_FIELDS.length, 6);
  assert(TEMPLATE.includes("{{REVIEW_CHECKLISTS}}"));
  const rendered = renderReviewBrief(TEMPLATE, {
    REVIEW_CONTEXT: "c",
    NO_TEST_ADDED_NOTE: "n",
    TEST_CHANGES: "t",
    PREVIOUS_FINDINGS: "p",
    REVIEW_CHECKLISTS: "CHECKLIST-SENTINEL-3594",
    CLOSURE_ENTRIES: "e",
  });
  assert(rendered.includes("CHECKLIST-SENTINEL-3594"));
  assert(!rendered.includes("{{REVIEW_CHECKLISTS}}"));
  assert(rendered.includes('"checklist":'));
});

Deno.test("renderReviewBrief fills {{CLOSURE_ENTRIES}} and the reply shape carries closure", () => {
  assert(TEMPLATE.includes("{{CLOSURE_ENTRIES}}"));
  const rendered = renderReviewBrief(TEMPLATE, {
    REVIEW_CONTEXT: "c",
    NO_TEST_ADDED_NOTE: "n",
    TEST_CHANGES: "t",
    PREVIOUS_FINDINGS: "p",
    REVIEW_CHECKLISTS: "r",
    CLOSURE_ENTRIES: "CLOSURE-SENTINEL-3766",
  });
  assert(rendered.includes("CLOSURE-SENTINEL-3766"));
  assert(!rendered.includes("{{CLOSURE_ENTRIES}}"));
  assert(rendered.includes('"closure":'));
});
