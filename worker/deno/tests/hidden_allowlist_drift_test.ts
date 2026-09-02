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
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const PROMPTS_DIR = `${REPO_ROOT}prompts`;

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

/** The latest `coding_guidelines` text, and the version it came from. */
async function latestGuidelines(): Promise<{ version: string; text: string }> {
  const latest = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (!latest.ok) throw new Error(latest.error.message);
  const loaded = await loadPrompt(
    "coding_guidelines",
    latest.value,
    PROMPTS_DIR,
  );
  assertEquals(loaded.ok, true);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return { version: latest.value, text: loaded.value };
}

/** `CODING-STANDARDS.md`, as one collapsed line so wrapping cannot hide a term. */
async function standardsText(): Promise<string> {
  const text = await Deno.readTextFile(`${REPO_ROOT}CODING-STANDARDS.md`);
  return text.replace(/\s+/g, " ");
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
  const { version, text } = await latestGuidelines();
  const collapsed = text.replace(/\s+/g, " ");
  for (const entry of reAllowedEntries()) {
    assert(
      collapsed.includes(`\`${entry}\``) ||
        collapsed.includes(`\`${entry}/\``),
      `coding_guidelines ${version} omits \`${entry}\`, which the enforcer ` +
        `re-allows — an agent reading it would treat a tracked-and-allowed ` +
        `path as always forbidden`,
    );
  }
});

Deno.test("hidden allowlist - CODING-STANDARDS states every entry the enforcer re-allows (Issue #784)", async () => {
  const collapsed = await standardsText();
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
  const { version, text } = await latestGuidelines();
  const guidelines = text.replace(/\s+/g, " ");
  const standards = await standardsText();
  for (const pattern of KEY_MATERIAL) {
    assertStringIncludes(
      guidelines,
      `\`${pattern}\``,
      `coding_guidelines ${version} omits ${pattern}`,
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
  const { text } = await latestGuidelines();
  assertStringIncludes(text, "REQUIRED_GITIGNORE_PATTERNS");
  assertStringIncludes(await standardsText(), "REQUIRED_GITIGNORE_PATTERNS");
});

Deno.test("hidden allowlist - the retired guidelines version stays immutable (Issue #784)", async () => {
  const result = await loadPrompt("coding_guidelines", "v44", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.includes("REQUIRED_GITIGNORE_PATTERNS"),
    false,
    "v44 predates the alignment and must keep reading as it did",
  );
});
