/**
 * Issue #3250 — fleet UI PRs shipped Playwright checks that failed on
 * correct code: a closed `visually-hidden` element still keeps a 1×1 box,
 * which Playwright's `toBeVisible()`/`isHidden()` count as visible, so a
 * test asserting the closed element is hidden fails even when the UI is
 * behaving correctly. A second drift measured the DOM inside the same
 * synchronous `page.evaluate()` call that triggered the click, before the
 * UI had committed the change, so the assertion read stale state and
 * failed on correct code too.
 *
 * CODING-STANDARDS.md § "Choosing assertions" → the `**UI / PWA:**` bullet
 * now tells authors to assert the semantic closed state
 * (`aria-expanded="false"`, or the open-only class absent) instead, and to
 * measure only after the UI has committed the change. This test pins that
 * guidance so a future edit cannot silently drop it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const KEY_PHRASES = [
  "1×1 box",
  'aria-expanded="false"',
  "same synchronous `page.evaluate` as the click",
] as const;

Deno.test("Choosing assertions pins the closed-state UI/PWA guidance (Issue #3250)", async () => {
  const text = flat(
    section(await readRepoDoc("CODING-STANDARDS.md"), "Choosing assertions"),
  );

  for (const phrase of KEY_PHRASES) {
    assert(
      text.includes(phrase),
      `Choosing assertions is missing "${phrase}" from the closed-state ` +
        `UI/PWA guidance: ${text}`,
    );
  }
});
