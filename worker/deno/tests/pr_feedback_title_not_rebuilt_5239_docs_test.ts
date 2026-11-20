/**
 * Documentation-drift tests for the PR title rule (Issue #5239).
 *
 * The worker's body re-sync — `lib/pr_body_sync.ts` and
 * `lib/pr_body_reconcile.ts` — rebuilds a worker-built pull request's
 * description from the summary file and never its title. The `pr_feedback`
 * prompt therefore must say the summary file governs the body only, and name
 * the `gh pr edit <n> --title <title>` command for a title that a fix makes
 * false.
 *
 * Each pin is scoped to the narrowest heading section that carries it
 * (CODING-STANDARDS.md § Documentation-drift tests, condition 1).
 *
 * Australian English spelling used throughout (behaviour, recognised, etc.).
 */

import { assert, assertStringIncludes } from "@std/assert";
import { PR_RESPONSE_MESSAGE_FILE } from "../lib/worker_state_paths.ts";
import {
  flat,
  readRepoDoc,
  section,
  splitSection,
} from "./support/markdown_docs.ts";

const PROMPT = "prompts/pr_feedback/prompt.md";
const OPERATOR_DOC = "docs/workflows/pr-feedback.md";

/** The body-and-title wording the prompt carried before Issue #5239. */
const OLD_BODY_AND_TITLE_WORDING =
  "do not edit it yourself — the summary file is the only place to change it";

Deno.test("Issue #5239 - pr_feedback says the worker does not rebuild a PR title", async () => {
  const scoped = section(await readRepoDoc(PROMPT), "Making Changes");
  const summary = splitSection(scoped, "\n\n").find((paragraph) =>
    paragraph.includes("**Keep the PR summary true to the head.**")
  );
  assert(
    summary !== undefined,
    `${PROMPT}: no "Keep the PR summary true to the head." paragraph`,
  );
  const body = flat(summary);
  for (
    const required of [
      "For a worker-built description, do not edit the body yourself — the summary file is the only place to change it.",
      "The worker does not rebuild a pull request's title",
      `update it with \`gh pr edit <n> --title <title>\` and name that in \`${PR_RESPONSE_MESSAGE_FILE}\``,
    ]
  ) {
    assertStringIncludes(
      body,
      required,
      `${PROMPT}: "Keep the PR summary true to the head." is missing "${required}"`,
    );
  }
  assert(
    !body.includes(OLD_BODY_AND_TITLE_WORDING),
    `${PROMPT}: "Keep the PR summary true to the head." still carries the old body-and-title wording "${OLD_BODY_AND_TITLE_WORDING}"`,
  );
});

Deno.test("Issue #5239 - pr-feedback operator doc says the re-sync never rebuilds the title", async () => {
  const body = flat(
    section(
      await readRepoDoc(OPERATOR_DOC),
      "Every finding ends fixed or rebutted",
    ),
  );
  for (
    const required of [
      "rebuilds the description only, never the title",
      "gh pr edit <n> --title <title>",
    ]
  ) {
    assertStringIncludes(
      body,
      required,
      `${OPERATOR_DOC}: section "Every finding ends fixed or rebutted" is missing "${required}"`,
    );
  }
});
