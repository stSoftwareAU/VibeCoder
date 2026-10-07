/**
 * Issue #3335 — fleet UI PRs (GRQ-AutoTrader#2231, #2729 and #2596) measured
 * a popover, menu or pinned bar closed, at a single viewport size, or only
 * checked the top and bottom edges. Every one of those checks stayed green
 * while the open content ran off-screen in production: a `text-nowrap`
 * popover reaching past the right edge of a phone-width viewport, and a
 * sticky header holding an in-place confirm panel that grew taller than a
 * short landscape viewport and pushed its own Confirm control out of reach.
 *
 * The guidance now requires measuring such content **open**, at the
 * narrowest supported portrait size and at a short landscape height, with
 * all four viewport edges checked and clearance from every fixed bar. This
 * test pins that guidance so a future edit cannot silently drop it.
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
  "prompts/issue/prompt.md Instructions measures overlays and pinned bars open at portrait and landscape sizes (Issue #3335)",
  async () => {
    await assertPhrases("prompts/issue/prompt.md", "Instructions", [
      "Measure overlays and pinned bars open",
      "at a short landscape height",
      "on all four edges",
      "clear of every fixed bar",
      "must unpin while open",
    ]);
  },
);

Deno.test(
  "prompts/best_practices/buckets/html.md Visual design anti-patterns flags an open overlay or pinned bar off-screen (Issue #3335)",
  async () => {
    await assertPhrases(
      "prompts/best_practices/buckets/html.md",
      "Visual design anti-patterns",
      [
        "Open overlay or pinned bar off-screen",
        "focus-not-obscured-minimum",
      ],
    );
  },
);
