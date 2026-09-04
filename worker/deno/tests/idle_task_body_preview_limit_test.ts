/**
 * Quality gate: every idle-task wrapper preview must fit GitHub's issue-body
 * limit *without* being clamped (Issue #3863).
 *
 * Before this gate existed, an over-long preview only surfaced as a single
 * `action=truncated_body` line in the seeder log: `security_scan` v30 built a
 * 100,961-character body, so 35,946 characters were dropped from every seeded
 * wrapper. The clamp (`clampIdleTaskBody`, Issue #3634) is the backstop that
 * keeps the sweep alive; this suite is the gate that stops a prompt bump from
 * ever reaching it.
 *
 * Covers:
 *   - every registered template's preview body fits the budget unclamped;
 *   - the seeded wrapper body (preview + attribution) survives the clamp
 *     untruncated;
 *   - a condensed preview keeps its fingerprint heading and dispatches;
 *   - a condensed preview links the exact `prompts/<name>/vN.md` at a
 *     40-character commit SHA;
 *   - `condensePromptPreview` error and edge paths.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  buildPromptPreviewBody,
  condensePromptPreview,
  headCommitSha,
  IDLE_TASK_PREVIEW_CONDENSED_MARKER,
  IDLE_TASK_PREVIEW_MAX_CHARS,
  PROMPT_SOURCE_REPO,
} from "../lib/idle_task_body_preview.ts";
import {
  clampIdleTaskBody,
  GITHUB_ISSUE_BODY_MAX_CHARS,
} from "../lib/idle_task_body_limit.ts";
import { appendIdleTaskAttribution } from "../lib/idle_task_attribution.ts";
import {
  type IdleTaskTemplate,
  listTemplates,
} from "../lib/idle_task_template.ts";

// Registration side-effects — the production template set.
import "../lib/idle_task_templates/security_scan_template.ts";
import "../lib/idle_task_templates/best_practices_template.ts";
import "../lib/idle_task_templates/test_audit_template.ts";
import "../lib/idle_task_templates/github_actions_audit_template.ts";
import "../lib/idle_task_templates/supply_chain_readiness_template.ts";
import "../lib/idle_task_templates/orphan_deps_template.ts";
import "../lib/idle_task_templates/dead_code_template.ts";
import "../lib/idle_task_templates/doc_coverage_template.ts";
import "../lib/idle_task_templates/format_drift_template.ts";
import "../lib/idle_task_templates/deprecated_api_template.ts";
import "../lib/idle_task_templates/bash_script_refs_template.ts";
import "../lib/idle_task_templates/bash_syntax_audit_template.ts";
import "../lib/idle_task_templates/documentation_audit_template.ts";
import "../lib/idle_task_templates/alert_feed_template.ts";
import "../lib/idle_task_templates/workflow_annotation_scan_template.ts";
import "../lib/idle_task_templates/private_repo_reference_template.ts";
import "../lib/idle_task_templates/duplicated_knowledge_template.ts";
import "../lib/idle_task_templates/retro_template.ts";
import {
  pinPromptsToThisCheckout,
  withRepoRootCwd,
} from "./support/repo_prompts.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844).
pinPromptsToThisCheckout();

/** A 40-character commit SHA, as GitHub permalinks carry. */
const SHA_40 = /\b[0-9a-f]{40}\b/;

/** Build a template's preview body exactly as the two filers do. */
function buildPreview(template: IdleTaskTemplate): Promise<string> {
  return Promise.resolve(
    template.buildIssueBody({
      repo: "stSoftwareAU/private-repo-14",
      pickedAt: "2026-08-07T00:00:00.000Z",
      workerUser: "vibe-coder",
    }),
  );
}

// ---------------------------------------------------------------------------
// The gate — every registered template
// ---------------------------------------------------------------------------

Deno.test(
  "every registered idle-task template's preview body fits the limit unclamped",
  async () => {
    await withRepoRootCwd(async () => {
      const oversize: string[] = [];
      for (const template of listTemplates()) {
        const preview = await buildPreview(template);
        if (preview.length > IDLE_TASK_PREVIEW_MAX_CHARS) {
          oversize.push(`${template.name}=${preview.length}`);
        }
      }
      assertEquals(
        oversize,
        [],
        `over the ${IDLE_TASK_PREVIEW_MAX_CHARS}-character preview budget: ` +
          `${oversize.join(", ")} — condense the preview via ` +
          `buildPromptPreviewBody() instead of letting the clamp drop the middle`,
      );
    });
  },
);

Deno.test(
  "every seeded wrapper body survives the clamp untruncated",
  async () => {
    await withRepoRootCwd(async () => {
      for (const template of listTemplates()) {
        const body = appendIdleTaskAttribution(await buildPreview(template), {
          template: template.name,
          runId: "vibe-20260807-000000-0000",
        });
        const clamped = clampIdleTaskBody(body);
        assertEquals(
          clamped.truncated,
          false,
          `${template.name}: wrapper body was truncated (${clamped.droppedChars} ` +
            `of ${clamped.originalLength} characters dropped)`,
        );
        assert(clamped.body.length <= GITHUB_ISSUE_BODY_MAX_CHARS);
      }
    });
  },
);

// ---------------------------------------------------------------------------
// The condensed form — security-scan is the template that needs it
// ---------------------------------------------------------------------------

