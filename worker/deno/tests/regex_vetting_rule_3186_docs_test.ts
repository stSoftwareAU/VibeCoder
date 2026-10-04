/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3186 — the closure and reproduction gates read labelled values with a
 * greedy `(.*)$`, which a lone `\r` makes fail, so an unanchored label search
 * restarted at every later occurrence and went quadratic. The regex-vetting
 * rule in CODING-STANDARDS.md "Unit tests" and the coding_guidelines prompt's
 * unit-test section must both name that shape and the `([^\n]*)` remedy. The
 * 3164 suite already holds the two bullets word for word identical.
 *
 * Each pinned phrase was absent from its section on the base branch, so
 * deleting the new sentence turns this suite red.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const KEY_PHRASES = [
  "A `(.*)$` tail can fail too, because `.` stops at a lone `\\r`",
  "restarts at every later occurrence of the label",
  "read the value with `([^\\n]*)` and no `$`",
];

Deno.test("both surfaces name the failing `(.*)$` tail in the regex-vetting rule (Issue #3186)", async () => {
  for (
    const [path, heading] of [
      ["CODING-STANDARDS.md", "Unit tests"],
      ["prompts/coding_guidelines/prompt.md", "Unit Tests vs"],
    ] as const
  ) {
    const text = section(await readRepoDoc(path), heading);
    const start = text.indexOf("- **Vet every regex on untrusted text");
    assert(start >= 0, `${path} has no regex-vetting rule`);
    const rest = text.slice(start + 2);
    const ends = [rest.indexOf("\n- "), rest.indexOf("\n\n")].filter((i) =>
      i >= 0
    );
    const rule = flat(
      rest.slice(0, ends.length > 0 ? Math.min(...ends) : undefined),
    );
    for (const phrase of KEY_PHRASES) {
      assert(rule.includes(phrase), `${path} is missing "${phrase}"`);
    }
  }
});
