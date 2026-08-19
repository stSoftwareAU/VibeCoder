/**
 * Tests that the security-scan template's wrapper body (`buildIssueBody`)
 * substitutes the `{{ATTRIBUTION_FOOTER}}` placeholder so each filed
 * finding traces back to the run that produced it (Issue #2439).
 *
 * Mirrors the equivalent tests for `test-audit`, `best-practices`, and
 * `github-actions-audit` templates.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertStringIncludes } from "@std/assert";

import { createSecurityScanTemplate } from "../lib/idle_task_templates/security_scan_template.ts";
import type { Result } from "../types.ts";

const STUB_PROMPT = [
  "# MythOS-style Security Audit — Four-Phase Scan (v11)",
  "",
  "Suppressed:",
  "{{SUPPRESSED_IDS}}",
  "",
  "Known open:",
  "{{KNOWN_OPEN_FINDING_IDS}}",
  "",
  "Attribution footer line every filed body MUST end with:",
  "{{ATTRIBUTION_FOOTER}}",
].join("\n");

Deno.test(
  "security-scan - buildIssueBody substitutes {{ATTRIBUTION_FOOTER}} (Issue #2439)",
  async () => {
    const t = createSecurityScanTemplate({
      runSecurityScanFn: () =>
        Promise.resolve({ ok: true, value: { ok: true } }),
      ghCommandFn: () => Promise.resolve("[]"),
      loadPromptFn: () =>
        Promise.resolve({ ok: true, value: STUB_PROMPT } as Result<string>),
    });
    const body = await Promise.resolve(
      t.buildIssueBody({
        repo: "acme/widget",
        pickedAt: "2026-05-30T00:00:00Z",
        workerUser: "vibe",
      }),
    );
    // Placeholder fully consumed.
    assert(
      !body.includes("{{ATTRIBUTION_FOOTER}}"),
      "expected {{ATTRIBUTION_FOOTER}} to be substituted",
    );
    // Rendered footer names this template and carries a Run id field.
    assertStringIncludes(
      body,
      "🏷️ Filed by idle-task template: `security-scan`",
    );
    assertStringIncludes(body, "Run id:");
  },
);
