/**
 * Tests for test-audit prompt v12 (Issue #660).
 *
 * v12 adds audit check 11 — **tautological assertions**: a test whose
 * expected value is recomputed inside the test by the same algorithm the
 * code under test uses, so it passes by construction and can never
 * disagree with the implementation. Check 5 does not reach that shape:
 * every one of its bullets is about a *literal* expected value and where
 * that literal came from, and a tautological test has no literal at all.
 *
 * v11 stays immutable and serves as the negative control — each check-11
 * assertion asserts the gap is present in v11 and closed in v12, so the
 * suite fails against the unfixed prompt tree.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadTestAudit(version: string): Promise<string> {
  const result = await loadPrompt("test_audit", version, PROMPTS_DIR);
  assertEquals(result.ok, true, `test_audit ${version} failed to load`);
  if (!result.ok) throw new Error(`test_audit ${version} failed to load`);
  return result.value;
}

const loadV11 = () => loadTestAudit("v11");
const loadV12 = () => loadTestAudit("v12");

// --- Version resolution ---

Deno.test("test_audit v12 - is the version this contract entered at", async () => {
  // Issue #786 minted v13 (the ratio-assertion carve-out in check 3), so v12
  // is no longer what the worker resolves. What this file pins is the
  // contract v12 introduced — check 11 — and that contract must survive every
  // later version, so the resolution check is "v12 or newer" and the
  // comparison is against whatever is latest.
  const latest = await getLatestVersion("test_audit", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (!latest.ok) return;
  const version = parseInt(latest.value.replace("v", ""), 10);
  assertEquals(
    version >= 12,
    true,
    `Expected test_audit >= v12, got ${latest.value}`,
  );

  const [byName, byVersion] = await Promise.all([
    loadPrompt("test_audit", undefined, PROMPTS_DIR),
    loadPrompt("test_audit", latest.value, PROMPTS_DIR),
  ]);
  assertEquals(byName.ok, true);
  assertEquals(byVersion.ok, true);
  if (!byName.ok || !byVersion.ok) return;
  assertEquals(byName.value, byVersion.value);
});

Deno.test("test_audit v12 - keeps the dedup and attribution placeholders", async () => {
  const body = await loadV12();
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

Deno.test("test_audit v12 - adds check 11 for tautological assertions", async () => {
  const [v11, v12] = await Promise.all([loadV11(), loadV12()]);
  assert(
    !/### 11\./.test(v11),
    "v11 is the negative control: it must have no check 11",
  );
  assertStringIncludes(v12, "### 11. Tautological assertions");
  assertStringIncludes(
    v12,
    "same computation the code under test performs",
  );
});

Deno.test("test_audit v12 - check 11 names the recomputation shapes it fires on", async () => {
  const v12 = await loadV12();
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
    assertStringIncludes(v12, shape);
  }
});

Deno.test("test_audit v12 - check 11 carves out the two legitimate look-alikes", async () => {
  const [v11, v12] = await Promise.all([loadV11(), loadV12()]);
  // A fixture-row expected value and a deliberately different reference
  // implementation used as an oracle are both legitimate and look similar.
  assertStringIncludes(v12, "fixture");
  assertStringIncludes(v12, "oracle");
  assertStringIncludes(v12, "reference implementation");
  assert(
    !v11.includes("oracle"),
    "v11 is the negative control: it must not carve out the oracle case",
  );
});

Deno.test("test_audit v12 - check 11 has a worked example and a silent near-miss", async () => {
  const [v11, v12] = await Promise.all([loadV11(), loadV12()]);
  assertStringIncludes(v12, '<example name="tautological-expected-value">');
  assertStringIncludes(v12, "<signal>check 11");
  // The near-miss keeps the check off table-driven tests whose expected
  // value comes from the fixture row.
  assertStringIncludes(
    v12,
    '<example name="table-driven-expected-value-from-the-fixture">',
  );
  assert(
    !v11.includes("check 11"),
    "v11 is the negative control: no check 11 example",
  );
});

// --- Check-count bookkeeping the output format depends on ---

Deno.test("test_audit v12 - the stable-id recipe registers the new slug", async () => {
  const [v11, v12] = await Promise.all([loadV11(), loadV12()]);
  assertStringIncludes(v12, "`tautological-expected-value`");
  assertStringIncludes(v12, "which of the eleven checks");
  assert(
    !v11.includes("tautological-expected-value"),
    "v11 is the negative control: no tautological slug",
  );
});

Deno.test("test_audit v12 - renumbers the check counts consistently", async () => {
  const [v11, v12] = await Promise.all([loadV11(), loadV12()]);
  assertStringIncludes(v11, "## Phase 2 — Apply the ten audit checks");
  assertStringIncludes(v12, "## Phase 2 — Apply the eleven audit checks");
  assertStringIncludes(v12, "the ten test-maintainability smells");
  assert(
    !v12.includes("the ten audit checks"),
    "v12 must not still describe the checklist as ten checks",
  );
  assert(
    !v12.includes("the nine test-maintainability smells"),
    "v12 must not still describe nine maintainability smells",
  );
});

Deno.test("test_audit v12 - the maintainability check range includes check 11", async () => {
  const [v11, v12] = await Promise.all([loadV11(), loadV12()]);
  assert(
    v11.includes("checks 1–6 and 8–10"),
    "v11 is the negative control: its range stops at check 10",
  );
  assert(
    !v12.includes("checks 1–6 and 8–10"),
    "every v12 check range must extend to 11",
  );
  assertStringIncludes(v12, "checks 1–6 and 8–11");
});

Deno.test("test_audit v12 - severity guidance covers a tautological finding", async () => {
  const v12 = await loadV12();
  const severitySection = v12.slice(v12.indexOf("### Severity guidance"));
  assertStringIncludes(severitySection, "tautological");
});
