/**
 * The words of the unmet-criteria gate (Issues #4146, #4234, #4469).
 *
 * Since #4234 an unmet criterion is advice: the agent is told once and the
 * pull request is raised anyway. The reason and the note must not say
 * otherwise, because the note is also posted on the raised pull request.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildUnmetCriteriaGateComment,
  unmetCriteriaReason,
} from "../lib/unmet_criteria_gate.ts";
import type { DegradedShortfall } from "../lib/degraded_delivery.ts";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const UNMET: DegradedShortfall[] = [
  { criterion: "The router sends planning to opus.", status: "partial" },
  { criterion: "The docs table lists opus.", status: "missing" },
];

/** Phrases that claim the pull request is withheld or the run fails. */
const WITHHELD =
  /no PR (is )?raised|until every criterion|PR is raised only|run fails|resumes this branch/i;

Deno.test("unmetCriteriaReason - counts the criteria and says the PR is raised anyway", () => {
  const one = unmetCriteriaReason(UNMET.slice(0, 1));
  const two = unmetCriteriaReason(UNMET);
  assertStringIncludes(one, "1 acceptance criterion is not met");
  assertStringIncludes(two, "2 acceptance criteria are not met");
  for (const reason of [one, two]) {
    assertStringIncludes(reason, "raised anyway");
    assertEquals(WITHHELD.test(reason), false, reason);
  }
});

Deno.test("buildUnmetCriteriaGateComment - names each criterion and does not claim the PR is withheld", () => {
  const comment = buildUnmetCriteriaGateComment(UNMET);
  assert(
    comment.startsWith("### Acceptance criteria not met\n"),
    "the note opens with its heading",
  );
  assertStringIncludes(comment, "- **partial** — The router sends planning");
  assertStringIncludes(comment, "- **missing** — The docs table lists opus.");
  assertStringIncludes(comment, "raised and armed anyway");
  assertStringIncludes(comment, "`Part of #N`");
  assertEquals(WITHHELD.test(comment), false, comment);
  assert(!comment.includes("⛔"), "the heading must not read as a stop sign");
});

Deno.test("unmetCriteriaReason and buildUnmetCriteriaGateComment - carry no issue number in their output (Issue #4585)", () => {
  // Posted in target repos, where a bare `#N` links to an unrelated issue.
  const outputs = [
    unmetCriteriaReason(UNMET.slice(0, 1)),
    unmetCriteriaReason(UNMET),
    buildUnmetCriteriaGateComment(UNMET),
  ];
  for (const text of outputs) {
    assertEquals(text.match(/#\d+/g) ?? [], [], text);
  }
});

/**
 * Each section that tells an agent or operator what an unmet criterion does.
 * The prompt's line matters most: an agent told that a partial PR is never
 * raised writes `Closes #N` on one (#4445). DESIGN-PRINCIPLES.md is the
 * shared source of truth AGENTS.md sends agents to (#4490 review).
 */
const STATED_ELSEWHERE: readonly { doc: string; title: string }[] = [
  {
    doc: "DESIGN-PRINCIPLES.md",
    title: "An assigned issue is completed, never handed back",
  },
  {
    doc: "DESIGN-PRINCIPLES.md",
    title: "Unmet acceptance criteria are named, never a follow-up issue",
  },
  { doc: "prompts/issue/prompt.md", title: "Acceptance-Criteria Closure" },
  { doc: "docs/USAGE.md", title: "PR Summary File" },
  {
    doc: "docs/workflows/pr-feedback.md",
    title: "Every finding ends fixed or rebutted",
  },
  {
    doc: "docs/workflows/issue-processing.md",
    title: "A `missing` criterion does not close the issue",
  },
  {
    doc: "docs/workflows/issue-processing.md",
    title: "Acceptance-criteria closure before the PR",
  },
];

/**
 * Claims that an unmet criterion stops the PR, in the wordings the docs have
 * used: "blocks PR creation" (the closure gate before #4234), "blocks the PR",
 * "a PR is raised only when every criterion is met" (DESIGN-PRINCIPLES.md
 * before the #4490 review), "the draft is marked ready once every criterion is
 * met" (the draft-continuation wording), and "run fails" (the closure gate's
 * pre-#4234 outcome, issue-processing.md, #4512).
 */
const STOPS_THE_PR =
  /blocks PR creation|(partial|missing)[^.]*\bblocks\b|raised only (when|once|if) every criterion|once every criterion is met|run fails/i;

Deno.test("prompt and docs - no section says an unmet criterion blocks the PR", async () => {
  for (const { doc, title } of STATED_ELSEWHERE) {
    const text = flat(section(await readRepoDoc(doc), title));
    assertEquals(STOPS_THE_PR.test(text), false, `${doc} § ${title}`);
  }
});

/**
 * Claims that a summary-rule gate stops the PR (Issue #4574, after #4234 made
 * the summary-rule gates advisory). The wordings the docs used before #4234:
 * "blocks PR creation" and "gate blocks" (the summary-rule and reproduction
 * gates), "left standing blocks the PR" (an own-line breach) and "do not catch
 * blocks the PR" (a mutation the tests miss), and "commenting on the issue with
 * every rule" (the gate's comment). The carve-out "A violation this diff
 * introduced blocks the PR" is the agent's own rule, so it is deliberately not
 * matched.
 */
const SUMMARY_RULE_GATE_STOPS_PR =
  /blocks PR creation|gate blocks|gate stops a finished run|fails the run|run fails|(left standing|do not catch) blocks the PR|commenting on the issue with every rule/i;

Deno.test("prompt and docs - no section says a summary-rule gate stops PR creation (Issue #4574)", async () => {
  const sections: { doc: string; title: string }[] = [
    {
      doc: "prompts/issue/prompt.md",
      title: "Independent Review Before the PR",
    },
    { doc: "prompts/issue/prompt.md", title: "Reproduction Status" },
    { doc: "prompts/issue/prompt.md", title: "PR Summary File" },
    {
      doc: "docs/SPEC-KIT-COMPARISON.md",
      title: "Honest reproduction status for bug fixes",
    },
  ];
  for (const { doc, title } of sections) {
    const text = flat(section(await readRepoDoc(doc), title));
    assertEquals(
      SUMMARY_RULE_GATE_STOPS_PR.test(text),
      false,
      `${doc} § ${title}`,
    );
  }
});

Deno.test("summary-rule stop pattern - matches the old wordings and not the carve-out (Issue #4574)", () => {
  for (
    const oldWording of [
      "and the gate blocks PR creation on any reason that neither records a fix",
      "an own-line breach left standing blocks the PR",
      "the single most common way this gate stops a finished run",
      "other text fails the run with the work already done",
    ]
  ) {
    assertEquals(SUMMARY_RULE_GATE_STOPS_PR.test(oldWording), true, oldWording);
  }
  const carveOut = "A violation this diff introduced blocks the PR";
  assertEquals(SUMMARY_RULE_GATE_STOPS_PR.test(carveOut), false, carveOut);
});
