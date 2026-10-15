/**
 * Tests for degraded_delivery.ts — the verdict that stops a degraded
 * (fallback-model) implementation run from reading as complete delivery
 * (Issue #2562).
 *
 * On #2543 the implementation run asked for `opus`, was served Haiku after a
 * rate-limit fallback, shipped the pricing rows only, and closed the issue.
 * These tests pin the pure half of the guard: which scope an issue states
 * (including a grill-me `### Accepted scope so far` list, which the
 * acceptance-criteria gate does not read), and which of it a degraded run
 * failed to show as `met`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { extractAcceptedScope } from "../lib/acceptance_criteria_gate.ts";
import { emptyEnv } from "./support/env_lookup.ts";
import {
  assessDegradedDelivery,
  assessReportedGaps,
  assessScopeShortfalls,
  buildDegradedFollowUpIssue,
  buildDegradedNoFollowUpSection,
  buildDegradedPrSection,
  buildDegradedUnfiledGapSection,
  buildReportedGapPrSection,
  buildReportedGapStaleFollowUpSection,
  degradedFollowUpFindingId,
  degradedNeedsFollowUp,
  fileDegradedFollowUp,
  parseDegradedSection,
  rederiveDegradedSection,
  rederiveReportedGapSection,
  REPORTED_GAP_SECTION_HEADING,
  UNSTATED_SCOPE_ITEM,
} from "../lib/degraded_delivery.ts";

const ISSUE_WITH_CRITERIA = `## Problem

Two things are wrong.

## Acceptance Criteria

- [ ] The router sends planning to opus.
- [ ] The docs table lists opus for planning.
- [ ] The release floor is 1.9.0.
`;

/** A grill-me issue body, shaped like #2543 and #2560. */
const GRILL_ME_ISSUE = `<!-- GRILL-ME-UNDERSTANDING-START -->
## Current Understanding

Finish the switch.

### Accepted scope so far

- Route the eight planning phases to \`opus\`. Observable: config resolves opus.
- Raise the Claude Code pin. Observable: \`claude --version\` prints it.
- Bump the release floor to 1.9.0.

### Open questions

None.

### Assumptions

- This is not a scope item.
`;

const ISSUE_WITHOUT_SCOPE = `## Problem

The parser mishandles a leap year.
`;

/** An issue whose criteria sit under a `## Done when` heading (Issue #3486). */
const ISSUE_WITH_DONE_WHEN = `## Problem

Finish the switch.

## Done when

- [ ] The router sends planning to opus.
- [ ] The docs table lists opus for planning.
- [ ] The release floor is 1.9.0.
`;

/** One met, one missing, one partial — in criterion order. */
const SUMMARY_PARTIAL = `## Summary

Did some of it.

## Acceptance Criteria

- **met** — the router sends planning to opus — evidence: \`lib/config_defaults.ts\` — reviewer: met
- **missing** — the docs table lists opus — reviewer: missing — reason: ran out of turns
- **partial** — the release floor — evidence: \`.release-floor\` — reviewer: partial — reason: notes not written
`;

const SUMMARY_ALL_MET = `## Summary

Did all of it.

## Acceptance Criteria

- **met** — the router — evidence: \`lib/config_defaults.ts\` — reviewer: met
- **met** — the docs — evidence: \`docs/MODEL-AND-CACHING.md\` — reviewer: met
- **met** — the floor — evidence: \`.release-floor\` — reviewer: met
`;

const MINIMAL_BODY = `## Summary\n\nCloses #2543.\n\n`;

const HAIKU_FALLBACK = [{ fallbackModel: "haiku" }];

// ---------------------------------------------------------------------------
// extractAcceptedScope
// ---------------------------------------------------------------------------

Deno.test("extractAcceptedScope - acceptance criteria are the scope when stated", () => {
  assertEquals(extractAcceptedScope(ISSUE_WITH_CRITERIA), [
    "The router sends planning to opus.",
    "The docs table lists opus for planning.",
    "The release floor is 1.9.0.",
  ]);
});

Deno.test("extractAcceptedScope - reads a grill-me 'Accepted scope so far' list and nothing after it", () => {
  const scope = extractAcceptedScope(GRILL_ME_ISSUE);
  assertEquals(scope.length, 3);
  assertStringIncludes(scope[0]!, "Route the eight planning phases");
  assertStringIncludes(scope[2]!, "Bump the release floor");
  assert(!scope.some((s) => s.includes("not a scope item")));
});

Deno.test("extractAcceptedScope - an issue stating neither yields no scope", () => {
  assertEquals(extractAcceptedScope(ISSUE_WITHOUT_SCOPE), []);
});

Deno.test("extractAcceptedScope - reads a 'Done when' list (Issue #3486)", () => {
  assertEquals(extractAcceptedScope(ISSUE_WITH_DONE_WHEN), [
    "The router sends planning to opus.",
    "The docs table lists opus for planning.",
    "The release floor is 1.9.0.",
  ]);
});

// ---------------------------------------------------------------------------
// assessDegradedDelivery
// ---------------------------------------------------------------------------

Deno.test("assessDegradedDelivery - a healthy run is never flagged, whatever the summary says", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: [{}],
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: SUMMARY_PARTIAL,
  });
  assertEquals(verdict.degraded, false);
  assertEquals(verdict.shortfalls, []);
});

Deno.test("assessDegradedDelivery - a degraded run names each criterion short of met", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: SUMMARY_PARTIAL,
  });
  assertEquals(verdict.degraded, true);
  assertStringIncludes(verdict.reason ?? "", "haiku");
  assertEquals(verdict.delivered, ["The router sends planning to opus."]);
  assertEquals(verdict.shortfalls, [
    { criterion: "The docs table lists opus for planning.", status: "missing" },
    { criterion: "The release floor is 1.9.0.", status: "partial" },
  ]);
});

/** Same three criteria as SUMMARY_PARTIAL, but the entries appear in a
 * different order from the criteria — floor missing first, then router met,
 * then docs met — so a positional match would misattribute every status
 * (Issue #3128). */
