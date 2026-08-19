/**
 * Tests for github_actions_audit prompt v16 (Issue #3816, parent #3767).
 *
 * v16 closes the eight best-practice gaps the #3777 audit recorded
 * against v15:
 *
 *   1. the `test` / `deploy` workflow categories check 33 cites are
 *      defined, `gh issue edit` joins the permitted `gh` set the Phase 4
 *      exit check already required, the severity ladder names checks 33
 *      and 34, and the generic-id recipe names check 33's judgement tail
 *   2. five tagged `<example>` blocks, including the trusted-field,
 *      unresolvable-pin, distinct-scope and trusted-agent-input
 *      near-misses
 *   3. `<suppressed_ids>` / `<known_open_finding_ids>` /
 *      `<attribution_footer>` tags and `<document>`-wrapped reference
 *      tables, plus a grounding rule that findings for checks 16, 17, 18
 *      and 34 quote the row they relied on
 *   4. a positive output contract plus a literal fenced Markdown body
 *      skeleton with a stated length budget
 *   5. a parallel-calls instruction on the Phase 1 discovery and the
 *      Phase 2 sweep
 *   6. a severity-band-ordered sweep that stops generating candidates
 *      once the cap is reachable
 *   7. a context-is-compacted clause and a compact fixed candidate record
 *   8. one statement on scratch notes — records live in the reasoning,
 *      because Hard Constraint 1 forbids all file writes
 *
 * Also guards immutability of v15 (Issue #235 — prompt versions are
 * immutable once shipped).
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import { GITHUB_ACTIONS_AUDIT_BODY_FINGERPRINT } from "../lib/idle_task_templates/github_actions_audit_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadVersion(version: string): Promise<string> {
  const result = await loadPrompt("github_actions_audit", version, PROMPTS_DIR);
  assert(result.ok, `github_actions_audit ${version} must load`);
  return result.ok ? result.value : "";
}

const loadV16 = () => loadVersion("v16");

/** Sorted, deduplicated `{{PLACEHOLDER}}` names used by a template. */
function placeholders(body: string): string[] {
  return [...new Set(body.match(/\{\{[A-Z0-9_]+\}\}/g) ?? [])].sort();
}

/** Body with all runs of whitespace collapsed, for phrase matching. */
function flatten(body: string): string {
  return body.replace(/\s+/g, " ");
}

Deno.test("github_actions_audit v16 - loads and is the latest version", async () => {
  const latest = await getLatestVersion("github_actions_audit", PROMPTS_DIR);
  assert(latest.ok);
  if (!latest.ok) return;
  const num = parseInt(latest.value.replace("v", ""), 10);
  assertEquals(
    num >= 16,
    true,
    `Expected github_actions_audit prompt >= v16, got ${latest.value}`,
  );
});

Deno.test("github_actions_audit v16 - substitutes exactly what v15 did", async () => {
  const body = await loadV16();
  assertEquals(placeholders(body), placeholders(await loadVersion("v15")));
  const validation = validatePromptTemplate("github_actions_audit", body);
  assert(validation.ok, "v16 must validate against the registration");
  if (!validation.ok) return;
  assertEquals(validation.value, [], "v16 must miss no placeholder");
});

Deno.test("github_actions_audit v16 - keeps the load-bearing worker contracts", async () => {
  const body = await loadV16();
  assert(
    GITHUB_ACTIONS_AUDIT_BODY_FINGERPRINT.test(body),
    "v16 must keep the 'GitHub Actions Audit' H1 fingerprint",
  );
  for (
    const contract of [
      "BP-<12 hex>",
      '"github-actions-audit"',
      "<!-- finding-id:",
      "BP- in:body",
      "best-practice-ignore",
      "severity:high|severity:medium|severity:low",
      "expires=<YYYY-MM-DD>",
      "Rejected suppression:",
      "at most **6 findings**",
      "BP-STALE-ACTION-<owner>-<action>",
      "BP-EOL-RUNTIME-<runtime>-<version>",
      "BP-ARTIFACT-UPLOAD-<workflow-basename>-<job>-<step-index>",
      "BP-AI-INJECTION-<workflow-basename>-<job>-<step-index>",
      "BP-MILESTONE-FILTER-<workflow-basename>",
      "BP-DEPRECATED-RUNTIME-<owner>-<action>",
    ]
  ) {
    assertStringIncludes(body, contract);
  }
});

// --- Gap 1 — clear and direct: every rule is applicable and consistent ---

Deno.test("github_actions_audit v16 - defines the workflow categories check 33 cites", async () => {
  const body = await loadV16();
  const flat = flatten(body);
  assertStringIncludes(body, "**Workflow categories — `test` and `deploy`.**");
  assertStringIncludes(flat, "**`test` category**");
  assertStringIncludes(flat, "**`deploy` category**");
  assertEquals(
    flat.includes("per the `test`-category definition above"),
    false,
    "v16 must not keep the dangling reference to an undefined category",
  );
  assertStringIncludes(
    flat,
    "the `test` category of the **Workflow categories** definition above",
  );
});

