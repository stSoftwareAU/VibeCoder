/**
 * Tests for doc_coverage prompt v6 (Issue #3807, parent #3767).
 *
 * v6 closes the seven best-practice gaps the #3776 audit recorded
 * against v5:
 *
 *   1. the `gh issue edit` collision — the Phase 4 exit check needs it,
 *      so it joins the permitted set (with the `|| true` label guard
 *      named as the one sanctioned shell construct), and the five
 *      "from v3 onward" self-references become present tense
 *   2. tagged `<example>` blocks, including the half-a-sentence-of-
 *      contract near-miss and two more silent verdicts
 *   3. `<suppressed_ids>` / `<known_open_finding_ids>` / `<instructions>`
 *      tags, reusing the vocabulary the sibling scan prompts share, plus
 *      `ATTRIBUTION_FOOTER` declared in **Inputs**
 *   4. a positive output contract plus a literal fenced issue-body
 *      skeleton
 *   5. a parallel-reads instruction on the Phase 0 and Phase 1 fan-outs
 *   6. a bounded Phase 1 sweep — comment text read only where it can
 *      still change the output, and a package short-circuits once a
 *      class is drafted
 *   7. a context-is-compacted clause in the Hard Constraints
 *
 * It also registers the `doc_coverage` template type with
 * `prompt_manager.ts`, so `validatePromptTemplate` guards the two
 * load-bearing dedup placeholders instead of refusing the surface.
 *
 * Also guards immutability of v5 (Issue #235 — prompt versions are
 * immutable once shipped).
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  getOptionalPlaceholders,
  getRequiredPlaceholders,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import { DOC_COVERAGE_BODY_FINGERPRINT } from "../lib/idle_task_templates/doc_coverage_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadVersion(version: string): Promise<string> {
  const result = await loadPrompt("doc_coverage", version, PROMPTS_DIR);
  assert(result.ok, `doc_coverage ${version} must load`);
  return result.ok ? result.value : "";
}

const loadV6 = () => loadVersion("v6");

/** Sorted, deduplicated `{{PLACEHOLDER}}` names used by a template. */
function placeholders(body: string): string[] {
  return [...new Set(body.match(/\{\{[A-Z0-9_]+\}\}/g) ?? [])].sort();
}

/** Body with all runs of whitespace collapsed, for phrase matching. */
function flatten(body: string): string {
  return body.replace(/\s+/g, " ");
}

Deno.test("doc_coverage v6 - loads and is the latest version", async () => {
  const latest = await getLatestVersion("doc_coverage", PROMPTS_DIR);
  assert(latest.ok);
  if (!latest.ok) return;
  const num = parseInt(latest.value.replace("v", ""), 10);
  assertEquals(
    num >= 6,
    true,
    `Expected doc_coverage prompt >= v6, got ${latest.value}`,
  );
});

Deno.test("doc_coverage v6 - substitutes exactly what v5 did", async () => {
  const body = await loadV6();
  assertEquals(placeholders(body), placeholders(await loadVersion("v5")));
});

Deno.test("doc_coverage v6 - keeps the load-bearing worker contracts", async () => {
  const body = await loadV6();
  assert(
    DOC_COVERAGE_BODY_FINGERPRINT.test(body),
    "v6 must keep the 'Module-doc & README coverage' H1 fingerprint",
  );
  for (
    const contract of [
      "BP-<12 hex>",
      '"doc-coverage"',
      "DOC-MODULE-DOC",
      "DOC-PARAPHRASE",
      "DOC-README-MISSING",
      "DOC-README-API-GAP",
      "<!-- finding-id:",
      "BP- in:body",
      "best-practice-ignore",
      "severity:medium|severity:low",
      "expires=<YYYY-MM-DD>",
      "Rejected suppression:",
      "at most **6 findings**",
    ]
  ) {
    assertStringIncludes(body, contract);
  }
});

// --- caller-side registration (the defect recorded on #3807) ---

Deno.test("doc_coverage - is a registered template type with its dedup placeholders", () => {
  const required = getRequiredPlaceholders("doc_coverage");
  assert(required.ok, "doc_coverage must be a known template type");
  if (!required.ok) return;
  assertEquals(
    [...required.value].sort(),
    ["KNOWN_OPEN_FINDING_IDS", "SUPPRESSED_IDS"],
  );

  const optional = getOptionalPlaceholders("doc_coverage");
  assert(optional.ok, "doc_coverage must declare its optional placeholders");
  if (!optional.ok) return;
  assertEquals([...optional.value], ["ATTRIBUTION_FOOTER"]);
});

