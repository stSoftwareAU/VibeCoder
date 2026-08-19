/**
 * Tests for private_repo_reference_audit prompt v3 (Issue #3805, parent
 * #3767).
 *
 * v3 closes the eight best-practice gaps the #3774 audit recorded
 * against v2:
 *
 *   1. three rule collisions resolved — the unrunnable "enumerate the
 *      private repos" instruction is replaced by a candidate harvest
 *      from this repo's own text, `gh issue edit` joins the permitted
 *      set, and the `|| true` label guard is a named carve-out from the
 *      no-shell rule
 *   2. tagged `<example>` blocks covering both error directions,
 *      including the concept-level and public-repo near-misses
 *   3. `<suppressed_ids>` / `<known_open_finding_ids>` /
 *      `<attribution_footer>` / `<instructions>` tags, reusing the
 *      vocabulary the sibling scan prompts already share
 *   4. a positive output contract plus a literal issue-body skeleton
 *      that shows where the attribution footer sits
 *   5. a parallel instruction on the surface searches and the
 *      per-candidate visibility lookups
 *   6. three bounded search passes with a stated stopping condition,
 *      replacing the unguided whole-surface walk
 *   7. a context-is-compacted clause for the whole-repo run
 *   8. the `format_drift` no-scratch-file wording, tied to the
 *      never-quote-private-content rule
 *
 * Also guards immutability of v2 (Issue #235).
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const FAMILY = "private_repo_reference_audit";

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

Deno.test("private_repo_reference_audit v3 - loads and is the latest version", async () => {
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

Deno.test("private_repo_reference_audit v3 - substitutes exactly what v2 did", async () => {
  const body = await loadV3();
  assertEquals(placeholders(body), placeholders(await loadVersion("v2")));
  const validation = validatePromptTemplate(FAMILY, body);
  assertEquals(validation.ok, true);
});

Deno.test("private_repo_reference_audit v3 - keeps the load-bearing worker contracts", async () => {
  const body = await loadV3();
  assert(
    /^#+\s+Private-Repo Reference Audit\b/m.test(body),
    "v3 must keep the 'Private-Repo Reference Audit' H1 fingerprint",
  );
  for (
    const contract of [
      "BP-<12 hex>",
      '"private-repo-reference"',
      "<!-- finding-id:",
      "BP- in:body",
      "severity:high|severity:medium|severity:low",
      "Never quote private content",
      "expires=<YYYY-MM-DD>",
      "author=<github-login>",
      "Rejected suppression:",
      "the deterministic suppression check applies",
      "(`🟠` high, `🟡` medium, `🟢` low)",
    ]
  ) {
    assertStringIncludes(body, contract);
  }
  assertEquals(
    /worker\/deno\//.test(body),
    false,
    "v3 is filed verbatim cross-repo and must cite no VibeCoder path",
  );
});

// Gap 1 — no rule may collide with another, and every rule must be runnable.
Deno.test("private_repo_reference_audit v3 - replaces the unrunnable private-repo enumeration", async () => {
  const body = await loadV3();
  const flat = flatten(body);
  assertEquals(
    /Best-effort via `gh` repo metadata/.test(body),
    false,
    "v3 must drop the enumeration instruction the worker identity cannot run",
  );
  assertStringIncludes(
    flat,
    "a private repo is invisible to the worker identity, so no listing returns it",
  );
  assertStringIncludes(
    flat,
    "the candidate set comes from this repository's own text",
  );
});

Deno.test("private_repo_reference_audit v3 - permits gh issue edit and names its Phase 4 purpose", async () => {
  const flat = flatten(await loadV3());
  assertStringIncludes(flat, "`gh issue edit` (Phase 4 only, and only to");
  assertStringIncludes(flat, "correct an issue you just filed)");
});

Deno.test("private_repo_reference_audit v3 - carves the label block out of the no-shell rule", async () => {
  const flat = flatten(await loadV3());
  assertStringIncludes(
    flat,
    "the one sanctioned shell construct in this template",
  );
  assertStringIncludes(flat, "it runs no repo logic");
});

// Gap 2 — worked examples covering both error directions.
Deno.test("private_repo_reference_audit v3 - carries tagged worked examples with near-misses", async () => {
  const body = await loadV3();
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
      "clone-of-private-repo-in-test",
      "concept-level-mention",
      "private-derived-fixture-directory",
      "docs-further-reading-slug",
      "public-stsoftware-repo",
      "historical-layout-comment",
    ]
  ) {
    assertEquals(
      names.includes(required),
      true,
      `v3 must carry the '${required}' example`,
    );
  }
  const verdicts = [...body.matchAll(/<verdict>([^<]+)<\/verdict>/g)].map((m) =>
    m[1] ?? ""
  );
  assert(
    verdicts.filter((v) => v.includes("file")).length >= 3,
    "v3 must show at least three worked findings",
  );
  assert(
    verdicts.filter((v) => v.includes("silent")).length >= 2,
    "v3 must show at least two negative / near-miss verdicts",
  );
  // Every example must name the check it maps to, or say why none fires.
  assert(
    (body.match(/<check>/g) ?? []).length === names.length,
    "every example must record the check number it maps to",
  );
});

Deno.test("private_repo_reference_audit v3 - keeps the fixture example content-free", async () => {
  const body = await loadV3();
  const fixture = body.match(
    /<example name="private-derived-fixture-directory">[\s\S]*?<\/example>/,
  );
  assert(fixture, "the fixture example must exist");
  const flat = flatten(fixture?.[0] ?? "");
  assertStringIncludes(flat, "by path and provenance");
});

// Gap 3 — XML structure around every substituted value and the phase bodies.
Deno.test("private_repo_reference_audit v3 - wraps all three substituted values in XML tags", async () => {
  const body = await loadV3();
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

// Gap 4 — positive output contract and a shown issue-body skeleton.
Deno.test("private_repo_reference_audit v3 - states the output contract positively", async () => {
  const body = await loadV3();
  const flat = flatten(body);
  assertEquals(
    body.includes("no JSON block, no Markdown report, no summary"),
    false,
    "v3 must not state the output shape as a run of prohibitions",
  );
  assertEquals(
    body.includes("Your printed reply is irrelevant"),
    false,
    "v3 must not tell the model its reply is irrelevant",
  );
  assertStringIncludes(flat, "Your visible output is the Phase 1 plan");
  assertStringIncludes(flat, "Exit immediately after the last one.");
});

Deno.test("private_repo_reference_audit v3 - shows the issue body as a skeleton ending in the footer", async () => {
  const body = await loadV3();
  const skeleton = body.match(/```markdown\n([\s\S]*?)```/);
  assert(skeleton, "v3 must carry a fenced markdown body skeleton");
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

// Gap 5 — independent searches and lookups issued in parallel.
Deno.test("private_repo_reference_audit v3 - asks for the searches and lookups in parallel", async () => {
  const flat = flatten(await loadV3());
  assertStringIncludes(
    flat,
    "are independent of one another — issue them **in parallel rather than sequentially**",
  );
  assertStringIncludes(
    flat,
    "Only sequence a call when it needs the result of a previous one",
  );
});

// Gap 6 — bounded exploration with a stopping condition.
Deno.test("private_repo_reference_audit v3 - bounds Phase 1 to three search passes", async () => {
  const body = await loadV3();
  const flat = flatten(body);
  assertStringIncludes(flat, "three bounded search passes");
  for (
    const pass of [
      "**Pass 1 — harvest candidates from this repo's own text.**",
      "**Pass 2 — resolve each candidate's visibility, once.**",
      "**Pass 3 — sweep the confirmed-private names across the surface.**",
    ]
  ) {
    assertStringIncludes(flat, pass);
  }
  assertStringIncludes(flat, "**Stopping condition.**");
  assertStringIncludes(
    flat,
    "a private repo this repo never names cannot be referenced by it",
  );
});

// Gap 7 — long-horizon state tracking across a whole-repo run.
Deno.test("private_repo_reference_audit v3 - states that context is compacted, not exhausted", async () => {
  const flat = flatten(await loadV3());
  assertStringIncludes(flat, "**compacted** rather than exhausted");
  assertStringIncludes(
    flat,
    "**Do not stop the scan early over remaining token budget**",
  );
  assertStringIncludes(
    flat,
    "Record each confirmed-private name and each candidate location in the Phase 1 plan as you find it",
  );
});

// Gap 8 — no scratch files, tied to the confidentiality rule.
Deno.test("private_repo_reference_audit v3 - forbids scratch files and says why it matters here", async () => {
  const flat = flatten(await loadV3());
  assertStringIncludes(flat, "**no writes to tracked or untracked files**");
  assertStringIncludes(
    flat,
    "Keep the Phase 1 plan and the Phase 2 candidate list in your reply, never in a scratch file",
  );
  assertStringIncludes(
    flat,
    "a scratch note holds exactly the private names and paths this scan exists to keep out of the public repo",
  );
  assertStringIncludes(
    flat,
    "no file was written — tracked, untracked, or scratch",
  );
});

// --- immutability of the predecessor (Issue #235) ---

Deno.test("private_repo_reference_audit v2 - stays frozen without the v3 fixes", async () => {
  const v2 = await loadVersion("v2");
  assertEquals(
    v2.includes("<instructions>"),
    false,
    "v2 is immutable and must not gain the XML structure",
  );
  assertEquals(
    v2.includes("<examples>"),
    false,
    "v2 is immutable and must not gain worked examples",
  );
  assert(
    v2.includes("Best-effort via `gh` repo metadata"),
    "v2 must keep the unrunnable enumeration wording v3 replaces",
  );
  assert(
    v2.includes("no JSON block, no Markdown report, no summary"),
    "v2 must keep the prohibition-shaped output contract v3 replaces",
  );
});