const SUMMARY_REORDERED = `## Summary

Did some of it.

## Acceptance Criteria

- **missing** — the release floor is 1.9.0 — reviewer: missing — reason: ran out of turns
- **met** — the router sends planning to opus — evidence: \`lib/config_defaults.ts\` — reviewer: met
- **met** — the docs table lists opus for planning — evidence: \`docs/MODEL-AND-CACHING.md\` — reviewer: met
`;

Deno.test("assessDegradedDelivery - #3128: closure entries out of order are matched by content, not position", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: SUMMARY_REORDERED,
  });
  assertEquals(verdict.delivered, [
    "The router sends planning to opus.",
    "The docs table lists opus for planning.",
  ]);
  assertEquals(verdict.shortfalls, [
    { criterion: "The release floor is 1.9.0.", status: "missing" },
  ]);

  const issue = buildDegradedFollowUpIssue({
    parentNumber: 42,
    parentTitle: "Finish the switch",
    verdict,
    runId: "vibe-test-reorder",
  });
  assertStringIncludes(issue.body, "The release floor is 1.9.0.");
  assertStringIncludes(issue.body, "The router sends planning to opus.");
  const deliveredSection = issue.body.split("## Already delivered")[1]!;
  assert(!deliveredSection.includes("The release floor is 1.9.0."));
});

/** The first criterion split across a `met` entry and a `missing` entry; the
 * other two keep their own separate entries (Issue #3128). */
const SUMMARY_SPLIT_CRITERION = `## Summary

Did some of it.

## Acceptance Criteria

- **met** — the router sends planning to opus for the eight planning phases — evidence: \`lib/config_defaults.ts\` — reviewer: met
- **missing** — the router sends planning to opus for the ninth phase — reviewer: missing — reason: forgot one
- **met** — the docs table lists opus for planning — evidence: \`docs/MODEL-AND-CACHING.md\` — reviewer: met
- **met** — the release floor is 1.9.0 — evidence: \`.release-floor\` — reviewer: met
`;

Deno.test("assessDegradedDelivery - #3128: a criterion split across a met and a missing entry reads missing", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: SUMMARY_SPLIT_CRITERION,
  });
  assertEquals(verdict.shortfalls, [
    { criterion: "The router sends planning to opus.", status: "missing" },
  ]);
  assertEquals(verdict.delivered, [
    "The docs table lists opus for planning.",
    "The release floor is 1.9.0.",
  ]);
});

Deno.test("degradedNeedsFollowUp - an unmatched missing entry files a follow-up even when every criterion is met (Issue #3128)", () => {
  const prBody = `${SUMMARY_ALL_MET}
- **missing** — the changelog entry — reviewer: missing — reason: the changelog still says the old floor
`;
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITH_CRITERIA,
    prBody,
  });

  assertEquals(verdict.delivered.length, 3);
  assertEquals(degradedNeedsFollowUp(verdict), true);
  assert(
    verdict.shortfalls.some((s) =>
      s.status === "missing" && s.criterion.includes("changelog entry")
    ),
    "the unmatched gap is named on the follow-up",
  );
  const followUp = buildDegradedFollowUpIssue({
    parentNumber: 3128,
    parentTitle: "match closure entries",
    verdict,
    runId: "test",
  });
  assertStringIncludes(followUp.body, "changelog entry");
  assertStringIncludes(
    followUp.body,
    "did not show every accepted scope item as met, or reported a gap of its own",
  );
  assertStringIncludes(
    buildDegradedPrSection(verdict, 99),
    "did not show every accepted scope item as met, or reported a gap of its own",
  );
});

Deno.test("assessDegradedDelivery - a degraded run that met every criterion has no shortfall", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: SUMMARY_ALL_MET,
  });
  assertEquals(verdict.degraded, true);
  assertEquals(verdict.shortfalls, []);
  assertEquals(verdict.delivered.length, 3);
});

Deno.test("assessDegradedDelivery - #2543: a degraded run with no summary leaves every scope item unassessed", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: GRILL_ME_ISSUE,
    prBody: MINIMAL_BODY,
  });
  assertEquals(verdict.degraded, true);
  assertEquals(verdict.delivered, []);
  assertEquals(verdict.shortfalls.length, 3);
  assert(verdict.shortfalls.every((s) => s.status === "unassessed"));
});

Deno.test("assessDegradedDelivery - a pre-flight reroute counts as degraded", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: [{
      preflightDegraded: true,
      preflightDegradedReason: "pre-flight Fable reroute",
    }],
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: MINIMAL_BODY,
  });
  assertEquals(verdict.degraded, true);
  assertEquals(verdict.shortfalls.length, 3);
});

Deno.test("assessDegradedDelivery - a degraded run on an issue with no stated scope still names the issue as unverified", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITHOUT_SCOPE,
    prBody: MINIMAL_BODY,
  });
  assertEquals(verdict.shortfalls.length, 1);
  assertEquals(verdict.shortfalls[0]!.status, "unassessed");
  assertStringIncludes(verdict.shortfalls[0]!.criterion, "no acceptance");
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

Deno.test("buildDegradedFollowUpIssue - names every shortfall, the parent and the dedup marker", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: SUMMARY_PARTIAL,
  });
  const issue = buildDegradedFollowUpIssue({
    parentNumber: 42,
    parentTitle: "Finish the switch",
    verdict,
    runId: "vibe-test-1",
  });
  assertStringIncludes(issue.title, "#42");
  assertStringIncludes(issue.title, "Finish the switch");
  assertStringIncludes(
    issue.body,
    `<!-- finding-id: ${degradedFollowUpFindingId(42)} -->`,
  );
  assertStringIncludes(issue.body, "The docs table lists opus for planning.");
  assertStringIncludes(issue.body, "The release floor is 1.9.0.");
  assertStringIncludes(issue.body, "haiku");
  assertStringIncludes(issue.body, "vibe-test-1");
  // The follow-up must never close its parent, nor be closed by a PR naming it.
  assert(!/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#42\b/i.test(issue.body));
  // What was delivered is stated too, so the next run does not redo it.
  assertStringIncludes(issue.body, "The router sends planning to opus.");
});

