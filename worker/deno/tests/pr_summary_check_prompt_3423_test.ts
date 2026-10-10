/**
 * Drift tests for Issue #3423: the issue, pr_feedback and ci_fix prompts and
 * CODING-STANDARDS.md tell the agent to run `deno task pr-summary-check` only
 * when the repository defines that task, and that a gate reported as not
 * checked is not a pass. The prompts are shared with fleet repos that lack the
 * task, so the condition is pinned beside the command in each section.
 */
import { assert, assertStringIncludes } from "@std/assert";
import { assertPins, readRepoDoc, section } from "./support/markdown_docs.ts";

const COMMAND_PINS = [
  "deno task pr-summary-check",
  "not checked is not a pass",
];
// The prompts are shared with fleet repos that lack the task, so they also
// carry the condition; CODING-STANDARDS.md describes this repository only.
const PROMPT_PINS = ["defines a `pr-summary-check` task", ...COMMAND_PINS];

const SURFACES: readonly [string, string, string, readonly string[]][] = [
  [
    "issue prompt",
    "prompts/issue/prompt.md",
    "PR Summary File — docs/archive/pr-summaries/pr-summary-ISSUE.md",
    PROMPT_PINS,
  ],
  [
    "pr_feedback prompt",
    "prompts/pr_feedback/prompt.md",
    "Making Changes",
    PROMPT_PINS,
  ],
  [
    "ci_fix prompt",
    "prompts/ci_fix/prompt.md",
    "Fixing the Failure",
    PROMPT_PINS,
  ],
  [
    "CODING-STANDARDS",
    "CODING-STANDARDS.md",
    "PR Summary and Evidence",
    COMMAND_PINS,
  ],
];

for (const [name, doc, title, pins] of SURFACES) {
  Deno.test(`#3423: ${name} names the task and not-checked`, async () => {
    assertPins(section(await readRepoDoc(doc), title), pins);
  });
}

Deno.test("#3423: deno.json defines the pr-summary-check task the prompts name", async () => {
  const config = JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  );
  const command = config.tasks?.["pr-summary-check"];
  assert(typeof command === "string", "deno.json has no pr-summary-check task");
  assertStringIncludes(command, "lib/pr_summary_check_cli.ts");
});
