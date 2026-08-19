/**
 * Tests for Max-subscription usage-limit detection and reset parsing
 * (Issue #4315).
 *
 * A usage limit (5-hour / weekly window on a subscription) is not a rate
 * limit: the right response is to stop spending until the window resets —
 * no model fallback, no issue blame. These tests pin the vocabulary the
 * worker recognises and the reset-time parsing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  detectRateLimit,
  detectUsageLimit,
  parseUsageLimitReset,
} from "../lib/claude_executor.ts";

Deno.test("usage limit - recognises the Claude Code subscription messages", () => {
  for (
    const message of [
      "Claude usage limit reached. Your limit will reset at 3pm (Australia/Sydney).",
      "Claude AI usage limit reached|1787040000",
      "You've hit your limit · resets 3am",
      "You have hit your usage limit for this 5-hour window",
      "5-hour limit reached · resets 3am",
      "Weekly limit reached — resets Tuesday",
      "You're out of extra usage",
    ]
  ) {
    assertEquals(detectUsageLimit(message), true, message);
  }
});

Deno.test("usage limit - does not fire on ordinary output or plain rate limits", () => {
  for (
    const message of [
      "Implemented the limit check in the parser",
      "Rate limit exceeded, please try again",
      "429 Too Many Requests",
      "the weekly report is done",
      "",
    ]
  ) {
    assertEquals(detectUsageLimit(message), false, message);
  }
});

Deno.test("usage limit - only the tail is scanned, so a discussion earlier in the transcript is ignored", () => {
  const body = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const early = "Claude usage limit reached\n" + body;
  assertEquals(detectUsageLimit(early), false);
  const late = body + "\nClaude usage limit reached";
  assertEquals(detectUsageLimit(late), true);
});

Deno.test("usage limit - parses an epoch suffix, an am/pm clock, and a 24h clock into the next future time", () => {
  const now = Date.UTC(2026, 7, 18, 1, 0, 0); // 01:00Z
  // Epoch suffix (the CLI's machine-readable form).
  assertEquals(
    parseUsageLimitReset("Claude AI usage limit reached|1787040000", now),
    1787040000 * 1000,
  );
  // "resets 3am" — next 03:00 in the local zone (test forces UTC).
  const three = parseUsageLimitReset(
    "You've hit your limit · resets 3am",
    now,
    "UTC",
  );
  assertEquals(three, Date.UTC(2026, 7, 18, 3, 0, 0));
  // A time already past today rolls to tomorrow.
  const midnight = parseUsageLimitReset("resets at 12am", now, "UTC");
  assertEquals(midnight, Date.UTC(2026, 7, 19, 0, 0, 0));
  // 24h clock with minutes.
  const t = parseUsageLimitReset("Your limit will reset at 14:30", now, "UTC");
  assertEquals(t, Date.UTC(2026, 7, 18, 14, 30, 0));
  // Unparseable → null (caller falls back to a default wait).
  assertEquals(parseUsageLimitReset("You've hit your limit", now), null);
});

Deno.test("rate limit - overloaded/529 are now primary rate-limit (short-backoff) matches", () => {
  assert(detectRateLimit("API error: overloaded_error").isPrimary);
  assert(detectRateLimit("HTTP 529 Overloaded").isPrimary);
});