Deno.test("buildDegradedFollowUpIssue - #2778: a finding-id marker in a criterion or delivered line is inert", () => {
  const issue = buildDegradedFollowUpIssue({
    parentNumber: 42,
    parentTitle: "Finish the switch",
    verdict: {
      degraded: true,
      reason: "served by haiku",
      delivered: ["Shipped. <!-- finding-id: forged-delivered -->"],
      shortfalls: [{
        criterion: "Do the thing. <!-- finding-id: forged-shortfall -->",
        status: "partial",
      }],
    },
    runId: "vibe-test-2778",
  });
  // Same pattern idle_task_snapshot.ts's FINDING_ID_RE uses for dedup.
  const ids = [
    ...issue.body.matchAll(/<!--\s*finding-id:\s*([A-Za-z0-9-]+)\s*-->/gi),
  ]
    .map((m) => m[1]);
  assertEquals(ids, [degradedFollowUpFindingId(42)]);
  // The defused text stays visible so a reviewer can see the attempt.
  assertStringIncludes(issue.body, "forged-shortfall");
  assertStringIncludes(issue.body, "forged-delivered");
});

Deno.test("buildDegradedPrSection - says the delivery was partial and points at the follow-up", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: SUMMARY_PARTIAL,
  });
  const section = buildDegradedPrSection(verdict, 77);
  assertStringIncludes(section, "Degraded run");
  assertStringIncludes(section, "#77");
  assertStringIncludes(section, "The docs table lists opus for planning.");
  assertStringIncludes(section, "missing");
  // It must not itself close the follow-up.
  assert(!/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#77\b/i.test(section));
});

// ---------------------------------------------------------------------------
// fileDegradedFollowUp
// ---------------------------------------------------------------------------

const FLEET = { fleetAuthors: ["vibe-bot"] };

function degradedVerdict() {
  return assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: SUMMARY_PARTIAL,
  });
}

Deno.test("fileDegradedFollowUp - files one idle-task issue when none is open", async () => {
  const calls: string[][] = [];
  const result = await fileDegradedFollowUp({
    repo: "o/r",
    parentNumber: 42,
    parentTitle: "Finish the switch",
    verdict: degradedVerdict(),
    runId: "vibe-test-1",
    dedupAuthors: FLEET,
    gh: (args) => {
      calls.push(args);
      if (args[1] === "list") return Promise.resolve("[]");
      return Promise.resolve("https://github.com/o/r/issues/77\n");
    },
  });
  assertEquals(result, { ok: true, value: { number: 77, reused: false } });
  const create = calls.find((c) => c[0] === "issue" && c[1] === "create")!;
  assert(create, "gh issue create must run");
  assertEquals(create[create.indexOf("--label") + 1], "idle-task");
});

Deno.test("fileDegradedFollowUp - a parent's milestone is passed to gh issue create (PR #3676 review)", async () => {
  const create = async (milestoneTitle?: string) => {
    const calls: string[][] = [];
    await fileDegradedFollowUp({
      repo: "o/r",
      parentNumber: 42,
      parentTitle: "Finish the switch",
      verdict: degradedVerdict(),
      runId: "vibe-test-ms",
      dedupAuthors: FLEET,
      ...(milestoneTitle ? { milestoneTitle } : {}),
      gh: (args) => {
        calls.push(args);
        if (args[1] === "list") return Promise.resolve("[]");
        return Promise.resolve("https://github.com/o/r/issues/77\n");
      },
    });
    return calls.find((c) => c[0] === "issue" && c[1] === "create")!;
  };
  const withMilestone = await create("Q4 Launch");
  assertEquals(
    withMilestone[withMilestone.indexOf("--milestone") + 1],
    "Q4 Launch",
  );
  assert(!(await create()).includes("--milestone"));
});

Deno.test("fileDegradedFollowUp - reuses the open follow-up for the same parent", async () => {
  const calls: string[][] = [];
  const existing = JSON.stringify([{
    number: 70,
    body: `<!-- finding-id: ${degradedFollowUpFindingId(42)} -->`,
    author: { login: "vibe-bot" },
  }]);
  const result = await fileDegradedFollowUp({
    repo: "o/r",
    parentNumber: 42,
    parentTitle: "Finish the switch",
    verdict: degradedVerdict(),
    runId: "vibe-test-2",
    dedupAuthors: FLEET,
    gh: (args) => {
      calls.push(args);
      return Promise.resolve(existing);
    },
  });
  assertEquals(result, { ok: true, value: { number: 70, reused: true } });
  assert(!calls.some((c) => c[1] === "create"), "must not file a second one");
});

Deno.test("fileDegradedFollowUp - #3145: a reused follow-up is brought up to date with the later run's shortfalls", async () => {
  const calls: string[][] = [];
  const oldBody = [
    `<!-- finding-id: ${degradedFollowUpFindingId(42)} -->`,
    "",
    "## Acceptance Criteria",
    "",
    "- **missing** — An old criterion the first run missed.",
  ].join("\n");
  const existing = JSON.stringify([{
    number: 70,
    body: oldBody,
    author: { login: "vibe-bot" },
  }]);
  const verdict = degradedVerdict();
  const result = await fileDegradedFollowUp({
    repo: "o/r",
    parentNumber: 42,
    parentTitle: "Finish the switch",
    verdict,
    runId: "vibe-test-3145a",
    dedupAuthors: FLEET,
    gh: (args) => {
      calls.push(args);
      if (args[1] === "list") return Promise.resolve(existing);
      if (args[1] === "edit") return Promise.resolve("");
      return Promise.reject(new Error(`unexpected gh call: ${args[1]}`));
    },
  });
  assertEquals(result, { ok: true, value: { number: 70, reused: true } });
  assert(!calls.some((c) => c[1] === "create"), "must not file a second one");
  const edits = calls.filter((c) => c[1] === "edit");
  assertEquals(edits.length, 1);
  const edit = edits[0]!;
  assertEquals(edit[0], "issue");
  assertEquals(edit[1], "edit");
  assertEquals(edit[2], "70");
  assertEquals(edit[3], "--repo");
  assertEquals(edit[4], "o/r");
  const bodyIndex = edit.indexOf("--body");
  assert(bodyIndex !== -1, "edit must carry --body");
  const body = edit[bodyIndex + 1]!;
  const expected = buildDegradedFollowUpIssue({
    parentNumber: 42,
    parentTitle: "Finish the switch",
    verdict,
    runId: "vibe-test-3145a",
  }).body;
  assertEquals(body, expected);
  assertStringIncludes(body, "The docs table lists opus for planning.");
  assertStringIncludes(body, `finding-id: ${degradedFollowUpFindingId(42)}`);
  assertStringIncludes(body, "vibe-test-3145a");
  assert(
    !body.includes("An old criterion the first run missed."),
    "the stale shortfall must not survive the update",
  );
});

