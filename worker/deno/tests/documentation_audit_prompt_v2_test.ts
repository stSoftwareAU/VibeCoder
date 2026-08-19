/**
 * Tests for documentation_audit prompt v2 (Issue #3414).
 *
 * v2 extends the prose-documentation audit with a ninth Phase 2 check —
 * **multiple / redundant agent instruction files**. Where v1's check #5
 * flagged a *single* agent file that merely repeats the README, v2 adds a
 * distinct concern: two or more substantive agent instruction files
 * (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, near-miss variants like
 * `AGENT.md`) coexisting in one repo is itself redundancy. The finding
 * recommends consolidating towards a single set of instructions shared by
 * humans and agents, with the hierarchy: README/human docs first,
 * provider-specific files deleted, at most one thin `AGENTS.md` pointer.
 *
 * The load-bearing worker contracts are unchanged: the `Documentation
 * Audit` H1 body fingerprint, the `{{SUPPRESSED_IDS}}` /
 * `{{KNOWN_OPEN_FINDING_IDS}}` / `{{ATTRIBUTION_FOOTER}}` placeholders,
 * the `BP-<12 hex>` id recipe with the `"documentation-audit"`
 * discriminator, the `documentation-audit` / `severity:*` labels, the
 * `BP- in:body` dedup search, the hidden `<!-- finding-id:` marker, and
 * the 6-issue cap.
 *
 * Also guards immutability of v1 (Issue #235 — prompt versions are
 * immutable once shipped): v1 must NOT carry the v2 nine-check content.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import { DOCUMENTATION_AUDIT_BODY_FINGERPRINT } from "../lib/idle_task_templates/documentation_audit_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("documentation_audit prompt v2 - loads via loadPrompt", async () => {
  const result = await loadPrompt("documentation_audit", "v2", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test(
  "documentation_audit prompt v2 - latest version is v2 or later",
  async () => {
    const result = await getLatestVersion("documentation_audit", PROMPTS_DIR);
    assert(result.ok);
    if (result.ok) {
      const num = parseInt(result.value.replace("v", ""), 10);
      assertEquals(
        num >= 2,
        true,
        `Expected documentation_audit prompt >= v2, got ${result.value}`,
      );
    }
  },
);

Deno.test(
  "documentation_audit prompt v2 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("documentation_audit", "v2", PROMPTS_DIR);
    assert(result.ok);
    const v = validatePromptTemplate(
      "documentation_audit",
      result.ok ? result.value : "",
    );
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "documentation_audit prompt v2 - keeps the Documentation Audit H1 body fingerprint",
  async () => {
    const result = await loadPrompt("documentation_audit", "v2", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // Dispatch routes wrapper issues by matching the prompt's H1 against
    // DOCUMENTATION_AUDIT_BODY_FINGERPRINT — the heading must remain
    // intact so no template / dispatch change is required.
    assert(
      DOCUMENTATION_AUDIT_BODY_FINGERPRINT.test(result.value),
      "v2 must keep the 'Documentation Audit' H1 fingerprint",
    );
  },
);

Deno.test(
  "documentation_audit prompt v2 - keeps the three worker placeholders",
  async () => {
    const result = await loadPrompt("documentation_audit", "v2", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    for (
      const placeholder of [
        "{{SUPPRESSED_IDS}}",
        "{{KNOWN_OPEN_FINDING_IDS}}",
        "{{ATTRIBUTION_FOOTER}}",
      ]
    ) {
      assert(
        result.value.includes(placeholder),
        `v2 must keep the ${placeholder} placeholder`,
      );
    }
  },
);

Deno.test(
  "documentation_audit prompt v2 - adds the multiple-agent-files (check 9) detection",
  async () => {
    const result = await loadPrompt("documentation_audit", "v2", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const phrase of [
        "nine-check", // catalogue grew from eight to nine
        "Multiple", // the new concern names multiplicity
        "AGENTS.md", // the generic agent file that may remain
        "CLAUDE.md", // a provider-specific file to delete
        "provider-specific", // no justification for provider variants
        "pointer", // AGENTS.md may remain only as a thin pointer
      ]
    ) {
      assert(
        body.includes(phrase),
        `v2 must mention multiple-agent-file content: '${phrase}'`,
      );
    }
  },
);

Deno.test(
  "documentation_audit prompt v2 - retains the load-bearing worker contracts",
  async () => {
    const result = await loadPrompt("documentation_audit", "v2", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        "BP-<12 hex>", // stable id recipe
        '"documentation-audit"', // id discriminator
        "<!-- finding-id:", // hidden dedup marker
        "BP- in:body", // live dedup search
        "--label documentation-audit", // dedup search scope
        "best-practice-ignore", // suppression grammar
        "suppression_comments.ts", // worker grammar reference
        "severity:high|severity:medium|severity:low",
      ]
    ) {
      assert(
        body.includes(contract),
        `v2 must retain the contract string '${contract}'`,
      );
    }
  },
);

Deno.test(
  "documentation_audit prompt v1 - immutable: does NOT carry the v2 nine-check content (Issue #235)",
  async () => {
    const result = await loadPrompt("documentation_audit", "v1", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      !result.value.includes("nine-check"),
      "v1 must remain the pre-nine-check prompt",
    );
  },
);
