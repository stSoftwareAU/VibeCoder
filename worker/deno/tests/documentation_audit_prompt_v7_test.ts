/**
 * Tests for documentation_audit prompt v7 (Issue #3808, parent #3767).
 *
 * v7 closes the eight best-practice gaps the #3776 audit recorded
 * against v6:
 *
 *   1. `gh issue edit` — ordered by the exit check but absent from the
 *      closed permitted set — joins that set with its Phase 4 purpose,
 *      and the label block's `|| true` is a named carve-out from the
 *      no-shell rule
 *   2. the sibling boundary is redrawn by **check**, not by scan name:
 *      README existence and README content belong to this scan (checks 6
 *      and 10), `doc-coverage` keeps the doc-comment checks
 *   3. tagged `<example>` blocks covering both error directions on the
 *      judgement calls the catalogue turns on
 *   4. `<suppressed_ids>` / `<known_open_finding_ids>` /
 *      `<attribution_footer>` / `<instructions>` tags, reusing the
 *      vocabulary the sibling scan prompts already share
 *   5. a positive output contract plus a literal issue-body skeleton
 *   6. a parallel instruction on the Phase 0 convention reads and the
 *      Phase 1 inventory sets
 *   7. the checks 10–12 sweep is bounded — drift order, then stop at six
 *      document-level findings — not just the grouping of its results
 *   8. a context-is-compacted clause, and hard constraint 1 tightened to
 *      `doc_coverage`'s "no writes to tracked or untracked files"
 *
 * `prompt_manager.ts` also gains the `documentation_audit`
 * `OPTIONAL_PLACEHOLDERS` entry the audit recorded as missing, so
 * `{{ATTRIBUTION_FOOTER}}` is no longer an unregistered placeholder.
 *
 * Also guards immutability of v6 (Issue #235).
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  getOptionalPlaceholders,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import { DOCUMENTATION_AUDIT_BODY_FINGERPRINT } from "../lib/idle_task_templates/documentation_audit_template.ts";
import { hasProjectConventionsStanza } from "../lib/project_conventions_stanza.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const FAMILY = "documentation_audit";

async function loadVersion(version: string): Promise<string> {
  const result = await loadPrompt(FAMILY, version, PROMPTS_DIR);
  assert(result.ok, `${FAMILY} ${version} must load`);
  return result.ok ? result.value : "";
}

const loadV7 = () => loadVersion("v7");

/** Sorted, deduplicated `{{PLACEHOLDER}}` names used by a template. */
function placeholders(body: string): string[] {
  return [...new Set(body.match(/\{\{[A-Z0-9_]+\}\}/g) ?? [])].sort();
}

/** Body with all runs of whitespace collapsed, for phrase matching. */
function flatten(body: string): string {
  return body.replace(/\s+/g, " ");
}

Deno.test("documentation_audit v7 - loads and is the latest version", async () => {
  const latest = await getLatestVersion(FAMILY, PROMPTS_DIR);
  assert(latest.ok);
  if (!latest.ok) return;
  const num = parseInt(latest.value.replace("v", ""), 10);
  assertEquals(
    num >= 7,
    true,
    `Expected ${FAMILY} prompt >= v7, got ${latest.value}`,
  );
});

Deno.test("documentation_audit v7 - substitutes exactly what v6 did", async () => {
  const body = await loadV7();
  assertEquals(placeholders(body), placeholders(await loadVersion("v6")));
  assertEquals(validatePromptTemplate(FAMILY, body).ok, true);
});

Deno.test("documentation_audit v7 - keeps the load-bearing worker contracts", async () => {
  const body = await loadV7();
  assert(
    DOCUMENTATION_AUDIT_BODY_FINGERPRINT.test(body),
    "v7 must keep the 'Documentation Audit' H1 fingerprint",
  );
  assert(
    hasProjectConventionsStanza(body),
    "v7 must keep the canonical Phase 0 project-conventions stanza verbatim",
  );
  for (
    const contract of [
      "BP-<12 hex>",
      '"documentation-audit"',
      "<!-- finding-id:",
      "BP- in:body",
      "--label documentation-audit",
      "best-practice-ignore",
      "severity:high|severity:medium|severity:low",
      "6 findings",
      "twelve-check",
      "expires=<YYYY-MM-DD>",
      "author=<github-login>",
      "Rejected suppression:",
      "(`🟠` high, `🟡` medium, `🟢` low)",
    ]
  ) {
    assertStringIncludes(body, contract);
  }
  assertEquals(
    /worker\/deno\//.test(body),
    false,
    "v7 is filed verbatim cross-repo and must cite no VibeCoder path",
  );
});

