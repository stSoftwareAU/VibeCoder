/**
 * Documentation-drift test for Issue #3564 — the persisted-shape rule (#3328)
 * was skipped when a planner-written sub-issue dictated that a newly served
 * field's missing value throws in a client whose service-worker cache outlives
 * a deploy. The rule's client-cache paragraph must sit on both twin surfaces
 * (CODING-STANDARDS.md and the coding_guidelines prompt), the planning prompt
 * must carry the spec-versus-standard bullet so the planner checks what it
 * dictates, and the issue prompt must rank a coding standard above a
 * contradicting implementation detail in the issue.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  assertPins,
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

const PARAGRAPH_START = "**A cached API response is persisted data.**";

/** The client-cache paragraph, still within its section (not yet flattened). */
function clientCacheParagraph(
  sectionText: DocSection,
  what: string,
): DocSection {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(
    start >= 0,
    `could not locate the cached-API-response paragraph in ${what}`,
  );
  const end = sectionText.indexOf("\n\n", start);
  return excerpt(sectionText, start, end >= 0 ? end : undefined);
}

const CLIENT_CACHE_PINS = [
  "a cache that outlives a deployment",
  "a service worker, an HTTP cache, an offline store",
  "Making a newly served field required, or renaming one, is a shape change",
  "Unless the cache key is bumped",
  "a renamed field under its old name too",
  "absence as unknown (null)",
  "never as an error, and never as a made-up default",
  "seeds a body the previous release served",
  "An issue or plan that says a missing value throws does not override this",
];

Deno.test("both surfaces carry the cached-API-response paragraph (Issue #3564)", async () => {
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
    const paragraph = clientCacheParagraph(text, surface);
    assertPins(paragraph, CLIENT_CACHE_PINS);
  }

  assertEquals(
    flat(clientCacheParagraph(standards, "CODING-STANDARDS.md")).trim(),
    flat(clientCacheParagraph(guidelines, "coding_guidelines")).trim(),
    "the cached-API-response paragraph must be identical on both surfaces",
  );
});

Deno.test("CODING-STANDARDS.md scope sentence covers a client's cached responses (Issue #3564)", async () => {
  const text = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Changing the Shape of Persisted Data",
  );
  assertPins(text, [
    "a client's cached copy of its own API's responses included",
  ]);
});

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("the planning prompt checks a sub-issue's spec against the persisted-shape rule (Issue #3564)", async () => {
  const planning = section(
    await readRepoDoc("prompts/planning/prompt.md"),
    "Planning Guidelines",
  );
  assertPins(planning, [
    "A sub-issue's spec never contradicts a coding standard.",
    "adds, renames or removes a field a client parses",
    "bump the cache key, or read the old shape tolerantly with a test that seeds an old-shape body",
    "It never dictates that a missing value throws for a field the previous release did not serve",
    "no design detail that contradicts a coding standard",
  ]);

  const planningBuilt = await buildPlanningPrompt({
    repo: "owner/repo",
    issueNumber: "3564",
    issueTitle: "Plan it",
    issueBody: "Break this down",
    issueLabels: "planning",
    agentIdentity: { provider: "claude", model: "opus" },
    promptsDir: PROMPTS_DIR,
  });
  assert(planningBuilt.ok);
  assert(
    planningBuilt.value.prompt.replace(/\s+/g, " ").includes(
      "A sub-issue's spec never contradicts a coding standard.",
    ),
    "the planner's rendered prompt is missing the spec-versus-standard bullet",
  );
});

Deno.test("the issue prompt ranks a coding standard above a contradicting spec line (Issue #3564)", async () => {
  const issueGuidelines = section(
    await readRepoDoc("prompts/issue/prompt.md"),
    "Project Guidelines",
  );
  assertPins(issueGuidelines, [
    "A coding standard outranks an implementation detail in the issue.",
    "follow the standard and record the deviation in the PR summary",
    "a reviewer judges the deviation rather than the literal line",
    "A line that only chooses among designs the standards allow is not a contradiction",
  ]);

  const issueBuilt = await buildIssuePrompt({
    repo: "owner/repo",
    issueNumber: "3564",
    issueTitle: "Fix the bug",
    issueBody: "The bug needs fixing.",
    issueLabels: "bug",
    qualityInstructions: "Run ./quality.sh",
    promptsDir: PROMPTS_DIR,
  });
  assert(issueBuilt.ok);
  assert(
    issueBuilt.value.prompt.replace(/\s+/g, " ").includes(
      "A coding standard outranks an implementation detail in the issue.",
    ),
    "the issue prompt's rendered prompt is missing the standard-outranks rule",
  );
});
