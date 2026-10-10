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
 * The scoping invariant loops over every prompt directory's `prompt.md` on
 * disk and reads each whole file, because it is an absence check (no
 * unscoped overflow-tracker prohibition anywhere in a template); the two
 * presence pins (security_scan's mandate, the six templates' own scoping)
 * are scoped to the section that holds each rule (CODING-STANDARDS.md §
 * Documentation-drift tests, condition 1; Issue #3309).
 */

import { assert, assertEquals } from "@std/assert";
import { section } from "./support/markdown_docs.ts";

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

Deno.test("overflow tracker - security_scan still mandates one (Issue #790)", async () => {
  const prompts = await allPrompts();
  const security = prompts.find(([name]) => name === "security_scan");
  assert(security, "security_scan template is missing");
  assert(
    section(
      security[2],
      "### For each surviving finding (skip silently if its id is in the suppressed or known-open list)",
    ).includes("security-scan-overflow"),
    "security_scan must keep the overflow tracker this issue scoped to it",
  );
});

Deno.test("overflow tracker - the six rescoped templates name their own scan (Issue #790)", async () => {
  // The "## Suggested fix" the prohibition sits beside is inside the fenced
  // issue-body template, so the heading section() sees is the per-finding step.
  const FOR_EACH =
    "### For each surviving finding (skip silently if its id is in the suppressed or known-open list)";
  const expected: Record<string, [scan: string, heading: string]> = {
    github_actions_audit: ["github-actions-audit", FOR_EACH],
    dead_code: ["dead-code", FOR_EACH],
    deprecated_api: ["deprecated-api", FOR_EACH],
    documentation_audit: ["documentation-audit", "## Phase 3 — Triage"],
    duplicated_knowledge: ["duplicated-knowledge", "## Phase 3 — Triage"],
    private_repo_reference_audit: [
      "private-repo-reference-audit",
      "## Phase 3 — Triage",
    ],
  };
  const prompts = await allPrompts();
  for (const [name, [scan, heading]] of Object.entries(expected)) {
    const found = prompts.find(([n]) => n === name);
    assert(found, `${name} template is missing`);
    const sentences = overflowSentences(section(found[2], heading));
    assert(
      sentences.length > 0,
      `${name}/${found[1]} no longer mentions an overflow tracker`,
    );
    assert(
      sentences.some((s) => s.includes(`for ${scan} runs`)),
      `${name}/${found[1]} must scope its prohibition to ${scan} runs, got:\n` +
        sentences.join("\n"),
    );
  }
});