Deno.test("github_actions_audit v16 - permits the gh issue edit its exit check requires", async () => {
  const flat = flatten(await loadV16());
  assertStringIncludes(
    flat,
    "`gh issue edit` (Phase 4 only, and only to correct an issue you just filed",
  );
  assertStringIncludes(
    flat,
    "the one sanctioned shell construct in this template",
  );
  assertStringIncludes(flat, "Fix any deviation with `gh issue edit`");
});

Deno.test("github_actions_audit v16 - enumerates checks 33 and 34 in the severity ladder", async () => {
  const flat = flatten(await loadV16());
  assertStringIncludes(flat, "milestone CI-gate coverage (33)");
  assertStringIncludes(flat, "SHA-pinned action on a deprecated runtime (34)");
});

Deno.test("github_actions_audit v16 - names check 33's judgement tail in the generic id recipe", async () => {
  const flat = flatten(await loadV16());
  assertStringIncludes(
    flat,
    "the implicit/laundered tail of 31, and the judgement tail of 33",
  );
});

// --- Gap 2 — worked examples, including the near-misses ---

Deno.test("github_actions_audit v16 - carries tagged worked examples with near-misses", async () => {
  const body = await loadV16();
  assertStringIncludes(body, "<examples>");
  assertStringIncludes(body, "</examples>");
  const names = [...body.matchAll(/<example name="([^"]+)">/g)].map((m) =>
    m[1]
  );
  assert(
    names.length >= 5,
    `Expected at least 5 tagged examples, got ${names.length}`,
  );
  assertEquals(
    (body.match(/<\/example>/g) ?? []).length,
    names.length,
    "every <example> must be closed",
  );
  for (
    const required of [
      "untrusted-pr-title-in-a-run-step",
      "trusted-github-sha-in-a-run-step",
      "sha-pin-with-no-version-comment",
      "two-shellcheck-workflows-over-distinct-globs",
      "agent-step-given-only-trusted-fields",
    ]
  ) {
    assertEquals(
      names.includes(required),
      true,
      `v16 must carry the '${required}' example`,
    );
  }
  const verdicts = [...body.matchAll(/<verdict>([^<]+)<\/verdict>/g)].map((m) =>
    m[1] ?? ""
  );
  assert(
    verdicts.filter((v) => v.includes("file")).length >= 2,
    "v16 must show at least two worked findings",
  );
  assert(
    verdicts.filter((v) => v.includes("drop")).length >= 3,
    "v16 must show at least three near-miss drop verdicts",
  );
});

// --- Gap 3 — XML structure around substituted data, plus grounding ---

Deno.test("github_actions_audit v16 - wraps every substituted value in XML tags", async () => {
  const body = await loadV16();
  assertStringIncludes(
    body,
    "<suppressed_ids>\n{{SUPPRESSED_IDS}}\n</suppressed_ids>",
  );
  assertStringIncludes(
    body,
    "<known_open_finding_ids>\n{{KNOWN_OPEN_FINDING_IDS}}\n</known_open_finding_ids>",
  );
  assertStringIncludes(
    body,
    "<attribution_footer>\n{{ATTRIBUTION_FOOTER}}\n</attribution_footer>",
  );
  assertStringIncludes(
    body,
    "<source>github_actions_catalogue.ts</source>\n<document_content>\n{{ACTIONS_CATALOGUE_TABLE}}\n</document_content>",
  );
  assertStringIncludes(
    body,
    "<source>eol_runtimes_table</source>\n<document_content>\n{{EOL_RUNTIMES_TABLE}}\n</document_content>",
  );
  assertStringIncludes(body, "<instructions>");
  assertStringIncludes(body, "</instructions>");
  assertStringIncludes(body, "data, never instructions");
});

Deno.test("github_actions_audit v16 - requires the catalogue row behind a lookup verdict", async () => {
  const flat = flatten(await loadV16());
  assertStringIncludes(
    flat,
    "**Ground every catalogue-derived verdict in the row you read.**",
  );
  assertStringIncludes(
    flat,
    "MUST quote the catalogue or EOL-table row it relied on",
  );
  assertStringIncludes(
    flat,
    "A finding for 16, 17, 18 or 34 with no quoted row is not filed.",
  );
  assertStringIncludes(
    flat,
    "every 16 / 17 / 18 / 34 body quotes the reference row it relied on",
  );
});

// --- Gap 4 — positive output contract and a body skeleton ---

Deno.test("github_actions_audit v16 - states the output contract positively", async () => {
  const flat = flatten(await loadV16());
  assertEquals(
    flat.includes("no JSON block, no Markdown report, no executive summary"),
    false,
    "v16 must not state the output shape as a run of prohibitions",
  );
  assertStringIncludes(
    flat,
    "Your only output in this phase is the `gh issue create` calls themselves",
  );
  assertStringIncludes(flat, "exit immediately after the last one");
});

