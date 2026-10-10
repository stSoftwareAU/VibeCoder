/**
 * One hidden-file allowlist, stated in three places (Issue #784).
 *
 * The same named artefact — "the only hidden paths that may ever be
 * staged/tracked" — had three memberships:
 *
 *   - `gitignore_enforcer.ts` re-allowed **five** entries, and it is what
 *     actually writes every monitored repository's `.gitignore`;
 *   - `CODING-STANDARDS.md` listed four (no `.vscode/`);
 *   - `coding_guidelines` listed three (no `.vscode/`, no `.gitattributes`)
 *     **and** ended with a catch-all: "any other hidden file not on the
 *     allowlist above" is always forbidden.
 *
 * So the enforcer wrote `.gitattributes` into each repo as tracked-and-allowed
 * while the injected block told the agent staging it was always forbidden, and
 * `.vscode/` was re-allowed by the enforcer and named in neither document.
 *
 * The enforcer is ground truth and is not modified: dropping a re-allow would
 * change behaviour in every monitored repository. Both documents now restate
 * its list, and this test pins them to it — the membership is read out of
 * `REQUIRED_GITIGNORE_PATTERNS` at run time, so a sixth re-allow fails here
 * until both documents name it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { REQUIRED_GITIGNORE_PATTERNS } from "../lib/gitignore_enforcer.ts";
import {
  type DocSection,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const COMMIT_SAFETY_SECTION = "Commit Safety";

/** The hidden entries the enforcer re-allows, without the `!`. */
function reAllowedEntries(): string[] {
  return REQUIRED_GITIGNORE_PATTERNS
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
}

/**
 * The private-key class the enforcer ignores and both documents must state.
 *
 * None of these begins with a dot, so the hidden-file rule never covered them.
 */
const KEY_MATERIAL = [
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_rsa.*",
  "credentials.json",
  "service-account*.json",
] as const;

/** The `coding_guidelines` Commit Safety section the worker injects. */
async function guidelinesCommitSafety(): Promise<DocSection> {
  const text = await readRepoDoc("prompts/coding_guidelines/prompt.md");
  return section(text, COMMIT_SAFETY_SECTION);
}

/** `CODING-STANDARDS.md`'s Commit Safety section. */
async function standardsCommitSafety(): Promise<DocSection> {
  const text = await readRepoDoc("CODING-STANDARDS.md");
  return section(text, COMMIT_SAFETY_SECTION);
}

Deno.test("hidden allowlist - the enforcer re-allows exactly the five documented entries (Issue #784)", () => {
  // Pinned so a sixth re-allow is a deliberate act that fails this test until
  // both documents are updated with it, rather than silent drift.
  assertEquals(reAllowedEntries(), [
    ".gitignore",
    ".github",
    ".vscode",
    ".markdownlint-cli2.jsonc",
    ".gitattributes",
  ]);
});

Deno.test("hidden allowlist - the guidelines state every entry the enforcer re-allows (Issue #784)", async () => {
  const collapsed = flat(await guidelinesCommitSafety());
  for (const entry of reAllowedEntries()) {
    assert(
      collapsed.includes(`\`${entry}\``) ||
        collapsed.includes(`\`${entry}/\``),
      `coding_guidelines omits \`${entry}\`, which the enforcer ` +
        `re-allows — an agent reading it would treat a tracked-and-allowed ` +
        `path as always forbidden`,
    );
  }
});

Deno.test("hidden allowlist - CODING-STANDARDS states every entry the enforcer re-allows (Issue #784)", async () => {
  const collapsed = flat(await standardsCommitSafety());
  for (const entry of reAllowedEntries()) {
    assert(
      collapsed.includes(`\`${entry}\``) ||
        collapsed.includes(`\`${entry}/\``),
      `CODING-STANDARDS.md omits \`${entry}\`, which the enforcer re-allows`,
    );
  }
});

Deno.test("hidden allowlist - both surfaces state the private-key class (Issue #784)", async () => {
  // The guidelines had no counterpart for this at all, so an agent running on
  // the injected block alone had no rule against staging a `.pem`.
  const guidelines = flat(await guidelinesCommitSafety());
  const standards = flat(await standardsCommitSafety());
  for (const pattern of KEY_MATERIAL) {
    assertStringIncludes(
      guidelines,
      `\`${pattern}\``,
      `coding_guidelines omits ${pattern}`,
    );
    assertStringIncludes(standards, `\`${pattern}\``);
    // …and the enforcer ignores it, which is why the documents say so.
    assert(
      REQUIRED_GITIGNORE_PATTERNS.includes(pattern),
      `${pattern} is documented as forbidden but the enforcer does not ignore it`,
    );
  }
});

Deno.test("hidden allowlist - both surfaces name the enforcer as the source (Issue #784)", async () => {
  // The lists are restatements. Saying so is what stops the next reader
  // treating a document as the definition and editing it on its own.
  assertStringIncludes(
    flat(await guidelinesCommitSafety()),
    "REQUIRED_GITIGNORE_PATTERNS",
  );
  assertStringIncludes(
    flat(await standardsCommitSafety()),
    "REQUIRED_GITIGNORE_PATTERNS",
  );
});
