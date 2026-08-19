/**
 * Tests for github_actions_audit prompt v11 (Issue #3313, parent #3309).
 *
 * v11 closes the GitLost-style agentic prompt-injection gap end-to-end in
 * scanned repos, adding three clauses on top of the v10 contract:
 *
 *   1. **AI-action prompt-injection sink** (check #31) — untrusted
 *      `github.event.*` reaching an AI coding-agent action's `prompt:` /
 *      `with.args`, not just a `run:` shell. The explicit-`with:` core is
 *      pre-filed natively as `BP-AI-INJECTION-…`.
 *   2. **Agentic-workflow LLM-usage clause** — an agent-only workflow is
 *      an LLM surface for the OWASP **LLM01:2025** prompt-injection class,
 *      so LLM01 is no longer skipped for agent-only repos.
 *   3. **End-to-end GitLost chain + public-comment exfil** (check #32) —
 *      a single correlated finding when a privileged trigger + agent step
 *      + untrusted text + public-write token co-occur, plus the
 *      public-comment exfil sink check.
 *
 * The load-bearing v10 contracts are unchanged: the `GitHub Actions
 * Audit` H1 fingerprint, the five `{{…}}` placeholders, every stable-id
 * recipe, the `github-actions-audit` / `severity:*` labels, the defensive
 * `gh label create` block, the `BP- in:body` dedup search, and the
 * 6-issue cap.
 *
 * Also guards immutability of v10 (Issue #235 — prompt versions are
 * immutable once shipped): v10 must NOT carry the new GitLost clauses.
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
  "github_actions_audit prompt v11 - loadPrompt resolves v11.md",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v11", PROMPTS_DIR);
    assert(
      result.ok,
      `loadPrompt failed: ${result.ok ? "" : result.error.message}`,
    );
  },
);

Deno.test(
  "github_actions_audit prompt - latest version is v11 or later",
  async () => {
    const result = await getLatestVersion("github_actions_audit", PROMPTS_DIR);
    assert(result.ok);
    if (result.ok) {
      const num = parseInt(result.value.replace("v", ""), 10);
      assertEquals(
        num >= 11,
        true,
        `Expected github_actions_audit prompt >= v11, got ${result.value}`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v11 - validatePromptTemplate passes (all required placeholders present)",
  async () => {
    const load = await loadPrompt("github_actions_audit", "v11", PROMPTS_DIR);
    assert(load.ok);
    if (!load.ok) return;
    const v = validatePromptTemplate("github_actions_audit", load.value);
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "github_actions_audit prompt v11 - keeps the H1 body fingerprint",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v11", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      /^#+\s+GitHub Actions Audit\b/m.test(result.value),
      "v11 must keep the 'GitHub Actions Audit' H1 fingerprint",
    );
  },
);

Deno.test(
  "github_actions_audit prompt v11 - GitLost clause 1: AI-action prompt-injection sink",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v11", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        // The sink is the agent prompt inputs, not just `run:`.
        "with.args",
        "anthropics/claude-code-action",
        // The native pre-filer id for the decidable core.
        "BP-AI-INJECTION-<workflow-basename>-<job>-<step-index>",
      ]
    ) {
      assert(
        body.includes(contract),
        `v11 GitLost clause 1 must name '${contract}'`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v11 - GitLost clause 2: agentic-workflow LLM-usage",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v11", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        "Agentic workflow is an LLM surface",
        "LLM01:2025",
      ]
    ) {
      assert(
        body.includes(contract),
        `v11 GitLost clause 2 must name '${contract}'`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v11 - GitLost clause 3: end-to-end chain + public-comment exfil",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v11", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        "End-to-end GitLost chain",
        "Public-comment exfil sink",
        "public-write token",
      ]
    ) {
      assert(
        body.includes(contract),
        `v11 GitLost clause 3 must name '${contract}'`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v11 - retains every stable-id recipe and label contract",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v11", PROMPTS_DIR);
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
        "BP-ARTIFACT-UPLOAD-<workflow-basename>-<job>-<step-index>",
        "<!-- finding-id:",
        "BP- in:body",
        "gh label create github-actions-audit",
        "severity:high|severity:medium|severity:low",
      ]
    ) {
      assert(
        body.includes(contract),
        `v11 must retain the contract string '${contract}'`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v10 - immutable: no GitLost agentic clauses (Issue #235)",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v10", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // v10 predates Issue #3313 — its body must not carry the new
    // agentic-injection clauses.
    for (
      const clause of [
        "BP-AI-INJECTION-",
        "End-to-end GitLost chain",
        "Agentic workflow is an LLM surface",
      ]
    ) {
      assertEquals(
        result.value.includes(clause),
        false,
        `v10 must NOT contain '${clause}' (added in v11)`,
      );
    }
  },
);
