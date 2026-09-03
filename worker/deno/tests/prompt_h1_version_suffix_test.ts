/**
 * Issue #792: a prompt's H1 must not declare a version.
 *
 * While templates were immutable `vN.md` files, a new version started as a
 * copy of its predecessor — and the `(vN)` suffix in the H1 title came along
 * with it, so nine templates announced the version *before* the one in their
 * filename. The original rule was therefore "a mismatching suffix fails".
 *
 * Issue #844 removed versioning: each type holds one editable
 * `prompts/<type>/prompt.md` and there is no number for a suffix to agree
 * with. Any `(vN)` suffix is now stale by construction, so the rule tightens
 * to "no suffix at all" — which is what the migration left behind and what a
 * model reading the title should see.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("prompt H1 - no template declares a version (Issue #792)", async () => {
  const stale: string[] = [];
  for await (const entry of Deno.readDir(PROMPTS_DIR)) {
    if (!entry.isDirectory) continue;
    const file = `${PROMPTS_DIR}/${entry.name}/prompt.md`;
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch {
      continue; // a directory of buckets rather than a template
    }
    const h1 = text.split("\n")[0] ?? "";
    if (/\(v\d+\)\s*$/.test(h1)) {
      stale.push(`${entry.name}/prompt.md: ${h1.trim()}`);
    }
  }
  stale.sort();
  assertEquals(
    stale,
    [],
    "templates are no longer versioned, so a `(vN)` suffix in the H1 " +
      "announces a revision that does not exist:\n" + stale.join("\n"),
  );
});
