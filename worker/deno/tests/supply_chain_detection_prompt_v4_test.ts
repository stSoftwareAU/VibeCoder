/**
 * Tests for supply_chain_detection prompt v4 (Issue #3803, parent #3767).
 *
 * v4 closes the seven best-practice gaps the #3774 audit recorded
 * against v3:
 *
 *   1. three rule collisions resolved — `gh issue edit` is permitted,
 *      the `|| true` label guard is a named carve-out from the no-shell
 *      rule, and `SCD-TYPOSQUAT` is grounded in two co-declared
 *      dependencies instead of recalled package popularity
 *   2. a tagged `<examples>` block, including the vendor-CDN near-miss
 *   3. `<suppressed_ids>` / `<known_open_finding_ids>` / `<instructions>`
 *      tags, reusing the vocabulary the sibling scan prompts already use
 *   4. a positive output contract plus a literal issue-body skeleton,
 *      and the family's `🟠`/`🟡`/`🟢` severity emoji map
 *   5. a parallel-reads instruction on the inventory fan-out
 *   6. a context-compaction clause for long lockfile walks
 *   7. the `format_drift` no-scratch-file wording
 *
 * Also guards immutability of v3 (Issue #235).
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

async function loadVersion(version: string): Promise<string> {
  const result = await loadPrompt(
    "supply_chain_detection",
    version,
    PROMPTS_DIR,
  );
  assert(result.ok, `supply_chain_detection ${version} must load`);
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

Deno.test("supply_chain_detection v4 - loads and is the latest version", async () => {
  const latest = await getLatestVersion("supply_chain_detection", PROMPTS_DIR);
  assert(latest.ok);
  if (!latest.ok) return;
  const num = parseInt(latest.value.replace("v", ""), 10);
  assertEquals(
    num >= 4,
    true,
    `Expected supply_chain_detection prompt >= v4, got ${latest.value}`,
  );
});

Deno.test("supply_chain_detection v4 - substitutes exactly what v3 did", async () => {
  const body = await loadV4();
  assertEquals(placeholders(body), placeholders(await loadVersion("v3")));
  const validation = validatePromptTemplate("supply_chain_detection", body);
  assertEquals(validation.ok, true);
});

Deno.test("supply_chain_detection v4 - keeps the load-bearing worker contracts", async () => {
  const body = await loadV4();
  assert(
    /^#+\s+Supply-chain detection\b/m.test(body),
    "v4 must keep the 'Supply-chain detection' H1 fingerprint",
  );
  for (
    const contract of [
      "SEC-<12 hex>",
      '"supply-chain-detection"',
      "SCD-INSTALL-SCRIPT",
      "SCD-DEP-CONFUSION",
      "SCD-TYPOSQUAT",
      "SCD-FLOATING-PIN",
      "SCD-UNVERIFIED-SOURCE",
      "<!-- finding-id:",
      "SEC- in:body",
      "security-scan-ignore",
      "severity:high|severity:medium|severity:low",
      "static-evidence only",
      "do not contact a registry or the network",
      "expires=<YYYY-MM-DD>",
      "Rejected suppression:",
      "the deterministic suppression check applies",
    ]
  ) {
    assertStringIncludes(body, contract);
  }
});

// Gap 1 — no rule may collide with another.
Deno.test("supply_chain_detection v4 - permits gh issue edit and names its Phase 4 purpose", async () => {
  const flat = flatten(await loadV4());
  assertStringIncludes(flat, "`gh issue edit` (Phase 4 only, and only to");
  assertStringIncludes(flat, "correct an issue you just filed)");
});

Deno.test("supply_chain_detection v4 - carves the label block out of the no-shell rule", async () => {
  const flat = flatten(await loadV4());
  assertStringIncludes(
    flat,
    "the one sanctioned shell construct in this template",
  );
  assertStringIncludes(flat, "it runs no repo logic");
});

Deno.test("supply_chain_detection v4 - grounds SCD-TYPOSQUAT in two co-declared dependencies", async () => {
  const body = await loadV4();
  const flat = flatten(body);
  assertEquals(
    /well-known popular package/.test(body),
    false,
    "v4 must not ask for a recalled popularity judgement",
  );
  assertStringIncludes(flat, "**Both** names must be committed in this");
  assertStringIncludes(
    flat,
    "a popularity judgement drawn from recall is **not** evidence",
  );
  assertStringIncludes(flat, "Cite both manifest/lockfile lines");
});

// Gap 2 — worked examples, including a near-miss.
Deno.test("supply_chain_detection v4 - carries tagged worked examples with negatives", async () => {
  const body = await loadV4();
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
      "postinstall-harvests-env",
      "node-gyp-rebuild",
      "vendor-cdn-prebuilt-binary",
      "internal-scope-with-npmrc-mapping",
      "caret-range-with-lockfile",
    ]
  ) {
    assertEquals(
      names.includes(required),
      true,
      `v4 must carry the '${required}' example`,
    );
  }
  // At least one fire verdict and several silent ones.
  const verdicts = [...body.matchAll(/<verdict>([^<]+)<\/verdict>/g)].map((m) =>
    m[1] ?? ""
  );
  assert(
    verdicts.some((v) => v.includes("file")),
    "v4 must show at least one worked finding",
  );
  assert(
    verdicts.filter((v) => v.includes("silent")).length >= 3,
    "v4 must show at least three negative / near-miss verdicts",
  );
});

// Gap 3 — XML structure around substituted data and the phase bodies.
Deno.test("supply_chain_detection v4 - wraps both substituted lists and the phases in XML tags", async () => {
  const body = await loadV4();
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

// Gap 4 — positive output contract, a body skeleton, one emoji map.
Deno.test("supply_chain_detection v4 - states the output contract positively", async () => {
  const body = await loadV4();
  const flat = flatten(body);
  assertEquals(
    body.includes("no JSON block, no Markdown report, no summary"),
    false,
    "v4 must not state the output shape as a run of prohibitions",
  );
  assertEquals(
    body.includes("Your printed reply is irrelevant"),
    false,
    "v4 must not tell the model its reply is irrelevant",
  );
  assertStringIncludes(
    flat,
    "Your visible output is the Phase 1 check plan",
  );
  assertStringIncludes(flat, "Exit immediately after the last one.");
});

Deno.test("supply_chain_detection v4 - gives a literal issue-body skeleton", async () => {
  const body = await loadV4();
  const skeleton = body.match(/```markdown\n([\s\S]*?)```/);
  assert(skeleton, "v4 must carry a fenced markdown body skeleton");
  const shape = skeleton?.[1] ?? "";
  assertStringIncludes(shape, "<!-- finding-id: SEC-");
  for (
    const section of [
      "## Why this matters",
      "## Evidence",
      "## Suggested action",
      "## Cross-links",
    ]
  ) {
    assertStringIncludes(shape, section);
  }
  // The sections must appear in the documented order.
  const order = [
    "## Why this matters",
    "## Evidence",
    "## Suggested action",
    "## Cross-links",
  ].map((s) => shape.indexOf(s));
  assertEquals(
    order.every((pos, i) => pos > 0 && (i === 0 || pos > (order[i - 1] ?? -1))),
    true,
    "skeleton sections must appear in order",
  );
});

Deno.test("supply_chain_detection v4 - adopts the family severity emoji map", async () => {
  const body = await loadV4();
  assertStringIncludes(body, "(`🟠` high, `🟡` medium, `🟢` low");
  assertEquals(
    body.includes("🔴"),
    false,
    "v4 must drop the 🔴 high marker the sibling scan prompts do not use",
  );
});

// Gap 5 — parallel reads across the inventory fan-out.
Deno.test("supply_chain_detection v4 - asks for the inventory reads in parallel", async () => {
  const flat = flatten(await loadV4());
  assertStringIncludes(
    flat,
    "are independent of one another — issue them **in parallel rather than sequentially**",
  );
  assertStringIncludes(
    flat,
    "Only sequence a read when it needs the result of a previous one",
  );
});

// Gap 6 — long-horizon state tracking.
Deno.test("supply_chain_detection v4 - states that context is compacted, not exhausted", async () => {
  const flat = flatten(await loadV4());
  assertStringIncludes(flat, "**compacted** rather than exhausted");
  assertStringIncludes(
    flat,
    "**do not stop the scan early over remaining token budget**",
  );
  assertStringIncludes(flat, "Walk lockfile entries in file order");
});

// Gap 7 — no scratch files.
Deno.test("supply_chain_detection v4 - forbids scratch and helper files", async () => {
  const flat = flatten(await loadV4());
  assertStringIncludes(flat, "**no writes to tracked or untracked files**");
  assertStringIncludes(
    flat,
    "Keep the Phase 1 check plan and the Phase 2 candidate list in your reply, never in a scratch file.",
  );
  assertStringIncludes(
    flat,
    "no file was written — tracked, untracked, or scratch",
  );
});

// --- immutability of the predecessor (Issue #235) ---

Deno.test("supply_chain_detection v3 - stays frozen without the v4 fixes", async () => {
  const v3 = await loadVersion("v3");
  assertEquals(
    v3.includes("<instructions>"),
    false,
    "v3 is immutable and must not gain the XML structure",
  );
  assertEquals(
    v3.includes("<examples>"),
    false,
    "v3 is immutable and must not gain worked examples",
  );
  assert(
    v3.includes("🔴"),
    "v3 must keep the emoji map it shipped with",
  );
  assert(
    /well-known popular package/.test(v3),
    "v3 must keep the recall-based typosquat wording v4 replaces",
  );
});
