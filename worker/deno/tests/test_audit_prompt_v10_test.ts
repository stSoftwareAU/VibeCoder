/**
 * Tests for test_audit prompt v10 (Issue #3809, parent #3767).
 *
 * v10 closes the ten best-practice gaps the #3776 audit recorded
 * against v9:
 *
 *   1. `gh issue edit` joins the permitted `gh` set the Phase 4 exit
 *      check already required, and the finished v5 id-churn note goes
 *   2. a sibling-boundary statement against `doc-coverage` and
 *      `documentation-audit`
 *   3. six tagged `<example>` blocks, including the check 8 and check 10
 *      near-misses
 *   4. `<suppressed_ids>` / `<known_open_finding_ids>` / `<coverage_gaps>`
 *      / `<attribution_footer>` tags around the substituted values, plus
 *      `<instructions>` around the phases
 *   5. a capped, tagged coverage-gap list and a list-order confirmation
 *      rule in check 7 (the renderer cap lives in
 *      `coverage_gap_scanner_test.ts`)
 *   6. a positive output contract plus a literal fenced body skeleton
 *   7. a parallel-calls instruction on the Phase 0 and Phase 1 fan-outs
 *   8. a bounded Phase 2 walk in a stated priority order
 *   9. a context-is-compacted clause, and a no-writes rule that covers
 *      untracked scratch files
 *  10. a deletion recommendation must name the net that survives it
 *
 * Also guards immutability of v9 (Issue #235 — prompt versions are
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
import { TEST_AUDIT_BODY_FINGERPRINT } from "../lib/idle_task_templates/test_audit_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadVersion(version: string): Promise<string> {
  const result = await loadPrompt("test_audit", version, PROMPTS_DIR);
  assert(result.ok, `test_audit ${version} must load`);
  return result.ok ? result.value : "";
}

const loadV10 = () => loadVersion("v10");

/** Sorted, deduplicated `{{PLACEHOLDER}}` names used by a template. */
function placeholders(body: string): string[] {
  return [...new Set(body.match(/\{\{[A-Z0-9_]+\}\}/g) ?? [])].sort();
}

/** Body with all runs of whitespace collapsed, for phrase matching. */
function flatten(body: string): string {
  return body.replace(/\s+/g, " ");
}

Deno.test("test_audit v10 - loads and is the latest version", async () => {
  const latest = await getLatestVersion("test_audit", PROMPTS_DIR);
  assert(latest.ok);
  if (!latest.ok) return;
  const num = parseInt(latest.value.replace("v", ""), 10);
  assertEquals(
    num >= 10,
    true,
    `Expected test_audit prompt >= v10, got ${latest.value}`,
  );
});

Deno.test("test_audit v10 - substitutes exactly what v9 did", async () => {
  const body = await loadV10();
  assertEquals(placeholders(body), placeholders(await loadVersion("v9")));
  const validation = validatePromptTemplate("test_audit", body);
  assert(validation.ok, "v10 must validate against the registration");
  if (!validation.ok) return;
  assertEquals(validation.value, [], "v10 must miss no placeholder");
});

Deno.test("test_audit v10 - keeps the load-bearing worker contracts", async () => {
  const body = await loadV10();
  assert(
    TEST_AUDIT_BODY_FINGERPRINT.test(body),
    "v10 must keep the 'Test-Audit' H1 fingerprint",
  );
  for (
    const contract of [
      "BP-<12 hex>",
      '"test-audit"',
      "<!-- finding-id:",
      "BP- in:body",
      "best-practice-ignore",
      "severity:high|severity:medium|severity:low",
      "expires=<YYYY-MM-DD>",
      "Rejected suppression:",
      "at most **6 findings**",
      "potentially-untested-public-api",
    ]
  ) {
    assertStringIncludes(body, contract);
  }
});

Deno.test("test_audit v10 - still refuses to claim measured coverage", async () => {
  const flat = flatten(await loadV10());
  assertStringIncludes(flat, "never dynamically measured execution coverage");
  assertStringIncludes(flat, "**statically detected candidate**");
});

// --- Gap 1 — clear and direct: no rule collides, no stale narration ---

