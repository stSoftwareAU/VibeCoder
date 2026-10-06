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
 * Positive pins are section-scoped (CODING-STANDARDS.md § Documentation-drift
 * tests, condition 1), so a rule that moves to another heading fails loudly
 * rather than passing by matching the whole file; the "first-party" absence
 * checks and the tag carve-out regex deliberately read the whole file, since
 * an absence check must not be narrowed to one section.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  flat,
  flatWholeFile,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

/** The families that state the pinning rule. */
const SUBJECTS = ["github_actions_audit", "workflow_setup"] as const;

/** The audit's definitions section, where the carve-out and owner set live. */
const AUDIT_DEFINITIONS = {
  doc: "prompts/github_actions_audit/prompt.md",
  title: "Definitions",
} as const;

/** The audit's supply-chain checks, where checks 10 and 13 live. */
const AUDIT_SUPPLY_CHAIN = {
  doc: "prompts/github_actions_audit/prompt.md",
  title: "Supply-chain hardening",
} as const;

/** `workflow_setup`'s CI hardening defaults, where the owner set is restated. */
const SETUP_HARDENING = {
  doc: "prompts/workflow_setup/prompt.md",
  title: "CI Hardening Defaults",
} as const;

/** The guidelines' dependency/supply-chain section, where the SHA rule lives. */
const GUIDELINES_SUPPLY_CHAIN = {
  doc: "prompts/coding_guidelines/prompt.md",
  title: "Dependency Bumps and Supply Chain",
} as const;

/** One surface's section, flattened so wrapped prose still matches. */
async function scoped(doc: string, title: string): Promise<string> {
  return flat(section(await readRepoDoc(doc), title));
}

Deno.test("action pinning - neither template says first-party any more (Issue #787)", async () => {
  // The term named two disjoint sets over exactly the rule it gated. This is
  // an absence check, so it deliberately reads the whole file.
  for (const family of SUBJECTS) {
    const text = await readRepoDoc(`prompts/${family}/prompt.md`);
    assertEquals(
      /first-party/i.test(text),
      false,
      `${family} still says "first-party", which means ` +
        `GitHub-owned actions/* in one template and stSoftwareAU/* in the other`,
    );
  }
});

Deno.test("action pinning - no owner is exempt from the SHA rule (Issue #787)", async () => {
  const auditText = await readRepoDoc(AUDIT_DEFINITIONS.doc);
  const audit = {
    text: auditText,
    collapsed: flat(section(auditText, AUDIT_DEFINITIONS.title)),
  };
  const setup = {
    collapsed: await scoped(SETUP_HARDENING.doc, SETUP_HARDENING.title),
  };

  // The audit no longer licenses a tag on an internal action — an absence
  // check, so it deliberately reads the whole file.
  assertEquals(
    /`stSoftwareAU\/\*` actions and\s+`ghcr\.io\/stsoftwareau\/\*` images may pin to a tag/
      .test(flatWholeFile(audit.text)),
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
  const collapsed = await scoped(
    AUDIT_DEFINITIONS.doc,
    AUDIT_DEFINITIONS.title,
  );
  assertStringIncludes(collapsed, "**Container images** are the one carve-out");
  assertStringIncludes(collapsed, "`ghcr.io/stsoftwareau/*` images");
  assertStringIncludes(collapsed, "`@sha256:` digest");
});

Deno.test("action pinning - check 13 no longer contradicts the rule above it (Issue #787)", async () => {
  // A cross-repo reusable workflow at a tag hit two rules with opposite
  // verdicts; check 13 now names the absence of an owner exception.
  const collapsed = await scoped(
    AUDIT_SUPPLY_CHAIN.doc,
    AUDIT_SUPPLY_CHAIN.title,
  );
  assertStringIncludes(collapsed, "Reusable workflows pinned by commit SHA");
  assertStringIncludes(
    collapsed,
    "an internal `stSoftwareAU/*` reusable workflow at a tag is flagged",
  );
});

Deno.test("action pinning - check 10 stays about authorship, not pinning (Issue #787)", async () => {
  // Its `actions/*`/`stSoftwareAU/*` set is about who wrote the code a
  // privileged trigger runs. Left as a set, it read as a pinning exemption.
  const collapsed = await scoped(
    AUDIT_SUPPLY_CHAIN.doc,
    AUDIT_SUPPLY_CHAIN.title,
  );
  assertStringIncludes(
    collapsed,
    "this check is about *who wrote the code a privileged trigger runs*",
  );
});

Deno.test("action pinning - the guidelines already stated the rule and are untouched (Issue #787)", async () => {
  const text = await readRepoDoc(GUIDELINES_SUPPLY_CHAIN.doc);
  const collapsed = flat(section(text, GUIDELINES_SUPPLY_CHAIN.title));
  assertStringIncludes(collapsed, "Pin GitHub Actions to commit SHAs");
  // An absence check, so it deliberately reads the whole file.
  assertEquals(
    /first-party/i.test(text),
    false,
    "the guidelines never used the term and must not gain it",
  );
});
