/**
 * Tests for `worker/deno/lib/workflow_annotation_fetcher.ts` (Issue #3486,
 * part of #3485).
 *
 * Verifies the native fetcher that lists recent workflow runs via an injected
 * `ghCommandFn`, discovers their check runs, and normalises the resulting
 * annotations. All `gh` calls are stubbed so the suite runs deterministically
 * offline with no live network access.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DEFAULT_ANNOTATION_SCAN_MAX_RUNS,
  DEFAULT_ANNOTATION_SCAN_WINDOW_DAYS,
  fetchWorkflowRunAnnotations,
  type GhCommandFn,
} from "../lib/workflow_annotation_fetcher.ts";

const REPO = "owner/repo";
// Fixed clock so window filtering is deterministic.
const NOW = () => new Date("2026-07-17T00:00:00Z");

/** A single run descriptor for the mock. */
interface MockRun {
  id: number;
  checkSuiteId: number | null;
  createdAt: string;
  name?: string;
  path?: string;
  htmlUrl?: string;
}

/** Mock-response bundle keyed by run/check ids. */
interface MockSpec {
  runs: MockRun[];
  /** check-run ids per check-suite id. */
  checkRunsBySuite: Record<number, number[]>;
  /** raw annotations JSON (or override) per check-run id. */
  annotationsByCheck: Record<number, unknown[]>;
  /** check-suite ids whose check-runs listing returns malformed JSON. */
  malformedSuites?: Set<number>;
  /** check-suite ids whose check-runs listing throws (simulated 404). */
  throwingSuites?: Set<number>;
  /** check-run ids whose annotations listing returns malformed JSON. */
  malformedChecks?: Set<number>;
  /** Force the run-list call to return malformed JSON. */
  malformedRunList?: boolean;
  /** Force the run-list call to throw. */
  throwRunList?: boolean;
}

function runListJson(runs: MockRun[]): string {
  return JSON.stringify(
    runs.map((r) => ({
      id: r.id,
      name: r.name ?? "CI",
      path: r.path ?? ".github/workflows/ci.yml",
      html_url: r.htmlUrl ??
        `https://github.com/${REPO}/actions/runs/${r.id}`,
      check_suite_id: r.checkSuiteId,
      created_at: r.createdAt,
    })),
  );
}

/**
 * Build a `GhCommandFn` that routes on the API path in `args[1]`. Records
 * every call so tests can assert on the traversal.
 */
function makeMockGh(spec: MockSpec): { fn: GhCommandFn; calls: string[][] } {
  const calls: string[][] = [];
  const fn: GhCommandFn = (args) => {
    calls.push([...args]);
    const path = args[1] ?? "";

    if (path.startsWith(`repos/${REPO}/actions/runs`)) {
      if (spec.throwRunList) return Promise.reject(new Error("network down"));
      if (spec.malformedRunList) return Promise.resolve("{ not json");
      return Promise.resolve(runListJson(spec.runs));
    }

    const suiteMatch = path.match(/check-suites\/(\d+)\/check-runs/);
    if (suiteMatch) {
      const suiteId = Number(suiteMatch[1]);
      if (spec.throwingSuites?.has(suiteId)) {
        return Promise.reject(new Error("HTTP 404"));
      }
      if (spec.malformedSuites?.has(suiteId)) {
        return Promise.resolve("<<not json>>");
      }
      const ids = spec.checkRunsBySuite[suiteId] ?? [];
      return Promise.resolve(JSON.stringify(ids.map((id) => ({ id }))));
    }

    const checkMatch = path.match(/check-runs\/(\d+)\/annotations/);
    if (checkMatch) {
      const checkId = Number(checkMatch[1]);
      if (spec.malformedChecks?.has(checkId)) {
        return Promise.resolve("not-an-array");
      }
      const anns = spec.annotationsByCheck[checkId] ?? [];
      return Promise.resolve(JSON.stringify(anns));
    }

    return Promise.resolve("[]");
  };
  return { fn, calls };
}

/** A realistic annotation object as GitHub returns it. */
function annotation(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    annotation_level: "warning",
    message: "example",
    title: "",
    path: ".github",
    raw_details: "",
    ...overrides,
  };
}

Deno.test("multi-run window: iterates every run inside the window", async () => {
  const { fn, calls } = makeMockGh({
    runs: [
      { id: 1, checkSuiteId: 101, createdAt: "2026-07-16T00:00:00Z" },
      { id: 2, checkSuiteId: 102, createdAt: "2026-07-15T00:00:00Z" },
      { id: 3, checkSuiteId: 103, createdAt: "2026-07-14T00:00:00Z" },
    ],
    checkRunsBySuite: { 101: [201], 102: [202], 103: [203] },
    annotationsByCheck: {
      201: [annotation({ message: "a" })],
      202: [annotation({ message: "b" })],
      203: [annotation({ message: "c" })],
    },
  });

  const result = await fetchWorkflowRunAnnotations({
    repo: REPO,
    ghCommandFn: fn,
    now: NOW,
  });

  assertEquals(result.length, 3);
  assertEquals(result.map((r) => r.runId).sort(), [1, 2, 3]);
  // Each run's check suite and each check run's annotations were queried.
  const paths = calls.map((c) => c[1] ?? "");
  assert(paths.some((p) => p.includes("check-suites/101/check-runs")));
  assert(paths.some((p) => p.includes("check-runs/203/annotations")));
});

