/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3288 — the issue-run branch-outcomes gate (Issue #3147) only ever
 * checked that a `Branch outcomes:` list existed and that each named test
 * was real; it never read what an entry actually said, so a PR summary could
 * carry an entry that openly admitted its outcome was never reached ("no
 * test reaches it", "not reached by any test", a flip that "never went red",
 * or — when the entry names no test path and records no red flip —
 * "unreached", "untested", "unreachable", or a flip that "stayed green") and
 * still pass the gate. A separate change teaches the gate itself to block
 * such an admission, with the sole exception of an entry written `exempt
 * (out of scope): <reason>` or `exempt (untestable): <reason>` with a reason
 * of at least three words. This test pins the documentation of that rule on
 * every surface that states it: CODING-STANDARDS.md and the
 * coding_guidelines prompt's shared branch-outcome paragraph, the issue
 * prompt's PR Summary File step, and the pr_feedback prompt's Making Changes
 * section.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import {
  type DocSection,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

Deno.test("CODING-STANDARDS.md and coding_guidelines pin the no-admitted-untested-outcome rule (Issue #3288)", async () => {
  const standards = flat(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Test coverage expectations",
    ),
  );
  const guidelines = flat(
    section(
      await readRepoDoc("prompts/coding_guidelines/prompt.md"),
      "Test Coverage Expectations",
    ),
  );

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    for (
      const phrase of [
        "admits no test reaches its outcome is work still to do",
        "exempt (untestable): <reason>",
      ]
    ) {
      assert(
        text.includes(phrase),
        `${surface} is missing "${phrase}" from the branch-outcome rule: ${text}`,
      );
    }
  }
});

Deno.test("issue prompt PR Summary File step blocks an admitted-untested Branch outcomes: entry (Issue #3288)", async () => {
  const text: DocSection = section(
    await readRepoDoc("prompts/issue/prompt.md"),
    "PR Summary File",
  );
  const flattened = flat(text);

  assert(
    flattened.includes("is work still to do before the summary, not reporting"),
    `PR Summary File section is missing the admission rule: ${flattened}`,
  );
});

Deno.test("pr_feedback prompt Making Changes section blocks an admitted-untested Branch outcomes: entry (Issue #3288)", async () => {
  const text: DocSection = section(
    await readRepoDoc("prompts/pr_feedback/prompt.md"),
    "Making Changes",
  );
  const flattened = flat(text);

  assert(
    flattened.includes("is work still to do in this push, not reporting"),
    `Making Changes section is missing the admission rule: ${flattened}`,
  );
});
