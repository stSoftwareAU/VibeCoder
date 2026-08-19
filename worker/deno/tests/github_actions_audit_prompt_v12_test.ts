/**
 * Tests for github_actions_audit prompt v12 (Issue #3360).
 *
 * v12 adds a single check on top of the v11 contract:
 *
 *   - **Milestone-branch CI-gate coverage** (check #33) — a CI quality
 *     workflow whose `pull_request` branch filter misses milestone feature
 *     branches (`milestone/<slug>`, Issue #1300), so milestone sub-issue
 *     PRs merge into the milestone branch without the gate running. The
 *     decidable single-filter core is pre-filed natively as
 *     `BP-MILESTONE-FILTER-<workflow-basename>`.
 *
 * The load-bearing v11 contracts are unchanged: the `GitHub Actions Audit`
 * H1 fingerprint, the five `{{…}}` placeholders, every stable-id recipe,
 * the `github-actions-audit` / `severity:*` labels, and the 6-issue cap.
 *
 * Also guards immutability of v11 (Issue #235 — prompt versions are
 * immutable once shipped): v11 must NOT carry the new milestone clause.
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
  "github_actions_audit prompt v12 - loadPrompt resolves v12.md",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v12", PROMPTS_DIR);
    assert(
      result.ok,
      `loadPrompt failed: ${result.ok ? "" : result.error.message}`,
    );
  },
);

Deno.test(
  "github_actions_audit prompt - latest version is v12 or later",
  async () => {
    const result = await getLatestVersion("github_actions_audit", PROMPTS_DIR);
    assert(result.ok);
    if (result.ok) {
      const num = parseInt(result.value.replace("v", ""), 10);
      assertEquals(
        num >= 12,
        true,
        `Expected github_actions_audit prompt >= v12, got ${result.value}`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v12 - validatePromptTemplate passes",
  async () => {
    const load = await loadPrompt("github_actions_audit", "v12", PROMPTS_DIR);
    assert(load.ok);
    if (!load.ok) return;
    const v = validatePromptTemplate("github_actions_audit", load.value);
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "github_actions_audit prompt v12 - keeps the H1 body fingerprint",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v12", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      /^#+\s+GitHub Actions Audit\b/m.test(result.value),
      "v12 must keep the 'GitHub Actions Audit' H1 fingerprint",
    );
  },
);

Deno.test(
  "github_actions_audit prompt v12 - milestone-branch CI-gate check",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v12", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        "CI quality workflow skips milestone PRs",
        "milestone/<name>",
        // The native pre-filer id for the decidable core.
        "BP-MILESTONE-FILTER-<workflow-basename>",
        "milestone_branch_filter_scanner.ts",
      ]
    ) {
      assert(
        body.includes(contract),
        `v12 milestone check must name '${contract}'`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v12 - retains v11 stable-id and label contracts",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v12", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        "BP-<12 hex>",
        '"github-actions-audit"',
        "BP-ARTIFACT-UPLOAD-<workflow-basename>-<job>-<step-index>",
        "BP-AI-INJECTION-<workflow-basename>-<job>-<step-index>",
        "<!-- finding-id:",
        "severity:high|severity:medium|severity:low",
      ]
    ) {
      assert(
        body.includes(contract),
        `v12 must retain the contract string '${contract}'`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v11 - immutable: no milestone clause (Issue #235)",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v11", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // v11 predates Issue #3360 — its body must not carry the milestone
    // CI-gate clause.
    for (
      const clause of [
        "CI quality workflow skips milestone PRs",
        "BP-MILESTONE-FILTER-",
      ]
    ) {
      assertEquals(
        result.value.includes(clause),
        false,
        `v11 must NOT contain '${clause}' (added in v12)`,
      );
    }
  },
);
