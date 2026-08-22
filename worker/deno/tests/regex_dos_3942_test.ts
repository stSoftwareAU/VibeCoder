/**
 * Regression tests for the two uncapped super-linear regexes that could stall
 * the single-threaded worker (Issue #3942, finding SEC-82bf6e57e20d).
 *
 * Both regexes ran synchronously on the main thread against
 * attacker-influenced text, so a pathological input froze the whole Deno
 * event loop — timers, heartbeats and the Claude timeout included.
 *
 *  (a) `suppression_comments.ts` block-comment patterns backtracked cubically
 *      on an unterminated `/* … ` marker followed by a long whitespace run.
 *  (b) `secret_redaction.ts` `url-userinfo` and `secret-cli-flag` backtracked
 *      quadratically on a long alphanumeric (or hyphen) run.
 *
 * These are deliberately wall-clock assertions: super-linear backtracking has
 * no observable output difference, only a runtime one. The budgets are set an
 * order of magnitude above the fixed cost (milliseconds) and far below the
 * unfixed cost (tens of seconds at these sizes), so they stay stable even on a
 * loaded machine.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _resetSuppressionAuthorAllowlist,
  _resetSuppressionCommitAuthors,
  findSuppressions,
  resetSuppressionRegistry,
  setSuppressionAuthorAllowlist,
  setSuppressionCommitAuthors,
} from "../lib/suppression_comments.ts";
import { redactSecrets } from "../lib/secret_redaction.ts";
import {
  capManifestText,
  MAX_MANIFEST_SCAN_CHARS,
  MAX_MANIFEST_SCAN_LINE_CHARS,
} from "../lib/orphan_deps_suppression_scan.ts";

/** Wall-clock budget for a single pathological input, in milliseconds. */
const BUDGET_MS = 2_000;

/** Run `fn` and return how long it took, in milliseconds. */
function elapsedMs(fn: () => void): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

// ---------------------------------------------------------------------------
// (a) suppression block-comment patterns
// ---------------------------------------------------------------------------

Deno.test("findSuppressions - unterminated block marker with a long whitespace tail does not stall", () => {
  resetSuppressionRegistry();
  // 40 kB of trailing whitespace with no closing `*/` — the cubic case.
  const line = `/* orphan-deps-ignore: BP-aaaaaaaaaaaa${" ".repeat(40_000)}`;
  let records: unknown[] = [];
  const took = elapsedMs(() => {
    records = findSuppressions(line, "ts");
  });
  assertEquals(records.length, 0, "an unterminated block marker is not a hit");
  assert(took < BUDGET_MS, `took ${took.toFixed(0)}ms, budget ${BUDGET_MS}ms`);
});

Deno.test("findSuppressions - unterminated SEC block marker with a long tail does not stall", () => {
  resetSuppressionRegistry();
  const line = `/* security-scan-ignore: SEC-abc123${" ".repeat(40_000)}`;
  let records: unknown[] = [];
  const took = elapsedMs(() => {
    records = findSuppressions(line, "ts");
  });
  assertEquals(records.length, 0);
  assert(took < BUDGET_MS, `took ${took.toFixed(0)}ms, budget ${BUDGET_MS}ms`);
});

Deno.test("findSuppressions - terminated block marker with a long reason does not stall", () => {
  resetSuppressionRegistry();
  _resetSuppressionAuthorAllowlist();
  _resetSuppressionCommitAuthors();
  setSuppressionAuthorAllowlist(["nigel"]);
  setSuppressionCommitAuthors(["nigel"]);
  try {
    // Long, but inside MAX_SUPPRESSION_LINE_CHARS — a longer line is skipped
    // unparsed by the per-line cap, which its own tests cover.
    const reason = "why ".repeat(400);
    const line =
      `/* security-scan-ignore: SEC-abc123 — author=nigel expires=2099-12-31 ${reason}*/`;
    let records: { id: string; valid: boolean; reason: string }[] = [];
    const took = elapsedMs(() => {
      records = findSuppressions(line, "ts");
    });
    assertEquals(records.length, 1);
    assertEquals(records[0]?.id, "SEC-abc123");
    assertEquals(records[0]?.valid, true);
    assertStringIncludes(records[0]?.reason ?? "", "why why");
    assert(
      took < BUDGET_MS,
      `took ${took.toFixed(0)}ms, budget ${BUDGET_MS}ms`,
    );
  } finally {
    _resetSuppressionAuthorAllowlist();
    _resetSuppressionCommitAuthors();
    resetSuppressionRegistry();
  }
});

