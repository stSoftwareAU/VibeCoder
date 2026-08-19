/**
 * Tests for model-unavailable detection driving immediate model fallback
 * (Issue #2724).
 *
 * When a top-tier model is pulled (suspended, revoked, removed, or otherwise
 * not permitted) the Claude CLI exits non-zero with an error that is NOT a
 * rate limit. Retrying the same model is futile — the only recovery is to fall
 * back to the next-best model. `detectModelUnavailable()` is the pure decision
 * function that distinguishes that class of failure from a transient rate
 * limit (handled by `detectRateLimit()`), so `runClaudeWithRetry()` can
 * downgrade immediately instead of returning a hard failure.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  detectModelUnavailable,
  detectRateLimit,
} from "../lib/claude_executor.ts";

// ---------------------------------------------------------------------------
// detectModelUnavailable — positive cases (should fall back)
// ---------------------------------------------------------------------------

const POSITIVE_CASES: ReadonlyArray<readonly [string, string]> = [
  [
    "access suspended (the #2724 incident)",
    "Access to Fable 5 has been suspended",
  ],
  ["403 access suspended", "API Error 403: access to fable has been suspended"],
  ["model not available", "Error: model 'fable' is not available"],
  ["model not found", "model not found: claude-fable-5"],
  ["unknown model", "Unknown model: fable"],
  ["invalid model", "Invalid model 'fable'"],
  ["unsupported model", "This is an unsupported model"],
  ["no longer available", "This model is no longer available"],
  ["403 forbidden", "403 Forbidden"],
  ["not authorized to use", "You are not authorized to use this model"],
  ["not authorised to access (en-AU)", "Not authorised to access this model"],
  [
    "does not have access",
    "Your organisation does not have access to model fable",
  ],
  ["tier disabled", "model fable is currently disabled"],
  ["access revoked", "access to this model has been revoked"],
  // ---------------------------------------------------------------------------
  // Real-world Fable export-disable signatures (Issue #2735, parent #2720).
  //
  // These mirror the shapes the Anthropic API / Claude CLI emit when a tier is
  // entitlement- or export-control-disabled: a 403 with a `permission_error`
  // body, or "restricted"/"export control" wording naming the model alias.
  // Cross-references #2711 (the `fable` alias is forwarded verbatim) — a
  // rejected alias produces output the detector must match.
  // ---------------------------------------------------------------------------
  [
    "403 permission_error JSON (entitlement denied)",
    'API Error: 403 {"type":"error","error":{"type":"permission_error",' +
    '"message":"Your organisation is not authorised to access model fable"}}',
  ],
  [
    "permission_error model not available",
    '{"type":"error","error":{"type":"permission_error",' +
    '"message":"This model is not available"}}',
  ],
  [
    "export control — model not available",
    "model fable is not available due to export control restrictions",
  ],
  [
    "export compliance — disabled",
    "The fable model has been disabled for export compliance",
  ],
  [
    "export controls — restricted (alias only, no access/use prefix)",
    "Fable is restricted in your region due to export controls",
  ],
];

for (const [name, output] of POSITIVE_CASES) {
  Deno.test(`detectModelUnavailable - detects ${name}`, () => {
    assertEquals(detectModelUnavailable(output), true);
  });
}

// ---------------------------------------------------------------------------
// detectModelUnavailable — negative cases (must NOT fall back)
// ---------------------------------------------------------------------------

const NEGATIVE_CASES: ReadonlyArray<readonly [string, string]> = [
  ["empty output", ""],
  ["whitespace only", "   \n  \n"],
  ["rate limit text", "rate limit exceeded, try again later"],
  ["credit exhaustion", "Credit balance is too low to continue"],
  ["429 too many requests", "429 Too Many Requests"],
  ["quota exceeded", "quota exceeded for this period"],
  ["normal success", "Successfully created PR #42 and pushed the branch"],
  ["git ssh failure", "fatal: permission denied (publickey)"],
  [
    "claude prose about availability",
    "I considered whether the API is available and it is",
  ],
];

for (const [name, output] of NEGATIVE_CASES) {
  Deno.test(`detectModelUnavailable - ignores ${name}`, () => {
    assertEquals(detectModelUnavailable(output), false);
  });
}

// ---------------------------------------------------------------------------
// Only scans the tail (mirrors detectRateLimit) — avoids false positives from
// Claude discussing model availability earlier in a long, otherwise-fine run.
// ---------------------------------------------------------------------------

Deno.test("detectModelUnavailable - only scans the last N lines", () => {
  const noise = Array.from({ length: 50 }, (_, i) => `log line ${i}`).join(
    "\n",
  );
  const output = `Unknown model: fable\n${noise}`;
  // The signal is 50+ lines back from the end — outside the default 30-line tail.
  assertEquals(detectModelUnavailable(output, 30), false);
  // Widen the window and it is found again.
  assertEquals(detectModelUnavailable(output, 60), true);
});

// ---------------------------------------------------------------------------
// The two detectors are distinct — a model-unavailable error is not mistaken
// for a rate limit, and a rate limit is not mistaken for model-unavailable.
// This matters because runClaudeWithRetry routes them differently: rate limits
// wait-and-retry, model-unavailable falls back with no wait.
// ---------------------------------------------------------------------------

Deno.test("detectModelUnavailable - suspension is not classified as a rate limit", () => {
  const output = "Access to Fable 5 has been suspended";
  assertEquals(detectModelUnavailable(output), true);
  assertEquals(detectRateLimit(output).isRateLimited, false);
});

Deno.test("detectModelUnavailable - a plain rate limit is not classified as model-unavailable", () => {
  const output = "rate limit exceeded";
  assertEquals(detectRateLimit(output).isRateLimited, true);
  assertEquals(detectModelUnavailable(output), false);
});
