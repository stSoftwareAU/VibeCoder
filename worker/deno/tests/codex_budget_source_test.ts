/**
 * Tests for lib/codex_budget_source.ts — parsing the Codex budget shapes that
 * were verified against the pinned CLI (Issue #1697, parent #1694).
 *
 * Fixture-driven: every rollout line comes from
 * `tests/fixtures/codex_budget/`, whose shapes are derived from
 * `openai/codex` at `rust-v0.147.0` rather than invented.
 *
 * Australian English spelling throughout (behaviour, organisation, utilise).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type CodexBudgetKnown,
  codexResetAtToEpochMs,
  MAX_PLAUSIBLE_RESET_EPOCH_SECONDS,
  MIN_PLAUSIBLE_RESET_EPOCH_SECONDS,
  parseCodexExhaustion,
  parseCodexRateLimitSnapshot,
  parseCodexRolloutLine,
} from "../lib/codex_budget_source.ts";

const FIXTURES = new URL("./fixtures/codex_budget/", import.meta.url);

/** Read a fixture's non-empty lines. */
function fixtureLines(name: string): string[] {
  return Deno.readTextFileSync(new URL(name, FIXTURES))
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

/** Narrow a budget to its known form, failing the test when it is not. */
function known(budget: ReturnType<typeof parseCodexRateLimitSnapshot>) {
  assert(
    budget.known,
    `expected a known budget, got ${JSON.stringify(budget)}`,
  );
  return budget as CodexBudgetKnown;
}

Deno.test("parseCodexRateLimitSnapshot - reads both verified windows", () => {
  const budget = known(parseCodexRateLimitSnapshot({
    limit_id: "codex",
    limit_name: null,
    primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1788483600 },
    secondary: {
      used_percent: 61.75,
      window_minutes: 10080,
      resets_at: 1788829200,
    },
    plan_type: "pro",
  }));

  assertEquals(budget.windows.length, 2);
  assertEquals(budget.windows[0]?.window, "primary");
  assertEquals(budget.windows[0]?.usedPercent, 12.5);
  assertEquals(budget.windows[0]?.remainingFraction, 0.875);
  assertEquals(budget.windows[0]?.windowMinutes, 300);
  assertEquals(budget.windows[1]?.windowMinutes, 10080);
  assertEquals(budget.limitId, "codex");
  assertEquals(budget.planType, "pro");
  // `limit_name: null` is absent, not the string "null".
  assertEquals(budget.limitName, undefined);
});

Deno.test("parseCodexRateLimitSnapshot - headline is the most constrained window", () => {
  const budget = known(parseCodexRateLimitSnapshot({
    primary: { used_percent: 5, window_minutes: 300, resets_at: 1788483600 },
    secondary: {
      used_percent: 99,
      window_minutes: 10080,
      resets_at: 1788829200,
    },
  }));

  assertEquals(budget.window, "secondary");
  assertEquals(Number(budget.remainingFraction.toFixed(6)), 0.01);
  assertEquals(budget.resetAt, 1788829200 * 1000);
});

Deno.test("parseCodexRateLimitSnapshot - resets_at is epoch seconds, converted to ms", () => {
  const budget = known(parseCodexRateLimitSnapshot({
    primary: { used_percent: 10, window_minutes: 300, resets_at: 1788483600 },
  }));
  assertEquals(budget.windows[0]?.resetAt, 1788483600000);
  // The instant is the UTC one the CLI documents — no local-timezone shift.
  assertEquals(
    new Date(budget.windows[0]!.resetAt!).toISOString(),
    "2026-09-04T01:00:00.000Z",
  );
});

Deno.test("codexResetAtToEpochMs - rejects implausible, non-integral and absent values", () => {
  assertEquals(codexResetAtToEpochMs(1788483600), 1788483600000);
  assertEquals(codexResetAtToEpochMs(undefined), undefined);
  assertEquals(codexResetAtToEpochMs(null), undefined);
  assertEquals(codexResetAtToEpochMs("1788483600"), undefined);
  assertEquals(codexResetAtToEpochMs(0), undefined);
  assertEquals(codexResetAtToEpochMs(-1), undefined);
  assertEquals(codexResetAtToEpochMs(1788483600.5), undefined);
  // A millisecond value would read as a reset 1000x too far away.
  assertEquals(codexResetAtToEpochMs(1788483600000), undefined);
  // A *relative* value — the `resets_in_seconds` convention earlier releases
  // used for this field — would otherwise become a reset instant in 1970.
  assertEquals(codexResetAtToEpochMs(3600), undefined);
  assertEquals(
    codexResetAtToEpochMs(MIN_PLAUSIBLE_RESET_EPOCH_SECONDS - 1),
    undefined,
  );
  assertEquals(
    codexResetAtToEpochMs(MIN_PLAUSIBLE_RESET_EPOCH_SECONDS),
    MIN_PLAUSIBLE_RESET_EPOCH_SECONDS * 1000,
  );
  assertEquals(
    codexResetAtToEpochMs(MAX_PLAUSIBLE_RESET_EPOCH_SECONDS),
    MAX_PLAUSIBLE_RESET_EPOCH_SECONDS * 1000,
  );
});

