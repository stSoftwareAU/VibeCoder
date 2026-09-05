/**
 * Tests for the built-in GitHub Actions CI log provider (Issue #3580).
 *
 * Covers job-id resolution from a check run, the "not applicable"
 * fall-through for non-Actions checks, timestamp-prefix stripping, the
 * failure-context/tail trimming, and the hard byte cap on the excerpt.
 * Every test injects a fake `gh` function — no live API calls.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  fetchGithubActionsLogExcerpt,
  GITHUB_ACTIONS_PROVIDER_ID,
  MAX_ACTIONS_EXCERPT_BYTES,
  parseActionsCheckUrl,
  resolveActionsJobId,
  stripAnsi,
  summariseActionsLog,
} from "../lib/github_actions_log_fetcher.ts";

/** Build a fake `gh` runner from an endpoint → response map. */
function fakeGh(
  responses: Record<string, string>,
  calls: string[][] = [],
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    calls.push(args);
    // The endpoint is the last arg (flags such as --allow-escape-sequences
    // may precede it — Issue #4376).
    const endpoint = args[args.length - 1] ?? "";
    const body = responses[endpoint];
    if (body === undefined) {
      return Promise.reject(new Error(`unexpected gh api call: ${endpoint}`));
    }
    return Promise.resolve(body);
  };
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

Deno.test("parseActionsCheckUrl - extracts run and job ids", () => {
  const parsed = parseActionsCheckUrl(
    "https://github.com/stSoftwareAU/VibeCoder/actions/runs/123/job/456",
  );
  assertEquals(parsed, { kind: "job", runId: 123, jobId: 456 });
});

Deno.test("parseActionsCheckUrl - accepts the /jobs/ variant", () => {
  const parsed = parseActionsCheckUrl(
    "https://github.com/o/r/actions/runs/9/jobs/8?check_suite_focus=true",
  );
  assertEquals(parsed, { kind: "job", runId: 9, jobId: 8 });
});

Deno.test("parseActionsCheckUrl - run-only URL yields a run resolution", () => {
  const parsed = parseActionsCheckUrl(
    "https://github.com/o/r/actions/runs/77",
  );
  assertEquals(parsed, { kind: "run", runId: 77 });
});

Deno.test("parseActionsCheckUrl - an external CI URL is not an Actions URL", () => {
  const parsed = parseActionsCheckUrl(
    "https://ci.example.com/job/Migration/job/Develop/1234/",
  );
  assertEquals(parsed.kind, "other");
});

// ---------------------------------------------------------------------------
// Job-id resolution
// ---------------------------------------------------------------------------

Deno.test("resolveActionsJobId - resolves straight from the target URL", async () => {
  const result = await resolveActionsJobId({
    repo: "o/r",
    checkRunId: "555",
    targetUrl: "https://github.com/o/r/actions/runs/123/job/456",
    ghFn: fakeGh({}),
  });
  assertEquals(result, { kind: "job", jobId: 456 });
});

Deno.test("resolveActionsJobId - falls back to the check-run API when no target URL", async () => {
  const calls: string[][] = [];
  const ghFn = fakeGh({
    "repos/o/r/check-runs/555": JSON.stringify({
      name: "quality",
      app: { slug: "github-actions" },
      details_url: "https://github.com/o/r/actions/runs/123/job/456",
    }),
  }, calls);

  const result = await resolveActionsJobId({
    repo: "o/r",
    checkRunId: "555",
    ghFn,
  });

  assertEquals(result, { kind: "job", jobId: 456 });
  assertEquals(calls[0], ["api", "repos/o/r/check-runs/555"]);
});

Deno.test("resolveActionsJobId - non-Actions check run is not applicable", async () => {
  const ghFn = fakeGh({
    "repos/o/r/check-runs/555": JSON.stringify({
      name: "continuous-integration/external-ci/pr-head",
      app: { slug: "external-ci" },
      details_url: "https://ci.example.com/job/Foo/12/",
    }),
  });

  const result = await resolveActionsJobId({
    repo: "o/r",
    checkRunId: "555",
    ghFn,
  });

  assertEquals(result.kind, "not-applicable");
});