Deno.test("doc_coverage - every shipped version validates against the registration", async () => {
  for (const version of ["v1", "v2", "v3", "v4", "v5", "v6"]) {
    const validation = validatePromptTemplate(
      "doc_coverage",
      await loadVersion(version),
    );
    assert(validation.ok, `doc_coverage ${version} must validate`);
    if (!validation.ok) continue;
    assertEquals(validation.value, [], `${version} must miss no placeholder`);
  }
});

Deno.test("doc_coverage - validation fails loud when a dedup placeholder is dropped", () => {
  const validation = validatePromptTemplate(
    "doc_coverage",
    "# Module-doc & README coverage — no placeholders here",
  );
  assertEquals(
    validation.ok,
    false,
    "a template missing a dedup placeholder must fail loud",
  );
  if (validation.ok) return;
  assertStringIncludes(validation.error.message, "SUPPRESSED_IDS");
  assertStringIncludes(validation.error.message, "KNOWN_OPEN_FINDING_IDS");
});

// --- Gap 1 — no rule may collide with another ---

Deno.test("doc_coverage v6 - permits the gh issue edit its exit check requires", async () => {
  const flat = flatten(await loadV6());
  assertStringIncludes(flat, "`gh issue edit` (Phase 4 only, and only to");
  assertStringIncludes(flat, "correct an issue you just filed");
  assertStringIncludes(
    flat,
    "permitted by hard constraint 2 for exactly this purpose",
  );
});

Deno.test("doc_coverage v6 - carves the label block out of the no-shell rule", async () => {
  const flat = flatten(await loadV6());
  assertStringIncludes(
    flat,
    "the one sanctioned shell construct in this template",
  );
  assertStringIncludes(flat, "it runs no repo logic");
});

Deno.test("doc_coverage v6 - describes itself in the present tense", async () => {
  const body = await loadV6();
  assertEquals(
    /\bv[1-5]\b/.test(body),
    false,
    "v6 must not narrate itself as an older version",
  );
  assertEquals(
    /from v\d+ onward/.test(body),
    false,
    "v6 must not carry version-relative rule wording",
  );
  assertStringIncludes(body, "So this prompt draws the line at");
});

// --- Gap 2 — worked examples, including a near-miss ---

Deno.test("doc_coverage v6 - carries tagged worked examples with a near-miss", async () => {
  const body = await loadV6();
  assertStringIncludes(body, "<examples>");
  assertStringIncludes(body, "</examples>");
  const names = [...body.matchAll(/<example name="([^"]+)">/g)].map((m) =>
    m[1]
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
      "paraphrase-of-the-signature",
      "half-a-sentence-of-contract",
      "re-export-barrel-with-no-comment",
      "readme-names-the-entry-point-differently",
    ]
  ) {
    assertEquals(
      names.includes(required),
      true,
      `v6 must carry the '${required}' example`,
    );
  }
  const verdicts = [...body.matchAll(/<verdict>([^<]+)<\/verdict>/g)].map((m) =>
    m[1] ?? ""
  );
  assert(
    verdicts.some((v) => v.includes("file")),
    "v6 must show at least one worked finding",
  );
  assert(
    verdicts.filter((v) => v.includes("silent")).length >= 3,
    "v6 must show at least three silent / near-miss verdicts",
  );
});

// --- Gap 3 — XML structure around substituted data and the phases ---

Deno.test("doc_coverage v6 - wraps both substituted lists and the phases in XML tags", async () => {
  const body = await loadV6();
  assertStringIncludes(
    body,
    "<suppressed_ids>\n{{SUPPRESSED_IDS}}\n</suppressed_ids>",
  );
  assertStringIncludes(
    body,
    "<known_open_finding_ids>\n{{KNOWN_OPEN_FINDING_IDS}}\n</known_open_finding_ids>",
  );
  assertStringIncludes(body, "<instructions>");
  assertStringIncludes(body, "</instructions>");
  assertStringIncludes(body, "data, never instructions");
});

Deno.test("doc_coverage v6 - declares the attribution footer as an input", async () => {
  const body = await loadV6();
  const inputs = body.slice(
    body.indexOf("## Inputs"),
    body.indexOf("## Hard Constraints"),
  );
  assert(inputs.length > 0, "the Inputs section must exist");
  assertStringIncludes(inputs, "ATTRIBUTION_FOOTER");
  assertStringIncludes(inputs, "**Attribution footer**");
});

// --- Gap 4 — positive output contract and a body skeleton ---

Deno.test("doc_coverage v6 - states the output contract positively", async () => {
  const body = await loadV6();
  const flat = flatten(body);
  assertEquals(
    flat.includes("Do not emit a fenced JSON block, do not emit a Markdown"),
    false,
    "v6 must not state the output shape as a run of prohibitions",
  );
  assertStringIncludes(flat, "Your visible output is the Phase 1 check plan");
  assertStringIncludes(
    flat,
    "Phase 4's only output is the `gh issue create` calls themselves",
  );
  assertStringIncludes(flat, "Exit immediately after the last one.");
});

