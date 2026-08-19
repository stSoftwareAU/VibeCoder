/**
 * Tests for bash_script_refs prompt v3 (Issue #3817, parent #3767).
 *
 * v3 closes the three best-practice gaps the #3777 audit recorded
 * against v2 — the surface is a wrapper issue body only (its core check
 * is a native scanner, `bash_script_refs_template.ts:7-11`), so only the
 * rows that grade the text itself were in scope:
 *
 *   1. row 1 (be clear and direct) — the actor is named once at the top,
 *      the finding contract is framed as a description of what the filer
 *      builds in code, and the one section addressed to a reader sits
 *      under an explicit "What a human does next" heading
 *   2. row 3 (use examples effectively) — a tagged `<examples>` block
 *      walks the reported / not-reported / skipped boundary, including
 *      the near-misses
 *   3. row 20 (overeagerness) — the wrapper states how many issues one
 *      run may file, and why one issue per missing path is correct here
 *
 * Also guards immutability of v2 (Issue #235).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";
import { BASH_SCRIPT_REFS_BODY_FINGERPRINT } from "../lib/idle_task_templates/bash_script_refs_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const FAMILY = "bash_script_refs";

async function loadVersion(version: string): Promise<string> {
  const result = await loadPrompt(FAMILY, version, PROMPTS_DIR);
  assert(result.ok, `${FAMILY} ${version} must load`);
  return result.ok ? result.value : "";
}

const loadV3 = () => loadVersion("v3");

/** Sorted, deduplicated `{{PLACEHOLDER}}` names used by a template. */
function placeholders(body: string): string[] {
  return [...new Set(body.match(/\{\{[A-Z0-9_]+\}\}/g) ?? [])].sort();
}

/** Body with all runs of whitespace collapsed, for phrase matching. */
function flatten(body: string): string {
  return body.replace(/\s+/g, " ");
}

Deno.test("bash_script_refs v3 - loads and is the latest version", async () => {
  const latest = await getLatestVersion(FAMILY, PROMPTS_DIR);
  assert(latest.ok);
  if (!latest.ok) return;
  const num = parseInt(latest.value.replace("v", ""), 10);
  assertEquals(
    num >= 3,
    true,
    `Expected ${FAMILY} prompt >= v3, got ${latest.value}`,
  );
});

Deno.test("bash_script_refs v3 - substitutes exactly what v2 did", async () => {
  const body = await loadV3();
  assertEquals(placeholders(body), placeholders(await loadVersion("v2")));
  assertEquals(placeholders(body), ["{{ATTRIBUTION_FOOTER}}"]);
});

Deno.test("bash_script_refs v3 - keeps the wrapper dispatch fingerprint", async () => {
  const body = await loadV3();
  assert(
    BASH_SCRIPT_REFS_BODY_FINGERPRINT.test(body),
    "v3 must keep the H1 the wrapper body fingerprint matches",
  );
  // The substituted body must carry no raw placeholder once the footer lands.
  const rendered = body.replaceAll("{{ATTRIBUTION_FOOTER}}", "FOOTER");
  assertEquals(rendered.includes("{{"), false);
});

Deno.test("bash_script_refs v3 - keeps the load-bearing worker contracts", async () => {
  const body = await loadV3();
  for (
    const contract of [
      "`bash-missing-script`",
      "exit\n127",
      "fleet_source_or_fail",
      "WorkerSourcePathsExist.ts",
      "opens a pull request or edits a file",
      "never returns a silent green",
      "Australian English",
    ]
  ) {
    assertStringIncludes(flatten(body), flatten(contract));
  }
});

// --- Gap 1: be clear and direct — name the actor, separate description
// from the work a reader must do. ---

Deno.test("bash_script_refs v3 - names the acting party before any scanner narration", async () => {
  const body = await loadV3();
  const flat = flatten(body);
  assertStringIncludes(flat, "A native scanner performs this check");
  assertStringIncludes(flat, "Nothing on this page asks you to run it");
  const actorIdx = body.indexOf("A native scanner performs this check");
  const narrationIdx = body.indexOf("## What the scanner does");
  assert(actorIdx >= 0 && narrationIdx > actorIdx, "actor must be named first");
});

Deno.test("bash_script_refs v3 - reframes the finding contract as a description of the filer", async () => {
  const body = await loadV3();
  const flat = flatten(body);
  assertStringIncludes(
    flat,
    "The filer builds every finding body in code; the sections below are a " +
      "description of that contract, not instructions to a reader",
  );
  // The bare imperatives v2 addressed to nobody are gone.
  assertEquals(
    flat.includes("Name the stale reference and its likely fix"),
    false,
    "v3 must not carry v2's unattributed imperative",
  );
  assertEquals(
    flat.includes("and recommend wiring a **repo-local layer-2 CI guard**"),
    false,
    "v3 must not carry v2's unattributed 'recommend' imperative",
  );
});