Deno.test("resolveActionsJobId - an external CI target URL is not applicable without any gh call", async () => {
  const calls: string[][] = [];
  const result = await resolveActionsJobId({
    repo: "o/r",
    checkRunId: "555",
    targetUrl: "https://ci.example.com/job/Migration/job/Develop/1234/",
    ghFn: fakeGh({}, calls),
  });

  assertEquals(result.kind, "not-applicable");
  assertEquals(calls.length, 0);
});

Deno.test("resolveActionsJobId - run-only URL picks the failing job from the run", async () => {
  const ghFn = fakeGh({
    "repos/o/r/actions/runs/77/jobs?per_page=100": JSON.stringify({
      jobs: [
        { id: 1, name: "build", conclusion: "success" },
        { id: 2, name: "quality", conclusion: "failure" },
      ],
    }),
  });

  const result = await resolveActionsJobId({
    repo: "o/r",
    checkRunId: "555",
    checkName: "quality",
    targetUrl: "https://github.com/o/r/actions/runs/77",
    ghFn,
  });

  assertEquals(result, { kind: "job", jobId: 2 });
});

Deno.test("resolveActionsJobId - gh failure is reported as an error, not silently ignored", async () => {
  const result = await resolveActionsJobId({
    repo: "o/r",
    checkRunId: "555",
    ghFn: () => Promise.reject(new Error("gh: HTTP 403")),
  });

  assertEquals(result.kind, "error");
  if (result.kind === "error") {
    assertStringIncludes(result.error, "403");
  }
});

// ---------------------------------------------------------------------------
// Trimming and timestamp stripping
// ---------------------------------------------------------------------------

Deno.test("summariseActionsLog - strips the ISO-8601 timestamp prefix", () => {
  const log = [
    "2026-07-28T01:02:03.1234567Z Run deno test",
    "plain line without a timestamp",
    "2026-07-28T01:02:04.0000000Z error: assertion failed",
  ].join("\n");

  const excerpt = summariseActionsLog(log);

  assertStringIncludes(excerpt, "Run deno test");
  assertStringIncludes(excerpt, "plain line without a timestamp");
  assertStringIncludes(excerpt, "error: assertion failed");
  assertEquals(excerpt.includes("2026-07-28T01:02:03"), false);
});

Deno.test("summariseActionsLog - keeps the first failure marker context from a long log", () => {
  const lines: string[] = [];
  for (let i = 0; i < 5000; i++) {
    lines.push(`2026-07-28T01:02:03.0000000Z setup noise line ${i}`);
  }
  lines.push("2026-07-28T01:02:03.0000000Z ##[error]Process completed");
  lines.push("2026-07-28T01:02:03.0000000Z FAILED test_widget_renders");
  for (let i = 0; i < 5000; i++) {
    lines.push(`2026-07-28T01:02:03.0000000Z trailing noise line ${i}`);
  }

  const excerpt = summariseActionsLog(lines.join("\n"));

  assertStringIncludes(excerpt, "Process completed");
  assertStringIncludes(excerpt, "FAILED test_widget_renders");
  // The tail is preserved too.
  assertStringIncludes(excerpt, "trailing noise line 4999");
});

Deno.test("summariseActionsLog - short log is returned whole", () => {
  const excerpt = summariseActionsLog("one\ntwo\nthree");
  assertStringIncludes(excerpt, "one");
  assertStringIncludes(excerpt, "three");
});

Deno.test("summariseActionsLog - oversized log is hard-capped", () => {
  const oversized = Array.from(
    { length: 200_000 },
    (_, i) => `2026-07-28T01:02:03.0000000Z padding line ${i} aaaaaaaaaaaaaaaa`,
  ).join("\n");

  const excerpt = summariseActionsLog(oversized);
  const bytes = new TextEncoder().encode(excerpt).byteLength;

  assert(
    bytes <= MAX_ACTIONS_EXCERPT_BYTES,
    `excerpt was ${bytes} bytes, cap is ${MAX_ACTIONS_EXCERPT_BYTES}`,
  );
});

Deno.test("summariseActionsLog - honours a custom cap", () => {
  const oversized = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join(
    "\n",
  );
  const excerpt = summariseActionsLog(oversized, { maxBytes: 2048 });
  const bytes = new TextEncoder().encode(excerpt).byteLength;
  assert(bytes <= 2048, `excerpt was ${bytes} bytes, cap is 2048`);
});