Deno.test("window: runs older than windowDays are excluded", async () => {
  const { fn } = makeMockGh({
    runs: [
      { id: 1, checkSuiteId: 101, createdAt: "2026-07-16T00:00:00Z" },
      // 30 days old — outside the default 7-day window.
      { id: 2, checkSuiteId: 102, createdAt: "2026-06-16T00:00:00Z" },
    ],
    checkRunsBySuite: { 101: [201], 102: [202] },
    annotationsByCheck: {
      201: [annotation({ message: "fresh" })],
      202: [annotation({ message: "stale" })],
    },
  });

  const result = await fetchWorkflowRunAnnotations({
    repo: REPO,
    ghCommandFn: fn,
    now: NOW,
  });

  assertEquals(result.length, 1);
  assertEquals(result[0]!.runId, 1);
  assertEquals(result[0]!.message, "fresh");
});

Deno.test("maxRuns caps how many runs are inspected", async () => {
  const { fn } = makeMockGh({
    runs: [
      { id: 1, checkSuiteId: 101, createdAt: "2026-07-16T00:00:00Z" },
      { id: 2, checkSuiteId: 102, createdAt: "2026-07-16T00:00:00Z" },
      { id: 3, checkSuiteId: 103, createdAt: "2026-07-16T00:00:00Z" },
    ],
    checkRunsBySuite: { 101: [201], 102: [202], 103: [203] },
    annotationsByCheck: {
      201: [annotation({})],
      202: [annotation({})],
      203: [annotation({})],
    },
  });

  const result = await fetchWorkflowRunAnnotations({
    repo: REPO,
    ghCommandFn: fn,
    now: NOW,
    maxRuns: 2,
  });

  assertEquals(result.length, 2);
});

Deno.test("captures both failure and warning levels verbatim", async () => {
  const { fn } = makeMockGh({
    runs: [{ id: 1, checkSuiteId: 101, createdAt: "2026-07-16T00:00:00Z" }],
    checkRunsBySuite: { 101: [201] },
    annotationsByCheck: {
      201: [
        annotation({
          annotation_level: "failure",
          message: "boom",
          title: "T1",
        }),
        annotation({
          annotation_level: "warning",
          message: "deprecated runtime detected",
          raw_details: "some/action@sha",
        }),
        annotation({ annotation_level: "notice", message: "fyi" }),
      ],
    },
  });

  const result = await fetchWorkflowRunAnnotations({
    repo: REPO,
    ghCommandFn: fn,
    now: NOW,
  });

  assertEquals(result.length, 3);
  const failure = result.find((r) => r.level === "failure")!;
  assertEquals(failure.message, "boom");
  assertEquals(failure.title, "T1");
  assertEquals(failure.runUrl, `https://github.com/${REPO}/actions/runs/1`);
  assertEquals(failure.workflowName, "CI");
  assertEquals(failure.workflowPath, ".github/workflows/ci.yml");

  const warning = result.find((r) => r.level === "warning")!;
  assertEquals(warning.message, "deprecated runtime detected");
  assertEquals(warning.rawDetails, "some/action@sha");

  assert(result.some((r) => r.level === "notice"));
});

Deno.test("per-run 404 (throwing check-suite) is tolerated, not aborted", async () => {
  const { fn } = makeMockGh({
    runs: [
      { id: 1, checkSuiteId: 101, createdAt: "2026-07-16T00:00:00Z" },
      { id: 2, checkSuiteId: 102, createdAt: "2026-07-16T00:00:00Z" },
    ],
    checkRunsBySuite: { 102: [202] },
    annotationsByCheck: { 202: [annotation({ message: "survivor" })] },
    throwingSuites: new Set([101]),
  });

  const logs: string[] = [];
  const result = await fetchWorkflowRunAnnotations({
    repo: REPO,
    ghCommandFn: fn,
    now: NOW,
    log: (m) => logs.push(m),
  });

  // Run 1 failed but run 2 still contributed its annotation.
  assertEquals(result.length, 1);
  assertEquals(result[0]!.message, "survivor");
  assert(logs.some((l) => l.includes("list-check-runs-failed")));
});

