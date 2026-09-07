/**
 * Tests for the truthful GraphQL quota probe (Issue #1456).
 *
 * The probe exists because `gh api rate_limit` reported the GraphQL bucket
 * as untouched while the same token's GraphQL response headers said a third
 * of it was gone. These tests pin the header-first parse, the body fallback,
 * the exhausted-window shape GitHub actually returns, and the adapters the
 * pre-flight gate and telemetry consume.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  formatGraphqlQuotaLine,
  GRAPHQL_QUOTA_PROBE_ARGS,
  graphqlSpendBetween,
  isGraphqlQuotaProbe,
  parseGraphqlQuotaProbe,
  probeGraphqlQuota,
  toRateLimitDocument,
} from "../lib/graphql_quota_probe.ts";
import type { GhSpawnResult } from "../lib/gh_spawn.ts";

const RESET = 1_788_746_247;

/** A `gh api --include graphql` response the way GitHub sends it (CRLF). */
function includeOutput(
  headers: Record<string, string>,
  body: string,
  status = "HTTP/2.0 200 OK",
): string {
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  return `${status}\r\n${lines.join("\r\n")}\r\n\r\n${body}`;
}

function healthyHeaders(overrides: Record<string, string> = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "X-Ratelimit-Limit": "5000",
    "X-Ratelimit-Remaining": "3896",
    "X-Ratelimit-Reset": String(RESET),
    "X-Ratelimit-Resource": "graphql",
    "X-Ratelimit-Used": "1104",
    ...overrides,
  };
}

const HEALTHY_BODY =
  '{"data":{"rateLimit":{"limit":5000,"remaining":3896,"used":1104,"resetAt":"2026-09-07T01:57:27Z"}}}';

Deno.test("probe - headers are read first and are the source of truth", () => {
  const parsed = parseGraphqlQuotaProbe(
    includeOutput(healthyHeaders(), HEALTHY_BODY),
  );
  assert(parsed.ok);
  assertEquals(parsed.value, {
    limit: 5000,
    remaining: 3896,
    used: 1104,
    reset: RESET,
    source: "headers",
  });
});

Deno.test("probe - the exhausted window GitHub really returns: 200, headers say 0 left, body is an error", () => {
  // Once the primary quota is gone GitHub answers 200 with an errors body;
  // gh exits non-zero on that body but the headers still name the reset.
  const out = includeOutput(
    healthyHeaders({
      "X-Ratelimit-Remaining": "0",
      "X-Ratelimit-Used": "5000",
    }),
    '{"errors":[{"type":"RATE_LIMITED","message":"API rate limit already exceeded for user ID 23146043."}]}',
  );
  const parsed = parseGraphqlQuotaProbe(out);
  assert(parsed.ok);
  assertEquals(parsed.value.remaining, 0);
  assertEquals(parsed.value.used, 5000);
  assertEquals(parsed.value.reset, RESET);
});

Deno.test("probe - a body without headers still yields a reading", () => {
  const parsed = parseGraphqlQuotaProbe(HEALTHY_BODY);
  assert(parsed.ok);
  assertEquals(parsed.value.source, "body");
  assertEquals(parsed.value.remaining, 3896);
  assertEquals(parsed.value.used, 1104);
  assertEquals(
    parsed.value.reset,
    Date.parse("2026-09-07T01:57:27Z") / 1000,
  );
});

Deno.test("probe - used is derived when the header is missing", () => {
  const { "X-Ratelimit-Used": _dropped, ...headers } = healthyHeaders();
  const parsed = parseGraphqlQuotaProbe(includeOutput(headers, HEALTHY_BODY));
  assert(parsed.ok);
  assertEquals(parsed.value.used, 5000 - 3896);
});

Deno.test("probe - headers for another bucket are refused, not misread", () => {
  const parsed = parseGraphqlQuotaProbe(
    includeOutput(healthyHeaders({ "X-Ratelimit-Resource": "core" }), "{}"),
  );
  assert(!parsed.ok);
  assertStringIncludes(parsed.error.message, '"core"');
});

Deno.test("probe - output with neither headers nor a rateLimit body is a failure", () => {
  const parsed = parseGraphqlQuotaProbe("gh: command not found");
  assert(!parsed.ok);
  assertStringIncludes(parsed.error.message, "neither");
});

