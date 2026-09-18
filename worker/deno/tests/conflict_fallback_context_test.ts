/**
 * Tests for the PR-path fallback context readers (Issue #2310, parent #2298).
 *
 * Each reader feeds a permanent public issue body, so the tests are ordered by
 * what a wrong answer costs:
 *
 * 1. **An invented number.** `behind_by` and the diff summary are quoted as
 *    fact on the flag issue, so an unreadable response must leave the field
 *    unrecorded rather than render a plausible zero.
 * 2. **A dropped stage.** An attempt that died inside the agent is exactly what
 *    the timings exist to show, so `unfinished` must survive the round trip
 *    through the comment.
 * 3. **A read that stops the fallback.** None of these may throw: the PR is
 *    being closed either way, and a failed read must not become a failed close.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  MAX_DIFF_SUMMARY_PATHS,
  parseStageTimingsLine,
  readPrDiffSummary,
  readPrDivergence,
} from "../lib/conflict_fallback_context.ts";
import { formatStageTimings } from "../lib/conflict_stage_timer.ts";
import type { LogContext, Logger } from "../types.ts";

const REPO = "org/repo";
const PR_NUMBER = 48;

interface RecordingLogger extends Logger {
  warnings: Array<{ message: string; context?: LogContext }>;
}

function makeLogger(): RecordingLogger {
  const warnings: Array<{ message: string; context?: LogContext }> = [];
  const noop = () => {};
  return {
    warnings,
    info: noop,
    warn: (message: string, context?: LogContext) => {
      warnings.push({ message, ...(context ? { context } : {}) });
    },
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/** One `labeled` timeline event, as the REST timeline renders it. */
function labelledEvent(label: string, at: string) {
  return {
    event: "labeled",
    label: { name: label },
    actor: { login: "vibe-bot" },
    created_at: at,
  };
}

// ---------------------------------------------------------------------------
// The timings line, read back off a conclusion comment
// ---------------------------------------------------------------------------

Deno.test("parseStageTimingsLine - round-trips what formatStageTimings wrote", () => {
  // The renderer is the other half of this contract, so the fixture is its own
  // output rather than a hand-typed copy that can drift from it.
  const line = formatStageTimings([
    { stage: "deepen", seconds: 3 },
    { stage: "rules", seconds: 1 },
    { stage: "agent", seconds: 212 },
  ], "mel-01");
  const body = [
    '<!-- vibe-coder:merge-conflict-failed n="2" -->',
    "❌ attempt 2 failed",
    "",
    line,
  ].join("\n");

  const parsed = parseStageTimingsLine(body);
  assert(parsed, "the line was not found in the comment");
  assertEquals(parsed.host, "mel-01");
  assertEquals(parsed.timings, [
    { stage: "deepen", seconds: 3 },
    { stage: "rules", seconds: 1 },
    { stage: "agent", seconds: 212 },
  ]);
});

Deno.test("parseStageTimingsLine - an unfinished stage survives as unfinished", () => {
  // An attempt that died inside the agent is the case these timings exist to
  // show; rendering it as a duration, or dropping it, hides exactly that.
  const parsed = parseStageTimingsLine(
    formatStageTimings([
      { stage: "deepen", seconds: 4 },
      { stage: "agent", seconds: null },
    ], "syd-02"),
  );

  assertEquals(parsed?.host, "syd-02");
  assertEquals(parsed?.timings, [
    { stage: "deepen", seconds: 4 },
    { stage: "agent", seconds: null },
  ]);
});

Deno.test("parseStageTimingsLine - an empty report records the host and no stage", () => {
  const parsed = parseStageTimingsLine(formatStageTimings([], "mel-01"));
  assertEquals(parsed?.host, "mel-01");
  assertEquals(parsed?.timings, []);
});

