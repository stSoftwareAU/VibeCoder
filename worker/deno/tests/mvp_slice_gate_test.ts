/**
 * Tests for mvp_slice_gate.ts — the deterministic MVP-slice gate on a published
 * plan (Issue #522).
 *
 * The gate is the enforcement half of "name the MVP slice": the publish turn
 * marks exactly one sub-issue in its summary comment with `**MVP slice**` and a
 * sentence saying what value lands if nothing after it is built — or states
 * plainly that no slice is independently valuable — and the plan stays ordered
 * MVP-first inside its `Depends on` edges.
 *
 * Every test calls a real exported function with real markdown and asserts on
 * the verdict — no source-text inspection.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildMvpSliceGateReason,
  escalateMissingMvpSlice,
  extractPlanEntries,
  judgeMvpSlice,
  MVP_SLICE_REQUIREMENT,
  runMvpSliceGate,
  validatePlanOrder,
} from "../lib/mvp_slice_gate.ts";
import type { GitHubClient, Logger, Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A published plan naming exactly one MVP slice, ordered MVP-first. */
const MARKED_COMMENT = `## Plan published

Sub-issues created, MVP slice first:

1. #101 — Add the query result cache (\`enhancement\`) — **MVP slice**: repeated dashboard queries are served from memory even if nothing after this lands
2. #102 — Rewrite the query planner (\`enhancement\`, depends on #101)
3. #103 — Add the eviction policy (\`enhancement\`, depends on #101)

## Plan Coverage

| Ask | Covered by | Notes |
| --- | --- | --- |
| Cache query results | #101 | |
`;

/** A plan where nothing is independently valuable, said so explicitly. */
const NO_SLICE_COMMENT = `## Plan published

Sub-issues created, in implementation order:

1. #201 — Move the parser into \`lib/parser.ts\` (\`enhancement\`)
2. #202 — Point every importer at the new path (\`enhancement\`, depends on #201)

No independently valuable slice — a mechanical module move; nothing ships until every importer is repointed.
`;

/** The same plan with two sub-issues both claiming the slice. */
const TWO_MARKER_COMMENT = `## Plan published

1. #101 — Add the query result cache (\`enhancement\`) — **MVP slice**: queries hit memory
2. #102 — Rewrite the query planner (\`enhancement\`) — **MVP slice**: the planner gets faster
`;

/** A plan naming no slice and saying nothing about why. */
const UNMARKED_COMMENT = `## Plan published

Sub-issues created, in implementation order:

1. #101 — Add the query result cache (\`enhancement\`)
2. #102 — Rewrite the query planner (\`enhancement\`, depends on #101)
`;

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

// ---------------------------------------------------------------------------
// extractPlanEntries
// ---------------------------------------------------------------------------

Deno.test("extractPlanEntries - reads number, marker and dependencies", () => {
  const entries = extractPlanEntries(MARKED_COMMENT);
  assertEquals(entries.length, 3);
  assertEquals(entries.map((e) => e.number), [101, 102, 103]);
  assertEquals(entries.map((e) => e.isMvp), [true, false, false]);
  assertEquals(entries[1]?.dependsOn, [101]);
  assertStringIncludes(entries[0]?.valueStatement ?? "", "served from memory");
});

Deno.test("extractPlanEntries - a dependency phrase does not swallow later numbers", () => {
  const entries = extractPlanEntries(
    "1. #10 — Base (`enhancement`)\n" +
      "2. #11 — Feature (depends on #10) — see #99 for background\n",
  );
  assertEquals(entries[1]?.dependsOn, [10]);
});

Deno.test("extractPlanEntries - reads several dependencies on one entry", () => {
  const entries = extractPlanEntries(
    "1. #10 — Base\n2. #11 — Other\n3. #12 — Tests (depends on #10 and #11)\n",
  );
  assertEquals(entries[2]?.dependsOn, [10, 11]);
});

