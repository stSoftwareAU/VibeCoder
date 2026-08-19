/**
 * Tests for github_actions_audit prompt v3 (Issue #2352).
 *
 * v3 generalises the previous `pull_request_target`-only checks (#6 and
 * #10) to a broader **privileged trigger** family that also covers
 * `workflow_run`, `issue_comment`, `issues`, `discussion`, and
 * `discussion_comment`. Each of these runs with write tokens and access
 * to repo secrets in a context an attacker can influence (PR-controlled
 * ref, comment body, completed-workflow head_branch, etc.), so the same
 * privilege-escalation rules must apply.
 *
 * Severity:
 * - `severity:high` for checkout/exec of an attacker-controllable ref
 *   or input under any privileged trigger.
 * - `severity:medium` for a missing justification comment on the
 *   trigger itself.
 *
 * Behavioural assertions only — these exercise the real
 * `loadPrompt` / `validatePromptTemplate` / `getLatestVersion` paths in
 * `prompt_manager.ts` rather than grepping the template by path.
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

Deno.test("github_actions_audit prompt - latest version is v3 or later", async () => {
  const result = await getLatestVersion("github_actions_audit", PROMPTS_DIR);
  assert(
    result.ok,
    `latest version lookup failed: ${result.ok ? "" : result.error.message}`,
  );
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 3,
      true,
      `Expected github_actions_audit prompt >= v3, got ${result.value}`,
    );
  }
});

Deno.test("github_actions_audit prompt v3 - loadPrompt resolves v3.md", async () => {
  const result = await loadPrompt("github_actions_audit", "v3", PROMPTS_DIR);
  assert(
    result.ok,
    `loadPrompt failed: ${result.ok ? "" : result.error.message}`,
  );
});

Deno.test(
  "github_actions_audit prompt v3 - validatePromptTemplate passes (all required placeholders present)",
  async () => {
    const load = await loadPrompt("github_actions_audit", "v3", PROMPTS_DIR);
    assert(load.ok);
    if (!load.ok) return;
    const validate = validatePromptTemplate("github_actions_audit", load.value);
    assertEquals(validate.ok, true);
  },
);
