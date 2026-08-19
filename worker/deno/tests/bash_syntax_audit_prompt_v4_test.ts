/**
 * Tests for bash_syntax_audit prompt v4 (Issue #3818, parent #3767).
 *
 * v4 closes the two best-practice gaps the #3777 audit recorded against
 * v3:
 *
 *   1. item 1 (be clear and direct) — the file names its actor. The
 *      detectors perform every check before the wrapper issue is filed,
 *      so the suppression section is stated in the indicative rather
 *      than as instructions to a reader, and the dead "LLM triage path"
 *      justification is gone.
 *   2. item 3 (use examples effectively) — a tagged `<examples>` block
 *      with one accepted marker and the three near-miss rejections
 *      (past expiry, empty `author=`, no reason text), each carrying its
 *      literal `Rejected suppression:` line.
 *
 * The governance grammar itself (Issue #3737) and the wrapper contracts
 * the template depends on are unchanged, and v3 stays frozen (Issue
 * #235).
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";
import {
  BASH_SYNTAX_AUDIT_BODY_FINGERPRINT,
  createBashSyntaxAuditTemplate,
} from "../lib/idle_task_templates/bash_syntax_audit_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadVersion(version: string): Promise<string> {
  const result = await loadPrompt("bash_syntax_audit", version, PROMPTS_DIR);
  assert(result.ok, `bash_syntax_audit ${version} must load`);
  return result.ok ? result.value : "";
}

const loadV4 = () => loadVersion("v4");

/** Sorted, deduplicated `{{PLACEHOLDER}}` names used by a template. */
function placeholders(body: string): string[] {
  return [...new Set(body.match(/\{\{[A-Z0-9_]+\}\}/g) ?? [])].sort();
}

/** Body with all runs of whitespace collapsed, for phrase matching. */
function flatten(body: string): string {
  return body.replace(/\s+/g, " ");
}

Deno.test("bash_syntax_audit v4 - loads and is the latest version", async () => {
  const latest = await getLatestVersion("bash_syntax_audit", PROMPTS_DIR);
  assert(latest.ok);
  if (!latest.ok) return;
  const num = parseInt(latest.value.replace("v", ""), 10);
  assertEquals(
    num >= 4,
    true,
    `Expected bash_syntax_audit prompt >= v4, got ${latest.value}`,
  );
});

Deno.test("bash_syntax_audit v4 - substitutes exactly what v3 did", async () => {
  assertEquals(
    placeholders(await loadV4()),
    placeholders(await loadVersion("v3")),
  );
});

// ---------------------------------------------------------------------------
// Gap 1 — be clear and direct: the file names the actor
// ---------------------------------------------------------------------------

Deno.test("bash_syntax_audit v4 - names the actor before describing the checks", async () => {
  const body = await loadV4();
  const flat = flatten(body);

  assert(
    /^#+\s+Who performs this audit\b/m.test(body),
    "v4 must carry a section naming who performs the audit",
  );
  assert(
    /no model turn is involved/i.test(flat),
    "v4 must state that no model turn is involved",
  );
  assert(
    /take no action|nothing in this body is work/i.test(flat),
    "v4 must state that a reader has no work to do",
  );

  // The actor statement must precede the descriptions it governs.
  const actorAt = body.indexOf("## Who performs this audit");
  const checksAt = body.indexOf("## What the detectors check");
  const suppressionAt = body.indexOf("## In-code suppression");
  assert(actorAt >= 0 && checksAt > actorAt && suppressionAt > actorAt);
});

Deno.test("bash_syntax_audit v4 - drops the LLM triage path that does not exist", async () => {
  const flat = flatten(await loadV4());
  assertEquals(
    /LLM triage/i.test(flat),
    false,
    "v4 must not justify a rule by an LLM triage path the template never runs",
  );
  assert(
    /the only path that reads these markers/i.test(flat),
    "v4 must say the deterministic check is the only reader of these markers",
  );
});

Deno.test("bash_syntax_audit v4 - states the suppression rule in the indicative", async () => {
  const flat = flatten(await loadV4());
  assert(
    /suppression check honours a marker/i.test(flat),
    "v4 must describe what the check does, not order a reader to do it",
  );
  assertEquals(
    /Honour a marker/.test(flat),
    false,
    "v4 must not instruct an actor that never runs",
  );
});

// ---------------------------------------------------------------------------
// Gap 2 — worked accept/reject examples
// ---------------------------------------------------------------------------