Deno.test("extractPlanEntries - ignores a numbered list that names no sub-issues", () => {
  const entries = extractPlanEntries(
    "Steps taken:\n1. Read the issue\n2. Listed open issues\n",
  );
  assertEquals(entries.length, 0);
});

Deno.test("extractPlanEntries - accepts full issue URLs", () => {
  const entries = extractPlanEntries(
    "1. https://github.com/owner/repo/issues/77 — Ship it — **MVP slice**: it ships\n",
  );
  assertEquals(entries[0]?.number, 77);
  assertEquals(entries[0]?.isMvp, true);
});

// ---------------------------------------------------------------------------
// judgeMvpSlice — the two accepted shapes and every rejected one
// ---------------------------------------------------------------------------

Deno.test("judgeMvpSlice - exactly one marked slice passes", () => {
  const verdict = judgeMvpSlice(MARKED_COMMENT);
  assertEquals(verdict.markerCount, 1);
  assertEquals(verdict.offenders, []);
  assertEquals(verdict.passed, true);
});

Deno.test("judgeMvpSlice - an explicit no-slice statement passes", () => {
  const verdict = judgeMvpSlice(NO_SLICE_COMMENT);
  assertEquals(verdict.markerCount, 0);
  assertStringIncludes(verdict.noSliceReason ?? "", "mechanical module move");
  assertEquals(verdict.passed, true);
});

Deno.test("judgeMvpSlice - two markers are rejected", () => {
  const verdict = judgeMvpSlice(TWO_MARKER_COMMENT);
  assertEquals(verdict.markerCount, 2);
  assertEquals(verdict.passed, false);
  assert(verdict.offenders.some((o) => o.reason.includes("exactly one slice")));
});

Deno.test("judgeMvpSlice - zero markers and no statement is rejected", () => {
  const verdict = judgeMvpSlice(UNMARKED_COMMENT);
  assertEquals(verdict.markerCount, 0);
  assertEquals(verdict.passed, false);
  assert(
    verdict.offenders.some((o) =>
      o.reason.includes("No independently valuable")
    ),
  );
});

Deno.test("judgeMvpSlice - a bare no-slice line with no reason is rejected", () => {
  const verdict = judgeMvpSlice(
    "1. #201 — Move the parser (`enhancement`)\n\nNo independently valuable slice —\n",
  );
  assertEquals(verdict.passed, false);
  assert(verdict.offenders.some((o) => o.reason.includes("no reason")));
});

Deno.test("judgeMvpSlice - a no-slice line left as the template placeholder is rejected", () => {
  const verdict = judgeMvpSlice(
    "1. #201 — Move the parser (`enhancement`)\n\n" +
      "No independently valuable slice — <reason>\n",
  );
  assertEquals(verdict.passed, false);
  assertEquals(verdict.noSliceReason, undefined);
  assert(verdict.offenders.some((o) => o.reason.includes("no reason")));
});

Deno.test("judgeMvpSlice - marking a slice and declaring none is contradictory", () => {
  const verdict = judgeMvpSlice(
    "1. #201 — Move the parser — **MVP slice**: the parser moves\n\n" +
      "No independently valuable slice — it is a mechanical move.\n",
  );
  assertEquals(verdict.passed, false);
  assert(verdict.offenders.some((o) => o.reason.includes("contradict")));
});

Deno.test("judgeMvpSlice - a marker with no value statement is rejected", () => {
  const verdict = judgeMvpSlice("1. #101 — Add the cache — **MVP slice**\n");
  assertEquals(verdict.markerCount, 1);
  assertEquals(verdict.passed, false);
  assert(verdict.offenders.some((o) => o.reason.includes("what value lands")));
});

Deno.test("judgeMvpSlice - a placeholder value statement is rejected", () => {
  const verdict = judgeMvpSlice(
    "1. #101 — Add the cache — **MVP slice**: TBD\n",
  );
  assertEquals(verdict.passed, false);
  assert(verdict.offenders.some((o) => o.subject === "#101"));
});