Deno.test("fileDegradedFollowUp - #3145: a reused follow-up that cannot be updated is an error, not a silent pass", async () => {
  const existing = JSON.stringify([{
    number: 70,
    body: `<!-- finding-id: ${degradedFollowUpFindingId(42)} -->`,
    author: { login: "vibe-bot" },
  }]);
  const result = await fileDegradedFollowUp({
    repo: "o/r",
    parentNumber: 42,
    parentTitle: "Finish the switch",
    verdict: degradedVerdict(),
    runId: "vibe-test-3145b",
    dedupAuthors: FLEET,
    gh: (args) =>
      args[1] === "list"
        ? Promise.resolve(existing)
        : Promise.reject(new Error("HTTP 502")),
  });
  assertEquals(result.ok, false);
  assert(!result.ok);
  assertStringIncludes(result.error.message, "#70");
});

Deno.test("fileDegradedFollowUp - a failed create is an error, not a silent pass", async () => {
  const result = await fileDegradedFollowUp({
    repo: "o/r",
    parentNumber: 42,
    parentTitle: "Finish the switch",
    verdict: degradedVerdict(),
    runId: "vibe-test-3",
    dedupAuthors: FLEET,
    gh: (args) =>
      args[1] === "list"
        ? Promise.resolve("[]")
        : Promise.reject(new Error("HTTP 502")),
  });
  assertEquals(result.ok, false);
});

// ---------------------------------------------------------------------------
// A previous generation of the right tier is not a fallback (Issue #2560)
// ---------------------------------------------------------------------------

Deno.test("assessDegradedDelivery - a run served a previous generation of the expected tier files no follow-up", () => {
  // A container whose CLI still resolves `sonnet` (the issue manager's tier
  // since #3473) to Sonnet 5 is flagged stale by the run-stats comment, but
  // the run was not served a fallback model: it ran on the tier it asked for,
  // so its delivery is not in question.
  const verdict = assessDegradedDelivery({
    claudeResults: [{
      runStats: {
        servedModels: ["claude-sonnet-5"],
        requestedModel: "sonnet",
        wallClockMs: 1000,
      },
    }],
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: MINIMAL_BODY,
    env: emptyEnv,
  });
  assertEquals(verdict.degraded, false);
  assertEquals(verdict.shortfalls, []);
});

Deno.test("assessDegradedDelivery - a run served a lower tier than expected is still degraded", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: [{
      runStats: {
        servedModels: ["claude-haiku-4-5-20251001"],
        requestedModel: "opus",
        wallClockMs: 1000,
      },
    }],
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: MINIMAL_BODY,
    env: emptyEnv,
  });
  assertEquals(verdict.degraded, true);
  assertEquals(verdict.shortfalls.length, 3);
});

// ---------------------------------------------------------------------------
// Follow-up gating (Issue #2695)
// ---------------------------------------------------------------------------

/** One criterion assessed `partial`; the other two left unassessed. */
const SUMMARY_ONE_PARTIAL = `## Summary

Did a little.

## Acceptance Criteria

- **partial** — the router — evidence: \`lib/config_defaults.ts\` — reviewer: partial — reason: execution only
`;

Deno.test("degradedNeedsFollowUp - (a) no stated criteria files no follow-up", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITHOUT_SCOPE,
    prBody: MINIMAL_BODY,
  });
  assertEquals(verdict.degraded, true);
  assertEquals(degradedNeedsFollowUp(verdict), false);
});

Deno.test("degradedNeedsFollowUp - (b) stated criteria all unassessed files no follow-up", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: GRILL_ME_ISSUE,
    prBody: MINIMAL_BODY,
  });
  assertEquals(verdict.shortfalls.length, 3);
  assertEquals(degradedNeedsFollowUp(verdict), false);
});

Deno.test("degradedNeedsFollowUp - a missing entry with no subject still files a follow-up (Issue #3128)", () => {
  const prBody = `## Acceptance Criteria

- **met** — the router sends planning to opus — evidence: \`router.ts\` — reviewer: met
- **missing** — reviewer: missing — reason: the docs table still says sonnet
- **met** — the release floor is 1.9.0 — evidence: \`Cargo.toml\` — reviewer: met
`;
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITH_CRITERIA,
    prBody,
  });

  assertEquals(degradedNeedsFollowUp(verdict), true);
  assert(
    verdict.shortfalls.some((s) =>
      s.status === "missing" &&
      s.criterion.includes("docs table still says sonnet")
    ),
    "the reason names the gap when the entry has no subject",
  );
});

Deno.test("degradedNeedsFollowUp - a reworded in-order missing entry still files a follow-up (Issue #3128)", () => {
  const prBody = `## Acceptance Criteria

- **met** — the router sends planning to opus — evidence: \`router.ts\` — reviewer: met
- **missing** — the docs table names opus as the planning model — reason: the table still says sonnet
`;
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITH_CRITERIA,
    prBody,
  });

  assertEquals(degradedNeedsFollowUp(verdict), true);
  assert(
    verdict.shortfalls.some((s) =>
      s.status === "missing" &&
      s.criterion.includes("docs table names opus")
    ),
    "the paraphrased gap is named on the follow-up",
  );
  const followUp = buildDegradedFollowUpIssue({
    parentNumber: 3128,
    parentTitle: "match closure entries",
    verdict,
    runId: "test",
  });
  assertStringIncludes(followUp.body, "docs table names opus");
});

