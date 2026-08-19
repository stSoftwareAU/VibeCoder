/**
 * Tests that the Idle-task Framework documentation page uses the sleeping
 * emoji (😴) as its page_icon (favicon and browser-tab glyph). Issue #1995.
 *
 * The idle-task framework is the worker's "do nothing claimable; nap on
 * something useful" mechanism, so 😴 is the natural visual cue. This test
 * pins that choice so future edits do not silently regress it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";

function repoRoot(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return thisDir.replace(/worker\/deno\/tests\/$/, "");
}

Deno.test("Idle-task framework page uses 😴 as its page_icon", async () => {
  const root = repoRoot();
  const yamlPath = `${root}_data/page_titles.yml`;
  const content = await Deno.readTextFile(yamlPath);
  const metadata = parseYaml(content) as Record<
    string,
    { title?: string; page_icon?: string }
  >;

  const entry = metadata["docs/IDLE-TASK-FRAMEWORK.md"];
  assertEquals(
    entry?.page_icon,
    "😴",
    "docs/IDLE-TASK-FRAMEWORK.md must use 😴 (sleeping face) as its page_icon — see issue #1995.",
  );
});