Deno.test("parseStageTimingsLine - a comment with no timings line records nothing", () => {
  // Every attempt from before Issue #2308, and every run that died before it
  // could write the line.
  assertEquals(
    parseStageTimingsLine("❌ attempt 1 failed\n\nno timings here"),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// How far behind, and since when
// ---------------------------------------------------------------------------

Deno.test("readPrDivergence - reads behind_by and the label event", async () => {
  const calls: string[][] = [];
  const divergence = await readPrDivergence({
    repo: REPO,
    prNumber: PR_NUMBER,
    baseBranch: "main",
    headBranch: "issue-16-fix",
    queueLabel: "merge-conflict",
    gh: (args) => {
      calls.push(args);
      if (args[1]?.includes("/compare/")) return Promise.resolve("7\n");
      if (args[1]?.includes("/timeline")) {
        return Promise.resolve(JSON.stringify([
          labelledEvent("needs-human", "2026-08-01T00:00:00Z"),
          labelledEvent("merge-conflict", "2026-08-18T09:30:00Z"),
        ]));
      }
      return Promise.resolve("");
    },
  });

  assertEquals(divergence, {
    behindBy: 7,
    behindSince: "2026-08-18T09:30:00.000Z",
  });
  assert(
    calls.some((args) =>
      args[1] === `repos/${REPO}/compare/main...issue-16-fix`
    ),
    `the compare call was not made: ${JSON.stringify(calls)}`,
  );
});

Deno.test("readPrDivergence - an unreadable compare leaves the field unrecorded", async () => {
  // The flag issue quotes this as fact. "0 commits behind" on a PR nobody
  // could compare is an invented number, and worse than `not recorded`.
  const logger = makeLogger();
  const divergence = await readPrDivergence({
    repo: REPO,
    prNumber: PR_NUMBER,
    baseBranch: "main",
    headBranch: "issue-16-fix",
    queueLabel: "merge-conflict",
    logger,
    gh: (args) =>
      args[1]?.includes("/compare/")
        ? Promise.reject(new Error("gh: 404 Not Found"))
        : Promise.resolve("[]"),
  });

  assertEquals(divergence, {});
  assertEquals(logger.warnings.length, 2, "both reads must say so out loud");
});

Deno.test("readPrDivergence - refuses a ref that could redirect the compare", async () => {
  // Defence in depth: the refs come off GitHub's own listing, and a ref
  // carrying `..` would point the API call somewhere else entirely.
  const calls: string[][] = [];
  const divergence = await readPrDivergence({
    repo: REPO,
    prNumber: PR_NUMBER,
    baseBranch: "../../../other/repo/commits/main",
    headBranch: "issue-16-fix",
    queueLabel: "merge-conflict",
    gh: (args) => {
      calls.push(args);
      return Promise.resolve("[]");
    },
  });

  assertEquals(divergence.behindBy, undefined);
  assertEquals(
    calls.filter((args) => args[1]?.includes("/compare/")),
    [],
    "no compare call may be made with an unusable ref",
  );
});

// ---------------------------------------------------------------------------
// What the abandoned PR changed
// ---------------------------------------------------------------------------

Deno.test("readPrDiffSummary - lists path, additions and deletions", async () => {
  const summary = await readPrDiffSummary({
    repo: REPO,
    prNumber: PR_NUMBER,
    gh: () =>
      Promise.resolve(JSON.stringify({
        files: [
          { path: "worker/deno/lib/limits.ts", additions: 12, deletions: 3 },
          { path: "README.md", additions: 1, deletions: 0 },
        ],
      })),
  });

  assertEquals(summary, {
    files: [
      { path: "worker/deno/lib/limits.ts", additions: 12, deletions: 3 },
      { path: "README.md", additions: 1, deletions: 0 },
    ],
    omitted: 0,
  });
});

Deno.test("readPrDiffSummary - caps the paths and counts what it left out", async () => {
  const files = Array.from({ length: MAX_DIFF_SUMMARY_PATHS + 5 }, (_, i) => ({
    path: `file-${i}.ts`,
    additions: 1,
    deletions: 1,
  }));
  const summary = await readPrDiffSummary({
    repo: REPO,
    prNumber: PR_NUMBER,
    gh: () => Promise.resolve(JSON.stringify({ files })),
  });

  assertEquals(summary?.files.length, MAX_DIFF_SUMMARY_PATHS);
  assertEquals(summary?.omitted, 5, "the excess must be counted, not dropped");
});

Deno.test("readPrDiffSummary - an unreadable response records nothing, loudly", async () => {
  const logger = makeLogger();
  const summary = await readPrDiffSummary({
    repo: REPO,
    prNumber: PR_NUMBER,
    logger,
    gh: () => Promise.resolve("not json at all"),
  });

  assertEquals(summary, undefined);
  assertEquals(logger.warnings.length, 1);
});

Deno.test("readPrDiffSummary - a gh failure never throws at the caller", async () => {
  // The PR is being closed either way: a failed read must not become a failed
  // fallback.
  const summary = await readPrDiffSummary({
    repo: REPO,
    prNumber: PR_NUMBER,
    gh: () => Promise.reject(new Error("gh: 500")),
  });
  assertEquals(summary, undefined);
});