Deno.test("bash_syntax_audit v4 - carries a tagged examples block", async () => {
  const body = await loadV4();
  assertStringIncludes(body, "<examples>");
  assertStringIncludes(body, "</examples>");

  // Scope the tag count to the block: the suppression grammar above it
  // uses `<reason>` as a placeholder.
  const block = body.slice(body.indexOf("<examples>"));
  const examples = block.match(/<example>/g) ?? [];
  assertEquals(
    examples.length >= 4,
    true,
    `Expected at least 4 <example> entries, got ${examples.length}`,
  );
  for (const tag of ["<case>", "<verdict>", "<reason>"]) {
    assertEquals(
      (block.match(new RegExp(tag, "g")) ?? []).length,
      examples.length,
      `every <example> must carry a ${tag}`,
    );
  }
});

Deno.test("bash_syntax_audit v4 - works one accepted marker and three rejections", async () => {
  const flat = flatten(await loadV4());

  assert(
    /<verdict>suppressed — no finding is filed for this id<\/verdict>/.test(
      flat,
    ),
    "v4 must work the accepted case through to its verdict",
  );

  const rejections =
    flat.match(/Rejected suppression: \.github\/workflows\//g) ??
      [];
  assertEquals(
    rejections.length >= 3,
    true,
    `Expected at least 3 literal rejection lines, got ${rejections.length}`,
  );

  // Each independent rejection reason gets its own worked instance.
  for (
    const failed of [
      "expires=2026-05-01 has passed",
      "author= empty",
      "reason text empty",
    ]
  ) {
    assert(
      flat.includes(failed),
      `v4 must show the '${failed}' rejection`,
    );
  }
});

Deno.test("bash_syntax_audit v4 - examples use the detectors' real gate ids", async () => {
  const body = await loadV4();
  const examplesBlock = body.slice(
    body.indexOf("<examples>"),
    body.indexOf("</examples>"),
  );
  for (
    const id of [
      "BP-BASH-SYNTAX-GATE",
      "BP-BASH-SHELLCHECK-GATE",
      "BP-VALIDITY-GATE-",
    ]
  ) {
    assertStringIncludes(examplesBlock, id);
  }
  // A gate marker lives in a workflow file, so the examples must show a
  // `#` comment rather than the `//` form the code scans use.
  assertStringIncludes(examplesBlock, "# best-practice-ignore:");
});

// ---------------------------------------------------------------------------
// Unchanged contracts
// ---------------------------------------------------------------------------

Deno.test("bash_syntax_audit v4 - keeps the suppression governance grammar", async () => {
  const body = await loadV4();
  const flat = flatten(body);

  assertStringIncludes(flat, "author=<github-login>");
  assertStringIncludes(flat, "expires=<YYYY-MM-DD>");
  assert(/calendar date/i.test(flat) && /today or later/i.test(flat));
  assert(/reason text/i.test(flat));
  assert(/does not suppress/i.test(flat));
  assertStringIncludes(flat, "Rejected suppression:");
  assertStringIncludes(flat, "the deterministic suppression check applies");
  assertEquals(
    /worker\/deno\//.test(body),
    false,
    "the body is filed verbatim into other repos — no internal path",
  );
});

Deno.test("bash_syntax_audit v4 - keeps the issue-only, fail-loud, isolation contracts", async () => {
  const flat = flatten(await loadV4());
  for (
    const contract of [
      "never** opens a pull request",
      "absolutely isolated",
      "never return a silent green on error",
      "bash-syntax-audit",
      "severity:high",
      "severity:medium",
      "shellcheck",
      "bash -n",
    ]
  ) {
    assertStringIncludes(flat, contract);
  }
});

Deno.test("bash_syntax_audit v4 - renders as the wrapper issue body", async () => {
  const template = createBashSyntaxAuditTemplate({
    loadPromptFn: async (name) => await loadPrompt(name, "v4", PROMPTS_DIR),
  });
  const body = await template.buildIssueBody({
    repo: "acme/widget",
    pickedAt: "2026-08-07T00:00:00Z",
    workerUser: "vibe",
  });

  assert(BASH_SYNTAX_AUDIT_BODY_FINGERPRINT.test(body));
  assertEquals(template.matchesIdleTaskBody?.(body), true);
  assert(!body.includes("{{"), "expected no raw placeholders");
  assertStringIncludes(body, "<examples>");
});

// ---------------------------------------------------------------------------
// Immutability of the predecessor (Issue #235)
// ---------------------------------------------------------------------------

Deno.test("bash_syntax_audit v3 - stays frozen without the v4 fixes", async () => {
  const v3 = await loadVersion("v3");
  assertEquals(v3.includes("<examples>"), false);
  assertEquals(v3.includes("## Who performs this audit"), false);
  assert(
    /Honour a marker/.test(v3),
    "v3 must keep its original imperative wording",
  );
});
