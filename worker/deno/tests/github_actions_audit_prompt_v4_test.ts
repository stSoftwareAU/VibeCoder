/**
 * Tests for github_actions_audit prompt v4 (Issue #2351).
 *
 * v4 adds a new check covering **self-hosted runners reachable from
 * untrusted code**. GitHub explicitly warns against using self-hosted
 * runners with public repos: forked PRs can run arbitrary code on the
 * runner, and self-hosted runners are not ephemeral by default, so a
 * malicious job can persist tooling, harvest other jobs' tokens or
 * secrets, and pivot into the network.
 *
 * The dangerous shape is a workflow that:
 *
 *   - declares `runs-on:` resolving to a self-hosted runner (the
 *     `self-hosted` label, or any non-GitHub-hosted label/group), AND
 *   - is reachable from untrusted code — `pull_request` (without a fork
 *     guard), `pull_request_target`, `workflow_run`, or `issue_comment`
 *     / `issues` / `discussion` / `discussion_comment` triggers.
 *
 * Severity guidance (per the issue):
 *
 *   - `severity:high` when reachable from fork/untrusted triggers.
 *   - `severity:medium` for self-hosted on `push`/`schedule` only
 *     (ephemerality + least-privilege hygiene).
 *
 * Stable id: generic `BP-<12 hex>` recipe.
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

Deno.test(
  "github_actions_audit prompt - latest version is v4 or later",
  async () => {
    const result = await getLatestVersion(
      "github_actions_audit",
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (result.ok) {
      const num = parseInt(result.value.replace("v", ""), 10);
      assertEquals(
        num >= 4,
        true,
        `Expected github_actions_audit prompt >= v4, got ${result.value}`,
      );
    }
  },
);

Deno.test("github_actions_audit prompt v4 - loadPrompt resolves v4.md", async () => {
  const result = await loadPrompt("github_actions_audit", "v4", PROMPTS_DIR);
  assert(
    result.ok,
    `loadPrompt failed: ${result.ok ? "" : result.error.message}`,
  );
});

Deno.test(
  "github_actions_audit prompt v4 - validatePromptTemplate passes (placeholder contract)",
  async () => {
    const load = await loadPrompt("github_actions_audit", "v4", PROMPTS_DIR);
    assert(load.ok);
    if (!load.ok) return;
    const v = validatePromptTemplate("github_actions_audit", load.value);
    assertEquals(v.ok, true);
  },
);
