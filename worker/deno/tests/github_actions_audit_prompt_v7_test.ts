/**
 * Tests for github_actions_audit prompt v7 (Issue #2413).
 *
 * v7 adds four new check classes, mapped from the Wiz GitHub Actions
 * research and Wiz's SITF threat framework, on top of the v6 catalogue:
 *
 *   - #26 PWN-request (SITF T-C003), `severity:high` — a privileged
 *     trigger checks out the untrusted PR head AND builds/executes it
 *     with secrets in scope (the classic poisoned-pipeline RCE chain).
 *   - #27 Secret exfiltration (SITF T-C005/T-C015), `severity:high` —
 *     `toJson(secrets)` dumps and secrets echoed into logs / `run:`
 *     output / uploaded artifacts.
 *   - #28 Action cache poisoning (SITF T-C007), `severity:medium` — a
 *     cache write reachable from a fork / privileged trigger that a
 *     trusted run later consumes.
 *   - #29 AI coding-action hardening (Wiz Pt 2), `severity:high/medium`
 *     — verbosity/debug flags that leak secrets (`show_full_output`,
 *     `gemini_debug`) and over-broad input trust (bots/dependabot in the
 *     trusted zone, missing `allow-bot-users` scoping).
 *
 * All four use the generic `BP-<12 hex>` id recipe; cap/ordering and the
 * read-only / no-PR conventions are unchanged.
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
  "github_actions_audit prompt - latest version is v7 or later",
  async () => {
    const result = await getLatestVersion(
      "github_actions_audit",
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (result.ok) {
      const num = parseInt(result.value.replace("v", ""), 10);
      assertEquals(
        num >= 7,
        true,
        `Expected github_actions_audit prompt >= v7, got ${result.value}`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v7 - loadPrompt resolves v7.md",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v7", PROMPTS_DIR);
    assert(
      result.ok,
      `loadPrompt failed: ${result.ok ? "" : result.error.message}`,
    );
  },
);

Deno.test(
  "github_actions_audit prompt v7 - validatePromptTemplate passes (all required placeholders present)",
  async () => {
    const load = await loadPrompt("github_actions_audit", "v7", PROMPTS_DIR);
    assert(load.ok);
    if (!load.ok) return;
    const v = validatePromptTemplate("github_actions_audit", load.value);
    assertEquals(v.ok, true);
  },
);
