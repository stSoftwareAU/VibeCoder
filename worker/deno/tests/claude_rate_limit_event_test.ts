/**
 * Tests for the stream-json `rate_limit_event` parser (Issue #1666).
 *
 * The CLI emits a structured event on the same stdout the runner tees to
 * the agent jsonl. These tests pin the parent's live event, the
 * rejection predicate, the skip-malformed rule, and a runner path whose
 * only evidence is the event (no assistant prose).
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  isUsageLimitRejection,
  parseRateLimitEvents,
} from "../lib/claude_rate_limit_event.ts";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import { posixSingleQuote } from "../lib/shell_quote.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

/**
 * The event the parent recorded from
 * `agent-vibe-mtsn4ggo-212774.jsonl` (Issue #1653).
 */
export const PARENT_RATE_LIMIT_EVENT =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1788875400,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":1,"resetsAt":1788875400},"seven_day":{"utilization":0.36,"resetsAt":1789434000}}}}';

Deno.test("parseRateLimitEvents - the parent's event parses to the two windows (Issue #1666)", () => {
  const events = parseRateLimitEvents(PARENT_RATE_LIMIT_EVENT);
  assertEquals(events.length, 1);
  const event = events[0]!;
  assertEquals(event.status, "rejected");
  assertEquals(event.rateLimitType, "five_hour");
  assertEquals(event.resetsAtEpochMs, 1788875400000);
  assertEquals(event.windows, [
    {
      window: "five_hour",
      remainingFraction: 0,
      resetAt: 1788875400000,
    },
    {
      window: "seven_day",
      remainingFraction: 0.64,
      resetAt: 1789434000000,
    },
  ]);
  assertEquals(isUsageLimitRejection(event), true);
});

Deno.test("parseRateLimitEvents - a status allowed event is not a rejection (Issue #1666)", () => {
  const line =
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1788875400,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0.1,"resetsAt":1788875400}}}}';
  const events = parseRateLimitEvents(line);
  assertEquals(events.length, 1);
  assertEquals(events[0]!.status, "allowed");
  assertEquals(isUsageLimitRejection(events[0]!), false);
});

Deno.test("parseRateLimitEvents - a corrupt line is skipped, never thrown on (Issue #1666)", () => {
  const raw = [
    "{not-json",
    PARENT_RATE_LIMIT_EVENT,
    '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}',
    '{"type":"assistant","message":{"content":[]}}',
  ].join("\n");
  const events = parseRateLimitEvents(raw);
  assertEquals(events.length, 1);
  assertEquals(events[0]!.resetsAtEpochMs, 1788875400000);
});

Deno.test("isUsageLimitRejection - only five_hour and seven_day rejections count (Issue #1666)", () => {
  const base = {
    status: "rejected" as const,
    resetsAtEpochMs: 1,
    windows: [],
  };
  assertEquals(
    isUsageLimitRejection({ ...base, rateLimitType: "five_hour" }),
    true,
  );
  assertEquals(
    isUsageLimitRejection({ ...base, rateLimitType: "seven_day" }),
    true,
  );
  assertEquals(
    isUsageLimitRejection({ ...base, rateLimitType: "tokens" }),
    false,
  );
  assertEquals(
    isUsageLimitRejection({
      ...base,
      status: "allowed",
      rateLimitType: "five_hour",
    }),
    false,
  );
});

Deno.test({
  name:
    "runClaudeWithRetry - a rejected five_hour event with no prose is a usage limit (Issue #1666)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const workDir = await Deno.makeTempDir({ prefix: "ul_event_" });
    try {
      const body = `printf '%s\\n' ${
        posixSingleQuote(PARENT_RATE_LIMIT_EVENT)
      }\nexit 1\n`;
      const result = await withAgentStub(
        body,
        (stub) =>
          runClaudeWithRetry(
            {
              clock: fakeClock(),
              prompt: "t",
              model: "opus",
              timeoutSeconds: 30,
              killAfterSeconds: 2,
              agentBinaryPath: stub.path,
              workDir,
            },
            { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 0 },
          ),
        { prefix: "claude_rle_stub_" },
      );
      assert(result.ok);
      assertEquals(result.value.exitCode, 2);
      assertEquals(result.value.usageLimit?.resetEpochMs, 1788875400000);
      assertEquals(result.value.usageLimit?.windows, [
        {
          window: "five_hour",
          remainingFraction: 0,
          resetAt: 1788875400000,
        },
        {
          window: "seven_day",
          remainingFraction: 0.64,
          resetAt: 1789434000000,
        },
      ]);
    } finally {
      await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
    }
  },
});
