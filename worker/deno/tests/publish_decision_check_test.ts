/**
 * Tests for the Phase 4 publish-decision dossier checker (Issue #4200).
 *
 * The dossier (`docs/PUBLISH-DECISION.md`) is operator-private and its
 * default is NO-GO. The checker exists so an incomplete dossier can never
 * read as a GO: every condition needs a verdict AND a cited artefact, and
 * the document verdict may only be GO when every condition is MET.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  checkPublishDecision,
  PHASE4_CONDITION_COUNT,
  publishDecisionProblems,
} from "../lib/publish_decision_check.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

function condition(
  n: number,
  verdict: "MET" | "UNMET" | "",
  evidence: string,
): string {
  const verdictLine = verdict === "" ? "" : `**Verdict:** ${verdict}\n\n`;
  return `### Condition ${n} — thing ${n}\n\n${verdictLine}**Evidence:** ${evidence}\n\n`;
}

function dossier(
  conditions: string,
  verdict: string,
  date = "2026-08-19",
): string {
  return `# Publish decision dossier\n\n## Conditions\n\n${conditions}## Verdict\n\n**Verdict: ${verdict}** — dated ${date}.\n`;
}

const ALL_MET = [1, 2, 3, 4, 5]
  .map((n) => condition(n, "MET", `\`docs/evidence/thing-${n}.md\``))
  .join("");

Deno.test("publish-decision-check - a complete NO-GO dossier passes", () => {
  const text = dossier(
    [1, 2, 3, 4, 5]
      .map((n) => condition(n, "UNMET", "`docs/THREAT-MODEL.md`"))
      .join(""),
    "NO-GO",
  );
  const result = checkPublishDecision(text);
  assertEquals(result.problems, []);
  assertEquals(result.verdict, "NO-GO");
  assertEquals(result.conditions.length, PHASE4_CONDITION_COUNT);
  assert(result.conditions.every((c) => c.verdict === "UNMET"));
});

Deno.test("publish-decision-check - GO with every condition MET and cited passes", () => {
  const result = checkPublishDecision(dossier(ALL_MET, "GO"));
  assertEquals(result.problems, []);
  assertEquals(result.verdict, "GO");
});

Deno.test("publish-decision-check - GO while any condition is UNMET is a problem", () => {
  const conditions = [1, 2, 3, 4]
    .map((n) => condition(n, "MET", "`docs/x.md`"))
    .join("") + condition(5, "UNMET", "`docs/x.md`");
  const problems = publishDecisionProblems(dossier(conditions, "GO"));
  assert(
    problems.some((p) => p.includes("GO") && p.includes("Condition 5")),
    problems.join("\n"),
  );
});

Deno.test("publish-decision-check - a condition without a verdict is a problem", () => {
  const conditions = [1, 2, 3, 4]
    .map((n) => condition(n, "UNMET", "`docs/x.md`"))
    .join("") + condition(5, "", "`docs/x.md`");
  const problems = publishDecisionProblems(dossier(conditions, "NO-GO"));
  assert(
    problems.some((p) => p.includes("Condition 5") && p.includes("verdict")),
    problems.join("\n"),
  );
});

Deno.test("publish-decision-check - a condition MET by assertion alone (no cited artefact) is a problem", () => {
  const conditions = [1, 2, 3, 4]
    .map((n) => condition(n, "MET", "`docs/x.md`"))
    .join("") + condition(5, "MET", "we are confident this holds");
  const problems = publishDecisionProblems(dossier(conditions, "GO"));
  assert(
    problems.some((p) => p.includes("Condition 5") && p.includes("artefact")),
    problems.join("\n"),
  );
});

Deno.test("publish-decision-check - a missing condition section is a problem", () => {
  const conditions = [1, 2, 3, 4]
    .map((n) => condition(n, "UNMET", "`docs/x.md`"))
    .join("");
  const problems = publishDecisionProblems(dossier(conditions, "NO-GO"));
  assert(
    problems.some((p) => p.includes("Condition 5") && p.includes("missing")),
    problems.join("\n"),
  );
});

Deno.test("publish-decision-check - a missing or undated verdict line is a problem", () => {
  const noVerdict = `# Dossier\n\n${ALL_MET}`;
  assert(
    publishDecisionProblems(noVerdict).some((p) => p.includes("verdict line")),
  );
  const undated = `# Dossier\n\n${ALL_MET}## Verdict\n\n**Verdict: GO**\n`;
  assert(publishDecisionProblems(undated).some((p) => p.includes("dated")));
});

Deno.test("publish-decision-check - the committed dossier passes and is NO-GO while conditions are unmet", async () => {
  const text = await Deno.readTextFile(`${REPO_ROOT}docs/PUBLISH-DECISION.md`);
  const result = checkPublishDecision(text);
  assertEquals(result.problems, [], result.problems.join("\n"));
  const unmet = result.conditions.filter((c) => c.verdict === "UNMET");
  if (unmet.length > 0) {
    assertEquals(result.verdict, "NO-GO");
  }
  // Every cited artefact must exist in the tree — a citation to a file that
  // is not there is assertion dressed as evidence.
  for (const c of result.conditions) {
    for (const path of c.evidencePaths) {
      if (path.includes("<")) continue; // a described-not-yet-existing artefact
      const stat = await Deno.stat(`${REPO_ROOT}${path}`).catch(() => null);
      assert(stat, `Condition ${c.number} cites ${path}, which does not exist`);
    }
  }
});

Deno.test("publish-decision-check - the dossier is not listed in the public manifest", async () => {
  const manifest = await Deno.readTextFile(
    `${REPO_ROOT}export/public-manifest.txt`,
  );
  const listed = manifest
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .some((l) => l.toLowerCase().includes("publish-decision"));
  assert(!listed, "docs/PUBLISH-DECISION.md must never be in the manifest");
});