// ---------------------------------------------------------------------------
// End-to-end provider behaviour
// ---------------------------------------------------------------------------

Deno.test("fetchGithubActionsLogExcerpt - returns a populated excerpt for a failing job", async () => {
  const ghFn = fakeGh({
    "repos/o/r/check-runs/555": JSON.stringify({
      name: "quality",
      app: { slug: "github-actions" },
      details_url: "https://github.com/o/r/actions/runs/123/job/456",
    }),
    "repos/o/r/actions/jobs/456/logs": [
      "2026-07-28T01:02:03.0000000Z Run ./quality.sh",
      "2026-07-28T01:02:04.0000000Z ##[error]deno test failed: 2 failing",
    ].join("\n"),
  });

  const outcome = await fetchGithubActionsLogExcerpt({
    repo: "o/r",
    checkRunId: "555",
    checkName: "quality",
    ghFn,
  });

  assertEquals(outcome.kind, "excerpt");
  if (outcome.kind === "excerpt") {
    assertEquals(outcome.providerId, GITHUB_ACTIONS_PROVIDER_ID);
    assertEquals(outcome.jobId, 456);
    assertStringIncludes(outcome.excerpt, "deno test failed: 2 failing");
    assertEquals(outcome.excerpt.includes("2026-07-28T01:02:04"), false);
  }
});

Deno.test("fetchGithubActionsLogExcerpt - an external CI check falls through as not applicable", async () => {
  const outcome = await fetchGithubActionsLogExcerpt({
    repo: "o/r",
    checkRunId: "555",
    checkName: "continuous-integration/external-ci/pr-head",
    targetUrl: "https://ci.example.com/job/Migration/job/Develop/1234/",
    ghFn: fakeGh({}),
  });

  assertEquals(outcome.kind, "not-applicable");
  if (outcome.kind === "not-applicable") {
    assert(outcome.reason.length > 0);
  }
});

Deno.test("fetchGithubActionsLogExcerpt - empty log body is reported, not returned as a blank excerpt", async () => {
  const ghFn = fakeGh({
    "repos/o/r/actions/jobs/456/logs": "   \n  \n",
  });

  const outcome = await fetchGithubActionsLogExcerpt({
    repo: "o/r",
    checkRunId: "555",
    targetUrl: "https://github.com/o/r/actions/runs/123/job/456",
    ghFn,
  });

  assertEquals(outcome.kind, "error");
});

Deno.test("fetchGithubActionsLogExcerpt - log fetch failure surfaces an error outcome", async () => {
  const outcome = await fetchGithubActionsLogExcerpt({
    repo: "o/r",
    checkRunId: "555",
    targetUrl: "https://github.com/o/r/actions/runs/123/job/456",
    ghFn: () => Promise.reject(new Error("gh: HTTP 404 Not Found")),
  });

  assertEquals(outcome.kind, "error");
  if (outcome.kind === "error") {
    assertStringIncludes(outcome.error, "404");
  }
});

