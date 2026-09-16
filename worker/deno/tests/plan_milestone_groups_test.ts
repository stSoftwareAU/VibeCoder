/**
 * Tests for plan_milestone_groups.ts — the deterministic structural gate on
 * the `## Milestones` table a planning run publishes (Issue #2172).
 *
 * The publish turn groups its sub-issues by file area and posts one row per
 * group; this gate parses that table and reports the rows that break the
 * structural rules — a published sub-issue in no group or in two, a group
 * with no file area, or a fifth multi-sub-issue milestone. File overlap
 * between groups is deliberately **never** checked here: that is planner
 * judgement, not a structural fault.
 *
 * Every test calls a real exported function with real markdown and asserts on
 * the result — no source-text inspection.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildMilestoneGroupsGateReason,
  escalateMilestoneGroupOffenders,
  extractMilestoneGroups,
  MAX_MILESTONE_GROUPS,
  MILESTONES_TABLE_REQUIREMENT,
  runMilestoneGroupsGate,
  validateMilestoneGroups,
} from "../lib/plan_milestone_groups.ts";
import type { MilestoneGroup } from "../lib/plan_milestone_groups.ts";
import type { GitHubClient, Logger, Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A published summary comment carrying both published tables. */
const PUBLISHED_COMMENT = `## Plan published

Sub-issues created, grouped by file area:

1. #101 — Terraform the options desk (\`enhancement\`)
2. #102 — Lambda handlers (\`enhancement\`)

## Plan Coverage

| Ask | Covered by | Notes |
| --- | --- | --- |
| Allow options trading | #101, #102, #103 | Split by file area |

## Milestones

| Milestone | File area | Sub-issues |
| --- | --- | --- |
| infra: options trading | infra/ | #101 |
| backend: options trading | backend/lambdas | #102, #104 |
| — | docs/ | #103 |
`;

/** The fleet login the comment-author check trusts (Issue #1244). */
const FLEET_LOGIN = "fleet-bot";
const FLEET_OPTIONS = { fleetAuthors: [FLEET_LOGIN] };

function makeSilentLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

/** A logger that captures its warnings, for the author-check assertions. */
function makeCapturingLogger(warnings: string[]): Logger {
  return {
    ...makeSilentLogger(),
    warn: (message: string) => {
      warnings.push(message);
    },
  };
}

/** Build a group, defaulting the parts a test does not care about. */
function group(
  title: string,
  area: string,
  subIssueNumbers: number[],
): MilestoneGroup {
  return { title, area, subIssueNumbers };
}

// ---------------------------------------------------------------------------
// extractMilestoneGroups
// ---------------------------------------------------------------------------

Deno.test("extractMilestoneGroups - reads milestone/area/sub-issue rows", () => {
  const groups = extractMilestoneGroups(PUBLISHED_COMMENT);
  assert(groups !== null);
  assertEquals(groups.length, 3);
  assertEquals(groups[0], group("infra: options trading", "infra/", [101]));
  assertEquals(
    groups[1],
    group("backend: options trading", "backend/lambdas", [102, 104]),
  );
});

Deno.test("extractMilestoneGroups - a `—` milestone cell means no milestone", () => {
  const groups = extractMilestoneGroups(PUBLISHED_COMMENT);
  assert(groups !== null);
  assertEquals(groups[2], group("", "docs/", [103]));
});

Deno.test("extractMilestoneGroups - `none` and an empty cell also mean no milestone", () => {
  const groups = extractMilestoneGroups(`| Milestone | File area | Sub-issues |
| --- | --- | --- |
| none | docs/ | #7 |
|  | infra/ | #8 |
| N/A | worker/ | #9 |
`);
  assert(groups !== null);
  assertEquals(groups.map((g) => g.title), ["", "", ""]);
  assertEquals(groups.map((g) => g.subIssueNumbers), [[7], [8], [9]]);
});

Deno.test("extractMilestoneGroups - returns null when no table is present", () => {
  assertEquals(
    extractMilestoneGroups("## Plan published\n\nNo table here."),
    null,
  );
});

Deno.test("extractMilestoneGroups - ignores an adjacent `## Plan Coverage` table", () => {
  const coverageOnly = `## Plan Coverage

| Ask | Covered by | Notes |
| --- | --- | --- |
| Allow options trading | #101 | |
`;
  assertEquals(extractMilestoneGroups(coverageOnly), null);
});

Deno.test("extractMilestoneGroups - ignores an unrelated table", () => {
  const body = `| Name | Value |
| --- | --- |
| foo | bar |
`;
  assertEquals(extractMilestoneGroups(body), null);
});

