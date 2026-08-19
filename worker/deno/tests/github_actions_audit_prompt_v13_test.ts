/**
 * Tests for github_actions_audit prompt v13 (Issue #3460).
 *
 * v13 closes the deprecated-runtime gap on top of the v12 contract:
 *
 *   - **New check #34 — SHA-pinned action on a deprecated Actions
 *     runtime.** A SHA-pinned action whose resolved `runs.using` runner
 *     is a deprecated Actions runtime (`node12`, `node16`, `node20`; the
 *     list is maintained in the prompt itself) slips through the v12
 *     catalogue: #16 skips SHA pins, #17 reads only declared
 *     `node-version:` inputs, #18 only catches catalogue-flagged actions.
 *     The motivating case is SHA-pinned `actions/checkout` v4.2.2 and
 *     `actions/setup-node` on the deprecated node20 runtime
 *     (FLEET-GTC#220 / PR #222). New stable-id prefix
 *     `BP-DEPRECATED-RUNTIME-<owner>-<action>`.
 *   - **Extended check #16 — SHA pins no longer exempt from stale-major.**
 *     v12 skipped SHA-pinned actions in the stale-major check; v13 maps
 *     the pin to its major (via the trailing version comment or the
 *     catalogue) and flags when that major is behind the latest.
 *
 * The load-bearing v12 contracts are unchanged: the `GitHub Actions
 * Audit` H1 fingerprint, the five `{{…}}` placeholders, every prior
 * stable-id recipe, the `github-actions-audit` / `severity:*` labels, and
 * the 6-issue cap.
 *
 * Also guards immutability of v12 (Issue #235 — prompt versions are
 * immutable once shipped): v12 must NOT carry the new deprecated-runtime
 * clause.
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
  "github_actions_audit prompt v13 - loadPrompt resolves v13.md",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v13", PROMPTS_DIR);
    assert(
      result.ok,
      `loadPrompt failed: ${result.ok ? "" : result.error.message}`,
    );
  },
);

Deno.test(
  "github_actions_audit prompt - latest version is v13 or later",
  async () => {
    const result = await getLatestVersion("github_actions_audit", PROMPTS_DIR);
    assert(result.ok);
    if (result.ok) {
      const num = parseInt(result.value.replace("v", ""), 10);
      assertEquals(
        num >= 13,
        true,
        `Expected github_actions_audit prompt >= v13, got ${result.value}`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v13 - validatePromptTemplate passes",
  async () => {
    const load = await loadPrompt("github_actions_audit", "v13", PROMPTS_DIR);
    assert(load.ok);
    if (!load.ok) return;
    const v = validatePromptTemplate("github_actions_audit", load.value);
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "github_actions_audit prompt v13 - keeps the H1 body fingerprint",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v13", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      /^#+\s+GitHub Actions Audit\b/m.test(result.value),
      "v13 must keep the 'GitHub Actions Audit' H1 fingerprint",
    );
  },
);

Deno.test(
  "github_actions_audit prompt v13 - deprecated-runtime check (#34)",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v13", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        // Check title / signal.
        "SHA-pinned action on a deprecated Actions runtime",
        "runs.using",
        // The maintained deprecated-runtime list lives in the prompt.
        "node12",
        "node16",
        "node20",
        // New specific-prefix stable id.
        "BP-DEPRECATED-RUNTIME-<owner>-<action>",
        // Supply-chain policy must be preserved by any downstream fix.
        "24h quarantine",
        // Must not double-file against the CI-annotation pre-filer.
        "runner_deprecation_scanner.ts",
        "BP-RUNNER-<action-slug>-<runtime>",
      ]
    ) {
      assert(
        body.includes(contract),
        `v13 deprecated-runtime check must name '${contract}'`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v13 - stale-major check now covers SHA pins",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v13", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    // v12 exempted SHA pins from the stale-major check; v13 removes that
    // exemption and maps the pin to its major instead.
    assertEquals(
      body.includes("Skip actions already pinned to a commit SHA"),
      false,
      "v13 must drop the v12 'Skip actions already pinned to a commit SHA' " +
        "exemption from check #16",
    );
    assert(
      body.includes("map the pin to its major"),
      "v13 must extend #16 to map a SHA pin to its major",
    );
  },
);

Deno.test(
  "github_actions_audit prompt v13 - registers #34 in the stable-id recipe",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v13", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      result.value.includes(
        "BP-DEPRECATED-RUNTIME-<owner>-<action>` (check #34)",
      ),
      "v13 must list the #34 stable-id in the specific-prefix recipe block",
    );
  },
);

Deno.test(
  "github_actions_audit prompt v13 - retains v12 stable-id and label contracts",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v13", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        "BP-<12 hex>",
        '"github-actions-audit"',
        "BP-ARTIFACT-UPLOAD-<workflow-basename>-<job>-<step-index>",
        "BP-AI-INJECTION-<workflow-basename>-<job>-<step-index>",
        "BP-EOL-RUNTIME-<runtime>-<version>",
        "BP-STALE-ACTION-<owner>-<action>",
        // v12's milestone check survives.
        "CI quality workflow skips milestone PRs",
        "BP-MILESTONE-FILTER-<workflow-basename>",
        "<!-- finding-id:",
        "severity:high|severity:medium|severity:low",
      ]
    ) {
      assert(
        body.includes(contract),
        `v13 must retain the contract string '${contract}'`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v12 - immutable: no deprecated-runtime clause (Issue #235)",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v12", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // v12 predates Issue #3460 — its body must not carry the new
    // deprecated-runtime check or its stable-id prefix.
    for (
      const clause of [
        "SHA-pinned action on a deprecated Actions runtime",
        "BP-DEPRECATED-RUNTIME-",
      ]
    ) {
      assertEquals(
        result.value.includes(clause),
        false,
        `v12 must NOT contain '${clause}' (added in v13)`,
      );
    }
  },
);