Deno.test("malformed check-runs JSON for one run is tolerated", async () => {
  const { fn } = makeMockGh({
    runs: [
      { id: 1, checkSuiteId: 101, createdAt: "2026-07-16T00:00:00Z" },
      { id: 2, checkSuiteId: 102, createdAt: "2026-07-16T00:00:00Z" },
    ],
    checkRunsBySuite: { 102: [202] },
    annotationsByCheck: { 202: [annotation({ message: "ok" })] },
    malformedSuites: new Set([101]),
  });

  const result = await fetchWorkflowRunAnnotations({
    repo: REPO,
    ghCommandFn: fn,
    now: NOW,
  });

  assertEquals(result.length, 1);
  assertEquals(result[0]!.message, "ok");
});

Deno.test("malformed annotations JSON for one check run is tolerated", async () => {
  const { fn } = makeMockGh({
    runs: [{ id: 1, checkSuiteId: 101, createdAt: "2026-07-16T00:00:00Z" }],
    checkRunsBySuite: { 101: [201, 202] },
    annotationsByCheck: { 202: [annotation({ message: "ok" })] },
    malformedChecks: new Set([201]),
  });

  const result = await fetchWorkflowRunAnnotations({
    repo: REPO,
    ghCommandFn: fn,
    now: NOW,
  });

  assertEquals(result.length, 1);
  assertEquals(result[0]!.message, "ok");
});

Deno.test("empty result: no annotations returns []", async () => {
  const { fn } = makeMockGh({
    runs: [{ id: 1, checkSuiteId: 101, createdAt: "2026-07-16T00:00:00Z" }],
    checkRunsBySuite: { 101: [201] },
    annotationsByCheck: { 201: [] },
  });

  const result = await fetchWorkflowRunAnnotations({
    repo: REPO,
    ghCommandFn: fn,
    now: NOW,
  });

  assertEquals(result, []);
});

Deno.test("empty result: no runs returns []", async () => {
  const { fn } = makeMockGh({
    runs: [],
    checkRunsBySuite: {},
    annotationsByCheck: {},
  });

  const result = await fetchWorkflowRunAnnotations({
    repo: REPO,
    ghCommandFn: fn,
    now: NOW,
  });

  assertEquals(result, []);
});

Deno.test("malformed run-list JSON degrades to []", async () => {
  const { fn } = makeMockGh({
    runs: [],
    checkRunsBySuite: {},
    annotationsByCheck: {},
    malformedRunList: true,
  });

  const result = await fetchWorkflowRunAnnotations({
    repo: REPO,
    ghCommandFn: fn,
    now: NOW,
  });

  assertEquals(result, []);
});

Deno.test("throwing run-list call degrades to []", async () => {
  const { fn } = makeMockGh({
    runs: [],
    checkRunsBySuite: {},
    annotationsByCheck: {},
    throwRunList: true,
  });

  const logs: string[] = [];
  const result = await fetchWorkflowRunAnnotations({
    repo: REPO,
    ghCommandFn: fn,
    now: NOW,
    log: (m) => logs.push(m),
  });

  assertEquals(result, []);
  assert(logs.some((l) => l.includes("list-runs-failed")));
});

Deno.test("run with null check_suite_id contributes no annotations", async () => {
  const { fn } = makeMockGh({
    runs: [{ id: 1, checkSuiteId: null, createdAt: "2026-07-16T00:00:00Z" }],
    checkRunsBySuite: {},
    annotationsByCheck: {},
  });

  const result = await fetchWorkflowRunAnnotations({
    repo: REPO,
    ghCommandFn: fn,
    now: NOW,
  });

  assertEquals(result, []);
});

Deno.test("window constants have the planned defaults", () => {
  assertEquals(DEFAULT_ANNOTATION_SCAN_MAX_RUNS, 50);
  assertEquals(DEFAULT_ANNOTATION_SCAN_WINDOW_DAYS, 7);
});

Deno.test("version-agnosticism guard: module hardcodes no runtime version string", async () => {
  const source = await Deno.readTextFile(
    new URL("../lib/workflow_annotation_fetcher.ts", import.meta.url),
  );
  // Strip the doc comment's illustrative `node20` mention before scanning:
  // the guard targets executable filtering logic, not prose examples.
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const match = withoutBlockComments.match(/node\s*\d+/i);
  assertEquals(
    match,
    null,
    `unexpected hardcoded runtime string: ${match?.[0]}`,
  );
});

Deno.test("unknown annotation_level coerces to notice; empty annotation skipped", async () => {
  const { fn } = makeMockGh({
    runs: [{ id: 1, checkSuiteId: 101, createdAt: "2026-07-16T00:00:00Z" }],
    checkRunsBySuite: { 101: [201] },
    annotationsByCheck: {
      201: [
        { annotation_level: "surprise", message: "odd" },
        {}, // entirely empty → skipped
      ],
    },
  });

  const result = await fetchWorkflowRunAnnotations({
    repo: REPO,
    ghCommandFn: fn,
    now: NOW,
  });

  assertEquals(result.length, 1);
  assertEquals(result[0]!.level, "notice");
  assertStringIncludes(result[0]!.message, "odd");
});