Deno.test("extractMilestoneGroups - reads full issue URLs as sub-issue refs", () => {
  const groups = extractMilestoneGroups(`| Milestone | File area | Sub-issues |
| --- | --- | --- |
| infra | infra/ | https://github.com/owner/repo/issues/12, #13 |
`);
  assert(groups !== null);
  assertEquals(groups[0]?.subIssueNumbers, [12, 13]);
});

Deno.test("extractMilestoneGroups - keeps escaped pipes inside a cell", () => {
  const groups = extractMilestoneGroups(`| Milestone | File area | Sub-issues |
| --- | --- | --- |
| infra \\| options | worker/deno/lib \\| tests | #7 |
`);
  assert(groups !== null);
  assertEquals(groups.length, 1);
  assertEquals(groups[0]?.title, "infra | options");
  assertEquals(groups[0]?.area, "worker/deno/lib | tests");
});

Deno.test("extractMilestoneGroups - a header-only table yields no groups, not null", () => {
  const groups = extractMilestoneGroups(`| Milestone | File area | Sub-issues |
| --- | --- | --- |
`);
  assertEquals(groups, []);
});

Deno.test("extractMilestoneGroups - a repeated sub-issue ref in one cell is counted once", () => {
  const groups = extractMilestoneGroups(`| Milestone | File area | Sub-issues |
| --- | --- | --- |
| infra | infra/ | #7, #7 |
`);
  assertEquals(groups?.[0]?.subIssueNumbers, [7]);
});

// ---------------------------------------------------------------------------
// validateMilestoneGroups — accept shapes
// ---------------------------------------------------------------------------

Deno.test("validateMilestoneGroups - every published sub-issue in exactly one group passes", () => {
  const offenders = validateMilestoneGroups([
    group("infra", "infra/", [101]),
    group("backend", "backend/", [102, 103]),
  ], [101, 102, 103]);
  assertEquals(offenders, []);
});

Deno.test("validateMilestoneGroups - overlapping file areas are never an offence", () => {
  // Two groups naming the same file area is planner judgement, not a
  // structural fault — the gate must stay silent about it.
  const offenders = validateMilestoneGroups([
    group("infra a", "worker/deno/lib", [101, 102]),
    group("infra b", "worker/deno/lib", [103, 104]),
  ], [101, 102, 103, 104]);
  assertEquals(offenders, []);
});