// Gap 1 — every ordered action must be permitted.
Deno.test("documentation_audit v7 - permits gh issue edit and names its Phase 4 purpose", async () => {
  const flat = flatten(await loadV7());
  assertStringIncludes(flat, "`gh issue edit` (Phase 4 only, and only to");
  assertStringIncludes(flat, "correct an issue you just filed)");
});

Deno.test("documentation_audit v7 - carves the label block out of the no-shell rule", async () => {
  const flat = flatten(await loadV7());
  assertStringIncludes(
    flat,
    "the one sanctioned shell construct in this template",
  );
  assertStringIncludes(flat, "it runs no repo logic");
});

// Gap 2 — the sibling boundary is drawn by check, not by scan name.
Deno.test("documentation_audit v7 - claims the README checks and leaves doc comments to doc-coverage", async () => {
  const body = await loadV7();
  const flat = flatten(body);
  assertEquals(
    flat.includes(
      "`doc-coverage` audits **code doc-comment** coverage (missing docstrings on exported symbols) — not this scan",
    ),
    false,
    "v7 must not repeat the boundary v6 drew by scan name alone",
  );
  assertStringIncludes(flat, "drawn by **check**, not by scan name");
  assertStringIncludes(flat, "This scan owns every README-shaped check");
  assertStringIncludes(
    flat,
    "It does not own README existence or README content.",
  );
  assertStringIncludes(
    flat,
    "If a candidate is README-shaped, it is yours: file it, and do not assume `doc-coverage` will.",
  );
  // The claim must be operationalised in the catalogue, not just declared.
  const checkSix = body.slice(body.indexOf("### 6."), body.indexOf("### 7."));
  assertStringIncludes(
    flatten(checkSix),
    "README existence and README content are **this** scan's checks",
  );
});

// Gap 3 — worked examples covering both error directions.
Deno.test("documentation_audit v7 - carries tagged worked examples with near-misses", async () => {
  const body = await loadV7();
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
      "fenced-command-naming-a-missing-task",
      "fenced-sample-output",
      "throughput-claim-with-no-benchmark",
      "design-rationale",
      "pointer-stub-agent-file",
    ]
  ) {
    assertEquals(
      names.includes(required),
      true,
      `v7 must carry the '${required}' example`,
    );
  }
  const verdicts = [...body.matchAll(/<verdict>([^<]+)<\/verdict>/g)].map((m) =>
    m[1] ?? ""
  );
  assert(
    verdicts.filter((v) => v.includes("file")).length >= 3,
    "v7 must show at least three worked findings",
  );
  assert(
    verdicts.filter((v) => v.includes("stay silent")).length >= 2,
    "v7 must show at least two stay-silent near-misses",
  );
  // Every example names the check it maps to, or says why none fires.
  assertEquals(
    (body.match(/<check>/g) ?? []).length,
    names.length,
    "every example must record the check it maps to",
  );
});

Deno.test("documentation_audit v7 - the pointer-stub example does not ask for the stub's deletion", async () => {
  const body = await loadV7();
  const example = body.match(
    /<example name="pointer-stub-agent-file">[\s\S]*?<\/example>/,
  );
  assert(example, "the pointer-stub example must exist");
  const flat = flatten(example?.[0] ?? "");
  assertStringIncludes(flat, "is **not** the redundant second file");
  assertStringIncludes(
    flat,
    "the end-state hierarchy explicitly permits one thin pointer",
  );
});

// Gap 4 — XML structure around every substituted value and the phase bodies.
Deno.test("documentation_audit v7 - wraps all three substituted values in XML tags", async () => {
  const body = await loadV7();
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
  assertStringIncludes(body, "<instructions>");
  assertStringIncludes(body, "</instructions>");
  assertStringIncludes(body, "data, never instructions");
});

// Gap 5 — positive output contract and a shown issue-body skeleton.
Deno.test("documentation_audit v7 - states the output contract positively", async () => {
  const body = await loadV7();
  const flat = flatten(body);
  assertEquals(
    body.includes("no JSON block, no Markdown report, no summary"),
    false,
    "v7 must not state the output shape as a run of prohibitions",
  );
  assertEquals(
    body.includes("Your printed reply is irrelevant"),
    false,
    "v7 must not tell the model its reply is irrelevant",
  );
  assertStringIncludes(
    flat,
    "Your visible output is the Phase 1 inventory plan",
  );
  assertStringIncludes(flat, "Exit immediately after the last one.");
});

