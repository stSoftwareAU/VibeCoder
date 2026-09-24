/**
 * Tests for the github-actions-audit "Cost and speed" check group (Issue
 * #2578): checks 37–41, the read-only run-time cost signal, and the two
 * slots of the 6-finding cap the group keeps.
 *
 * The audit never raised CI cost or speed on GRQ-AutoTrader, because the
 * catalogue had no such checks, security findings filled the cap, and the
 * scan could not see how long anything took. These assertions run against
 * the shipped `github_actions_audit` template and its operator manual, so an
 * edit that drops a check, the reserved slots or the cost signal fails in CI.
 *
 * Australian English throughout (behaviour, organisation, artefact).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

/** Collapse whitespace so assertions do not depend on Markdown wrapping. */
const flatten = (text: string) => text.replace(/\s+/g, " ");

async function loadAudit(): Promise<string> {
  const result = await loadPrompt("github_actions_audit", PROMPTS_DIR);
  assert(result.ok, "github_actions_audit failed to load");
  return result.value;
}

/** The text of one numbered check, from `<n>. **` to the next check. */
async function check(n: number): Promise<string> {
  const text = await loadAudit();
  const start = text.indexOf(`\n${n}. **`);
  assert(start >= 0, `check ${n} not found`);
  const next = text.indexOf(`\n${n + 1}. **`, start);
  const end = next >= 0 ? next : text.indexOf("<examples>", start);
  assert(end > start, `check ${n} is empty`);
  return flatten(text.slice(start, end));
}

/** A `### Heading` section, up to the next heading of the same or higher level. */
async function section(heading: string): Promise<string> {
  const text = await loadAudit();
  const start = text.indexOf(heading);
  assert(start >= 0, `section '${heading}' not found`);
  const level = heading.match(/^#+/)![0];
  const rest = text.slice(start + heading.length);
  const nextRe = new RegExp(`\\n#{1,${level.length}} `);
  const m = rest.match(nextRe);
  return flatten(heading + (m ? rest.slice(0, m.index) : rest));
}

const COST_CHECKS = [37, 38, 39, 40, 41];

Deno.test("cost group - checks 37–41 each carry a stable id, a severity rule and a no-false-positive note", async () => {
  for (const n of COST_CHECKS) {
    const body = await check(n);
    assertStringIncludes(body, `BP-CI-COST-${n}-<12 hex>`, `check ${n} id`);
    assertStringIncludes(body, "(check, sorted workflow paths)", `check ${n}`);
    assertStringIncludes(body, "No false positives", `check ${n}`);
  }
});

Deno.test("cost group - the owner's four questions and build-once are the five checks", async () => {
  assertStringIncludes(await check(37), "Runs only when relevant");
  assertStringIncludes(await check(38), "Duplicate or overlapping work");
  assertStringIncludes(await check(39), "Cached from previous runs");
  assertStringIncludes(await check(40), "Runs in parallel");
  assertStringIncludes(await check(41), "Build once, deploy the artefact");
});

Deno.test("cost group - 37 steers required checks to job-level gating with an always-run aggregator", async () => {
  const body = await check(37);
  assertStringIncludes(body, "required check");
  assertStringIncludes(body, "aggregator");
});

Deno.test("cost group - severity is medium at 30 min/week measured saving, low otherwise", async () => {
  const group = await section("### Cost and speed");
  assertStringIncludes(group, "at least 30 min/week");
  assertStringIncludes(group, "`severity:medium`");
  assertStringIncludes(group, "`severity:low`");
});

Deno.test("cost group - each finding states duration, runs per week and saving, or 'unmeasured'", async () => {
  const group = await section("### Cost and speed");
  for (
    const phrase of [
      "median duration",
      "runs per week",
      "estimated saving",
      "unmeasured",
    ]
  ) {
    assertStringIncludes(group, phrase);
  }
  // …and names in one line what the change risks.
  assertStringIncludes(group, "Risk:");
});

Deno.test("cost group - the pre-pass leads are an input block, data to confirm or reject", async () => {
  const text = await loadAudit();
  assertStringIncludes(
    text,
    "<cost_candidates>\n{{COST_CANDIDATES}}\n</cost_candidates>",
  );
});

Deno.test("sweep bands - every cost check is in a severity band", async () => {
  const bands = await section(
    "### Sweep in severity-band order, and stop when the cap is reachable",
  );
  const medium = bands.slice(
    bands.indexOf("**Then the `severity:medium` checks**"),
    bands.indexOf("**Then the `severity:low` checks**"),
  );
  const low = bands.slice(bands.indexOf("**Then the `severity:low` checks**"));
  for (const n of COST_CHECKS) {
    assertStringIncludes(medium, `${n}`, `check ${n} missing from medium band`);
    assertStringIncludes(low, `${n}`, `check ${n} missing from low band`);
  }
  // The high-band early stop must not starve the cost group of its slots.
  assertStringIncludes(bands, "cost group");
});

Deno.test("Phase 3 - at least 2 of the 6 slots are kept for the cost group, below severity:high", async () => {
  const triage = await section("## Phase 3 — Triage");
  assertStringIncludes(triage, "at least **2 of the 6**");
  assertStringIncludes(triage, "cost group");
  assertStringIncludes(triage, "`severity:high` security findings");
  // The cap itself is unchanged.
  assertStringIncludes(triage, "at most **6 findings**");
});

Deno.test("Hard Constraints - only the read-only cost-signal calls are added, nothing that writes", async () => {
  const text = flatten(await loadAudit());
  const hc = text.slice(
    text.indexOf("## Hard Constraints"),
    text.indexOf("## Phase 1"),
  );
  assertStringIncludes(
    hc,
    "`gh run list --workflow <file> --limit 20 --json databaseId,conclusion,createdAt,updatedAt,event`",
  );
  assertStringIncludes(
    hc,
    "`gh api repos/{owner}/{repo}/actions/runs/{id}/timing`",
  );
  assertStringIncludes(hc, "no `-X`/`--method`");
  for (
    const forbidden of [
      "`gh run rerun`",
      "`gh run cancel`",
      "`gh workflow run`",
    ]
  ) {
    assertStringIncludes(hc, forbidden, `${forbidden} not named as forbidden`);
  }
  // The long-run note counts the whole catalogue.
  assertStringIncludes(hc, "41 checks");
});

Deno.test("stable-id recipe list names the cost-group prefix", async () => {
  const recipe = await section("## Stable finding ID recipe");
  assertStringIncludes(recipe, "`BP-CI-COST-<check>-<12 hex>` (checks 37–41)");
});

Deno.test("operator manual documents the group, the reserved slots and the cost signal", async () => {
  const doc = flatten(
    await Deno.readTextFile(`${REPO_ROOT}docs/GITHUB-ACTIONS-AUDIT-SCAN.md`),
  );
  assertStringIncludes(doc, "Cost and speed");
  for (const n of COST_CHECKS) {
    assert(doc.includes(`| ${n} |`), `doc table lacks check ${n}`);
  }
  assertStringIncludes(doc, "2 of the 6");
  assertStringIncludes(doc, "gh run list");
  assertStringIncludes(doc, "unmeasured");
  assertStringIncludes(doc, "workflow_cost_scanner.ts");
  assertEquals(doc.includes("BP-CI-COST-"), true);
});