Deno.test("validateMilestoneGroups - four multi groups plus any number of `—` rows pass", () => {
  const groups = [
    group("a", "a/", [1, 2]),
    group("b", "b/", [3, 4]),
    group("c", "c/", [5, 6]),
    group("d", "d/", [7, 8]),
    group("", "e/", [9]),
    group("", "f/", [10]),
    group("", "g/", [11]),
  ];
  assertEquals(MAX_MILESTONE_GROUPS, 4);
  assertEquals(
    validateMilestoneGroups(groups, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    [],
  );
});

Deno.test("validateMilestoneGroups - a group naming an unpublished sub-issue is not an offence", () => {
  // #104 was not published by this run (a pre-existing issue folded into the
  // plan). The gate only rules on the run's own published set.
  const offenders = validateMilestoneGroups([
    group("infra", "infra/", [101, 104]),
  ], [101]);
  assertEquals(offenders, []);
});

// ---------------------------------------------------------------------------
// validateMilestoneGroups — reject shapes
// ---------------------------------------------------------------------------

Deno.test("validateMilestoneGroups - a published sub-issue in no group is an offender", () => {
  const offenders = validateMilestoneGroups([
    group("infra", "infra/", [101]),
  ], [101, 102]);
  assertEquals(offenders.length, 1);
  assertEquals(offenders[0]?.subject, "#102");
  assertStringIncludes(offenders[0]?.reason ?? "", "no milestone group");
});

Deno.test("validateMilestoneGroups - a published sub-issue in two groups is an offender", () => {
  const offenders = validateMilestoneGroups([
    group("infra", "infra/", [101, 102]),
    group("backend", "backend/", [102]),
  ], [101, 102]);
  assertEquals(offenders.length, 1);
  assertEquals(offenders[0]?.subject, "#102");
  assertStringIncludes(offenders[0]?.reason ?? "", "2 milestone groups");
  assertStringIncludes(offenders[0]?.reason ?? "", "infra");
  assertStringIncludes(offenders[0]?.reason ?? "", "backend");
});

Deno.test("validateMilestoneGroups - a group with no file area is an offender", () => {
  const offenders = validateMilestoneGroups([
    group("infra", "", [101, 102]),
  ], [101, 102]);
  assertEquals(offenders.length, 1);
  assertStringIncludes(offenders[0]?.subject ?? "", "infra");
  assertStringIncludes(offenders[0]?.reason ?? "", "no file area");
});

Deno.test("validateMilestoneGroups - a bracketed placeholder file area is no file area", () => {
  const offenders = validateMilestoneGroups([
    group("infra", "[top-level directory]", [101, 102]),
  ], [101, 102]);
  assertEquals(offenders.length, 1);
  assertStringIncludes(offenders[0]?.reason ?? "", "no file area");
});

Deno.test("validateMilestoneGroups - a `—` row with no file area is an offender too", () => {
  const offenders = validateMilestoneGroups([
    group("", "", [101]),
  ], [101]);
  assertEquals(offenders.length, 1);
  assertStringIncludes(offenders[0]?.subject ?? "", "#101");
  assertStringIncludes(offenders[0]?.reason ?? "", "no file area");
});

Deno.test("validateMilestoneGroups - a fifth multi-sub-issue group is an offender", () => {
  const groups = [
    group("a", "a/", [1, 2]),
    group("b", "b/", [3, 4]),
    group("c", "c/", [5, 6]),
    group("d", "d/", [7, 8]),
    group("e", "e/", [9, 10]),
  ];
  const offenders = validateMilestoneGroups(
    groups,
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assertEquals(offenders.length, 1);
  assertStringIncludes(offenders[0]?.subject ?? "", "e");
  assertStringIncludes(offenders[0]?.reason ?? "", "at most 4 milestones");
});

Deno.test("validateMilestoneGroups - single-sub-issue groups do not count towards the cap", () => {
  const groups = [
    group("a", "a/", [1, 2]),
    group("", "b/", [3]),
    group("", "c/", [4]),
    group("", "d/", [5]),
    group("", "e/", [6]),
    group("f", "f/", [7, 8]),
  ];
  assertEquals(validateMilestoneGroups(groups, [1, 2, 3, 4, 5, 6, 7, 8]), []);
});

Deno.test("validateMilestoneGroups - no groups at all offends every published sub-issue", () => {
  const offenders = validateMilestoneGroups([], [101, 102]);
  assertEquals(offenders.map((o) => o.subject), ["#101", "#102"]);
});

// ---------------------------------------------------------------------------
// runMilestoneGroupsGate — fetch orchestration
// ---------------------------------------------------------------------------

Deno.test("runMilestoneGroupsGate - finds the table in a parent comment", async () => {
  const calls: string[][] = [];
  const verdict = await runMilestoneGroupsGate({
    repo: "owner/repo",
    parentIssueNumber: 42,
    ghCommandFn: (args) => {
      calls.push(args);
      return Promise.resolve(JSON.stringify({
        body: "Parent issue body",
        comments: [
          { body: "unrelated chatter", author: { login: FLEET_LOGIN } },
          { body: PUBLISHED_COMMENT, author: { login: FLEET_LOGIN } },
        ],
      }));
    },
    logger: makeSilentLogger(),
    authorOptions: FLEET_OPTIONS,
  });
  assertEquals(verdict.tableFound, true);
  assertEquals(verdict.groups.length, 3);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.[0], "issue");
  assert(calls[0]?.includes("body,comments"));
});

Deno.test("runMilestoneGroupsGate - falls back to the parent body", async () => {
  const verdict = await runMilestoneGroupsGate({
    repo: "owner/repo",
    parentIssueNumber: 42,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify({
        body: PUBLISHED_COMMENT,
        comments: [],
      })),
    logger: makeSilentLogger(),
  });
  assertEquals(verdict.tableFound, true);
  assertEquals(verdict.groups.length, 3);
});

Deno.test("runMilestoneGroupsGate - no table anywhere reports no table", async () => {
  const verdict = await runMilestoneGroupsGate({
    repo: "owner/repo",
    parentIssueNumber: 42,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify({ body: "nothing", comments: [] })),
    logger: makeSilentLogger(),
  });
  assertEquals(verdict.tableFound, false);
  assertEquals(verdict.groups, []);
});

Deno.test("runMilestoneGroupsGate - an unreadable parent is reported, not treated as table-free", async () => {
  const verdict = await runMilestoneGroupsGate({
    repo: "owner/repo",
    parentIssueNumber: 42,
    ghCommandFn: () => Promise.reject(new Error("gh exploded")),
    logger: makeSilentLogger(),
  });
  assertEquals(verdict.tableFound, false);
  assertEquals(verdict.readFailed, true);
});

