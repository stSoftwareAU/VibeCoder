/**
 * Section-scoped presence pins for the security-scan-only overflow tracker
 * (Issue #790), split out of `overflow_tracker_scope_test.ts` and scoped to
 * the section that holds each rule per Issue #3309 (CODING-STANDARDS.md §
 * Documentation-drift tests, condition 1).
 *
 * `security_scan` mandates rolling surplus findings into a
 * `security-scan-overflow` tracker; six sibling scan templates each scope their
 * prohibition to their own runs. These tests pin both halves within the
 * section of each template where the rule lives.
 *
 * This file imports `markdown_docs.ts`, which spawns git and so matches the
 * completeness-check `HEAVY_RE`. That is why these pins live here rather than
 * in `overflow_tracker_scope_test.ts`: importing it there would silently drop
 * that file, which enumerates the prompt tree, from the `check:manifests`
 * completeness family (Issue #1483).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

/** The template file read for each prompt directory. */
const file = "prompt.md";

/**
 * Sentences mentioning an overflow tracker in already-flattened text. Mirrors
 * the helper of the same name in overflow_tracker_scope_test.ts, differing only
 * in taking pre-flattened text.
 */
function overflowSentences(flattened: string): string[] {
  return [...flattened.matchAll(/[^.;]*overflow tracker[^.;]*[.;]/g)]
    .map((m) => m[0].trim());
}

Deno.test("overflow tracker - security_scan still mandates one (Issue #790)", async () => {
  const security = await readRepoDoc("prompts/security_scan/prompt.md");
  assert(security, "security_scan template is missing");
  assert(
    section(
      security,
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
  for (const [name, [scan, heading]] of Object.entries(expected)) {
    const text = await readRepoDoc(`prompts/${name}/prompt.md`);
    assert(text, `${name} template is missing`);
    const sentences = overflowSentences(flat(section(text, heading)));
    assert(
      sentences.length > 0,
      `${name}/${file} no longer mentions an overflow tracker`,
    );
    assert(
      sentences.some((s) => s.includes(`for ${scan} runs`)),
      `${name}/${file} must scope its prohibition to ${scan} runs, got:\n` +
        sentences.join("\n"),
    );
  }
});
