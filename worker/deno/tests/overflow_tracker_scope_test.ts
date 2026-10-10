/**
 * Issue #790: the >6-findings overflow tracker is security-scan-only.
 *
 * `security_scan` mandates rolling the surplus into a
 * `security-scan-overflow` tracker. Every sibling scan template forbids one —
 * but six of them worded the prohibition without scoping it to their own run,
 * so it read as a family-wide invariant that `security_scan` breaks. The fix
 * scopes each prohibition to its own scan, the way `doc_coverage` already did.
 *
 * This test pins the resulting invariant: in every prompt template, a mention
 * of an overflow tracker is either `security_scan`'s own mandate or a
 * prohibition scoped to that template's runs. It reads each type's
 * `prompt.md`, so an edit that drops the scoping fails here rather than
 * silently reintroducing the contradiction.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 *
 * This file holds only the whole-file absence check, which loops over every
 * prompt directory's `prompt.md` on disk (no unscoped overflow-tracker
 * prohibition anywhere in a template). The two section-scoped presence pins
 * (security_scan's mandate, the six templates' own scoping; Issue #3309) live
 * in `overflow_tracker_scope_drift_test.ts`, because they import
 * `markdown_docs.ts`, which spawns git and matches the completeness-check
 * `HEAVY_RE`; importing it here would silently drop this file from the
 * `check:manifests` family (Issue #1483).
 */

import { assertEquals } from "@std/assert";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Join a path segment onto `PROMPTS_DIR`-style absolute paths. */
const join = (...parts: string[]): string => parts.join("/");

/** Every prompt template, as `[promptName, fileName, text]`. */
async function allPrompts(): Promise<[string, string, string][]> {
  const out: [string, string, string][] = [];
  for await (const entry of Deno.readDir(PROMPTS_DIR)) {
    if (!entry.isDirectory) continue;
    const file = join(PROMPTS_DIR, entry.name, "prompt.md");
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch {
      continue; // a directory of buckets rather than a template
    }
    out.push([entry.name, "prompt.md", text]);
  }
  out.sort((a, b) => a[0].localeCompare(b[0]));
  return out;
}

/** Sentences mentioning an overflow tracker, with wrapping collapsed. */
function overflowSentences(text: string): string[] {
  const flat = text.replace(/\s+/g, " ");
  return [...flat.matchAll(/[^.;]*overflow tracker[^.;]*[.;]/g)]
    .map((m) => m[0].trim());
}

Deno.test("overflow tracker - every prohibition is scoped to its own scan (Issue #790)", async () => {
  const offenders: string[] = [];
  for (const [name, file, text] of await allPrompts()) {
    if (name === "security_scan") continue;
    for (const sentence of overflowSentences(text)) {
      // A prohibition must name whose runs it governs: "... for <scan> runs".
      if (!/ for [a-z0-9-]+(?: [a-z0-9-]+)* runs[.;,]?/i.test(sentence)) {
        offenders.push(`${name}/${file}: ${sentence}`);
      }
    }
  }
  assertEquals(
    offenders,
    [],
    "an unscoped overflow-tracker prohibition reads as a family-wide rule " +
      "that security_scan breaks:\n" + offenders.join("\n"),
  );
});