Deno.test("bash_script_refs v3 - puts reader work under its own heading", async () => {
  const body = await loadV3();
  assertStringIncludes(body, "## What a human does next");
  const flat = flatten(body);
  assertStringIncludes(
    flat,
    "This is the only work this page asks of a reader",
  );
  const headingIdx = body.indexOf("## What a human does next");
  const section = body.slice(headingIdx);
  assertStringIncludes(
    section,
    "Triage the filed `bash-missing-script` issues",
  );
  assertStringIncludes(section, "Close this wrapper issue once triaged");
  // The fail-loud path is a human action, not a silent "clean" result.
  assertStringIncludes(section, "it did not complete");
});

// --- Gap 2: worked examples on the reported / not-reported boundary. ---

Deno.test("bash_script_refs v3 - carries tagged worked examples", async () => {
  const body = await loadV3();
  assertStringIncludes(body, "<examples>");
  assertStringIncludes(body, "</examples>");
  const names = [...body.matchAll(/<example name="([^"]+)">/g)].map((m) =>
    m[1] ?? ""
  );
  assert(
    names.length >= 4,
    `Expected at least 4 tagged examples, got ${names.length}`,
  );
  assertEquals(
    (body.match(/<\/example>/g) ?? []).length,
    names.length,
    "every <example> must be closed",
  );
  for (
    const required of [
      "script-dir-missing-target",
      "ambiguous-root-resolves-via-ancestor",
      "dynamic-command-substitution",
      "shellcheck-annotation-resolves",
    ]
  ) {
    assertEquals(
      names.includes(required),
      true,
      `v3 must carry the '${required}' example`,
    );
  }
});

Deno.test("bash_script_refs v3 - every example shows the source line, the paths tried and a verdict", async () => {
  const body = await loadV3();
  const blocks = [
    ...body.matchAll(/<example name="[^"]+">([\s\S]*?)<\/example>/g),
  ]
    .map((m) => m[1] ?? "");
  assert(blocks.length >= 4);
  for (const block of blocks) {
    for (const tag of ["source_line", "paths_tried", "on_disk", "verdict"]) {
      assertStringIncludes(block, `<${tag}>`);
      assertStringIncludes(block, `</${tag}>`);
    }
  }
});

Deno.test("bash_script_refs v3 - examples cover reported, not-reported and skipped", async () => {
  const body = await loadV3();
  const verdicts = [...body.matchAll(/<verdict>([\s\S]*?)<\/verdict>/g)]
    .map((m) => flatten(m[1] ?? ""));
  assert(
    verdicts.some((v) => v.startsWith("REPORTED")),
    "at least one example must be a reported finding",
  );
  assert(
    verdicts.filter((v) => v.startsWith("NOT REPORTED")).length >= 2,
    "at least two examples must be near-misses that are not reported",
  );
  assert(
    verdicts.some((v) => v.startsWith("SKIPPED")),
    "at least one example must be a documented dynamic skip",
  );
});

// --- Gap 3: overeagerness — state the ceiling. ---

Deno.test("bash_script_refs v3 - states how many issues one run may file", async () => {
  const body = await loadV3();
  assertStringIncludes(body, "### How many issues one run may file");
  const flat = flatten(body);
  assertStringIncludes(flat, "There is no per-run ceiling, by design");
  assertStringIncludes(
    flat,
    "Each missing path is an independent runtime break with its own fix",
  );
});

Deno.test("bash_script_refs v3 - names the bounds that do apply", async () => {
  const flat = flatten(await loadV3());
  assertStringIncludes(flat, "Dedup per missing path");
  assertStringIncludes(flat, "One wrapper at a time");
  assertStringIncludes(flat, "`cooldownHours: 168`");
});

// --- immutability of the predecessor (Issue #235) ---

Deno.test("bash_script_refs v2 - stays frozen without the v3 fixes", async () => {
  const v2 = await loadVersion("v2");
  assertEquals(
    v2.includes("<examples>"),
    false,
    "v2 is immutable and must not gain worked examples",
  );
  assertEquals(
    v2.includes("What a human does next"),
    false,
    "v2 is immutable and must not gain the reader-work heading",
  );
  assert(
    v2.includes("**Primary — fix + guard.** Name the stale reference"),
    "v2 must keep the unattributed imperative v3 replaces",
  );
  assert(
    v2.includes("Each missing target is filed as its own deduped issue"),
    "v2 must keep the uncapped filing wording v3 explains",
  );
});