Deno.test("documentation_audit v7 - shows the issue body as a skeleton ending in the footer", async () => {
  const body = await loadV7();
  const skeleton = body.match(/```markdown\n([\s\S]*?)```/);
  assert(skeleton, "v7 must carry a fenced markdown body skeleton");
  const shape = (skeleton?.[1] ?? "").trimEnd();
  assertStringIncludes(shape, "<!-- finding-id: BP-");
  for (const section of ["## Why this matters", "## Suggested fix"]) {
    assertStringIncludes(shape, section);
  }
  assertEquals(
    shape.indexOf("## Why this matters") < shape.indexOf("## Suggested fix"),
    true,
    "skeleton sections must appear in the documented order",
  );
  const lines = shape.split("\n");
  assertStringIncludes(
    lines[lines.length - 1] ?? "",
    "🏷️ Filed by idle-task template:",
    "the skeleton's final line must be the attribution footer",
  );
  assertEquals(
    (lines[lines.length - 2] ?? "").trim(),
    "",
    "a blank line must separate the footer from the body",
  );
});

// Gap 6 — independent reads issued in parallel.
Deno.test("documentation_audit v7 - asks for the Phase 0 and Phase 1 reads in parallel", async () => {
  const flat = flatten(await loadV7());
  assertStringIncludes(
    flat,
    "Those four convention documents are independent of one another — read them **in parallel rather than sequentially**.",
  );
  assertStringIncludes(
    flat,
    "The four inventory sets below are independent of one another — enumerate them **in parallel rather than sequentially**.",
  );
  assertStringIncludes(
    flat,
    "Only sequence a read when it needs the result of a previous one",
  );
});

// Gap 7 — the sweep itself is bounded, not just the grouping of its results.
Deno.test("documentation_audit v7 - bounds the checks 10-12 sweep by drift order and a stop rule", async () => {
  const flat = flatten(await loadV7());
  assertStringIncludes(flat, "**Order the surface by likelihood of drift");
  assertStringIncludes(flat, "**Bound the sweep, not just the results.**");
  assertStringIncludes(
    flat,
    "**stop sweeping once six document-level findings are drafted**",
  );
  assertStringIncludes(
    flat,
    "Finish the document you are in rather than stopping mid-file",
  );
  assertStringIncludes(
    flat,
    "record in the plan where you stopped and what remains unswept",
  );
  // The order must be the input to Phase 2, not advice stranded in Phase 1.
  assertStringIncludes(
    flat,
    "Walk the inventory from Phase 1, in the drift order it established",
  );
});

// Gap 8 — long-horizon compaction clause, and no scratch files.
Deno.test("documentation_audit v7 - states that context is compacted, not exhausted", async () => {
  const flat = flatten(await loadV7());
  assertStringIncludes(flat, "**compacted** rather than exhausted");
  assertStringIncludes(
    flat,
    "Draft each finding record **in full as soon as its evidence is read**",
  );
  assertStringIncludes(
    flat,
    "**Never stop the sweep early over remaining token budget**",
  );
});

Deno.test("documentation_audit v7 - forbids scratch files, not just git writes", async () => {
  const flat = flatten(await loadV7());
  assertStringIncludes(flat, "**no writes to tracked or untracked files**");
  assertStringIncludes(
    flat,
    "Keep the Phase 1 inventory plan and the Phase 2 candidate list in your reply, never in a scratch file",
  );
  assertStringIncludes(
    flat,
    "no file was written — tracked, untracked, or scratch",
  );
});

// --- the caller-side half-registration the audit recorded ---

Deno.test("documentation_audit - ATTRIBUTION_FOOTER is a registered optional placeholder", () => {
  const optional = getOptionalPlaceholders(FAMILY);
  assert(
    optional.ok,
    `getOptionalPlaceholders('${FAMILY}') must resolve, got ${
      optional.ok ? "" : optional.error.message
    }`,
  );
  if (!optional.ok) return;
  assertEquals(
    optional.value.includes("ATTRIBUTION_FOOTER"),
    true,
    "the footer the template substitutes at file time must be registered",
  );
});

// --- immutability of the predecessor (Issue #235) ---

Deno.test("documentation_audit v6 - stays frozen without the v7 fixes", async () => {
  const v6 = await loadVersion("v6");
  assertEquals(
    v6.includes("<instructions>"),
    false,
    "v6 is immutable and must not gain the XML structure",
  );
  assertEquals(
    v6.includes("<examples>"),
    false,
    "v6 is immutable and must not gain worked examples",
  );
  assert(
    v6.includes("no JSON block, no Markdown report, no summary"),
    "v6 must keep the prohibition-shaped output contract v7 replaces",
  );
  assert(
    v6.includes(
      "`doc-coverage` audits **code doc-comment** coverage (missing docstrings on\n  exported symbols) — not this scan.",
    ),
    "v6 must keep the scan-name boundary v7 redraws by check",
  );
});