Deno.test("judgeMvpSlice - a bracketed template placeholder is rejected", () => {
  const verdict = judgeMvpSlice(
    "1. #101 — Add the cache — **MVP slice**: [what value lands if nothing after it is built]\n",
  );
  assertEquals(verdict.passed, false);
});

Deno.test("judgeMvpSlice - a plan with no sub-issue list is rejected", () => {
  const verdict = judgeMvpSlice("## Plan published\n\nNothing to see here.\n");
  assertEquals(verdict.listFound, false);
  assertEquals(verdict.passed, false);
});

Deno.test("judgeMvpSlice - the heading wording alone is not a marker", () => {
  const verdict = judgeMvpSlice(
    "Sub-issues created, MVP slice first:\n\n1. #101 — Add the cache\n",
  );
  assertEquals(verdict.markerCount, 0);
  assertEquals(verdict.passed, false);
});

// ---------------------------------------------------------------------------
// validatePlanOrder — value ordering never crosses a `Depends on` edge
// ---------------------------------------------------------------------------

Deno.test("validatePlanOrder - a dependency listed after its dependant offends", () => {
  const entries = extractPlanEntries(
    "1. #102 — Rewrite the planner (`enhancement`, depends on #101) — **MVP slice**: the planner gets faster\n" +
      "2. #101 — Add the cache (`enhancement`)\n",
  );
  const offenders = validatePlanOrder(entries);
  assertEquals(offenders.length, 1);
  assertEquals(offenders[0]?.subject, "#102");
  assertStringIncludes(offenders[0]?.reason ?? "", "Depends on");
});

Deno.test("judgeMvpSlice - value ordering must not override a dependency edge", () => {
  const verdict = judgeMvpSlice(
    "## Plan published\n\n" +
      "1. #102 — Rewrite the planner (`enhancement`, depends on #101) — **MVP slice**: queries get faster on their own\n" +
      "2. #101 — Add the cache (`enhancement`)\n",
  );
  assertEquals(verdict.passed, false);
  assert(
    verdict.offenders.some((o) => o.reason.includes("must not reorder across")),
  );
});

Deno.test("validatePlanOrder - a prerequisite ahead of the MVP slice is allowed", () => {
  const entries = extractPlanEntries(
    "1. #101 — Add the cache (`enhancement`)\n" +
      "2. #102 — Rewrite the planner (`enhancement`, depends on #101) — **MVP slice**: dashboards get faster with nothing else built\n",
  );
  assertEquals(validatePlanOrder(entries), []);
});

Deno.test("validatePlanOrder - a transitive prerequisite ahead of the slice is allowed", () => {
  const entries = extractPlanEntries(
    "1. #100 — Schema (`enhancement`)\n" +
      "2. #101 — Cache (`enhancement`, depends on #100)\n" +
      "3. #102 — Planner (`enhancement`, depends on #101) — **MVP slice**: dashboards get faster on their own\n",
  );
  assertEquals(validatePlanOrder(entries), []);
});

Deno.test("validatePlanOrder - an unrelated sub-issue ahead of the slice offends", () => {
  const entries = extractPlanEntries(
    "1. #100 — Tidy the changelog (`documentation`)\n" +
      "2. #101 — Add the cache (`enhancement`) — **MVP slice**: dashboards are served from memory\n",
  );
  const offenders = validatePlanOrder(entries);
  assertEquals(offenders.length, 1);
  assertEquals(offenders[0]?.subject, "#100");
  assertStringIncludes(offenders[0]?.reason ?? "", "MVP-first");
});

Deno.test("validatePlanOrder - a plan with no marker is still order-checked", () => {
  const entries = extractPlanEntries(
    "1. #202 — Repoint the importers (depends on #201)\n2. #201 — Move the parser\n",
  );
  assertEquals(validatePlanOrder(entries).length, 1);
});

// ---------------------------------------------------------------------------
// runMvpSliceGate — fetch + judge orchestration
// ---------------------------------------------------------------------------

