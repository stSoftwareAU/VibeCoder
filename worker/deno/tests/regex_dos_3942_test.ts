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
 * The guard is behavioural, not a benchmark: each adversarial input is fed to
 * the real scanner and its output asserted. A super-linear pattern does not
 * merely run slowly on inputs this size — it never returns, so the test
 * runner's own timeout fails the case on every machine under every load. No
 * wall-clock budget is measured or asserted, because timing readings differ
 * wildly between machines and loads.
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

// ---------------------------------------------------------------------------
// (a) suppression block-comment patterns
// ---------------------------------------------------------------------------

Deno.test("findSuppressions - unterminated block marker with a long whitespace tail is not a hit", () => {
  resetSuppressionRegistry();
  // 40 kB of trailing whitespace with no closing `*/` — the cubic case.
  const line = `/* orphan-deps-ignore: BP-aaaaaaaaaaaa${" ".repeat(40_000)}`;
  const records = findSuppressions(line, "ts");
  assertEquals(records.length, 0, "an unterminated block marker is not a hit");
});

Deno.test("findSuppressions - unterminated SEC block marker with a long tail is not a hit", () => {
  resetSuppressionRegistry();
  const line = `/* security-scan-ignore: SEC-abc123${" ".repeat(40_000)}`;
  const records = findSuppressions(line, "ts");
  assertEquals(records.length, 0);
});

Deno.test("findSuppressions - terminated block marker with a long reason parses whole", () => {
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
    const records = findSuppressions(line, "ts");
    assertEquals(records.length, 1);
    assertEquals(records[0]?.id, "SEC-abc123");
    assertEquals(records[0]?.valid, true);
    assertStringIncludes(records[0]?.reason ?? "", "why why");
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

Deno.test("redactSecrets - long alphanumeric run passes through unchanged", () => {
  const text = "a".repeat(200_000);
  const out = redactSecrets(text);
  assertEquals(out, text, "no secret present, so the text is unchanged");
});

Deno.test("redactSecrets - long hyphen run passes through unchanged", () => {
  const text = "-".repeat(200_000);
  const out = redactSecrets(text);
  assertEquals(out, text);
});

Deno.test("redactSecrets - masks a credential URL after a long scheme-like run", () => {
  const text = `${"a".repeat(100_000)} https://alice:s3cr3t@db.example.com/app`;
  const out = redactSecrets(text);
  assert(!out.includes("s3cr3t"), "the URL password is still masked");
  assertStringIncludes(out, "https://alice:***REDACTED***@db.example.com/app");
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