Deno.test("runMilestoneGroupsGate - an outsider's table is discarded", async () => {
  const warnings: string[] = [];
  const verdict = await runMilestoneGroupsGate({
    repo: "owner/repo",
    parentIssueNumber: 42,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify({
        body: "Parent issue body with no table",
        comments: [
          { body: PUBLISHED_COMMENT, author: { login: "outsider" } },
        ],
      })),
    logger: makeCapturingLogger(warnings),
    authorOptions: FLEET_OPTIONS,
  });
  assertEquals(verdict.tableFound, false);
  assert(
    warnings.some((w) => w.includes("authored outside the fleet")),
    "the discarded outsider table is logged",
  );
});

Deno.test("runMilestoneGroupsGate - the newest fleet table wins", async () => {
  const older = `| Milestone | File area | Sub-issues |
| --- | --- | --- |
| stale | old/ | #1 |
`;
  const verdict = await runMilestoneGroupsGate({
    repo: "owner/repo",
    parentIssueNumber: 42,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify({
        body: "",
        comments: [
          { body: older, author: { login: FLEET_LOGIN } },
          { body: PUBLISHED_COMMENT, author: { login: FLEET_LOGIN } },
        ],
      })),
    logger: makeSilentLogger(),
    authorOptions: FLEET_OPTIONS,
  });
  assertEquals(verdict.groups.length, 3);
});

Deno.test("runMilestoneGroupsGate - an unresolved fleet discards every comment table", async () => {
  const warnings: string[] = [];
  const verdict = await runMilestoneGroupsGate({
    repo: "owner/repo",
    parentIssueNumber: 42,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify({
        body: "",
        comments: [{ body: PUBLISHED_COMMENT, author: { login: FLEET_LOGIN } }],
      })),
    logger: makeCapturingLogger(warnings),
    authorOptions: { fleetAuthors: [] },
  });
  assertEquals(verdict.tableFound, false);
  assert(warnings.some((w) => w.includes("fleet author set unresolved")));
});

// ---------------------------------------------------------------------------
// Reason wording and the prompt constant
// ---------------------------------------------------------------------------

Deno.test("buildMilestoneGroupsGateReason - names every offending row", () => {
  const reason = buildMilestoneGroupsGateReason(
    validateMilestoneGroups([group("infra", "", [101])], [101, 102]),
  );
  assertStringIncludes(reason, "infra");
  assertStringIncludes(reason, "no file area");
  assertStringIncludes(reason, "#102");
});

Deno.test("MILESTONES_TABLE_REQUIREMENT - states the table, the columns and the cap", () => {
  assertStringIncludes(MILESTONES_TABLE_REQUIREMENT, "## Milestones");
  assertStringIncludes(MILESTONES_TABLE_REQUIREMENT, "File area");
  assertStringIncludes(MILESTONES_TABLE_REQUIREMENT, "Sub-issues");
  assertStringIncludes(MILESTONES_TABLE_REQUIREMENT, "four");
});

// ---------------------------------------------------------------------------
// escalateMilestoneGroupOffenders — the shared needs-human chokepoint
// ---------------------------------------------------------------------------

function makeStubClient(): {
  client: GitHubClient;
  comments: Array<{ issueNumber: number; body: string }>;
  labels: string[];
} {
  const comments: Array<{ issueNumber: number; body: string }> = [];
  const labels: string[] = [];
  const client: GitHubClient = {
    getIssue: () => {
      throw new Error("stub: getIssue not implemented");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: (_repo: string, _n: number, label: string) => {
      labels.push(label);
      return Promise.resolve();
    },
    removeLabel: () => Promise.resolve(),
    postComment: (_repo: string, n: number, body: string) => {
      comments.push({ issueNumber: n, body });
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
  return { client, comments, labels };
}

Deno.test("escalateMilestoneGroupOffenders - labels the parent and names the rows", async () => {
  const { client, comments, labels } = makeStubClient();
  const escalated = await escalateMilestoneGroupOffenders({
    ghClient: client,
    repo: "owner/repo",
    parentIssueNumber: 42,
    needsHumanLabel: "needs-human",
    offenders: validateMilestoneGroups([group("infra", "", [101])], [101, 102]),
    logger: makeSilentLogger(),
    deps: {
      github: {
        ensureLabelExists: () =>
          Promise.resolve({ ok: true, value: undefined } as Result<void>),
      },
    },
  });
  assertEquals(escalated, true);
  assertEquals(labels, ["needs-human"]);
  assertEquals(comments.length, 1);
  assertStringIncludes(comments[0]?.body ?? "", "#102");
  assertStringIncludes(comments[0]?.body ?? "", "Next step:");
});
