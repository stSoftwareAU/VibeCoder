/**
 * Tests for correct `needs-human` label behaviour in worker prompts (Issue #1951).
 *
 * The worker MAY apply `needs-human` — it is the designated worker-to-human
 * escalation signal. The worker MUST NOT apply other operational labels
 * (`work-on`, `planning`, `question`, etc.) — those are human-to-worker
 * control signals.
 *
 * History:
 *   - v17 (coding_guidelines) / v18 (issue): correct — applied `needs-human`.
 *   - v18 (coding_guidelines) / v19 (issue): incorrect — told the worker to
 *     request the label via comment instead of applying it (Issue #1950 fix
 *     that went too far; reverted by Issue #1951 feedback).
 *   - v19 (coding_guidelines) / v20 (issue): correct — applies `needs-human`
 *     directly while prohibiting all other operational labels.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// Operational labels the worker must never self-apply (human-to-worker controls).
// Issue #2031: needs-clarification was retired and is also forbidden — the
// clarification handoff is now the `needs-human` label.
const PROHIBITED_LABEL_PATTERNS: ReadonlyArray<RegExp> = [
  /--add-label\s+["']?work-on/i,
  /--add-label\s+["']?planning/i,
  /--add-label\s+["']?question/i,
  /--add-label\s+["']?top-priority/i,
  /--add-label\s+["']?failed/i,
  /--add-label\s+["']?needs-clarification/i,
];

function assertNoProhibitedLabelAdd(content: string, label: string): void {
  for (const pattern of PROHIBITED_LABEL_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      throw new Error(
        `${label} instructs adding a prohibited operational label: ` +
          `'${
            match[0]
          }' (pattern ${pattern}). Only needs-human may be applied.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Latest issue prompt
// ---------------------------------------------------------------------------

Deno.test("issue (latest) - allows applying needs-human label", async () => {
  const latest = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (!latest.ok) return;

  const result = await loadPrompt("issue", latest.value, PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  // The escalation section must instruct Claude to add needs-human directly.
  const hasAddDirective =
    result.value.includes("Add the `needs-human` label") ||
    result.value.includes("add the `needs-human` label");
  assertEquals(
    hasAddDirective,
    true,
    `issue/${latest.value} must instruct Claude to apply the needs-human label`,
  );
});

Deno.test("issue (latest) - still mentions needs-human", async () => {
  const latest = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (!latest.ok) return;

  const result = await loadPrompt("issue", latest.value, PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertStringIncludes(result.value, "needs-human");
});

Deno.test("issue (latest) - does not instruct adding other operational labels", async () => {
  const latest = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (!latest.ok) return;

  const result = await loadPrompt("issue", latest.value, PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertNoProhibitedLabelAdd(result.value, `issue/${latest.value}`);
});

Deno.test("issue (latest) - prohibits self-applying work-on and other control labels", async () => {
  const latest = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (!latest.ok) return;

  const result = await loadPrompt("issue", latest.value, PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  // Must explicitly list the prohibited labels.
  assertStringIncludes(result.value, "work-on");
  assertStringIncludes(result.value, "Never self-apply");
});

// ---------------------------------------------------------------------------
// Latest coding_guidelines prompt
// ---------------------------------------------------------------------------

Deno.test("coding_guidelines (latest) - allows applying needs-human label", async () => {
  const latest = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (!latest.ok) return;

  const result = await loadPrompt(
    "coding_guidelines",
    latest.value,
    PROMPTS_DIR,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;

  // The escalation section must instruct Claude to add needs-human directly.
  const hasAddDirective =
    result.value.includes("Add the `needs-human` label") ||
    result.value.includes("add the `needs-human` label");
  assertEquals(
    hasAddDirective,
    true,
    `coding_guidelines/${latest.value} must instruct Claude to apply the needs-human label`,
  );
});

Deno.test("coding_guidelines (latest) - still mentions needs-human", async () => {
  const latest = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (!latest.ok) return;

  const result = await loadPrompt(
    "coding_guidelines",
    latest.value,
    PROMPTS_DIR,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertStringIncludes(result.value, "needs-human");
});

Deno.test("coding_guidelines (latest) - does not instruct adding other operational labels", async () => {
  const latest = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (!latest.ok) return;

  const result = await loadPrompt(
    "coding_guidelines",
    latest.value,
    PROMPTS_DIR,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertNoProhibitedLabelAdd(
    result.value,
    `coding_guidelines/${latest.value}`,
  );
});

// ---------------------------------------------------------------------------
// Immutability spot-checks — frozen versions must remain unmodified.
// ---------------------------------------------------------------------------

Deno.test("issue v19 - retains its 'request via comment' wording (Issue #1950 fix)", async () => {
  // v19 introduced the request-via-comment approach (PR #1950).
  // It is now superseded by v20, but must remain immutable.
  const result = await loadPrompt("issue", "v19", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertStringIncludes(
    result.value,
    "Do **NOT** apply the `needs-human` label yourself",
    "issue/v19 must remain immutable with its request-via-comment wording",
  );
});

Deno.test("coding_guidelines v18 - retains its 'request via comment' wording (Issue #1950 fix)", async () => {
  // v18 introduced the request-via-comment approach (PR #1950).
  // It is now superseded by v19, but must remain immutable.
  const result = await loadPrompt("coding_guidelines", "v18", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertStringIncludes(
    result.value,
    "Do **NOT** apply the `needs-human` label yourself",
    "coding_guidelines/v18 must remain immutable with its request-via-comment wording",
  );
});

Deno.test("issue v18 - retains its original apply-label directive", async () => {
  // v18 is the version before PR #1950 changed the behaviour. Immutable.
  const result = await loadPrompt("issue", "v18", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  // v18 (issue) had --add-label in its content (the pre-#1950 version).
  // Verify it is still unmodified.
  assertStringIncludes(
    result.value,
    "needs-human",
    "issue/v18 must remain immutable",
  );
});

Deno.test("coding_guidelines v17 - retains its original apply-label directive", async () => {
  // v17 is the version before PR #1950 changed the behaviour. Immutable.
  const result = await loadPrompt("coding_guidelines", "v17", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertStringIncludes(
    result.value,
    "Add the `needs-human` label",
    "coding_guidelines/v17 must remain immutable with its original directive",
  );
});
