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
    comment.startsWith("### Acceptance criteria not met (Issue #4146)\n"),
    "the note opens with its heading",
  );
  assertStringIncludes(comment, "- **partial** — The router sends planning");
  assertStringIncludes(comment, "- **missing** — The docs table lists opus.");
  assertStringIncludes(comment, "raised and armed anyway");
  assertStringIncludes(comment, "`Part of #N`");
  assertEquals(WITHHELD.test(comment), false, comment);
  assert(!comment.includes("⛔"), "the heading must not read as a stop sign");
});

/**
 * Each section that tells an agent or operator what an unmet criterion does.
 * The prompt's line matters most: an agent told that a partial PR is never
 * raised writes `Closes #N` on one (#4445).
 */
const STATED_ELSEWHERE: readonly { doc: string; title: string }[] = [
  { doc: "prompts/issue/prompt.md", title: "Acceptance-Criteria Closure" },
  { doc: "docs/USAGE.md", title: "PR Summary File" },
  {
    doc: "docs/workflows/pr-feedback.md",
    title: "Every finding ends fixed or rebutted",
  },
];

Deno.test("prompt and docs - no section says an unmet criterion blocks the PR", async () => {
  for (const { doc, title } of STATED_ELSEWHERE) {
    const text = flat(section(await readRepoDoc(doc), title));
    assertEquals(
      /(partial|missing)[^.]*blocks the PR/.test(text),
      false,
      `${doc} § ${title}`,
    );
  }
});