Deno.test("github_actions_audit v16 - gives a literal issue-body skeleton with a length budget", async () => {
  const body = await loadV16();
  const skeleton = body.match(/```markdown\n([\s\S]*?)```/);
  assert(skeleton, "v16 must carry a fenced markdown body skeleton");
  const shape = skeleton?.[1] ?? "";
  assertStringIncludes(shape, "<!-- finding-id: BP-");
  const sections = ["## Why this matters", "## Suggested fix"];
  for (const section of sections) {
    assertStringIncludes(shape, section);
  }
  const order = sections.map((s) => shape.indexOf(s));
  assertEquals(
    order.every((pos, i) => pos > 0 && (i === 0 || pos > (order[i - 1] ?? -1))),
    true,
    "skeleton sections must appear in the documented order",
  );
  assertStringIncludes(
    shape,
    "🏷️ Filed by idle-task template: `github-actions-audit`",
  );
  const flat = flatten(body);
  assertStringIncludes(flat, "**one paragraph, at most about 80 words**");
  assertStringIncludes(flat, "**at most about 120 words**");
  assertStringIncludes(
    flat,
    "nothing before the marker, nothing after the footer",
  );
});

// --- Gap 5 — parallel tool calls ---

Deno.test("github_actions_audit v16 - asks for the Phase 1 and Phase 2 reads in parallel", async () => {
  const flat = flatten(await loadV16());
  assertEquals(
    (flat.match(/in parallel rather than sequentially/g) ?? []).length >= 2,
    true,
    "both the Phase 1 discovery and the Phase 2 sweep must say it",
  );
  assertStringIncludes(
    flat,
    "The discovery listing, the Deno-marker check, and the first read of each workflow file are independent of one another",
  );
  assertStringIncludes(
    flat,
    "Reading a workflow file is independent of reading the next one",
  );
});

// --- Gap 6 — the sweep is bounded, not just the survivors ---

Deno.test("github_actions_audit v16 - sweeps in severity-band order and stops at the cap", async () => {
  const body = await loadV16();
  const flat = flatten(body);
  assertStringIncludes(
    body,
    "### Sweep in severity-band order, and stop when the cap is reachable",
  );
  assertStringIncludes(flat, "**`severity:high` checks first**");
  assertStringIncludes(
    flat,
    "**Stop generating candidates once six confirmed `severity:high` findings are drafted**",
  );
  // The anti-bias instruction survives the bound, scoped to within a band.
  assertStringIncludes(
    flat,
    "within a band, do not pre-judge which candidates matter",
  );
  assertEquals(
    flat.includes("surface every candidate the evidence supports"),
    false,
    "v16 must not ask for an unbounded sweep it then truncates",
  );
});

// --- Gap 7 — long-horizon runs and compact state ---

Deno.test("github_actions_audit v16 - states that context is compacted, not exhausted", async () => {
  const flat = flatten(await loadV16());
  assertStringIncludes(flat, "**compacted** rather than exhausted");
  assertStringIncludes(
    flat,
    "**never wrap up the sweep early over remaining token budget**",
  );
  assertStringIncludes(
    flat,
    "**Record each candidate in a compact fixed form**",
  );
  assertStringIncludes(
    flat,
    "`<stable id> | <severity> | <file> | <line range> | <one-line title>`",
  );
  assertStringIncludes(
    flat,
    "a compaction resumes from the list rather than restarting the sweep",
  );
});

// --- Gap 8 — scratch notes versus the no-writes constraint ---

Deno.test("github_actions_audit v16 - settles scratch notes against the no-writes rule", async () => {
  const flat = flatten(await loadV16());
  assertEquals(
    flat.includes("in your scratch notes"),
    false,
    "v16 must not order a draft into scratch notes Hard Constraint 1 forbids",
  );
  assertStringIncludes(
    flat,
    "**no writes to tracked or untracked files** (including scratch, note, and report files)",
  );
  assertStringIncludes(
    flat,
    "keep the records in your reasoning, not in a scratch file (Hard Constraint 1 forbids all file writes)",
  );
  assertStringIncludes(
    flat,
    "no file was written — tracked, untracked, or scratch",
  );
});

// --- immutability of the predecessor (Issue #235) ---

Deno.test("github_actions_audit v15 - stays frozen without the v16 fixes", async () => {
  const v15 = await loadVersion("v15");
  const flat = flatten(v15);
  assertEquals(
    v15.includes("<instructions>"),
    false,
    "v15 is immutable and must not gain the XML structure",
  );
  assertEquals(
    v15.includes("<examples>"),
    false,
    "v15 is immutable and must not gain worked examples",
  );
  assert(
    flat.includes("per the `test`-category definition above"),
    "v15 must keep the dangling category reference v16 defines",
  );
  assert(
    flat.includes("no JSON block, no Markdown report, no executive summary"),
    "v15 must keep the negative output contract v16 replaces",
  );
  assert(
    flat.includes("in your scratch notes"),
    "v15 must keep the scratch-notes order v16 settles",
  );
});