Deno.test(
  "security-scan wrapper is condensed, still dispatches, and links the pinned prompt",
  async () => {
    await withRepoRootCwd(async () => {
      const template = listTemplates().find((t) => t.name === "security-scan");
      assert(template !== undefined, "security-scan template not registered");

      const preview = await buildPreview(template);

      assert(
        preview.length <= IDLE_TASK_PREVIEW_MAX_CHARS,
        `preview is ${preview.length} characters`,
      );
      assertStringIncludes(preview, IDLE_TASK_PREVIEW_CONDENSED_MARKER);

      // Dispatch signal (idle_task_claim_handler.ts) still recognises it.
      assert(
        template.matchesIdleTaskBody?.(preview) === true,
        "condensed body no longer matches the template's body fingerprint",
      );
      assert(
        preview.startsWith("# MythOS-style Security Audit"),
        `condensed body does not open with the fingerprint heading: ` +
          `${preview.slice(0, 80)}`,
      );

      // Permalink to the exact prompt text at a 40-character commit SHA.
      const sha = await headCommitSha();
      assert(sha !== null, "repo-root HEAD SHA could not be read");
      const link = new RegExp(
        `https://github\\.com/${PROMPT_SOURCE_REPO}/blob/[0-9a-f]{40}/` +
          `prompts/security_scan/prompt\\.md`,
      );
      assert(
        link.test(preview),
        "condensed body has no SHA-pinned prompts/security_scan/prompt.md permalink",
      );
      assert(SHA_40.test(preview));
      assertStringIncludes(preview, sha);
    });
  },
);

// ---------------------------------------------------------------------------
// buildPromptPreviewBody
// ---------------------------------------------------------------------------

Deno.test("buildPromptPreviewBody - an under-budget body passes through byte-for-byte", async () => {
  const full = "# Dead-Code Scan\n\nBody that comfortably fits.\n";

  const result = await buildPromptPreviewBody(full, {
    promptName: "dead_code",
    scope: "Find unreferenced code.",
  }, {
    headCommitShaFn: () => {
      throw new Error("must not read HEAD for an under-budget body");
    },
  });

  assertEquals(result, full);
});

Deno.test("buildPromptPreviewBody - an over-budget body is condensed with a pinned permalink", async () => {
  const sha = "a".repeat(40);
  const full = `# MythOS-style Security Audit — Four-Phase Scan\n\n` +
    `## Phase 1 — Inventory\n\n${"filler line\n".repeat(400)}` +
    `## Phase 2 — Attack surface\n\n${"filler line\n".repeat(400)}`;

  const result = await buildPromptPreviewBody(full, {
    promptName: "security_scan",
    scope: "Four-phase security-in-depth audit.",
    maxChars: 2_000,
  }, {
    headCommitShaFn: () => Promise.resolve(sha),
  });

  assert(result.length <= 2_000, `condensed body is ${result.length} chars`);
  assert(result.startsWith("# MythOS-style Security Audit"));
  assertStringIncludes(
    result,
    `https://github.com/${PROMPT_SOURCE_REPO}/blob/${sha}/prompts/security_scan/prompt.md`,
  );
  assertStringIncludes(result, "Phase 1 — Inventory");
  assertStringIncludes(result, "Phase 2 — Attack surface");
  assertStringIncludes(result, "Four-phase security-in-depth audit.");
});

Deno.test("buildPromptPreviewBody - an unreadable HEAD falls back to a visible main link", async () => {
  const full = `# Test-Audit Scan\n\n## Scope\n\n${"x".repeat(5_000)}`;

  const result = await buildPromptPreviewBody(full, {
    promptName: "test_audit",
    scope: "Audit tests.",
    maxChars: 2_000,
  }, {
    headCommitShaFn: () => Promise.resolve(null),
  });

  assertStringIncludes(
    result,
    `https://github.com/${PROMPT_SOURCE_REPO}/blob/main/prompts/test_audit/prompt.md`,
  );
  assertStringIncludes(result, "commit SHA was unavailable");
});

// ---------------------------------------------------------------------------
// condensePromptPreview
// ---------------------------------------------------------------------------

Deno.test("condensePromptPreview - throws when the body carries no heading to fingerprint", () => {
  let thrown: Error | null = null;
  try {
    condensePromptPreview("no heading here, just prose\n", {
      promptName: "security_scan",
      commitSha: "c".repeat(40),
      scope: "Scan.",
    });
  } catch (err) {
    thrown = err as Error;
  }

  assert(thrown !== null, "expected a heading-less body to throw");
  assertStringIncludes(thrown.message, "no Markdown heading");
});

Deno.test("condensePromptPreview - a huge outline is capped, and the cap is announced", () => {
  const sections = Array.from(
    { length: 200 },
    (_, i) => `## Section ${i + 1}\n\ndetail\n`,
  ).join("\n");

  const result = condensePromptPreview(`# Big Scan\n\n${sections}`, {
    promptName: "big_scan",
    commitSha: "d".repeat(40),
    scope: "Everything.",
  });

  assert(result.length <= IDLE_TASK_PREVIEW_MAX_CHARS);
  assertStringIncludes(result, "Section 1");
  assertStringIncludes(result, "more sections");
});