Deno.test("findSuppressions - block marker id must not run into adjacent word characters", () => {
  resetSuppressionRegistry();
  // `SEC-abc123XYZ` is not a well-formed id: the parser must not silently
  // truncate it to `SEC-abc123` and treat the remainder as a reason.
  const records = findSuppressions(
    "/* security-scan-ignore: SEC-abc123XYZ — author=nigel expires=2099-12-31 x */",
    "ts",
  );
  assertEquals(records.length, 0);
});

// ---------------------------------------------------------------------------
// (b) redactSecrets
// ---------------------------------------------------------------------------

Deno.test("redactSecrets - long alphanumeric run does not stall", () => {
  const text = "a".repeat(200_000);
  let out = "";
  const took = elapsedMs(() => {
    out = redactSecrets(text);
  });
  assertEquals(out, text, "no secret present, so the text is unchanged");
  assert(took < BUDGET_MS, `took ${took.toFixed(0)}ms, budget ${BUDGET_MS}ms`);
});

Deno.test("redactSecrets - long hyphen run does not stall", () => {
  const text = "-".repeat(200_000);
  let out = "";
  const took = elapsedMs(() => {
    out = redactSecrets(text);
  });
  assertEquals(out, text);
  assert(took < BUDGET_MS, `took ${took.toFixed(0)}ms, budget ${BUDGET_MS}ms`);
});

Deno.test("redactSecrets - long scheme-like run before a credential URL does not stall", () => {
  const text = `${"a".repeat(100_000)} https://alice:s3cr3t@db.example.com/app`;
  let out = "";
  const took = elapsedMs(() => {
    out = redactSecrets(text);
  });
  assert(!out.includes("s3cr3t"), "the URL password is still masked");
  assertStringIncludes(out, "https://alice:***REDACTED***@db.example.com/app");
  assert(took < BUDGET_MS, `took ${took.toFixed(0)}ms, budget ${BUDGET_MS}ms`);
});

Deno.test("redactSecrets - redacts a secret at the very end of a large input", () => {
  // The redact-before-truncate standard (SECURITY.md) means redaction must
  // cover the whole input: capping the scan would silently un-redact the tail.
  const text = `${
    "filler line\n".repeat(20_000)
  }--imgbb-api-key 0123abcd4567ef89`;
  const out = redactSecrets(text);
  assert(!out.includes("0123abcd4567ef89"), "trailing secret must be masked");
  assertStringIncludes(out, "--imgbb-api-key ***REDACTED***");
});

// ---------------------------------------------------------------------------
// Manifest scan caps (defence in depth)
// ---------------------------------------------------------------------------

Deno.test("capManifestText - drops a line longer than the per-line cap, keeping numbering", () => {
  const long = "x".repeat(MAX_MANIFEST_SCAN_LINE_CHARS + 1);
  const capped = capManifestText(`first\n${long}\nthird`);
  assertEquals(capped, "first\n\nthird");
});

Deno.test("capManifestText - keeps a line exactly at the per-line cap", () => {
  const atCap = "x".repeat(MAX_MANIFEST_SCAN_LINE_CHARS);
  assertEquals(capManifestText(atCap), atCap);
});

Deno.test("capManifestText - truncates text beyond the whole-file cap", () => {
  const capped = capManifestText("a\n".repeat(MAX_MANIFEST_SCAN_CHARS));
  assert(
    capped.length <= MAX_MANIFEST_SCAN_CHARS,
    `capped length ${capped.length} exceeds ${MAX_MANIFEST_SCAN_CHARS}`,
  );
});

Deno.test("capManifestText - leaves ordinary manifest text untouched", () => {
  const text = '{\n  // orphan-deps-ignore: BP-a — reason\n  "a": 1\n}';
  assertEquals(capManifestText(text), text);
});
