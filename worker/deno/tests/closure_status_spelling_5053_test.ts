/**
 * A closure entry whose status is spelled `partially met` or `not met` is an
 * unmet entry, not an unrecognised one (Issue #5053).
 *
 * Before the fix `statusOf` only knew `partial` and `missing`, so
 * `- **partially met** — …` was dropped by `parseClosureEntries` and the close
 * guard, `assemblePrBody` and `alignIssueCloseWithClosure` kept `Closes #N`.
 *
 * Uses Australian English throughout.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseClosureEntries } from "../lib/acceptance_criteria_gate.ts";
import { subjectOf } from "../lib/closure_criterion_match.ts";
import {
  alignIssueCloseWithClosure,
  withholdsIssueClose,
} from "../lib/missing_criterion_close_guard.ts";
import { hasClosingKeyword } from "../lib/pr_body.ts";
import { assemblePrBody } from "../lib/pr_body_sync.ts";

const ISSUE = 4930;

function summaryWith(entry: string): string {
  return `## Acceptance Criteria\n\n- ${entry}`;
}

function statusesOf(entry: string): string[] {
  return parseClosureEntries(summaryWith(entry)).map((e) => e.status);
}

const TAIL = " — Make the thing work — evidence: `x.ts` — reason: cases left";

Deno.test("parseClosureEntries reads partially-met spellings as partial (Issue #5053)", () => {
  for (
    const lead of [
      "**partially met**",
      "**Partially Met**",
      "**partially**",
      "**partially** met",
      "partially-met",
      "`partially met`",
      "_partially met_",
    ]
  ) {
    assertEquals(statusesOf(lead + TAIL), ["partial"], lead);
  }
});

Deno.test("parseClosureEntries reads not-met spellings as missing (Issue #5053)", () => {
  for (
    const lead of [
      "**not met**",
      "**Not met**",
      "**not** met",
      "not-met",
      "`not met`",
    ]
  ) {
    assertEquals(statusesOf(lead + TAIL), ["missing"], lead);
  }
});

Deno.test("parseClosureEntries still reads the canonical statuses (Issue #5053)", () => {
  assertEquals(statusesOf("**partial**" + TAIL), ["partial"]);
  assertEquals(statusesOf("**missing**" + TAIL), ["missing"]);
  assertEquals(statusesOf("**met**" + TAIL), ["met"]);
  assertEquals(statusesOf("**unrequested**" + TAIL), ["unrequested"]);
});

Deno.test("parseClosureEntries ignores look-alikes and non-leading status prose (Issue #5053)", () => {
  for (
    const entry of [
      "**partiality** — x",
      "**metadata** — x",
      "**not** — x",
      "**notable** — x",
      "**nothing met** — x",
      "The criterion is partially met — x",
      "Not every case: not met — x",
    ]
  ) {
    assertEquals(parseClosureEntries(summaryWith(entry)), [], entry);
  }
});

Deno.test("subjectOf strips the whole new status from the subject (Issue #5053)", () => {
  const [partial] = parseClosureEntries(summaryWith(
    "**partially met** — Make the thing work — evidence: `x.ts` — reason: r",
  ));
  assertEquals(subjectOf(partial!), "Make the thing work —");
  const [missing] = parseClosureEntries(summaryWith(
    "**not met** — Make the thing work — reason: r",
  ));
  assertEquals(subjectOf(missing!), "Make the thing work —");
});

Deno.test("withholdsIssueClose is true for partially met and not met (Issue #5053)", () => {
  for (const lead of ["**partially met**", "**not met**"]) {
    assertEquals(
      withholdsIssueClose(
        summaryWith(`${lead} — Make the thing work — reason: r`),
      ),
      true,
      lead,
    );
  }
});

function assemble(summaryContent: string): string {
  return assemblePrBody({
    summaryContent,
    issueNumber: ISSUE,
    extraSections: "",
    footer: "",
    summaryDigest: "deadbeef",
    subAgentTier: undefined,
    ensureReferences: (content) => content,
  });
}

function closingSummary(lead: string, keyword = `Closes #${ISSUE}.`): string {
  return `## Summary\n\n${keyword}\n\n## Acceptance Criteria\n\n- ${lead}` +
    " — Make the fleet run the gate — evidence: `a.ts` — reason: two cases open";
}

Deno.test("assemblePrBody does not close the issue for partially met or not met (Issue #5053)", () => {
  for (const lead of ["**partially met**", "**not met**"]) {
    const body = assemble(closingSummary(lead));
    assertStringIncludes(body, `Part of #${ISSUE}`);
    assertStringIncludes(body, `## Not closing #${ISSUE}`);
    assertEquals(hasClosingKeyword(body, ISSUE), false, lead);
    assertEquals(new RegExp(`\\bCloses #${ISSUE}\\b`, "i").test(body), false);
  }
});

Deno.test("alignIssueCloseWithClosure keeps Part of and rewrites Closes for partially met (Issue #5053)", () => {
  const partOf = closingSummary("**partially met**", `Part of #${ISSUE}`);
  const keptPartOf = alignIssueCloseWithClosure(partOf, ISSUE);
  assertStringIncludes(keptPartOf, `Part of #${ISSUE}`);
  assertEquals(hasClosingKeyword(keptPartOf, ISSUE), false);

  const closes = closingSummary("**partially met**", `Closes #${ISSUE}`);
  const rewritten = alignIssueCloseWithClosure(closes, ISSUE);
  assertStringIncludes(rewritten, `Part of #${ISSUE}`);
  assertEquals(hasClosingKeyword(rewritten, ISSUE), false);
});

Deno.test("hostile whitespace and marker runs return promptly (Issue #5053)", () => {
  const spaces = " ".repeat(50_000);
  assertEquals(
    statusesOf(`**partially${spaces}x — reason: r`),
    ["partial"],
  );
  assertEquals(statusesOf("*".repeat(50_000) + "x"), []);
  assertEquals(statusesOf(`**not${spaces}x`), []);

  const [entry] = parseClosureEntries(summaryWith(
    `**partially${spaces}metx — reason: r`,
  ));
  const subject = subjectOf(entry!);
  assertEquals(subject, "metx —");
});