Deno.test("runMvpSliceGate - finds the plan in a parent comment", async () => {
  const calls: string[][] = [];
  const verdict = await runMvpSliceGate({
    repo: "owner/repo",
    parentIssueNumber: 42,
    ghCommandFn: (args) => {
      calls.push(args);
      return Promise.resolve(JSON.stringify({
        body: "Parent issue body",
        comments: [{ body: "unrelated chatter" }, { body: MARKED_COMMENT }],
      }));
    },
    logger: makeSilentLogger(),
  });
  assertEquals(verdict.passed, true);
  assertEquals(verdict.entries.length, 3);
  assertEquals(calls.length, 1);
  assert(calls[0]?.includes("--json"));
});

Deno.test("runMvpSliceGate - the newest plan wins", async () => {
  const verdict = await runMvpSliceGate({
    repo: "owner/repo",
    parentIssueNumber: 42,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify({
        body: "",
        comments: [{ body: UNMARKED_COMMENT }, { body: MARKED_COMMENT }],
      })),
    logger: makeSilentLogger(),
  });
  assertEquals(verdict.passed, true);
});

Deno.test("runMvpSliceGate - falls back to the parent body", async () => {
  const verdict = await runMvpSliceGate({
    repo: "owner/repo",
    parentIssueNumber: 42,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify({ body: NO_SLICE_COMMENT, comments: [] })),
    logger: makeSilentLogger(),
  });
  assertEquals(verdict.passed, true);
});

Deno.test("runMvpSliceGate - no plan list anywhere fails the gate", async () => {
  const verdict = await runMvpSliceGate({
    repo: "owner/repo",
    parentIssueNumber: 42,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify({ body: "nothing", comments: [] })),
    logger: makeSilentLogger(),
  });
  assertEquals(verdict.listFound, false);
  assertEquals(verdict.passed, false);
});

Deno.test("runMvpSliceGate - an unreadable parent is reported, not passed", async () => {
  const verdict = await runMvpSliceGate({
    repo: "owner/repo",
    parentIssueNumber: 42,
    ghCommandFn: () => Promise.reject(new Error("gh exploded")),
    logger: makeSilentLogger(),
  });
  assertEquals(verdict.passed, false);
  assertEquals(verdict.readFailed, true);
});

// ---------------------------------------------------------------------------
// Reason wording
// ---------------------------------------------------------------------------

Deno.test("buildMvpSliceGateReason - names the rule and every offence", () => {
  const reason = buildMvpSliceGateReason(judgeMvpSlice(UNMARKED_COMMENT));
  assertStringIncludes(reason, "exactly one");
  assertStringIncludes(reason, "No independently valuable slice");
});

Deno.test("buildMvpSliceGateReason - says so when the parent could not be read", () => {
  const reason = buildMvpSliceGateReason({
    listFound: false,
    entries: [],
    markerCount: 0,
    offenders: [],
    passed: false,
    readFailed: true,
  });
  assertStringIncludes(reason, "could not be read");
});

Deno.test("MVP_SLICE_REQUIREMENT - states the marker, the order rule and the gate", () => {
  assertStringIncludes(MVP_SLICE_REQUIREMENT, "**MVP slice**");
  assertStringIncludes(
    MVP_SLICE_REQUIREMENT,
    "No independently valuable slice",
  );
  assertStringIncludes(MVP_SLICE_REQUIREMENT, "Depends on");
});

// ---------------------------------------------------------------------------
// escalateMissingMvpSlice — the shared needs-human chokepoint
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

Deno.test("escalateMissingMvpSlice - labels the parent and explains the offence", async () => {
  const { client, comments, labels } = makeStubClient();
  const escalated = await escalateMissingMvpSlice({
    ghClient: client,
    repo: "owner/repo",
    parentIssueNumber: 42,
    needsHumanLabel: "needs-human",
    verdict: judgeMvpSlice(TWO_MARKER_COMMENT),
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
  assertStringIncludes(comments[0]?.body ?? "", "MVP slice");
  assertStringIncludes(comments[0]?.body ?? "", "Next step:");
});