Deno.test("degradedNeedsFollowUp - (c) one partial criterion files a follow-up", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: SUMMARY_ONE_PARTIAL,
  });
  assertEquals(degradedNeedsFollowUp(verdict), true);
});

Deno.test("degradedNeedsFollowUp - a missing criterion files a follow-up", () => {
  assertEquals(
    degradedNeedsFollowUp({
      degraded: true,
      delivered: [],
      shortfalls: [{ criterion: "x", status: "missing" }],
    }),
    true,
  );
});

Deno.test("degradedNeedsFollowUp - a healthy or fully met run files no follow-up", () => {
  assertEquals(
    degradedNeedsFollowUp({ degraded: false, delivered: [], shortfalls: [] }),
    false,
  );
  assertEquals(
    degradedNeedsFollowUp({ degraded: true, delivered: ["x"], shortfalls: [] }),
    false,
  );
});

Deno.test("buildDegradedNoFollowUpSection - (a) names the reason and says the issue states no criteria", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITHOUT_SCOPE,
    prBody: MINIMAL_BODY,
  });
  const section = buildDegradedNoFollowUpSection(verdict);
  assert(section.startsWith("## ⚠️ Degraded run"));
  assertStringIncludes(section, "`haiku`");
  assertStringIncludes(section, verdict.reason!);
  assertStringIncludes(section, "the issue states no acceptance criteria");
  assert(!/#\d/.test(section), "no follow-up number is referenced");
});

Deno.test("buildDegradedNoFollowUpSection - (b) says no criterion was assessed partial or missing and lists them", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: GRILL_ME_ISSUE,
    prBody: MINIMAL_BODY,
  });
  const section = buildDegradedNoFollowUpSection(verdict);
  assertStringIncludes(section, "`haiku`");
  assertStringIncludes(
    section,
    "no acceptance criterion was assessed `partial` or `missing`",
  );
  assertStringIncludes(section, "Raise the Claude Code pin.");
  assertStringIncludes(section, "unassessed");
  assert(!section.includes("states no acceptance criteria"));
  assert(!/#\d/.test(section), "no follow-up number is referenced");
});

Deno.test("buildDegradedNoFollowUpSection - (c) does not claim a 'Done when' issue states no criteria", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITH_DONE_WHEN,
    prBody: MINIMAL_BODY,
  });
  const section = buildDegradedNoFollowUpSection(verdict);
  assertStringIncludes(section, "`haiku`");
  assertStringIncludes(
    section,
    "no acceptance criterion was assessed `partial` or `missing`",
  );
  assertStringIncludes(section, "The release floor is 1.9.0.");
  assert(!section.includes("states no acceptance criteria"));
  assert(!/#\d/.test(section), "no follow-up number is referenced");
});

Deno.test("buildDegradedNoFollowUpSection - a verdict with no reason still names the fallback", () => {
  const section = buildDegradedNoFollowUpSection({
    degraded: true,
    delivered: [],
    shortfalls: [{ criterion: "Do the thing.", status: "unassessed" }],
  });
  assertStringIncludes(section, "served by a fallback model");
});

Deno.test("buildDegradedNoFollowUpSection - throws when a shortfall is partial or missing", () => {
  for (const status of ["partial", "missing"] as const) {
    assertThrows(
      () =>
        buildDegradedNoFollowUpSection({
          degraded: true,
          delivered: [],
          shortfalls: [
            { criterion: "A.", status: "unassessed" },
            { criterion: "B.", status },
          ],
        }),
      Error,
      "needs only unassessed shortfalls",
    );
  }
});

Deno.test("buildDegradedNoFollowUpSection - throws when there are no shortfalls", () => {
  assertThrows(
    () =>
      buildDegradedNoFollowUpSection({
        degraded: true,
        delivered: ["A."],
        shortfalls: [],
      }),
    Error,
    "needs only unassessed shortfalls",
  );
});

Deno.test("buildDegradedPrSection - (c) lists unassessed items alongside the partial one", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: SUMMARY_ONE_PARTIAL,
  });
  const section = buildDegradedPrSection(verdict, 77);
  assertStringIncludes(section, "Degraded run — partial delivery");
  assertStringIncludes(section, "#77");
  assertStringIncludes(section, "**partial** — The router sends planning");
  assertStringIncludes(section, "**unassessed** — The release floor is 1.9.0.");
});

// --- Issue #3350: re-deriving a live degraded-run section -----------------

const PAREN_REASON =
  "no served model matches expected `opus` (served: `a`, `b`)";
const PARTIAL_SHORTFALL = [{
  criterion: "the export",
  status: "partial",
}] as const;
const UNASSESSED_SHORTFALL = [
  { criterion: "the export", status: "unassessed" },
] as const;
const MET_SUMMARY = `## Acceptance Criteria

- **met** — the export works — evidence: \`x_test.ts\` — reviewer: met
`;
const PARTIAL_SUMMARY = MET_SUMMARY.replace("**met**", "**partial**").replace(
  "reviewer: met",
  "reviewer: partial",
);
const EXPORT_ISSUE = "## Acceptance Criteria\n\n- the export works\n";

Deno.test("assessScopeShortfalls - matches scope against the closure block", () => {
  assertEquals(assessScopeShortfalls(EXPORT_ISSUE, MET_SUMMARY), {
    delivered: ["the export works"],
    shortfalls: [],
  });
  assertEquals(assessScopeShortfalls(EXPORT_ISSUE, PARTIAL_SUMMARY), {
    delivered: [],
    shortfalls: [{ criterion: "the export works", status: "partial" }],
  });
});

