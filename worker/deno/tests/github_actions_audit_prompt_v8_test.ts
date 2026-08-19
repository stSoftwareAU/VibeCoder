/**
 * Tests for github_actions_audit prompt v8 (Issue #2624).
 *
 * v8 simplifies the prompt for Fable 5: the phase-gate scaffolding is
 * dropped, the *privileged-trigger set* (restated in seven checks in v7)
 * is defined once and referenced, the "group by root cause, not by
 * call-site" rule is stated once in Phase 2, the Phase 4 triple-negation
 * output-format rule is rephrased positively, and the detection stage is
 * made coverage-oriented (surface every candidate; rank and cap at
 * triage).
 *
 * The load-bearing contracts are unchanged: the `GitHub Actions Audit`
 * H1 fingerprint, the five `{{…}}` placeholders, every stable-id recipe
 * (generic `BP-<12 hex>` plus the six prefix recipes), the
 * `github-actions-audit` / `severity:*` labels, the defensive
 * `gh label create` block, the `BP- in:body` dedup search, and the
 * 6-issue cap.
 *
 * Also guards immutability of v7 (Issue #235 — prompt versions are
 * immutable once shipped).
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test(
  "github_actions_audit prompt v8 - loadPrompt resolves v8.md",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v8", PROMPTS_DIR);
    assert(
      result.ok,
      `loadPrompt failed: ${result.ok ? "" : result.error.message}`,
    );
  },
);

Deno.test(
  "github_actions_audit prompt - latest version is v8 or later",
  async () => {
    const result = await getLatestVersion("github_actions_audit", PROMPTS_DIR);
    assert(result.ok);
    if (result.ok) {
      const num = parseInt(result.value.replace("v", ""), 10);
      assertEquals(
        num >= 8,
        true,
        `Expected github_actions_audit prompt >= v8, got ${result.value}`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v8 - validatePromptTemplate passes (all required placeholders present)",
  async () => {
    const load = await loadPrompt("github_actions_audit", "v8", PROMPTS_DIR);
    assert(load.ok);
    if (!load.ok) return;
    const v = validatePromptTemplate("github_actions_audit", load.value);
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "github_actions_audit prompt v8 - keeps the H1 body fingerprint",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v8", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // The template routes wrapper issues by matching the prompt H1
    // against /^#+\s+GitHub Actions Audit\b/m — keep it intact.
    assert(
      /^#+\s+GitHub Actions Audit\b/m.test(result.value),
      "v8 must keep the 'GitHub Actions Audit' H1 fingerprint",
    );
  },
);

Deno.test(
  "github_actions_audit prompt v8 - retains every stable-id recipe and label contract",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v8", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        "BP-<12 hex>",
        '"github-actions-audit"', // id discriminator
        "BP-STALE-ACTION-<owner>-<action>",
        "BP-EOL-RUNTIME-<runtime>-<version>",
        "BP-OBSOLETE-STEP-<owner>-<action>",
        "BP-DUP-IN-FILE-<12 hex>",
        "BP-DUP-XFILE-<12 hex>",
        "BP-OBSOLETE-REF-<12 hex>",
        "<!-- finding-id:", // hidden dedup marker
        "BP- in:body", // live dedup search
        "gh label create github-actions-audit", // defensive label creation
        "severity:high|severity:medium|severity:low",
      ]
    ) {
      assert(
        body.includes(contract),
        `v8 must retain the contract string '${contract}'`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v8 - defines the privileged-trigger set once",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v8", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      result.value.includes("Privileged-trigger set"),
      "v8 must define the privileged-trigger set as a named concept",
    );
  },
);

Deno.test(
  "github_actions_audit prompt v7 - immutable: keeps the phase-gate sentence v8 drops (Issue #235)",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v7", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      result.value.includes("Verify your own output at each"),
      "v7 must remain the pre-simplification prompt",
    );
  },
);
