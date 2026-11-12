/**
 * Documentation regression checks. Issue #5019 replaces routine mutation-proof
 * requirements with current-change coverage review and deterministic regressions.
 * These cases retain the relevant rule, scope and twin-document guarantees.
 * Behavioural tests in this file remain unchanged.
 */

import { assertPins, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test("new-test rule delegates to canonical live-value guidance", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/coding_guidelines/prompt.md"),
      "Test Coverage Expectations",
    ),
    [
      "section-scoping and live-value rules",
      "Documentation-drift tests",
    ],
  );
});

Deno.test("live-source linkage is reviewed without source mutation", async () => {
  assertPins(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Documentation-drift tests",
    ),
    [
      "imported from the live module",
      "use `fn.name` for a function name",
      "Review that the assertion uses the live source value",
      "do not require a source mutation",
    ],
  );
});

Deno.test("issue prompt applies canonical live-source rules", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "section-scoping, live-source and per-phrase relevance rules",
      "Do not require deliberate code breaks",
    ],
  );
});

Deno.test("feedback applies canonical live-source rules", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
    [
      "section-scoping and live-source rules",
    ],
  );
});

Deno.test("review brief checks source linkage without mutating it", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/pr_review_brief/prompt.md"),
      "Review Mode",
    ),
    [
      "built from that source, not typed in",
      "Review the source linkage",
      "Do not require a source-mutation run for every pin",
    ],
  );
});

Deno.test("contributor guide preserves live-source pins without mutations", async () => {
  assertPins(section(await readRepoDoc("CONTRIBUTING.md"), "Test layout"), [
    "come from that live source",
    "do not run a baseline or source-mutation exercise for every pin",
  ]);
});