Deno.test("parseDegradedSection - round-trips a reason with parentheses from each builder", () => {
  const noFollowUp = buildDegradedNoFollowUpSection({
    degraded: true,
    reason: PAREN_REASON,
    delivered: [],
    shortfalls: [...UNASSESSED_SHORTFALL],
  });
  assertEquals(parseDegradedSection(noFollowUp), { reason: PAREN_REASON });

  const verdict = {
    degraded: true,
    reason: PAREN_REASON,
    delivered: [],
    shortfalls: [...PARTIAL_SHORTFALL],
  };
  assertEquals(parseDegradedSection(buildDegradedUnfiledGapSection(verdict)), {
    reason: PAREN_REASON,
  });
  assertEquals(parseDegradedSection(buildDegradedPrSection(verdict, 77)), {
    reason: PAREN_REASON,
    followUpNumber: 77,
  });
});

Deno.test("parseDegradedSection - shortfall bullets never supply a follow-up number", () => {
  const section = buildDegradedNoFollowUpSection({
    degraded: true,
    reason: "served by a fallback model",
    delivered: [],
    shortfalls: [{
      criterion: "see continue in #9: here",
      status: "unassessed",
    }],
  });
  assertStringIncludes(section, "continue in #9:");
  assertEquals(parseDegradedSection(section).followUpNumber, undefined);
});

Deno.test("parseDegradedSection - a section without the opening line yields nothing", () => {
  assertEquals(parseDegradedSection("## ⚠️ Degraded run — x\n\n- a\n"), {});
});

Deno.test("buildDegradedUnfiledGapSection - throws on an all-unassessed verdict", () => {
  assertThrows(() =>
    buildDegradedUnfiledGapSection({
      degraded: true,
      delivered: [],
      shortfalls: [...UNASSESSED_SHORTFALL],
    })
  );
});

Deno.test("rederiveDegradedSection - empty when every item is now met", () => {
  const liveSection = buildDegradedPrSection({
    degraded: true,
    delivered: [],
    shortfalls: [...PARTIAL_SHORTFALL],
  }, 77);
  assertEquals(
    rederiveDegradedSection({
      liveSection,
      issueBody: EXPORT_ISSUE,
      prBody: MET_SUMMARY,
    }),
    "",
  );
});

Deno.test("rederiveDegradedSection - keeps the follow-up number and reason", () => {
  const liveSection = buildDegradedPrSection({
    degraded: true,
    reason: PAREN_REASON,
    delivered: [],
    shortfalls: [...PARTIAL_SHORTFALL],
  }, 77);
  const out = rederiveDegradedSection({
    liveSection,
    issueBody: EXPORT_ISSUE,
    prBody: PARTIAL_SUMMARY,
  });
  assertStringIncludes(out, "continue in #77:");
  assertStringIncludes(out, PAREN_REASON);
  assertStringIncludes(out, "**partial** — the export works");
});

Deno.test("rederiveDegradedSection - a gap with no follow-up gets the unfiled-gap section", () => {
  const liveSection = buildDegradedNoFollowUpSection({
    degraded: true,
    reason: PAREN_REASON,
    delivered: [],
    shortfalls: [...UNASSESSED_SHORTFALL],
  });
  const out = rederiveDegradedSection({
    liveSection,
    issueBody: EXPORT_ISSUE,
    prBody: PARTIAL_SUMMARY,
  });
  assertStringIncludes(out, "The worker filed no follow-up for these items");
  assertStringIncludes(out, PAREN_REASON);
});

Deno.test("rederiveDegradedSection - re-derives the no-follow-up reason from the current issue", () => {
  const liveSection = buildDegradedNoFollowUpSection({
    degraded: true,
    reason: "served by a fallback model",
    delivered: [],
    shortfalls: [{ criterion: UNSTATED_SCOPE_ITEM, status: "unassessed" }],
  });
  assertStringIncludes(liveSection, "the issue states no acceptance criteria");

  const nowStated = rederiveDegradedSection({
    liveSection,
    issueBody: EXPORT_ISSUE,
    prBody: "## Summary\n\nNothing assessed.\n",
  });
  assertStringIncludes(nowStated, "no acceptance criterion was assessed");
  assertEquals(nowStated.includes("states no acceptance criteria"), false);

  const stillNone = rederiveDegradedSection({
    liveSection,
    issueBody: "Just prose.",
    prBody: "## Summary\n\nNothing assessed.\n",
  });
  assertStringIncludes(stillNone, "the issue states no acceptance criteria");
});

Deno.test("parseDegradedSection - hostile follow-up digits are not read as a number (Issue #3350)", () => {
  const section = "This run was degraded (x) and did not show every item " +
    "as met. The outstanding items continue in #" + "1".repeat(100_000) +
    "x";
  assertEquals(parseDegradedSection(section), { reason: "x" });
});

// ---------------------------------------------------------------------------
// A healthy run's reported gaps (Issue #3506)
// ---------------------------------------------------------------------------

const TWO_CRITERIA_ISSUE =
  "## Acceptance Criteria\n\n- the export works\n- the import works\n";
const EXPORT_MET_IMPORT_PARTIAL = `## Acceptance Criteria

- **met** — the export works — evidence: \`x_test.ts\` — reviewer: met
- **partial** — the import works — evidence: \`y_test.ts\` — reviewer: partial — reason: no retry
`;

Deno.test("assessReportedGaps - a partial entry is a shortfall and a met one is delivered (Issue #3506)", () => {
  assertEquals(
    assessReportedGaps(TWO_CRITERIA_ISSUE, EXPORT_MET_IMPORT_PARTIAL),
    {
      degraded: false,
      delivered: ["the export works"],
      shortfalls: [{ criterion: "the import works", status: "partial" }],
    },
  );
});

Deno.test("assessReportedGaps - every entry met leaves no shortfall (Issue #3506)", () => {
  assertEquals(assessReportedGaps(EXPORT_ISSUE, MET_SUMMARY), {
    degraded: false,
    delivered: ["the export works"],
    shortfalls: [],
  });
});