Deno.test("fetchGithubActionsLogExcerpt - excerpt is capped for an oversized job log", async () => {
  const oversized = Array.from(
    { length: 200_000 },
    (_, i) => `2026-07-28T01:02:03.0000000Z padding line ${i} aaaaaaaaaaaaaaaa`,
  ).join("\n");
  const ghFn = fakeGh({ "repos/o/r/actions/jobs/456/logs": oversized });

  const outcome = await fetchGithubActionsLogExcerpt({
    repo: "o/r",
    checkRunId: "555",
    targetUrl: "https://github.com/o/r/actions/runs/123/job/456",
    ghFn,
  });

  assertEquals(outcome.kind, "excerpt");
  if (outcome.kind === "excerpt") {
    const bytes = new TextEncoder().encode(outcome.excerpt).byteLength;
    assert(
      bytes <= MAX_ACTIONS_EXCERPT_BYTES,
      `excerpt was ${bytes} bytes, cap is ${MAX_ACTIONS_EXCERPT_BYTES}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Issue #4376: gh ≥ 2.9x refuses Actions logs without --allow-escape-sequences
// ---------------------------------------------------------------------------

/** A gh that behaves like 2.97: logs need the flag; the body is ANSI-coloured. */
function fakeGhModern(calls: string[][]) {
  return (args: string[]): Promise<string> => {
    calls.push(args);
    const endpoint = args[args.length - 1] ?? "";
    if (endpoint === "repos/o/r/check-runs/555") {
      return Promise.resolve(JSON.stringify({
        name: "validate",
        app: { slug: "github-actions" },
        details_url: "https://github.com/o/r/actions/runs/123/job/456",
      }));
    }
    if (endpoint === "repos/o/r/actions/jobs/456/logs") {
      if (!args.includes("--allow-escape-sequences")) {
        return Promise.reject(
          new Error(
            "gh command failed (exit 1): the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway",
          ),
        );
      }
      return Promise.resolve(
        [
          "2026-08-18T08:27:00.0000000Z \x1b[0m\x1b[32mCheck\x1b[0m mod.ts",
          "2026-08-18T08:27:01.0000000Z \x1b[1m\x1b[31merror\x1b[0m: TS2339 [ERROR]: Property 'extensions' does not exist",
          "2026-08-18T08:27:02.0000000Z ##[error]Process completed with exit code 1.",
        ].join("\n"),
      );
    }
    return Promise.reject(new Error(`unexpected gh api call: ${endpoint}`));
  };
}

Deno.test("fetchGithubActionsLogExcerpt - passes --allow-escape-sequences so a current gh returns the log, and strips the ANSI colour codes (Issue #4376)", async () => {
  const calls: string[][] = [];
  const outcome = await fetchGithubActionsLogExcerpt({
    repo: "o/r",
    checkRunId: "555",
    checkName: "validate",
    ghFn: fakeGhModern(calls),
  });
  assertEquals(outcome.kind, "excerpt", JSON.stringify(outcome));
  if (outcome.kind === "excerpt") {
    assertStringIncludes(
      outcome.excerpt,
      "TS2339 [ERROR]: Property 'extensions' does not exist",
    );
    assertEquals(outcome.excerpt.includes("\x1b"), false, "ANSI stripped");
  }
  const logCall = calls.find((a) =>
    a.at(-1) === "repos/o/r/actions/jobs/456/logs"
  );
  assertEquals(logCall?.includes("--allow-escape-sequences"), true);
});

Deno.test("fetchGithubActionsLogExcerpt - an older gh that does not know the flag gets the plain call (Issue #4376)", async () => {
  const calls: string[][] = [];
  const ghFn = (args: string[]): Promise<string> => {
    calls.push(args);
    const endpoint = args[args.length - 1] ?? "";
    if (endpoint === "repos/o/r/check-runs/555") {
      return Promise.resolve(JSON.stringify({
        name: "validate",
        app: { slug: "github-actions" },
        details_url: "https://github.com/o/r/actions/runs/123/job/456",
      }));
    }
    if (args.includes("--allow-escape-sequences")) {
      return Promise.reject(
        new Error("unknown flag: --allow-escape-sequences"),
      );
    }
    if (endpoint === "repos/o/r/actions/jobs/456/logs") {
      return Promise.resolve(
        "2026-08-18T08:27:02.0000000Z ##[error]old gh log line",
      );
    }
    return Promise.reject(new Error(`unexpected: ${endpoint}`));
  };
  const outcome = await fetchGithubActionsLogExcerpt({
    repo: "o/r",
    checkRunId: "555",
    checkName: "validate",
    ghFn,
  });
  assertEquals(outcome.kind, "excerpt", JSON.stringify(outcome));
  if (outcome.kind === "excerpt") {
    assertStringIncludes(outcome.excerpt, "old gh log line");
  }
  assertEquals(
    calls.filter((a) => a.at(-1) === "repos/o/r/actions/jobs/456/logs").length,
    2,
    "flagged, then plain",
  );
});

Deno.test("stripAnsi - removes CSI colour and OSC sequences, keeps text (Issue #4376)", () => {
  assertEquals(
    stripAnsi(
      "\x1b[0m\x1b[32mCheck\x1b[0m mod.ts \x1b]8;;http://x\x07link\x1b]8;;\x07",
    ),
    "Check mod.ts link",
  );
});
