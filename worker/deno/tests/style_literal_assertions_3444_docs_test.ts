/**
 * Issue #3444 — after #3247, fleet UI PRs still pinned exact style values
 * outside stylesheets (an `rgba(...)` gridline colour; a computed max-height).
 * Issue #4991 rewrote the rule around incidental appearance choices (class and
 * tag names a component unit test asserts for a look it cannot see), dropped
 * the Test Plan quote and removed-line obligations, and removed the
 * pr_feedback copy.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertPins, readRepoDoc, section } from "./support/markdown_docs.ts";

const PINS = [
  "Do not pin incidental appearance choices",
  "An incidental class name, purely presentational tag, colour, length, font or other style value is not a test's expected value unless that exact value is part of the issue's contract",
  "A component unit test cannot see weight, colour, wrapping or layout",
  "the class that produces the look is not a test of it",
  "Its test is the browser check described next",
  "are semantic state, not style",
];

Deno.test(
  "CODING-STANDARDS.md Choosing assertions bans pinning incidental appearance choices (Issue #4991)",
  async () => {
    assertPins(
      section(await readRepoDoc("CODING-STANDARDS.md"), "Choosing assertions"),
      PINS,
    );
  },
);

Deno.test(
  "prompts/issue/prompt.md Instructions bans pinning incidental appearance choices (Issue #4991)",
  async () => {
    assertPins(
      section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
      PINS,
    );
  },
);