Deno.test("parseCodexRateLimitSnapshot - an implausible reset drops the reset, keeps the window", () => {
  const budget = known(parseCodexRateLimitSnapshot({
    primary: {
      used_percent: 40,
      window_minutes: 300,
      resets_at: 1788483600000,
    },
  }));
  assertEquals(budget.windows[0]?.usedPercent, 40);
  assertEquals(budget.windows[0]?.resetAt, undefined);
  assertEquals(budget.resetAt, undefined);
});

Deno.test("parseCodexRateLimitSnapshot - clamps an over-consumed window to zero", () => {
  const budget = known(parseCodexRateLimitSnapshot({
    primary: { used_percent: 103.4, window_minutes: 300 },
  }));
  assertEquals(budget.remainingFraction, 0);
});

Deno.test("parseCodexRateLimitSnapshot - missing and malformed data is unknown, never zero", () => {
  assertEquals(parseCodexRateLimitSnapshot(null), {
    known: false,
    reason: "no-rate-limit-data",
  });
  assertEquals(parseCodexRateLimitSnapshot(undefined).known, false);
  assertEquals(parseCodexRateLimitSnapshot([]).known, false);
  assertEquals(parseCodexRateLimitSnapshot("nope").known, false);

  const empty = parseCodexRateLimitSnapshot({ limit_id: "codex" });
  assertEquals(empty.known, false);
  assert(!empty.known && empty.reason === "unrecognised-snapshot-shape");

  const stringPercent = parseCodexRateLimitSnapshot({
    primary: { used_percent: "lots" },
  });
  assert(!stringPercent.known);
  assertEquals(stringPercent.reason, "unrecognised-snapshot-shape");
});

Deno.test("parseCodexRateLimitSnapshot - a secondary-only snapshot still parses", () => {
  const budget = known(parseCodexRateLimitSnapshot({
    primary: null,
    secondary: { used_percent: 30, window_minutes: 10080 },
  }));
  assertEquals(budget.windows.length, 1);
  assertEquals(budget.window, "secondary");
  assertEquals(budget.remainingFraction, 0.7);
});

Deno.test("parseCodexRateLimitSnapshot - credits are read without the balance", () => {
  const budget = known(parseCodexRateLimitSnapshot({
    primary: { used_percent: 1 },
    credits: { has_credits: true, unlimited: false, balance: "12.34" },
  }));
  assertEquals(budget.credits, { hasCredits: true, unlimited: false });
  assertEquals(JSON.stringify(budget).includes("12.34"), false);
});

Deno.test("parseCodexRolloutLine - reads the verified subscription fixture", () => {
  const lines = fixtureLines("rollout_chatgpt_subscription.jsonl");
  const readings = lines.map(parseCodexRolloutLine).filter((r) => r !== null);
  assertEquals(readings.length, 2);

  const newest = readings[1]!;
  assertEquals(newest.capturedAt, Date.parse("2026-09-09T01:05:00.000Z"));
  const budget = known(newest.budget);
  assertEquals(budget.window, "secondary");
  assertEquals(budget.windows[0]?.usedPercent, 18);
  assertEquals(budget.windows[1]?.usedPercent, 92.5);
  assertEquals(budget.planType, "pro");
});

Deno.test("parseCodexRolloutLine - ignores lines carrying no rate limits", () => {
  for (const line of fixtureLines("rollout_no_rate_limits.jsonl")) {
    assertEquals(parseCodexRolloutLine(line), null);
  }
});

Deno.test("parseCodexRolloutLine - malformed lines are unknown or skipped, never thrown", () => {
  const readings = fixtureLines("rollout_malformed.jsonl")
    .map(parseCodexRolloutLine);

  // Truncated JSON is skipped entirely; a `rate_limits` of the wrong shape is
  // retained with its own reason code rather than silently dropped.
  assertEquals(readings[3], null);
  const wrongShape = readings[2];
  assert(wrongShape && !wrongShape.budget.known);
  assertEquals(wrongShape.budget.reason, "no-rate-limit-data");
  // Wrong-typed and missing figures survive as explicit unknowns.
  for (const index of [0, 1]) {
    const budget = readings[index]?.budget;
    assert(budget && !budget.known);
    assertEquals(budget.reason, "unrecognised-snapshot-shape");
  }
});

