/**
 * Documentation-drift tests for the marker-less PR description rule (Issue
 * #4515).
 *
 * `buildSyncedPrBodyCandidate` in `lib/pr_body_sync.ts` rebuilds a PR
 * description only when it carries the `<!-- vibe-worker-issue-N -->` marker
 * (or, on the run's own `issue-<N>-…` branch, adopts a marker-less draft).
 * A marker-less description on any other branch was written outside the
 * worker and is never rebuilt, so the agent must update it itself with
 * `gh pr edit` and say so in `.pr_response_message`. The `pr_feedback`,
 * `ci_fix` and `merge_conflict` templates therefore must not carry the old
 * unconditional "do not edit the PR description yourself" ban.
 *
 * The code side of the foreign-branch case (reason "no worker marker") is
 * already pinned by the `sync - no worker marker` test in
 * `pr_body_sync_test.ts`, so this file pins only the prompt text.
 *
 * Each pin is scoped to the narrowest heading section that carries it
 * (CODING-STANDARDS.md § Documentation-drift tests, condition 1).
 *
 * Australian English spelling used throughout (behaviour, recognised, etc.).
 */

import { assert, assertStringIncludes } from "@std/assert";
import { WORKER_PR_MARKER_PREFIX } from "../lib/pr_body.ts";
import { PR_RESPONSE_MESSAGE_FILE } from "../lib/worker_state_paths.ts";
import {
  flat,
  readRepoDoc,
  section,
  withoutSection,
} from "./support/markdown_docs.ts";

const TYPES_AND_SECTIONS: readonly [type: string, heading: string][] = [
  ["pr_feedback", "Making Changes"],
  ["ci_fix", "Fixing the Failure"],
  ["merge_conflict", "What To Do"],
];

/** The unconditional ban the templates carried before Issue #4515. */
const OLD_UNCONDITIONAL_BAN = "do not edit the pr description yourself";

for (const [type, heading] of TYPES_AND_SECTIONS) {
  const doc = `prompts/${type}/prompt.md`;

  Deno.test(`Issue #4515 - ${type} says a marker-less description is edited with gh pr edit`, async () => {
    const scoped = section(await readRepoDoc(doc), heading);
    const body = flat(
      type === "ci_fix"
        ? withoutSection(scoped, "Dependency audit failures")
        : scoped,
    );

    for (
      const required of [
        `${WORKER_PR_MARKER_PREFIX}N -->`,
        "was written outside the worker",
        "gh pr edit <n> --body-file <file>",
        `and name that in \`${PR_RESPONSE_MESSAGE_FILE}\``,
      ]
    ) {
      assertStringIncludes(
        body,
        required,
        `${doc}: section "${heading}" is missing "${required}"`,
      );
    }

    assert(
      !body.toLowerCase().includes(OLD_UNCONDITIONAL_BAN),
      `${doc}: section "${heading}" still carries the old unconditional ban "${OLD_UNCONDITIONAL_BAN}"`,
    );
  });
}

Deno.test("Issue #4515 - dependency audit tracking reaches a marker-less body", async () => {
  const body = flat(
    section(
      await readRepoDoc("prompts/ci_fix/prompt.md"),
      "Dependency audit failures",
    ),
  );
  for (
    const required of [
      `description carrying \`${WORKER_PR_MARKER_PREFIX}N -->\``,
      "on a branch that is not this run's own `issue-<N>-…` branch",
      "add `Fixes #N` to the live body with `gh pr edit <n> --body-file <file>`",
      `and name that in \`${PR_RESPONSE_MESSAGE_FILE}\``,
    ]
  ) {
    assertStringIncludes(body, required);
  }
});
