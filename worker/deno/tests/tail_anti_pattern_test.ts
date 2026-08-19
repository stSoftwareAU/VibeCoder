/**
 * Tests for tail_anti_pattern.ts — `tail -f … | head -N` foot-gun detector
 * (Issue #1681).
 *
 * Acceptance criterion 1 from the issue: "A repro test where Claude is asked
 * to process a finished log file does not invoke `tail -f`." The detector is
 * the deterministic equivalent — given a candidate shell command, it must
 * flag the foot-gun and accept the safe rewrites.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { detectTailFAntiPattern } from "../lib/tail_anti_pattern.ts";

// ---------------------------------------------------------------------------
// Foot-gun: should be flagged
// ---------------------------------------------------------------------------

Deno.test("detectTailFAntiPattern - flags `tail -f file | head -50`", () => {
  const result = detectTailFAntiPattern("tail -f /tmp/run.log | head -50");
  assert(result.isAntiPattern, "expected the canonical foot-gun to be flagged");
  assertStringIncludes(result.reason ?? "", "head exits");
  assertStringIncludes(result.suggestion ?? "", "tail -n");
});

Deno.test("detectTailFAntiPattern - flags `tail -F file | head`", () => {
  const result = detectTailFAntiPattern(
    "tail -F /var/log/app.log | head -n 20",
  );
  assert(result.isAntiPattern, "tail -F must be treated like tail -f");
});

Deno.test("detectTailFAntiPattern - flags `tail --follow file | head`", () => {
  const result = detectTailFAntiPattern(
    "tail --follow /tmp/build.log | head -100",
  );
  assert(result.isAntiPattern);
});

Deno.test("detectTailFAntiPattern - flags `tail --follow=name file | head`", () => {
  const result = detectTailFAntiPattern(
    "tail --follow=name /tmp/x.log | head -10",
  );
  assert(result.isAntiPattern);
});

Deno.test("detectTailFAntiPattern - flags short-flag cluster `tail -nf 50 file`", () => {
  const result = detectTailFAntiPattern("tail -nf 50 /tmp/foo.log | head -20");
  assert(result.isAntiPattern, "combined short flags containing f must match");
});

Deno.test("detectTailFAntiPattern - flags `tail -fn 50 file`", () => {
  const result = detectTailFAntiPattern("tail -fn 50 /tmp/foo.log | head -20");
  assert(result.isAntiPattern);
});

Deno.test("detectTailFAntiPattern - flags unbounded `tail -f` even without head", () => {
  // Without a head, the writer dying still leaves tail forever. Flag it.
  const result = detectTailFAntiPattern("tail -f /tmp/run.log");
  assert(result.isAntiPattern);
  assertStringIncludes(result.reason ?? "", "Unbounded");
});

Deno.test("detectTailFAntiPattern - flags `tail -f` piped through grep then head", () => {
  // The foot-gun survives an intermediate filter — the original tail still
  // blocks forever when the writer dies.
  const result = detectTailFAntiPattern(
    "tail -f /tmp/run.log | grep ERROR | head -20",
  );
  assert(result.isAntiPattern);
});

// ---------------------------------------------------------------------------
// Safe alternatives: should NOT be flagged
// ---------------------------------------------------------------------------

Deno.test("detectTailFAntiPattern - accepts `tail -n 50 file`", () => {
  const result = detectTailFAntiPattern("tail -n 50 /tmp/run.log");
  assertEquals(result.isAntiPattern, false);
});

Deno.test("detectTailFAntiPattern - accepts `head -50 file`", () => {
  const result = detectTailFAntiPattern("head -50 /tmp/run.log");
  assertEquals(result.isAntiPattern, false);
});

Deno.test("detectTailFAntiPattern - accepts `timeout 30 tail -f file | head -50`", () => {
  const result = detectTailFAntiPattern(
    "timeout 30 tail -f /tmp/run.log | head -50",
  );
  assertEquals(
    result.isAntiPattern,
    false,
    "a timeout guard makes the streaming read safe",
  );
});

Deno.test("detectTailFAntiPattern - accepts `gtimeout 30 tail -f file`", () => {
  const result = detectTailFAntiPattern(
    "gtimeout 30 tail -f /tmp/run.log | head -50",
  );
  assertEquals(result.isAntiPattern, false);
});

Deno.test("detectTailFAntiPattern - accepts `$TIMEOUT_CMD 30 tail -f file`", () => {
  // The Vibe Coder uses $TIMEOUT_CMD (gtimeout on macOS, timeout on Linux).
  const result = detectTailFAntiPattern(
    "$TIMEOUT_CMD 30 tail -f /tmp/run.log | head -50",
  );
  assertEquals(result.isAntiPattern, false);
});

Deno.test("detectTailFAntiPattern - accepts `tail -n 50 finished.log` (the recommended pattern)", () => {
  // The first acceptance criterion: when asked to process a *finished* log,
  // the safe pattern is `tail -n N` against the static file. Must not be
  // flagged.
  const result = detectTailFAntiPattern("tail -n 50 /tmp/finished.log");
  assertEquals(result.isAntiPattern, false);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

Deno.test("detectTailFAntiPattern - empty string is not an anti-pattern", () => {
  assertEquals(detectTailFAntiPattern("").isAntiPattern, false);
});

Deno.test("detectTailFAntiPattern - whitespace-only string is not an anti-pattern", () => {
  assertEquals(detectTailFAntiPattern("   \t\n  ").isAntiPattern, false);
});

Deno.test("detectTailFAntiPattern - command without `tail` is not an anti-pattern", () => {
  assertEquals(
    detectTailFAntiPattern("grep ERROR /tmp/run.log | head -50").isAntiPattern,
    false,
  );
});

Deno.test("detectTailFAntiPattern - `tail` without follow flag is not an anti-pattern", () => {
  assertEquals(
    detectTailFAntiPattern("tail -n 100 /tmp/run.log | grep ERROR")
      .isAntiPattern,
    false,
  );
});

Deno.test("detectTailFAntiPattern - flags only the unguarded segment in compound commands", () => {
  // A compound command with a safe segment AND an unsafe segment should be
  // flagged. `;` does not propagate SIGPIPE so the two are independent.
  const result = detectTailFAntiPattern(
    "echo start; tail -f /tmp/run.log | head -50",
  );
  assert(result.isAntiPattern);
});

Deno.test("detectTailFAntiPattern - does not falsely match `--detail` style long options", () => {
  // The long option ends with neither `=name` nor exactly `--follow`, so it
  // must not be confused with `--follow`.
  const result = detectTailFAntiPattern("some-cmd --detail /tmp/run.log");
  assertEquals(result.isAntiPattern, false);
});