Deno.test("parseCodexRolloutLine - rejects non-rollout and empty input", () => {
  assertEquals(parseCodexRolloutLine(""), null);
  assertEquals(parseCodexRolloutLine("   "), null);
  assertEquals(parseCodexRolloutLine("not json"), null);
  assertEquals(parseCodexRolloutLine('{"type":"response_item"}'), null);
  assertEquals(
    parseCodexRolloutLine('{"type":"event_msg","payload":{"type":"error"}}'),
    null,
  );
});

Deno.test("parseCodexExhaustion - recognises the pinned CLI's usage-limit wordings", () => {
  const cases: ReadonlyArray<[string, string]> = [
    [
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:45 PM.",
      "rate_limit_reached",
    ],
    [
      "You've hit your usage limit. Try again at Sep 10th, 2026 9:00 AM.",
      "rate_limit_reached",
    ],
    [
      "Your workspace is out of credits. Add credits to continue.",
      "workspace_credits_depleted",
    ],
    [
      "You hit your spend cap set in your workspace. Increase your spend cap to continue.",
      "workspace_spend_cap_reached",
    ],
    ["Quota exceeded. Check your plan and billing details.", "quota_exceeded"],
    [
      "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
      "usage_not_included",
    ],
  ];

  for (const [message, expected] of cases) {
    const exhaustion = parseCodexExhaustion(message);
    assert(exhaustion, `expected exhaustion for: ${message}`);
    assertEquals(exhaustion.kind, expected);
    // The reset is never recovered — the CLI prints it in local time.
    assertEquals(exhaustion.resetAt, undefined);
  }
});

Deno.test("parseCodexExhaustion - a bare 429 is exhaustion", () => {
  const exhaustion = parseCodexExhaustion(
    "unexpected status 429 Too Many Requests: slow down, request id: req_1",
  );
  assert(exhaustion);
  assertEquals(exhaustion.kind, "http_429");
});

Deno.test("parseCodexExhaustion - names the specific limit when the CLI does", () => {
  const exhaustion = parseCodexExhaustion(
    "You've hit your usage limit for gpt-5.2-codex-sonic. Switch to another model now, or try again at 3:45 PM.",
  );
  assert(exhaustion);
  assertEquals(exhaustion.kind, "rate_limit_reached");
  assertEquals(exhaustion.limitName, "gpt-5.2-codex-sonic");
});

Deno.test("parseCodexExhaustion - ordinary failures are not exhaustion", () => {
  const notExhaustion = [
    "",
    "   ",
    "stream disconnected before completion: connection reset",
    "Codex ran out of room in the model's context window.",
    "unexpected status 500 Internal Server Error: Unknown error",
    "codex login is required",
  ];
  for (const message of notExhaustion) {
    assertEquals(parseCodexExhaustion(message), null, message);
  }
});

Deno.test("parseCodexRateLimitSnapshot - a relative reset is dropped, not fabricated", () => {
  const budget = known(parseCodexRateLimitSnapshot({
    primary: { used_percent: 20, window_minutes: 300, resets_at: 3600 },
  }));
  // 3600 seconds after the epoch is 1970 — a rollover silently in the past,
  // which reads as "the window has already reset, go again".
  assertEquals(budget.windows[0]?.resetAt, undefined);
  assertEquals(budget.windows[0]?.usedPercent, 20);
});

Deno.test("parseCodexRateLimitSnapshot - reads the backend's own exhaustion declaration", () => {
  const budget = known(parseCodexRateLimitSnapshot({
    primary: { used_percent: 100, window_minutes: 300 },
    spend_control_reached: true,
    rate_limit_reached_type: "workspace_member_usage_limit_reached",
  }));
  assertEquals(budget.rateLimitReachedType, "workspace_spend_cap_reached");
  assertEquals(budget.spendControlReached, true);
});

Deno.test("parseCodexRateLimitSnapshot - an unknown reached type is dropped, not guessed", () => {
  const budget = known(parseCodexRateLimitSnapshot({
    primary: { used_percent: 10 },
    rate_limit_reached_type: "something_new_openai_added",
  }));
  assertEquals(budget.rateLimitReachedType, undefined);
});

Deno.test("parseCodexRolloutLine - a present-but-malformed rate_limits is retained", () => {
  // Absent or null is simply not a reading; the wrong *shape* is a fact worth
  // keeping, with its own reason code.
  assertEquals(
    parseCodexRolloutLine(
      '{"type":"event_msg","payload":{"type":"token_count"}}',
    ),
    null,
  );
  assertEquals(
    parseCodexRolloutLine(
      '{"type":"event_msg","payload":{"type":"token_count","rate_limits":null}}',
    ),
    null,
  );
  const reading = parseCodexRolloutLine(
    '{"type":"event_msg","payload":{"type":"token_count","rate_limits":[]}}',
  );
  assert(reading && !reading.budget.known);
  assertEquals(reading.budget.reason, "no-rate-limit-data");
});
