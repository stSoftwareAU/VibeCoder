/**
 * Tests for the test-audit prompt's tautological-assertion check (Issue #660).
 *
 * Audit check 11 — **tautological assertions** — covers a test whose expected
 * value is recomputed inside the test by the same algorithm the code under
 * test uses, so it passes by construction and can never disagree with the
 * implementation. Check 5 does not reach that shape: every one of its bullets
 * is about a *literal* expected value and where that literal came from, and a
 * tautological test has no literal at all.
 *
 * The contract entered the template with Issue #660 and every later revision
 * must keep it, so these cases read the shipped template.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadTestAudit(): Promise<string> {
  const result = await loadPrompt("test_audit", PROMPTS_DIR);
  assertEquals(result.ok, true, "test_audit failed to load");
  if (!result.ok) throw new Error("test_audit failed to load");
  return result.value;
}

// --- Loading contract ---

Deno.test("test_audit - keeps the dedup and attribution placeholders", async () => {
  const body = await loadTestAudit();
  for (
    const placeholder of [
      "{{SUPPRESSED_IDS}}",
      "{{KNOWN_OPEN_FINDING_IDS}}",
      "{{OPEN_ISSUE_TITLES}}",
      "{{ATTRIBUTION_FOOTER}}",
    ]
  ) {
    assertStringIncludes(body, placeholder);
  }
});

// --- Check 11: the tautological-assertion rule ---

Deno.test("test_audit - carries check 11 for tautological assertions", async () => {
  const body = await loadTestAudit();
  assertStringIncludes(body, "### 11. Tautological assertions");
  assertStringIncludes(
    body,
    "same computation the code under test performs",
  );
});

Deno.test("test_audit - check 11 names the recomputation shapes it fires on", async () => {
  const body = await loadTestAudit();
  // The three shapes the issue enumerates: a mirrored reduce/map/loop, a
  // hand-built snapshot assembled the implementation's way, and a constant
  // asserted equal to itself.
  for (
    const shape of [
      "reduce",
      "hand-built snapshot",
      "asserted equal to itself",
    ]
  ) {
    assertStringIncludes(body, shape);
  }
});

Deno.test("test_audit - check 11 carves out the two legitimate look-alikes", async () => {
  const body = await loadTestAudit();
  // A fixture-row expected value and a deliberately different reference
  // implementation used as an oracle are both legitimate and look similar.
  assertStringIncludes(body, "fixture");
  assertStringIncludes(body, "oracle");
  assertStringIncludes(body, "reference implementation");
});

Deno.test("test_audit - check 11 has a worked example and a silent near-miss", async () => {
  const body = await loadTestAudit();
  assertStringIncludes(body, '<example name="tautological-expected-value">');
  assertStringIncludes(body, "<signal>check 11");
  // The near-miss keeps the check off table-driven tests whose expected
  // value comes from the fixture row.
  assertStringIncludes(
    body,
    '<example name="table-driven-expected-value-from-the-fixture">',
  );
});

// --- Check-count bookkeeping the output format depends on ---

Deno.test("test_audit - the stable-id recipe registers the tautological slug", async () => {
  const body = await loadTestAudit();
  assertStringIncludes(body, "`tautological-expected-value`");
  assertStringIncludes(body, "which of the eleven checks");
});

Deno.test("test_audit - the check counts are numbered consistently", async () => {
  const body = await loadTestAudit();
  assertStringIncludes(body, "## Phase 2 — Apply the eleven audit checks");
  assertStringIncludes(body, "the ten test-maintainability smells");
  assert(
    !body.includes("the ten audit checks"),
    "the checklist must not still be described as ten checks",
  );
  assert(
    !body.includes("the nine test-maintainability smells"),
    "the template must not still describe nine maintainability smells",
  );
});

Deno.test("test_audit - the maintainability check range includes check 11", async () => {
  const body = await loadTestAudit();
  assert(
    !body.includes("checks 1–6 and 8–10"),
    "every check range must extend to 11",
  );
  assertStringIncludes(body, "checks 1–6 and 8–11");
});

Deno.test("test_audit - severity guidance covers a tautological finding", async () => {
  const body = await loadTestAudit();
  const severitySection = body.slice(body.indexOf("### Severity guidance"));
  assertStringIncludes(severitySection, "tautological");
});
