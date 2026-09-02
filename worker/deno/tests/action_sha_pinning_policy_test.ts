/**
 * One SHA-pinning rule, and no "first-party" (Issue #787).
 *
 * Three surfaces disagreed about `uses: stSoftwareAU/foo@v1`:
 *
 *   - `github_actions_audit` — compliant, under a "first-party carve-out"
 *     letting `stSoftwareAU/*` actions pin to a tag;
 *   - `workflow_setup` — "no generated workflow may ship one";
 *   - `coding_guidelines` — pins every action to a SHA, no owner exception.
 *
 * And "first-party" named two disjoint sets: GitHub-owned `actions/*` in
 * `workflow_setup`, the organisation's own `stSoftwareAU/*` in the audit —
 * over exactly the set the rule gates, so a reader carrying one file's meaning
 * into the other inverts the verdict. The audit's own check 13 already
 * contradicted its carve-out: a cross-repo reusable workflow had to pin to a
 * SHA with no owner named.
 *
 * Settled: every `uses:` pins to a 40-character commit SHA whoever owns it;
 * only `ghcr.io/stsoftwareau/*` **container images** keep tag pinning; and the
 * term "first-party" is gone in favour of the explicit set names.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The families that state the pinning rule. */
const SUBJECTS = ["github_actions_audit", "workflow_setup"] as const;

/** The latest text of one family, collapsed for matching. */
async function latest(
  family: string,
): Promise<{ version: string; text: string; collapsed: string }> {
  const found = await getLatestVersion(family, PROMPTS_DIR);
  assertEquals(found.ok, true, `no latest version for ${family}`);
  if (!found.ok) throw new Error(found.error.message);
  const loaded = await loadPrompt(family, found.value, PROMPTS_DIR);
  assertEquals(loaded.ok, true);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return {
    version: found.value,
    text: loaded.value,
    collapsed: loaded.value.replace(/\s+/g, " "),
  };
}

Deno.test("action pinning - neither template says first-party any more (Issue #787)", async () => {
  // The term named two disjoint sets over exactly the rule it gated.
  for (const family of SUBJECTS) {
    const { version, text } = await latest(family);
    assertEquals(
      /first-party/i.test(text),
      false,
      `${family} ${version} still says "first-party", which means ` +
        `GitHub-owned actions/* in one template and stSoftwareAU/* in the other`,
    );
  }
});

Deno.test("action pinning - no owner is exempt from the SHA rule (Issue #787)", async () => {
  const audit = await latest("github_actions_audit");
  const setup = await latest("workflow_setup");

  // The audit no longer licenses a tag on an internal action …
  assertEquals(
    /`stSoftwareAU\/\*` actions and\s+`ghcr\.io\/stsoftwareau\/\*` images may pin to a tag/
      .test(audit.text.replace(/\s+/g, " ")),
    false,
    "the audit still carries the tag carve-out for stSoftwareAU/* actions",
  );
  assertStringIncludes(audit.collapsed, "no owner is exempt");
  // … and both templates say so in terms a reader cannot mistake.
  for (const { collapsed } of [audit, setup]) {
    assertStringIncludes(collapsed, "stSoftwareAU/*");
    assertStringIncludes(collapsed, "actions/*");
  }
  assertStringIncludes(setup.collapsed, "No owner is exempt");
});

Deno.test("action pinning - the image carve-out survives, and only for images (Issue #787)", async () => {
  // Tag-pinning an internal *image* is still permitted; the carve-out was
  // never wrong about images, only about `uses:` references.
  const { collapsed } = await latest("github_actions_audit");
  assertStringIncludes(collapsed, "**Container images** are the one carve-out");
  assertStringIncludes(collapsed, "`ghcr.io/stsoftwareau/*` images");
  assertStringIncludes(collapsed, "`@sha256:` digest");
});

Deno.test("action pinning - check 13 no longer contradicts the rule above it (Issue #787)", async () => {
  // A cross-repo reusable workflow at a tag hit two rules with opposite
  // verdicts; check 13 now names the absence of an owner exception.
  const { collapsed } = await latest("github_actions_audit");
  assertStringIncludes(collapsed, "Reusable workflows pinned by commit SHA");
  assertStringIncludes(
    collapsed,
    "an internal `stSoftwareAU/*` reusable workflow at a tag is flagged",
  );
});

Deno.test("action pinning - check 10 stays about authorship, not pinning (Issue #787)", async () => {
  // Its `actions/*`/`stSoftwareAU/*` set is about who wrote the code a
  // privileged trigger runs. Left as a set, it read as a pinning exemption.
  const { collapsed } = await latest("github_actions_audit");
  assertStringIncludes(
    collapsed,
    "this check is about *who wrote the code a privileged trigger runs*",
  );
});

Deno.test("action pinning - the guidelines already stated the rule and are untouched (Issue #787)", async () => {
  const { collapsed } = await latest("coding_guidelines");
  assertStringIncludes(collapsed, "Pin GitHub Actions to commit SHAs");
  assertEquals(
    /first-party/i.test(collapsed),
    false,
    "the guidelines never used the term and must not gain it",
  );
});

Deno.test("action pinning - the new audit version declares its own number (Issue #787)", async () => {
  // `github_actions_audit` carries its version in its H1, and v18 already
  // declared (v17) — the defect class #792 sweeps. The file this change adds
  // declares its own.
  const { version, text } = await latest("github_actions_audit");
  assertStringIncludes(text, `Workflow-Focused Review (${version})`);
});

Deno.test("action pinning - the retired versions stay immutable (Issue #787)", async () => {
  for (
    const [family, version] of [
      ["github_actions_audit", "v18"],
      ["workflow_setup", "v8"],
    ] as const
  ) {
    const result = await loadPrompt(family, version, PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (!result.ok) continue;
    assert(
      /first-party/i.test(result.value),
      `${family} ${version} used the term and must keep reading as it did`,
    );
  }
});
