/**
 * Tests for plan_coverage_gate.ts — the deterministic coverage gate on a
 * published plan (Issue #520).
 *
 * The gate is the artefact-and-enforcement half of the critique turn's private
 * "missing work" judgement: the publish turn posts an ask → sub-issue coverage
 * table on the parent, and this gate rejects any ask row that names no covering
 * sub-issue and no explicit out-of-scope reason.
 *
 * Every test calls a real exported function with real markdown and asserts on
 * the verdict — no source-text inspection.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildCoverageGateReason,
  COVERAGE_TABLE_REQUIREMENT,
  escalateUncoveredAsks,
  extractCoverageTable,
  judgePlanCoverage,
  runPlanCoverageGate,
  validateCoverageTable,
} from "../lib/plan_coverage_gate.ts";
import type { GitHubClient, Logger, Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A published summary comment whose every ask is covered or explained. */
const COMPLIANT_COMMENT = `## Plan published

Sub-issues created, in implementation order:

1. #101 — Publish the coverage table (\`enhancement\`)
2. #102 — Gate the coverage table (\`enhancement\`)

## Plan Coverage

| Ask | Covered by | Notes |
| --- | --- | --- |
| Publish a coverage table on the parent | #101 | Publish turn emits it |
| Gate the table at \`closePlanningIssue()\` | #102 | Deterministic gate |
| Rewrite the resume pass | Out of scope | The existing resume pass already covers it |
`;

/** The same plan with one ask left uncovered and unexplained. */
const UNCOVERED_COMMENT = `## Plan published

## Plan Coverage

| Ask | Covered by | Notes |
| --- | --- | --- |
| Publish a coverage table on the parent | #101 | Publish turn emits it |
| Carry the trace into each sub-issue | | |
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
// extractCoverageTable
// ---------------------------------------------------------------------------

Deno.test("extractCoverageTable - reads ask/covered-by/notes rows", () => {
  const rows = extractCoverageTable(COMPLIANT_COMMENT);
  assert(rows !== null);
  assertEquals(rows.length, 3);
  assertEquals(rows[0]?.ask, "Publish a coverage table on the parent");
  assertEquals(rows[0]?.coveredBy, "#101");
  assertEquals(rows[0]?.notes, "Publish turn emits it");
  assertEquals(rows[2]?.coveredBy, "Out of scope");
});

Deno.test("extractCoverageTable - returns null when no table is present", () => {
  assertEquals(
    extractCoverageTable("## Plan published\n\nNo table here."),
    null,
  );
});

Deno.test("extractCoverageTable - ignores an unrelated table", () => {
  const body = `| Name | Value |
| --- | --- |
| foo | bar |
`;
  assertEquals(extractCoverageTable(body), null);
});

Deno.test("extractCoverageTable - accepts a 'Sub-issue(s)' column heading", () => {
  const body = `| Ask | Sub-issue(s) | Notes |
| --- | --- | --- |
| Do the thing | #7 | done |
`;
  const rows = extractCoverageTable(body);
  assert(rows !== null);
  assertEquals(rows[0]?.coveredBy, "#7");
});

Deno.test("extractCoverageTable - keeps escaped pipes inside a cell", () => {
  const body = `| Ask | Covered by | Notes |
