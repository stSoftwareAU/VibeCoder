/**
 * The issue prompt's UI Changes extension list must match the screenshot
 * gate's actual extension list (Issue #3019).
 *
 * The prompt now states the file-extension rule up front, with the
 * extensions listed on their own backticked line. This drift test extracts
 * that line and asserts it is kept in lockstep with
 * {@link UI_FILE_EXTENSIONS} in `lib/screenshot_validation.ts` — if either
 * list changes without the other, the gate and the agent's instructions
 * disagree about what counts as a UI file.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assert } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { UI_FILE_EXTENSIONS } from "../lib/screenshot_validation.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/**
 * Extract the backticked extension list from the `- **UI Changes**:` bullet
 * block of the issue prompt. Returns the extensions (without the leading
 * dot) found on the first line within that block consisting solely of
 * `` `\.ext` `` tokens, or an empty array if no such line is found.
 */
export function extractUiChangesExtensions(prompt: string): string[] {
  const lines = prompt.split("\n");
  const start = lines.findIndex((l) => l.startsWith("- **UI Changes**:"));
  if (start === -1) return [];

  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    if (line.trim() !== "" && !line.startsWith(" ")) break;
    end++;
  }
  const block = lines.slice(start, end);

  for (const line of block) {
    const matches = [...line.matchAll(/`\\\.([a-z]+)`/g)].map((m) => m[1]);
    if (matches.length > 0 && line.trim().split(/\s+/).every((tok) =>
      /^`\\\.[a-z]+`$/.test(tok)
    )) {
      return matches;
    }
  }
  return [];
}

Deno.test("issue prompt UI Changes extension list matches UI_FILE_EXTENSIONS", async () => {
  const template = await loadPrompt("issue", PROMPTS_DIR);
  assertEquals(template.ok, true);
  if (!template.ok) return;

  const extracted = extractUiChangesExtensions(template.value);
  assert(
    extracted.length > 0,
    "could not find the backticked extension list under the " +
      "`- **UI Changes**:` bullet in prompts/issue/prompt.md",
  );

  assertEquals(
    [...extracted].sort(),
    [...UI_FILE_EXTENSIONS].sort(),
    "the issue prompt's UI Changes extension list has drifted from " +
      "UI_FILE_EXTENSIONS in lib/screenshot_validation.ts — update both " +
      "together (Issue #3019)",
  );
});

Deno.test("extractUiChangesExtensions - a trimmed list differs from UI_FILE_EXTENSIONS", () => {
  const block = "- **UI Changes**: rule.\n" +
    "  `\\.css` `\\.scss`\n" +
    "- **Other Bullet**: unrelated.";
  const extracted = extractUiChangesExtensions(block);
  assertEquals(extracted, ["css", "scss"]);
  assert(
    JSON.stringify([...extracted].sort()) !==
      JSON.stringify([...UI_FILE_EXTENSIONS].sort()),
    "expected the trimmed list to differ from the real extension list",
  );
});