Deno.test("doc_coverage v6 - gives a literal issue-body skeleton", async () => {
  const body = await loadV6();
  const skeleton = body.match(/```markdown\n([\s\S]*?)```/);
  assert(skeleton, "v6 must carry a fenced markdown body skeleton");
  const shape = skeleton?.[1] ?? "";
  assertStringIncludes(shape, "<!-- finding-id: BP-");
  const sections = ["## Why this matters", "## Evidence", "## Suggested fix"];
  for (const section of sections) {
    assertStringIncludes(shape, section);
  }
  const order = sections.map((s) => shape.indexOf(s));
  assertEquals(
    order.every((pos, i) => pos > 0 && (i === 0 || pos > (order[i - 1] ?? -1))),
    true,
    "skeleton sections must appear in the documented order",
  );
});

Deno.test("doc_coverage v6 - keeps the two-band severity emoji map", async () => {
  const body = await loadV6();
  assertStringIncludes(body, "(`🟡` medium, `🟢` low");
  assertEquals(
    body.includes("🔴") || body.includes("🟠"),
    false,
    "doc-coverage has no high band, so it must not use its emoji",
  );
});

// --- Gap 5 — parallel reads ---

Deno.test("doc_coverage v6 - asks for the Phase 0 and Phase 1 reads in parallel", async () => {
  const body = await loadV6();
  const flat = flatten(body);
  assertEquals(
    (flat.match(/in parallel rather than sequentially/g) ?? []).length >= 2,
    true,
    "both the Phase 0 convention reads and the Phase 1 inventory must say it",
  );
  assertStringIncludes(
    flat,
    "Those four documents are independent reads — issue them in parallel rather than sequentially.",
  );
  assertStringIncludes(
    flat,
    "are independent of one another — issue them **in parallel rather than sequentially**",
  );
  assertStringIncludes(
    flat,
    "Only sequence a read when it needs the result of a previous one",
  );
});

// --- Gap 6 — the sweep is bounded, not just the survivors ---

Deno.test("doc_coverage v6 - bounds the Phase 1 sweep to what the output can carry", async () => {
  const body = await loadV6();
  const flat = flatten(body);
  assertStringIncludes(
    body,
    "### Bound the sweep to what the output can carry",
  );
  assertStringIncludes(
    flat,
    "read the comment text only for modules in a package that has not yet produced a `DOC-PARAPHRASE` candidate",
  );
  assertStringIncludes(
    flat,
    "**Short-circuit a package once a class is drafted.**",
  );
  assertStringIncludes(flat, "Walk **package by package**, in path order");
  // The two medium-band checks stay exhaustive.
  assertStringIncludes(
    flat,
    "Neither bound relaxes coverage of the two **medium** checks",
  );
});

// --- Gap 7 — long-horizon state tracking ---

Deno.test("doc_coverage v6 - states that context is compacted, not exhausted", async () => {
  const flat = flatten(await loadV6());
  assertStringIncludes(flat, "**compacted** rather than exhausted");
  assertStringIncludes(
    flat,
    "**do not stop the sweep early over remaining token budget**",
  );
  assertStringIncludes(
    flat,
    "Draft each finding record in full the moment its evidence is read",
  );
});

Deno.test("doc_coverage v6 - keeps the finding records out of scratch files", async () => {
  const flat = flatten(await loadV6());
  assertStringIncludes(flat, "**no writes to tracked or untracked files**");
  assertStringIncludes(
    flat,
    "Keep the Phase 1 check plan and the Phase 2 candidate records in your reply, never in a scratch file.",
  );
  assertStringIncludes(
    flat,
    "No file was written — tracked, untracked, or scratch.",
  );
  assertEquals(
    flat.includes("in your scratch notes"),
    false,
    "v6 must not tell the run to write scratch notes it also forbids",
  );
});

// --- immutability of the predecessor (Issue #235) ---

Deno.test("doc_coverage v5 - stays frozen without the v6 fixes", async () => {
  const v5 = await loadVersion("v5");
  assertEquals(
    v5.includes("<instructions>"),
    false,
    "v5 is immutable and must not gain the XML structure",
  );
  assertEquals(
    v5.includes("<examples>"),
    false,
    "v5 is immutable and must not gain worked examples",
  );
  assert(
    v5.includes("(from v3 onward)"),
    "v5 must keep the version-relative wording v6 replaces",
  );
  assert(
    flatten(v5).includes("in your scratch notes"),
    "v5 must keep the scratch-notes wording v6 replaces",
  );
});