| --- | --- | --- |
| Support \\| in output | #7 | pipe-safe |
`;
  const rows = extractCoverageTable(body);
  assert(rows !== null);
  assertEquals(rows.length, 1);
  assertEquals(rows[0]?.ask, "Support | in output");
});

// ---------------------------------------------------------------------------
// validateCoverageTable — accept shapes
// ---------------------------------------------------------------------------

Deno.test("validateCoverageTable - a covered ask passes", () => {
  const offenders = validateCoverageTable([
    { ask: "Add the flag", coveredBy: "#12", notes: "" },
  ]);
  assertEquals(offenders, []);
});

Deno.test("validateCoverageTable - multiple covering sub-issues pass", () => {
  const offenders = validateCoverageTable([
    { ask: "Add the flag", coveredBy: "#12, #13", notes: "split by layer" },
  ]);
  assertEquals(offenders, []);
});

Deno.test("validateCoverageTable - a full issue URL counts as coverage", () => {
  const offenders = validateCoverageTable([
    {
      ask: "Add the flag",
      coveredBy: "https://github.com/owner/repo/issues/12",
      notes: "",
    },
  ]);
  assertEquals(offenders, []);
});

Deno.test("validateCoverageTable - an out-of-scope ask with a reason passes", () => {
  const offenders = validateCoverageTable([
    {
      ask: "Rewrite the resume pass",
      coveredBy: "Out of scope",
      notes: "The existing resume pass already finishes the repairs",
    },
  ]);
  assertEquals(offenders, []);
});

Deno.test("validateCoverageTable - out-of-scope reason may sit in the covered-by cell", () => {
  const offenders = validateCoverageTable([
    {
      ask: "Rewrite the resume pass",
      coveredBy: "Out of scope — already handled by the resume pass",
      notes: "",
    },
  ]);
  assertEquals(offenders, []);
});

// ---------------------------------------------------------------------------
// validateCoverageTable — reject shapes
// ---------------------------------------------------------------------------

Deno.test("validateCoverageTable - an uncovered, unexplained ask is an offender", () => {
  const offenders = validateCoverageTable([
    { ask: "Add the flag", coveredBy: "#12", notes: "" },
    { ask: "Carry the trace forward", coveredBy: "", notes: "" },
  ]);
  assertEquals(offenders.length, 1);
  assertEquals(offenders[0]?.ask, "Carry the trace forward");
  assertStringIncludes(offenders[0]?.reason ?? "", "no covering sub-issue");
});

Deno.test("validateCoverageTable - 'None' is not coverage", () => {
  const offenders = validateCoverageTable([
    { ask: "Add the flag", coveredBy: "None", notes: "TBD" },
  ]);
  assertEquals(offenders.length, 1);
});

Deno.test("validateCoverageTable - a bracketed placeholder is not coverage", () => {
  const offenders = validateCoverageTable([
    { ask: "Add the flag", coveredBy: "[#N of the sub-issue]", notes: "" },
  ]);
  assertEquals(offenders.length, 1);
  assertStringIncludes(offenders[0]?.reason ?? "", "placeholder");
});

Deno.test("validateCoverageTable - out of scope with no reason is an offender", () => {
  const offenders = validateCoverageTable([
    { ask: "Rewrite the resume pass", coveredBy: "Out of scope", notes: "" },
  ]);
  assertEquals(offenders.length, 1);
  assertStringIncludes(offenders[0]?.reason ?? "", "no reason");
});

Deno.test("validateCoverageTable - out of scope with a bracketed reason is an offender", () => {
  const offenders = validateCoverageTable([
    {
      ask: "Rewrite the resume pass",
      coveredBy: "Out of scope",
      notes: "[why it is out of scope]",
    },
  ]);
  assertEquals(offenders.length, 1);
});

Deno.test("validateCoverageTable - an empty ask cell is an offender", () => {
  const offenders = validateCoverageTable([
    { ask: "", coveredBy: "#12", notes: "" },
  ]);
  assertEquals(offenders.length, 1);
});

// ---------------------------------------------------------------------------
// judgePlanCoverage
// ---------------------------------------------------------------------------

Deno.test("judgePlanCoverage - a compliant published comment passes", () => {
  const verdict = judgePlanCoverage(COMPLIANT_COMMENT);
  assertEquals(verdict.tableFound, true);
  assertEquals(verdict.rowCount, 3);
  assertEquals(verdict.offenders, []);
  assertEquals(verdict.passed, true);
});

Deno.test("judgePlanCoverage - an uncovered ask fails the gate", () => {
  const verdict = judgePlanCoverage(UNCOVERED_COMMENT);
  assertEquals(verdict.tableFound, true);
  assertEquals(verdict.passed, false);
  assertEquals(verdict.offenders.length, 1);
  assertEquals(
    verdict.offenders[0]?.ask,
    "Carry the trace into each sub-issue",
  );
});

Deno.test("judgePlanCoverage - a missing table fails the gate", () => {
  const verdict = judgePlanCoverage("## Plan published\n\nSub-issues: #1, #2");
  assertEquals(verdict.tableFound, false);
  assertEquals(verdict.passed, false);
});

Deno.test("judgePlanCoverage - a header-only table fails the gate", () => {
  const verdict = judgePlanCoverage(`| Ask | Covered by | Notes |