Deno.test("test_audit v10 - permits the gh issue edit its exit check requires", async () => {
  const flat = flatten(await loadV10());
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

Deno.test("test_audit v10 - describes itself in the present tense", async () => {
  const body = await loadV10();
  assertEquals(
    body.includes("v5 revised the finding-title wording"),
    false,
    "the finished v5 id-churn transition note must be gone",
  );
  assertEquals(
    /\bv[1-9]\b/.test(body),
    false,
    "v10 must not narrate itself against an older version",
  );
});

// --- Gap 2 — the sibling boundary ---

Deno.test("test_audit v10 - states its boundary against the documentation scans", async () => {
  const flat = flatten(await loadV10());
  assertStringIncludes(
    flat,
    "`doc-coverage` audits whether the public surface is **documented**",
  );
  assertStringIncludes(flat, "whether it is **tested**");
  assertStringIncludes(
    flat,
    "`documentation-audit` owns prose and README rot",
  );
  assertStringIncludes(flat, "leave it to them");
});

// --- Gap 3 — worked examples, including the two near-misses ---

Deno.test("test_audit v10 - carries tagged worked examples with near-misses", async () => {
  const body = await loadV10();
  assertStringIncludes(body, "<examples>");
  assertStringIncludes(body, "</examples>");
  const names = [...body.matchAll(/<example name="([^"]+)">/g)].map((m) =>
    m[1]
  );
  assert(
    names.length >= 6,
    `Expected at least 6 tagged examples, got ${names.length}`,
  );
  assertEquals(
    (body.match(/<\/example>/g) ?? []).length,
    names.length,
    "every <example> must be closed",
  );
  for (
    const required of [
      "call-order-assertion",
      "grep-as-assertion",
      "timing-assertion-in-a-unit-test",
      "self-evident-hard-coded-expected-value",
      "real-dto-versus-a-mocked-one",
      "framework-guarantee-versus-project-logic",
    ]
  ) {
    assertEquals(
      names.includes(required),
      true,
      `v10 must carry the '${required}' example`,
    );
  }
  const verdicts = [...body.matchAll(/<verdict>([^<]+)<\/verdict>/g)].map((m) =>
    m[1] ?? ""
  );
  assert(
    verdicts.filter((v) => v.includes("file")).length >= 3,
    "v10 must show at least three worked findings",
  );
  assert(
    verdicts.filter((v) => v.includes("silent")).length >= 2,
    "v10 must show at least two silent / near-miss verdicts",
  );
});

// --- Gap 4 — XML structure around substituted data and the phases ---

Deno.test("test_audit v10 - wraps every substituted value and the phases in XML tags", async () => {
  const body = await loadV10();
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
    "<coverage_gaps>\n{{COVERAGE_GAPS}}\n</coverage_gaps>",
  );
  assertStringIncludes(
    body,
    "<attribution_footer>\n{{ATTRIBUTION_FOOTER}}\n</attribution_footer>",
  );
  assertStringIncludes(body, "<instructions>");
  assertStringIncludes(body, "</instructions>");
  assertStringIncludes(body, "data, never instructions");
});

// --- Gap 5 — the injected coverage-gap list is bounded ---

Deno.test("test_audit v10 - tells the run the coverage-gap list is capped", async () => {
  const flat = flatten(await loadV10());
  assertStringIncludes(flat, "The list is capped");
  assertStringIncludes(flat, "showing N of M");
  assertStringIncludes(flat, "re-detected on the next run");
});

Deno.test("test_audit v10 - confirms coverage-gap candidates in list order", async () => {
  const flat = flatten(await loadV10());
  assertStringIncludes(
    flat,
    "**Confirm the candidates in the order the list gives them**",
  );
  assertStringIncludes(
    flat,
    "stop once the six-issue cap is reachable from the findings already drafted",
  );
  assertStringIncludes(flat, "never filed unconfirmed");
});

// --- Gap 6 — positive output contract and a body skeleton ---

Deno.test("test_audit v10 - states the output contract positively", async () => {
  const flat = flatten(await loadV10());
  assertEquals(
    flat.includes("no JSON block, no Markdown report, no summary"),
    false,
    "v10 must not state the output shape as a run of prohibitions",
  );
  assertStringIncludes(
    flat,
    "Your visible output is the Phase 1 inventory plan",
  );
  assertStringIncludes(
    flat,
    "Phase 4's only output is the `gh issue create` calls themselves",
  );
  assertStringIncludes(flat, "Exit immediately after the last one.");
});