Deno.test("probe - a non-zero exit is not a failure when the headers parsed", async () => {
  const seen: string[][] = [];
  const spawn = (args: readonly string[]): Promise<GhSpawnResult> => {
    seen.push([...args]);
    return Promise.resolve({
      code: 1,
      success: false,
      stdout: includeOutput(
        healthyHeaders({
          "X-Ratelimit-Remaining": "0",
          "X-Ratelimit-Used": "5000",
        }),
        '{"errors":[{"type":"RATE_LIMITED","message":"API rate limit already exceeded for user ID 1."}]}',
      ),
      stderr: "GraphQL: API rate limit already exceeded for user ID 1.",
    });
  };
  const reading = await probeGraphqlQuota(spawn);
  assert(reading.ok);
  assertEquals(reading.value.remaining, 0);
  assertEquals(reading.value.reset, RESET);
  assertEquals(seen.length, 1);
  const sent = seen[0] ?? [];
  assert(isGraphqlQuotaProbe(sent), "the probe must send its own args");
  assertEquals(sent[1], "--include", "headers must be requested");
});

Deno.test("probe - a run failure carries the exit code and stderr", async () => {
  const spawn = (_args: readonly string[]): Promise<GhSpawnResult> =>
    Promise.resolve({
      code: 4,
      success: false,
      stdout: "",
      stderr: "gh: not logged in",
    });
  const reading = await probeGraphqlQuota(spawn);
  assert(!reading.ok);
  assertStringIncludes(reading.error.message, "exit 4");
  assertStringIncludes(reading.error.message, "not logged in");
});

Deno.test("probe - a spawn that throws is reported, not propagated", async () => {
  const reading = await probeGraphqlQuota(() =>
    Promise.reject(new Error("no gh binary"))
  );
  assert(!reading.ok);
  assertStringIncludes(reading.error.message, "no gh binary");
});

Deno.test("probe - isGraphqlQuotaProbe recognises only the probe", () => {
  assert(isGraphqlQuotaProbe(GRAPHQL_QUOTA_PROBE_ARGS));
  assert(!isGraphqlQuotaProbe(["api", "rate_limit"]));
  assert(
    !isGraphqlQuotaProbe([
      "api",
      "graphql",
      "-f",
      "query={ viewer { login } }",
    ]),
  );
});

Deno.test("probe - the rate_limit document adapter keeps the pre-flight parser's shape", () => {
  const doc = JSON.parse(
    toRateLimitDocument({
      limit: 5000,
      remaining: 12,
      used: 4988,
      reset: RESET,
      source: "headers",
    }),
  );
  assertEquals(doc, {
    resources: {
      graphql: { limit: 5000, used: 4988, remaining: 12, reset: RESET },
    },
  });
});

Deno.test("probe - spend between readings: same window is the delta, a new window is its own used", () => {
  const before = {
    limit: 5000,
    remaining: 3896,
    used: 1104,
    reset: RESET,
    source: "headers" as const,
  };
  assertEquals(
    graphqlSpendBetween(before, { ...before, used: 1579, remaining: 3421 }),
    475,
  );
  assertEquals(
    graphqlSpendBetween(before, {
      ...before,
      used: 210,
      remaining: 4790,
      reset: RESET + 3600,
    }),
    210,
  );
  // A counter that went backwards inside one window never reads as negative.
  assertEquals(graphqlSpendBetween(before, { ...before, used: 1000 }), 0);
});

Deno.test("probe - the telemetry line names the account-wide spend and the reopening", () => {
  const reading = {
    limit: 5000,
    remaining: 3421,
    used: 1579,
    reset: RESET,
    source: "headers" as const,
  };
  const line = formatGraphqlQuotaLine(reading, RESET - 782, 363);
  assertStringIncludes(line, "graphql-quota: used=1579/5000 remaining=3421");
  assertStringIncludes(line, "window-reopens at ");
  assertStringIncludes(line, "(in 13m 2s)");
  assertStringIncludes(line, "spent-since-last-cycle=363");
  assertStringIncludes(line, "every consumer of this GitHub account");
  // No spend on the first reading of a process.
  const first = formatGraphqlQuotaLine(reading, RESET - 782);
  assert(!first.includes("spent-since"));
});

Deno.test("probe - a retry-after header is surfaced for the burst cool-down", () => {
  const parsed = parseGraphqlQuotaProbe(
    includeOutput(
      healthyHeaders({ "Retry-After": "90" }),
      '{"message":"You have exceeded a secondary rate limit."}',
      "HTTP/2.0 403 Forbidden",
    ),
  );
  assert(parsed.ok);
  assertEquals(parsed.value.retryAfterSeconds, 90);
  const none = parseGraphqlQuotaProbe(
    includeOutput(healthyHeaders(), HEALTHY_BODY),
  );
  assert(none.ok);
  assertEquals(none.value.retryAfterSeconds, undefined);
});
