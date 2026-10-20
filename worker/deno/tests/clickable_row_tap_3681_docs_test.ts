/**
 * Issue #3681 — two fleet UI PRs added a tap control (an ⓘ toggle, then a
 * status-badge button) inside a list row whose whole area was a stretched-link
 * overlay. The control had no stacking position, so it sat under the overlay,
 * and a real tap opened the detail page instead. Their tests checked only React
 * handler bubbling, or used a synthetic `element.click()`, which skips
 * hit-testing, so neither caught it.
 *
 * The guidance now requires raising the control above the container's layer
 * and tapping it through real hit-testing. This test pins that guidance so a
 * future edit cannot silently drop it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertPins, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test(
  "prompts/issue/prompt.md Instructions requires a control inside a clickable row to win a real tap (Issue #3681)",
  async () => {
    assertPins(
      section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
      [
        "A control inside a clickable row must win the tap",
        "check what covers that container",
        "Give the control its own stacking position above that layer",
        "taps it through the real input layer at its on-screen centre",
        "without `force: true`",
        "`document.elementFromPoint` at that centre is the control or inside it",
        "the content was revealed and the URL did not change",
        "`element.click()` and `dispatchEvent` skip hit-testing",
        "Name the real-input tap (or the `elementFromPoint` check) and the unchanged URL",
      ],
    );
  },
);

Deno.test(
  "prompts/best_practices/buckets/html.md Visual design anti-patterns flags a control buried under a clickable container's overlay (Issue #3681)",
  async () => {
    assertPins(
      section(
        await readRepoDoc("prompts/best_practices/buckets/html.md"),
        "Visual design anti-patterns",
      ),
      [
        "Control buried under a clickable container's overlay",
        "so a tap opens the row's target instead of the control",
        "pointer-cancellation.html",
      ],
    );
  },
);
