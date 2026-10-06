/**
 * Issue #3247 — fleet UI PRs (GRQ-AutoTrader#2213, #2231, #2596) backed
 * layout claims with a regex over `app.css`: the "test" matched a selector
 * or a property value in the stylesheet's source text rather than measuring
 * anything the browser rendered. It broke whenever the selector list was
 * split or a property moved to a different rule, and it stayed green when
 * another rule overrode the property or a clipping container hid the
 * overflow the issue was actually about — the fleet's own CSS sources
 * never say which rule wins the cascade or whether an ancestor clips the
 * box.
 *
 * The guidance now names a stylesheet regex as a source-text grep, not a
 * layout test, even when appearance is itself the stated contract, and
 * requires a headless-browser check that measures rendered boxes instead —
 * `prompts/issue/prompt.md` (Instructions, and the PR Summary File
 * skeleton), `CODING-STANDARDS.md` § "Choosing assertions" and
 * `prompts/test_audit/prompt.md` § "Source-text greps used as assertions"
 * all say so. This test pins that guidance so a future edit cannot
 * silently drop it.
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
  "prompts/issue/prompt.md Instructions names a stylesheet regex as a source-text grep (Issue #3247)",
  async () => {
    await assertPhrases("prompts/issue/prompt.md", "Instructions", [
      "is a source-text grep, not a layout test",
      "measures rendered boxes",
      "names that gap in its Test Plan",
    ]);
  },
);

Deno.test(
  "prompts/issue/prompt.md PR Summary File skeleton uses a headless-browser regression test (Issue #3247)",
  async () => {
    await assertPhrases("prompts/issue/prompt.md", "PR Summary File", [
      "rects share one row at 375px",
    ]);
  },
);

Deno.test(
  "CODING-STANDARDS.md Choosing assertions names a stylesheet regex as a source-text grep (Issue #3247)",
  async () => {
    await assertPhrases("CODING-STANDARDS.md", "Choosing assertions", [
      "is a source-text grep",
      "measures rendered boxes",
    ]);
  },
);

Deno.test(
  "prompts/test_audit/prompt.md Source-text greps used as assertions flags stylesheet regexes (Issue #3247)",
  async () => {
    await assertPhrases(
      "prompts/test_audit/prompt.md",
      "Source-text greps used as assertions",
      [
        "Stylesheets are source code",
        "measures rendered boxes",
      ],
    );
  },
);
