/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3328 — a change altered the shape of data cached or stored beyond
 * one process without bumping the key or reading the old shape, so an entry
 * left behind by the old code was misread by the new code. VibeCoder#3325
 * moved `getSubIssues` from `number[]` to `SubIssueRef[]` but kept caching it
 * under the same `issue_sub_issues_v1_` key in the file-backed
 * `.gh-scan-cache`, so an old `[7, 8]` entry made `checkParentBlocked` throw
 * on `child.repo.trim()`; GRQ-AutoTrader#2481 made `cashChange` read only
 * `row.interest_charged` while the service worker's `grq-api-v1:` partitions
 * still served rows with the old `interest` key. CODING-STANDARDS.md and the
 * coding_guidelines prompt must both carry the same "changing the shape of
 * persisted data bumps its key or reads the old shape" rule, word for word
 * once wrapping is ignored, and it must render for code-writing phases only.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  type DocSection,
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";
import {
  buildIssuePrompt,
  buildPlanningPrompt,
} from "../lib/prompt_builder.ts";

const PARAGRAPH_START =
  "**Changing the shape of persisted data bumps its key or reads the old shape.**";

function persistedShapeParagraph(
  sectionText: DocSection,
  what: string,
): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(
    start >= 0,
    `could not locate the persisted-shape rule in ${what}`,
  );
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "outlives a deployment or relaunch",
  "bump the key's version",
  "read the old shape too and convert",
  "seeds an entry in the old shape",
  "a live read happens",
  "names the key",
  "which of the two the change chose",
  "neither a bumped key nor an old-shape test",
];

Deno.test("both surfaces carry the persisted-shape rule (Issue #3328)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Changing the Shape of Persisted Data",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Changing the Shape of Persisted Data",
  );

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    const paragraph = persistedShapeParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the persisted-shape rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    persistedShapeParagraph(standards, "CODING-STANDARDS.md"),
    persistedShapeParagraph(guidelines, "coding_guidelines"),
    "the persisted-shape rule must be identical on both surfaces",
  );
});

Deno.test("CODING-STANDARDS.md scopes the rule away from extension contracts (Issue #3328)", async () => {
  const text = flat(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Changing the Shape of Persisted Data",
    ),
  );
  assert(
    text.includes("A Contract a Deployed Extension Reads Is Additive-Only"),
    `CODING-STANDARDS.md is missing the carve-out pointing at the extension-contract rule: ${text}`,
  );
});

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("the rule renders for code-writing phases only (Issue #3328)", async () => {
  const issueBuilt = await buildIssuePrompt({
    repo: "owner/repo",
    issueNumber: "3328",
    issueTitle: "Fix the bug",
    issueBody: "The bug needs fixing.",
    issueLabels: "bug",
    qualityInstructions: "Run ./quality.sh",
    promptsDir: PROMPTS_DIR,
  });
  assert(issueBuilt.ok);
  assert(
    issueBuilt.value.systemPrompt.includes(
      "## Changing the Shape of Persisted Data",
    ),
    "the issue phase (code layer) is missing the persisted-shape heading",
  );

  const planningBuilt = await buildPlanningPrompt({
    repo: "owner/repo",
    issueNumber: "3328",
    issueTitle: "Plan it",
    issueBody: "Break this down",
    issueLabels: "planning",
    agentIdentity: { provider: "claude", model: "opus" },
    promptsDir: PROMPTS_DIR,
  });
  assert(planningBuilt.ok);
  assertEquals(
    planningBuilt.value.systemPrompt.includes(
      "## Changing the Shape of Persisted Data",
    ),
    false,
    "the planning phase (core layer) must not carry the code-only persisted-shape rule",
  );
});
