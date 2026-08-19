/**
 * Tests for github_actions_audit prompt v9 (Issue #2846).
 *
 * v9 adds base check #30 — broad artefact uploads (`actions/upload-artifact`
 * with a whole-workspace `with.path`: `.`, `./`, `${{ github.workspace }}`,
 * `*`, `**`) — the gap the Corgea checklist §9 identified. The decidable
 * core is pre-filed by `artifact_upload_scanner.ts`; the prompt check owns
 * the judgement-heavy long tail.
 *
 * The load-bearing contracts are unchanged from v8: the `GitHub Actions
 * Audit` H1 fingerprint, the five `{{…}}` placeholders, every stable-id
 * recipe (generic `BP-<12 hex>` plus the prefix recipes), the
 * `github-actions-audit` / `severity:*` labels, the defensive
 * `gh label create` block, the `BP- in:body` dedup search, and the
 * 6-issue cap.
 *
 * Also guards immutability of v8 (Issue #235 — prompt versions are
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
  "github_actions_audit prompt v9 - loadPrompt resolves v9.md",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v9", PROMPTS_DIR);
    assert(
      result.ok,
      `loadPrompt failed: ${result.ok ? "" : result.error.message}`,
    );
  },
);

Deno.test(
  "github_actions_audit prompt - latest version is v9 or later",
  async () => {
    const result = await getLatestVersion("github_actions_audit", PROMPTS_DIR);
    assert(result.ok);
    if (result.ok) {
      const num = parseInt(result.value.replace("v", ""), 10);
      assertEquals(
        num >= 9,
        true,
        `Expected github_actions_audit prompt >= v9, got ${result.value}`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v9 - validatePromptTemplate passes (all required placeholders present)",
  async () => {
    const load = await loadPrompt("github_actions_audit", "v9", PROMPTS_DIR);
    assert(load.ok);
    if (!load.ok) return;
    const v = validatePromptTemplate("github_actions_audit", load.value);
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "github_actions_audit prompt v9 - keeps the H1 body fingerprint",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v9", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      /^#+\s+GitHub Actions Audit\b/m.test(result.value),
      "v9 must keep the 'GitHub Actions Audit' H1 fingerprint",
    );
  },
);

Deno.test(
  "github_actions_audit prompt v9 - adds the broad-artefact-upload check #30",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v9", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        "actions/upload-artifact",
        "BP-ARTIFACT-UPLOAD-<workflow-basename>-<job>-<step-index>",
        "${{ github.workspace }}",
      ]
    ) {
      assert(
        body.includes(contract),
        `v9 must mention the broad-artefact-upload contract '${contract}'`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v9 - retains every stable-id recipe and label contract",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v9", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        "BP-<12 hex>",
        '"github-actions-audit"',
        "BP-STALE-ACTION-<owner>-<action>",
        "BP-EOL-RUNTIME-<runtime>-<version>",
        "BP-OBSOLETE-STEP-<owner>-<action>",
        "BP-DUP-IN-FILE-<12 hex>",
        "BP-DUP-XFILE-<12 hex>",
        "BP-OBSOLETE-REF-<12 hex>",
        "<!-- finding-id:",
        "BP- in:body",
        "gh label create github-actions-audit",
        "severity:high|severity:medium|severity:low",
      ]
    ) {
      assert(
        body.includes(contract),
        `v9 must retain the contract string '${contract}'`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v8 - immutable: keeps its 29-check ceiling (Issue #235)",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v8", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // v8 predates check #30 — it must remain unchanged.
    assertEquals(
      result.value.includes(
        "BP-ARTIFACT-UPLOAD-<workflow-basename>-<job>-<step-index>",
      ),
      false,
      "v8 must NOT contain the v9-only broad-artefact-upload id recipe",
    );
  },
);