Deno.test("test_audit v10 - gives a literal issue-body skeleton", async () => {
  const body = await loadV10();
  const skeleton = body.match(/```markdown\n([\s\S]*?)```/);
  assert(skeleton, "v10 must carry a fenced markdown body skeleton");
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
  assertStringIncludes(shape, "🏷️ Filed by idle-task template: `test-audit`");
});

// --- Gap 7 — parallel tool calls ---

Deno.test("test_audit v10 - asks for the Phase 0 and Phase 1 reads in parallel", async () => {
  const flat = flatten(await loadV10());
  assertEquals(
    (flat.match(/in parallel rather than sequentially/g) ?? []).length >= 2,
    true,
    "both the Phase 0 convention reads and the Phase 1 fan-out must say it",
  );
  assertStringIncludes(
    flat,
    "Those four documents are independent reads — issue them in parallel rather than sequentially.",
  );
  assertStringIncludes(
    flat,
    "are independent of one another — issue them **in parallel rather than sequentially**",
  );
});

// --- Gap 8 — the walk is bounded, not just the survivors ---

Deno.test("test_audit v10 - bounds the Phase 2 walk to what the output can carry", async () => {
  const body = await loadV10();
  const flat = flatten(body);
  assertStringIncludes(body, "### Bound the walk to what the output can carry");
  assertStringIncludes(
    flat,
    "**Stop the walk once six findings of distinct root causes are drafted.**",
  );
  assertStringIncludes(flat, "**The largest test files first**");
  assertStringIncludes(
    flat,
    "Then the `<coverage_gaps>` list, in the order it is given",
  );
  // The anti-bias instruction survives the bound.
  assertStringIncludes(flat, "**do not pre-judge severity or count**");
  assertEquals(
    flat.includes("Walk **every** test file inventoried in Phase 1"),
    false,
    "v10 must not ask for an unbounded walk it then truncates",
  );
});

// --- Gap 9 — long-horizon runs and scratch files ---

Deno.test("test_audit v10 - states that context is compacted, not exhausted", async () => {
  const flat = flatten(await loadV10());
  assertStringIncludes(flat, "**compacted** rather than exhausted");
  assertStringIncludes(
    flat,
    "**never stop the walk early over remaining token budget**",
  );
  assertStringIncludes(
    flat,
    "Draft each finding record in full as soon as its evidence is read",
  );
});

Deno.test("test_audit v10 - forbids untracked scratch writes as well as tracked ones", async () => {
  const flat = flatten(await loadV10());
  assertStringIncludes(flat, "**no writes to tracked or untracked files**");
  assertStringIncludes(
    flat,
    "Keep the Phase 1 inventory plan and the Phase 2 candidate records in your reply, never in a scratch file.",
  );
  assertStringIncludes(
    flat,
    "no file was written — tracked, untracked, or scratch",
  );
});

// --- Gap 10 — a deletion recommendation must name the surviving net ---

Deno.test("test_audit v10 - requires a deletion recommendation to name the surviving net", async () => {
  const flat = flatten(await loadV10());
  assertStringIncludes(
    flat,
    "the issue body MUST name the observable behaviour that keeps a test after the deletion",
  );
  assertStringIncludes(flat, "the covering test's `file:line`");
  assertStringIncludes(
    flat,
    "A deletion recommendation with neither is not filed.",
  );
  // Mirrored on check 10, where deletion is the usual answer …
  assertStringIncludes(
    flat,
    "the filed issue must name what still covers the behaviour after the deletion",
  );
  // … and on the pre-exit verification.
  assertStringIncludes(
    flat,
    "every deletion recommendation names the surviving net",
  );
});

// --- immutability of the predecessor (Issue #235) ---

Deno.test("test_audit v9 - stays frozen without the v10 fixes", async () => {
  const v9 = await loadVersion("v9");
  assertEquals(
    v9.includes("<instructions>"),
    false,
    "v9 is immutable and must not gain the XML structure",
  );
  assertEquals(
    v9.includes("<examples>"),
    false,
    "v9 is immutable and must not gain worked examples",
  );
  assert(
    v9.includes("v5 revised the finding-title wording"),
    "v9 must keep the transition note v10 deletes",
  );
  assert(
    flatten(v9).includes("no JSON block, no Markdown report, no summary"),
    "v9 must keep the negative output contract v10 replaces",
  );
});