Deno.test("assessReportedGaps - unassessed items are dropped but an unassigned partial gap is kept (Issue #3506)", () => {
  const unassessed = assessReportedGaps(
    TWO_CRITERIA_ISSUE,
    "## Acceptance Criteria\n\n- **met** — the export works — evidence: \`x_test.ts\` — reviewer: met\n",
  );
  assertEquals(unassessed.shortfalls, []);

  const gap = assessReportedGaps(
    EXPORT_ISSUE,
    MET_SUMMARY +
      "- **partial** — quarterly invoice emailer — reviewer: partial — reason: not started\n",
  );
  assertEquals(gap.shortfalls, [
    { criterion: "quarterly invoice emailer —", status: "partial" },
  ]);
});

Deno.test("assessReportedGaps - an issue stating no criteria keeps each partial or missing entry, named by its subject (PR #3676 review)", () => {
  assertEquals(
    assessReportedGaps(ISSUE_WITHOUT_SCOPE, PARTIAL_SUMMARY),
    {
      degraded: false,
      delivered: [],
      shortfalls: [{ criterion: "the export works —", status: "partial" }],
    },
  );
  const missing = assessReportedGaps(
    ISSUE_WITHOUT_SCOPE,
    MET_SUMMARY +
      "- **missing** — the quarterly emailer — reviewer: missing — reason: not started\n",
  );
  assertEquals(missing.shortfalls, [
    { criterion: "the quarterly emailer —", status: "missing" },
  ]);
  // A `met` entry alone is no gap, so a healthy run with no residue files nothing.
  assertEquals(
    assessReportedGaps(ISSUE_WITHOUT_SCOPE, MET_SUMMARY).shortfalls,
    [],
  );
});

Deno.test("assessScopeShortfalls - an issue stating no criteria lists its met entries as delivered and keeps its partial gap (PR #3676 review)", () => {
  const verdict = assessScopeShortfalls(
    ISSUE_WITHOUT_SCOPE,
    MET_SUMMARY +
      "- **partial** — the quarterly emailer — reviewer: partial — reason: not wired up\n",
  );
  assertEquals(verdict.delivered.length, 1);
  assertStringIncludes(verdict.delivered[0]!, "the export works");
  assertEquals(verdict.shortfalls.length, 2);
  assertEquals(verdict.shortfalls[0], {
    criterion: UNSTATED_SCOPE_ITEM,
    status: "unassessed",
  });
  assertStringIncludes(verdict.shortfalls[1]!.criterion, "quarterly emailer");
  assertEquals(verdict.shortfalls[1]!.status, "partial");
});

Deno.test("buildDegradedFollowUpIssue - a healthy verdict gets the reported-gap body under the same finding id (Issue #3506)", () => {
  const verdict = assessReportedGaps(
    TWO_CRITERIA_ISSUE,
    EXPORT_MET_IMPORT_PARTIAL,
  );
  const issue = buildDegradedFollowUpIssue({
    parentNumber: 77,
    parentTitle: "Add the importer",
    verdict,
    runId: "run-1",
  });
  assertEquals(issue.title, "Finish #77: Add the importer");
  assertStringIncludes(
    issue.body,
    `<!-- finding-id: ${degradedFollowUpFindingId(77)} -->`,
  );
  assertStringIncludes(issue.body, "Issue #3506");
  assertStringIncludes(issue.body, "- **partial** — the import works");
  assertStringIncludes(issue.body, "- the export works");
  assertEquals(issue.body.includes("**degraded**"), false);
});

Deno.test("buildDegradedFollowUpIssue - the healthy body is laid out exactly, blank lines and headings included (Issue #3506)", () => {
  const issue = buildDegradedFollowUpIssue({
    parentNumber: 77,
    parentTitle: "Add the importer",
    verdict: assessReportedGaps(TWO_CRITERIA_ISSUE, EXPORT_MET_IMPORT_PARTIAL),
    runId: "run-1",
  });
  assertEquals(
    issue.body,
    [
      `<!-- finding-id: ${degradedFollowUpFindingId(77)} -->`,
      "",
      "Auto-filed by the Vibe Coder (Issue #3506): the implementation run for " +
      "#77 closed out one or more acceptance criteria as `partial` or " +
      "`missing` in its PR summary. The outstanding scope continues here so " +
      "it survives that PR's merge.",
      "",
      "## Acceptance Criteria",
      "",
      "Outstanding from that run (status as its PR summary reported it):",
      "",
      "- **partial** — the import works",
      "",
      "## Already delivered by that run",
      "",
      "- the export works",
      "",
      "Check each outstanding item against the merged code before changing " +
      "anything: the run may have done more than its summary claimed.",
      "",
      "_Run id: `run-1`_",
    ].join("\n"),
  );
});

Deno.test("buildDegradedFollowUpIssue - a degraded verdict keeps the degraded body (Issue #3506)", () => {
  const issue = buildDegradedFollowUpIssue({
    parentNumber: 77,
    parentTitle: "Add the importer",
    verdict: {
      degraded: true,
      reason: "served by a fallback model",
      delivered: [],
      shortfalls: [...PARTIAL_SHORTFALL],
    },
    runId: "run-1",
  });
  assertStringIncludes(issue.body, "Issue #2562");
  assertStringIncludes(issue.body, "was **degraded**");
  assertEquals(issue.body.includes("Issue #3506"), false);
});

Deno.test("buildReportedGapPrSection - names the follow-up and the shortfall (Issue #3506)", () => {
  const section = buildReportedGapPrSection(
    assessReportedGaps(TWO_CRITERIA_ISSUE, EXPORT_MET_IMPORT_PARTIAL),
    77,
  );
  assert(section.startsWith(REPORTED_GAP_SECTION_HEADING));
  assertStringIncludes(section, "continue in #77:");
  assertStringIncludes(section, "- **partial** — the import works");
});

