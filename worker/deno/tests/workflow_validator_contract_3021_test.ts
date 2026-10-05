/**
 * Tests for the workflow-behaviour-extends-the-validator rule (Issue #3021).
 *
 * A worker PR changed a `.github/workflows/*` file's behaviour — adding the
 * `semgrep ci --no-suppress-errors` flag — and the README documented it as a
 * validated invariant, but `validateSemgrepWorkflow` never checked it; the
 * validator only ever pinned `persist-credentials`. The flag was load-bearing
 * in prose only, so a later edit silently dropped it and nothing failed
 * (GRQ-www#103, GRQ-www#102). This pins the rule — "a workflow behaviour
 * change extends the workflow validator with a positive and a negative test
 * per new/changed invariant, or an invariant documented but not validated is
 * a blocking self-review finding" — on every surface that carries it: the
 * human standards doc, its injected twin in the coding_guidelines prompt, the
 * issue prompt's own workflow-files section, the standards-reviewer
 * sub-agent's prompt, and the issue-processing design doc. A later edit that
 * drops the rule from any of these surfaces fails here.
 */

import { assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import {
  buildIssueReviewerAgents,
  STANDARDS_REVIEWER_AGENT_NAME,
} from "../lib/issue_executor_agents.ts";
import {
  flat,
  flatWholeFile,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function load(type: string): Promise<string> {
  const result = await loadPrompt(type, PROMPTS_DIR);
  if (!result.ok) throw new Error(`${type} failed to load`);
  return result.value;
}

Deno.test("Issue #3021 - CODING-STANDARDS.md requires a workflow behaviour change to extend the workflow validator", async () => {
  const body = await readRepoDoc("CODING-STANDARDS.md");
  const text = flat(section(body, "Test coverage expectations"));

  for (
    const required of [
      "**A workflow behaviour change extends the workflow validator.**",
      "a positive and a negative test",
      "documented but not validated",
      "blocking self-review finding",
    ]
  ) {
    assertStringIncludes(text, required);
  }
});

Deno.test("Issue #3021 - coding_guidelines prompt carries the same workflow-validator rule", async () => {
  const body = await load("coding_guidelines");
  const text = flat(section(body, "Test Coverage Expectations"));

  for (
    const required of [
      "**A workflow behaviour change extends the workflow validator.**",
      "a positive and a negative test",
      "documented but not validated",
      "blocking self-review finding",
    ]
  ) {
    assertStringIncludes(text, required);
  }
});

Deno.test("Issue #3021 - issue prompt's workflow-files section requires extending the workflow validator", async () => {
  const body = await load("issue");
  const text = flat(section(body, "Workflow Files — `.github/workflows/`"));

  for (
    const required of [
      "workflow validator",
      "a positive and a negative test",
      "documented but not validated",
      "blocking self-review finding",
    ]
  ) {
    assertStringIncludes(text, required);
  }
});

Deno.test("Issue #3021 - the standards-reviewer sub-agent prompt flags a documented-but-not-validated workflow invariant", () => {
  const reviewer = buildIssueReviewerAgents()[STANDARDS_REVIEWER_AGENT_NAME]!;
  const text = flatWholeFile(reviewer.prompt);

  for (
    const required of [
      "documented but not validated",
      "negative test",
    ]
  ) {
    assertStringIncludes(text, required);
  }
});

Deno.test("Issue #3021 - issue-processing.md documents the workflow-validator rule for the Standards reviewer", async () => {
  const body = await readRepoDoc("docs/workflows/issue-processing.md");
  const text = flat(section(body, "Independent review on two axes"));

  assertStringIncludes(text, "documented but not validated");
});
