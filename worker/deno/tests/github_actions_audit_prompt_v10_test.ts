/**
 * Tests for github_actions_audit prompt v10 (Issue #2847).
 *
 * v10 extends the *privileged-trigger set* definition to include
 * `pull_request_review` and `pull_request_review_comment` — the gap the
 * Corgea checklist §3 identified (it lists `issue_comment`,
 * `pull_request_review`, and `pull_request_review_comment`). Both events
 * run with repo secrets + a write `GITHUB_TOKEN` and carry an
 * attacker-influenced review body (`github.event.review.body`), so the
 * privileged-trigger-keyed checks (#6, #10, #22, #26, #27, #28) now cover
 * them too.
 *
 * The load-bearing contracts are unchanged from v9: the `GitHub Actions
 * Audit` H1 fingerprint, the five `{{…}}` placeholders, every stable-id
 * recipe (generic `BP-<12 hex>` plus the prefix recipes), the
 * `github-actions-audit` / `severity:*` labels, the defensive
 * `gh label create` block, the `BP- in:body` dedup search, the 6-issue
 * cap, and the v9 broad-artefact-upload check #30.
 *
 * Also guards immutability of v9 (Issue #235 — prompt versions are
 * immutable once shipped): v9 must NOT name the two new triggers in its
 * privileged-trigger definition.
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
  "github_actions_audit prompt v10 - loadPrompt resolves v10.md",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v10", PROMPTS_DIR);
    assert(
      result.ok,
      `loadPrompt failed: ${result.ok ? "" : result.error.message}`,
    );
  },
);

Deno.test(
  "github_actions_audit prompt - latest version is v10 or later",
  async () => {
    const result = await getLatestVersion("github_actions_audit", PROMPTS_DIR);
    assert(result.ok);
    if (result.ok) {
      const num = parseInt(result.value.replace("v", ""), 10);
      assertEquals(
        num >= 10,
        true,
        `Expected github_actions_audit prompt >= v10, got ${result.value}`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v10 - validatePromptTemplate passes (all required placeholders present)",
  async () => {
    const load = await loadPrompt("github_actions_audit", "v10", PROMPTS_DIR);
    assert(load.ok);
    if (!load.ok) return;
    const v = validatePromptTemplate("github_actions_audit", load.value);
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "github_actions_audit prompt v10 - keeps the H1 body fingerprint",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v10", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      /^#+\s+GitHub Actions Audit\b/m.test(result.value),
      "v10 must keep the 'GitHub Actions Audit' H1 fingerprint",
    );
  },
);

Deno.test(
  "github_actions_audit prompt v10 - privileged-trigger set names pull_request_review and pull_request_review_comment",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v10", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const trigger of [
        // Pre-existing members must remain.
        "pull_request_target",
        "workflow_run",
        "issue_comment",
        "issues",
        "discussion",
        "discussion_comment",
        // The two new members added in Issue #2847.
        "pull_request_review",
        "pull_request_review_comment",
      ]
    ) {
      assert(
        body.includes(trigger),
        `v10 privileged-trigger set must name '${trigger}'`,
      );
    }
    // The review-body field tying the new triggers to the injection surface.
    assert(
      body.includes("github.event.review.body"),
      "v10 must cite the attacker-influenced review body field",
    );
  },
);

Deno.test(
  "github_actions_audit prompt v10 - retains the v9 broad-artefact-upload check #30",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v10", PROMPTS_DIR);
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
        `v10 must retain the broad-artefact-upload contract '${contract}'`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v10 - retains every stable-id recipe and label contract",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v10", PROMPTS_DIR);
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
        `v10 must retain the contract string '${contract}'`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v9 - immutable: privileged set omits the review triggers (Issue #235)",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v9", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // v9 predates Issue #2847 — its privileged-trigger definition must
    // remain unchanged and not name the two review events.
    assertEquals(
      result.value.includes("pull_request_review"),
      false,
      "v9 must NOT name pull_request_review (added in v10)",
    );
  },
);