| --- | --- | --- |
`);
  assertEquals(verdict.tableFound, true);
  assertEquals(verdict.rowCount, 0);
  assertEquals(verdict.passed, false);
});

// ---------------------------------------------------------------------------
// runPlanCoverageGate — fetch + judge orchestration
// ---------------------------------------------------------------------------

Deno.test("runPlanCoverageGate - finds the table in a parent comment", async () => {
  const calls: string[][] = [];
  const verdict = await runPlanCoverageGate({
    repo: "owner/repo",
    parentIssueNumber: 42,
    ghCommandFn: (args) => {
      calls.push(args);
      return Promise.resolve(JSON.stringify({
        body: "Parent issue body",
        comments: [
          { body: "unrelated chatter" },
          { body: COMPLIANT_COMMENT },
        ],
      }));
    },
    logger: makeSilentLogger(),
  });
  assertEquals(verdict.passed, true);
  assertEquals(verdict.rowCount, 3);
  assertEquals(calls.length, 1);
  assert(calls[0]?.includes("--json"));
});

Deno.test("runPlanCoverageGate - the newest table wins", async () => {
  const verdict = await runPlanCoverageGate({
    repo: "owner/repo",
    parentIssueNumber: 42,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify({
        body: "",
        comments: [{ body: UNCOVERED_COMMENT }, { body: COMPLIANT_COMMENT }],
      })),
    logger: makeSilentLogger(),
  });
  assertEquals(verdict.passed, true);
});

Deno.test("runPlanCoverageGate - falls back to the parent body", async () => {
  const verdict = await runPlanCoverageGate({
    repo: "owner/repo",
    parentIssueNumber: 42,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify({
        body: COMPLIANT_COMMENT,
        comments: [],
      })),
    logger: makeSilentLogger(),
  });
  assertEquals(verdict.passed, true);
});

Deno.test("runPlanCoverageGate - no table anywhere fails the gate", async () => {
  const verdict = await runPlanCoverageGate({
    repo: "owner/repo",
    parentIssueNumber: 42,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify({ body: "nothing", comments: [] })),
    logger: makeSilentLogger(),
  });
  assertEquals(verdict.tableFound, false);
  assertEquals(verdict.passed, false);
});

Deno.test("runPlanCoverageGate - an unreadable parent is reported, not passed", async () => {
  const verdict = await runPlanCoverageGate({
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

Deno.test("buildCoverageGateReason - names every uncovered ask", () => {
  const reason = buildCoverageGateReason(judgePlanCoverage(UNCOVERED_COMMENT));
  assertStringIncludes(reason, "Carry the trace into each sub-issue");
  assertStringIncludes(reason, "no covering sub-issue");
});

Deno.test("buildCoverageGateReason - says so when the table is missing", () => {
  const reason = buildCoverageGateReason(judgePlanCoverage("no table"));
  assertStringIncludes(reason, "no coverage table");
});

Deno.test("COVERAGE_TABLE_REQUIREMENT - states the table and the gate", () => {
  assertStringIncludes(COVERAGE_TABLE_REQUIREMENT, "## Plan Coverage");
  assertStringIncludes(COVERAGE_TABLE_REQUIREMENT, "Out of scope");
});

// ---------------------------------------------------------------------------
// escalateUncoveredAsks — the shared needs-human chokepoint
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

Deno.test("escalateUncoveredAsks - labels the parent and names the ask", async () => {
  const { client, comments, labels } = makeStubClient();
  const escalated = await escalateUncoveredAsks({
    ghClient: client,
    repo: "owner/repo",
    parentIssueNumber: 42,
    needsHumanLabel: "needs-human",
    verdict: judgePlanCoverage(UNCOVERED_COMMENT),
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
  assertStringIncludes(
    comments[0]?.body ?? "",
    "Carry the trace into each sub-issue",
  );
  assertStringIncludes(comments[0]?.body ?? "", "Next step:");
});
