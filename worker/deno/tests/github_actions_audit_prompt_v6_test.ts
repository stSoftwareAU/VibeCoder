/**
 * Tests for github_actions_audit prompt v6 (Issue #2357).
 *
 * v6 adds a new check covering **container / Docker images not pinned by
 * digest**. The existing pinning checks (#1, #13, #16) cover `uses:`
 * actions and reusable workflows, but not container images, which carry
 * the same mutable-tag supply-chain risk. v6 flags container images
 * referenced via:
 *
 *   - `uses: docker://…` Docker container actions
 *   - job-level `container: { image: … }`
 *   - service containers `services: { db: { image: … } }`
 *   - `FROM …` in a composite/Docker action's `Dockerfile` under
 *     `.github/actions/`
 *
 * pinned to a mutable tag (`:16`, `:latest`) rather than an immutable
 * `@sha256:` digest.
 *
 * Severity guidance (per the issue):
 *
 *   - `severity:medium` — mirrors the action-pinning hardening band.
 *   - `severity:high` — when the image runs with secrets under a
 *     privileged trigger.
 *
 * First-party `ghcr.io/stsoftwareau/*` images follow the same carve-out
 * as `stSoftwareAU/*` actions.
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
  "github_actions_audit prompt - latest version is v6 or later",
  async () => {
    const result = await getLatestVersion(
      "github_actions_audit",
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (result.ok) {
      const num = parseInt(result.value.replace("v", ""), 10);
      assertEquals(
        num >= 6,
        true,
        `Expected github_actions_audit prompt >= v6, got ${result.value}`,
      );
    }
  },
);

Deno.test(
  "github_actions_audit prompt v6 - loadPrompt resolves v6.md",
  async () => {
    const result = await loadPrompt("github_actions_audit", "v6", PROMPTS_DIR);
    assert(
      result.ok,
      `loadPrompt failed: ${result.ok ? "" : result.error.message}`,
    );
  },
);

Deno.test(
  "github_actions_audit prompt v6 - validatePromptTemplate passes (all required placeholders present)",
  async () => {
    const load = await loadPrompt("github_actions_audit", "v6", PROMPTS_DIR);
    assert(load.ok);
    if (!load.ok) return;
    const validate = validatePromptTemplate("github_actions_audit", load.value);
    assert(
      validate.ok,
      `validatePromptTemplate failed: ${
        validate.ok ? "" : validate.error.message
      }`,
    );
  },
);