Deno.test("buildReportedGapPrSection - is laid out exactly, blank lines included (Issue #3506)", () => {
  assertEquals(
    buildReportedGapPrSection(
      assessReportedGaps(TWO_CRITERIA_ISSUE, EXPORT_MET_IMPORT_PARTIAL),
      77,
    ),
    [
      REPORTED_GAP_SECTION_HEADING,
      "",
      "This run's PR summary closed out the criteria below as `partial` or " +
      "`missing`. The outstanding items continue in #77:",
      "",
      "- **partial** — the import works",
      "",
      "",
    ].join("\n"),
  );
});

Deno.test("buildReportedGapPrSection - throws on a degraded verdict or one without a gap (Issue #3506)", () => {
  assertThrows(
    () =>
      buildReportedGapPrSection({
        degraded: true,
        delivered: [],
        shortfalls: [...PARTIAL_SHORTFALL],
      }, 77),
    Error,
    "needs a healthy verdict",
  );
  assertThrows(
    () =>
      buildReportedGapPrSection({
        degraded: false,
        delivered: [],
        shortfalls: [...UNASSESSED_SHORTFALL],
      }, 77),
    Error,
    "needs a healthy verdict",
  );
});

Deno.test("rederiveReportedGapSection - empty when everything is now met (Issue #3506)", () => {
  const liveSection = buildReportedGapPrSection(
    assessReportedGaps(EXPORT_ISSUE, PARTIAL_SUMMARY),
    77,
  );
  assertEquals(
    rederiveReportedGapSection({
      liveSection,
      issueBody: EXPORT_ISSUE,
      prBody: MET_SUMMARY,
    }),
    "",
  );
});

Deno.test("rederiveReportedGapSection - gaps the section was raised with stay as they are (Issue #3506)", () => {
  const liveSection = buildReportedGapPrSection(
    assessReportedGaps(TWO_CRITERIA_ISSUE, EXPORT_MET_IMPORT_PARTIAL),
    77,
  );
  assertEquals(
    rederiveReportedGapSection({
      liveSection,
      issueBody: TWO_CRITERIA_ISSUE,
      prBody: EXPORT_MET_IMPORT_PARTIAL,
    }),
    liveSection,
  );
});

Deno.test("rederiveReportedGapSection - changed gaps keep the number but do not claim the follow-up holds them (PR #3676 review)", () => {
  const liveSection = buildReportedGapPrSection(
    assessReportedGaps(EXPORT_ISSUE, PARTIAL_SUMMARY),
    77,
  );
  const out = rederiveReportedGapSection({
    liveSection,
    issueBody: TWO_CRITERIA_ISSUE,
    prBody: EXPORT_MET_IMPORT_PARTIAL,
  });
  assert(out.startsWith(REPORTED_GAP_SECTION_HEADING));
  assertStringIncludes(out, "The worker filed #77 for the outstanding items");
  assertStringIncludes(out, "does not rewrite it");
  assertEquals(out.includes("continue in #77:"), false);
  assertStringIncludes(out, "the import works");
  // A second re-derive from the same inputs is a no-op, not another rewrite.
  assertEquals(
    rederiveReportedGapSection({
      liveSection: out,
      issueBody: TWO_CRITERIA_ISSUE,
      prBody: EXPORT_MET_IMPORT_PARTIAL,
    }),
    out,
  );
});

Deno.test("buildReportedGapStaleFollowUpSection - is laid out exactly, blank lines included (PR #3676 review)", () => {
  assertEquals(
    buildReportedGapStaleFollowUpSection(
      assessReportedGaps(TWO_CRITERIA_ISSUE, EXPORT_MET_IMPORT_PARTIAL),
      77,
    ),
    [
      REPORTED_GAP_SECTION_HEADING,
      "",
      "This run's PR summary closed out the criteria below as `partial` or " +
      "`missing`. The worker filed #77 for the outstanding items when the PR " +
      "was raised and a re-sync does not rewrite it, so it may not list every " +
      "item below — check them against the diff before merging:",
      "",
      "- **partial** — the import works",
      "",
      "",
    ].join("\n"),
  );
});

Deno.test("buildReportedGapStaleFollowUpSection - throws on a degraded verdict or one without a gap (PR #3676 review)", () => {
  assertThrows(
    () =>
      buildReportedGapStaleFollowUpSection({
        degraded: true,
        delivered: [],
        shortfalls: [...PARTIAL_SHORTFALL],
      }, 77),
    Error,
    "needs a healthy verdict",
  );
  assertThrows(
    () =>
      buildReportedGapStaleFollowUpSection({
        degraded: false,
        delivered: [],
        shortfalls: [...UNASSESSED_SHORTFALL],
      }, 77),
    Error,
    "needs a healthy verdict",
  );
});

Deno.test("rederiveReportedGapSection - never reads the number from a hostile shortfall bullet (Issue #3506)", () => {
  const hostile =
    `${REPORTED_GAP_SECTION_HEADING}\n\n- **partial** — see continue in #12345: here\n\n`;
  const out = rederiveReportedGapSection({
    liveSection: hostile,
    issueBody: TWO_CRITERIA_ISSUE,
    prBody: EXPORT_MET_IMPORT_PARTIAL,
  });
  assertEquals(out, hostile);
  const hostileFiled =
    `${REPORTED_GAP_SECTION_HEADING}\n\n- **partial** — The worker filed #12345 here\n\n`;
  assertEquals(
    rederiveReportedGapSection({
      liveSection: hostileFiled,
      issueBody: TWO_CRITERIA_ISSUE,
      prBody: EXPORT_MET_IMPORT_PARTIAL,
    }),
    hostileFiled,
  );
});

Deno.test("rederiveReportedGapSection - a long run of digits is not read as a number (PR #3676 review)", () => {
  const live =
    `${REPORTED_GAP_SECTION_HEADING}\n\nThis run's PR summary closed out the criteria. The worker filed #${
      "9".repeat(50_000)
    }x\n\n`;
  assertEquals(
    rederiveReportedGapSection({
      liveSection: live,
      issueBody: TWO_CRITERIA_ISSUE,
      prBody: EXPORT_MET_IMPORT_PARTIAL,
    }),
    live,
  );
});
