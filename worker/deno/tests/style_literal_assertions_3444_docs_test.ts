/**
 * Issue #3444 — after #3247, fleet UI PRs still pinned exact style values
 * outside stylesheets (an `rgba(...)` gridline colour returned by a chart
 * options callback; a computed max-height compared with the stylesheet's
 * `calc(...)` string, which survived a review fix push). The guidance now
 * defines the rule by the kind of value rather than the file, adds a
 * self-review step, and has review fixes remove the literal.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertPins, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test(
  "CODING-STANDARDS.md Choosing assertions defines a style literal by its kind of value (Issue #3444)",
  async () => {
    assertPins(
      section(await readRepoDoc("CODING-STANDARDS.md"), "Choosing assertions"),
      [
        "A style literal is incidental wherever it lives",
        "in a TS/JS options object",
        "in a computed style a browser test reads",
        "it is never a test's expected value unless the issue names that value",
        "quote the issue sentence that names it in the Test Plan",
        "the panel's box ends above the bar's top",
      ],
    );
  },
);

Deno.test(
  "prompts/issue/prompt.md Instructions defines a style literal by its kind of value (Issue #3444)",
  async () => {
    assertPins(
      section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
      [
        "is never a test's expected value unless the issue names that value",
        "The rule is about the kind of value, not the file it lives in",
        "in a TS/JS options object",
        "computed style a browser test reads",
        "replace the literal with the behaviour it stands for",
      ],
    );
  },
);

Deno.test(
  "prompts/pr_feedback/prompt.md Making Changes removes a replaced style literal (Issue #3444)",
  async () => {
    assertPins(
      section(
        await readRepoDoc("prompts/pr_feedback/prompt.md"),
        "Making Changes",
      ),
      [
        "A replaced style literal is removed, not joined",
        "the push deletes the literal assertion",
        "A new check added beside the literal does not fix the finding",
        "cite the removed lines",
      ],
    );
  },
);
