/**
 * Issue #3656 — fleet UI PRs whose issue confined a change to one side of a
 * width breakpoint leaked it past that breakpoint. A toolbar padding rule was
 * written at every width and wrapped a one-row toolbar onto two rows from
 * 768px to about 845px, while the check measured only a desktop width. A hover
 * handler with no width guard reflowed rows on phones, while the phone check
 * only clicked. In both cases the browser check never measured the protected
 * side at the breakpoint itself, or at a device width just past it.
 *
 * The guidance now requires scoping each new rule, class, wrapper and handler
 * to the range the issue names, and measuring both sides of the breakpoint
 * with the interaction the change adds. This test pins that guidance so a
 * future edit cannot silently drop it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

async function assertPhrases(
  doc: string,
  title: string,
  phrases: readonly string[],
) {
  const text = flat(section(await readRepoDoc(doc), title));
  for (const phrase of phrases) {
    assert(
      text.includes(phrase),
      `${doc} § "${title}" is missing "${phrase}": ${text}`,
    );
  }
}

Deno.test(
  "prompts/issue/prompt.md Instructions checks both sides of a breakpoint the issue names (Issue #3656)",
  async () => {
    await assertPhrases("prompts/issue/prompt.md", "Instructions", [
      "Check both sides of a breakpoint the issue names",
      "scope every new rule, class, wrapper and event handler to that range",
      "at the breakpoint itself and at a common device width just past it",
      "hover as well as click",
      "measures the changed side just inside the",
      "Name the widths in the PR summary's Test Plan",
    ]);
  },
);

Deno.test(
  "CODING-STANDARDS.md Choosing assertions checks both sides of a breakpoint the issue names (Issue #3656)",
  async () => {
    await assertPhrases("CODING-STANDARDS.md", "Choosing assertions", [
      "Check both sides of a breakpoint the issue names",
      "scope every new rule, class, wrapper and event handler to that range",
      "at the breakpoint itself and at a common device width just past it",
      "Name the widths in the Test Plan",
    ]);
  },
);

Deno.test(
  "prompts/best_practices/buckets/html.md Visual design anti-patterns flags a change leaking past its breakpoint (Issue #3656)",
  async () => {
    await assertPhrases(
      "prompts/best_practices/buckets/html.md",
      "Visual design anti-patterns",
      [
        "Change leaking past its breakpoint",
        "Media_queries/Using",
      ],
    );
  },
);
