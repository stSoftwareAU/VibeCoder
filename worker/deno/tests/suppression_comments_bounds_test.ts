/**
 * Regression tests for the super-linear block-comment suppression parser
 * (Issue #3942).
 *
 * `blockGeneric` used three nested ambiguous whitespace quantifiers — a
 * `\s+`/`\s*…\s*` separator, a lazy `(.*?)` reason, then `\s*` before the
 * closing `*\/`. With the opening `/*` and an id present but no closing
 * `*\/`, every split of the whitespace tail was tried: O(n³). Because the
 * scan runs synchronously on the worker's only thread, one long line in a
 * lockfile stalled the whole fleet host.
 *
 * The fix is twofold: the block pattern's alternatives are now mutually
 * exclusive (a single separator character, then an unrolled non-ambiguous
 * body that must terminate at `*\/`), and `findSuppressions` skips lines
 * longer than {@link MAX_SUPPRESSION_LINE_CHARS}.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  _resetSuppressionAuthorAllowlist,
  _resetSuppressionCommitAuthors,
  findSuppressions,
  MAX_SUPPRESSION_LINE_CHARS,
  resetSuppressionRegistry,
  setSuppressionAuthorAllowlist,
  setSuppressionCommitAuthors,
} from "../lib/suppression_comments.ts";

/** A governed marker trailer every parsed record needs to be `valid`. */
const TRAILER = "author=nigel expires=2099-12-31 finished with it";

function withAllowlist<T>(fn: () => T): T {
  _resetSuppressionAuthorAllowlist();
  _resetSuppressionCommitAuthors();
  resetSuppressionRegistry();
  setSuppressionAuthorAllowlist(["nigel"]);
  setSuppressionCommitAuthors(["nigel"]);
  try {
    return fn();
  } finally {
    _resetSuppressionAuthorAllowlist();
    _resetSuppressionCommitAuthors();
    resetSuppressionRegistry();
  }
}

Deno.test("findSuppressions - unterminated block comment with a long whitespace tail returns promptly", () => {
  withAllowlist(() => {
    // The catastrophic input from Issue #3942: opening `/*`, a matching id,
    // then a long run of spaces and no closing `*/`. Pre-fix this took
    // ~10 s at 4,000 spaces and grew cubically.
    const line = "/* orphan-deps-ignore: BP-a" + " ".repeat(4000);
    const started = performance.now();
    const records = findSuppressions(line, "ts");
    const elapsed = performance.now() - started;

    assertEquals(records, [], "an unterminated block comment is not a marker");
    assert(
      elapsed < 1000,
      `unterminated block comment took ${elapsed.toFixed(0)} ms — the ` +
        "block pattern is still super-linear",
    );
  });
});

Deno.test("findSuppressions - unterminated security-scan block comment returns promptly", () => {
  withAllowlist(() => {
    const line = "/* security-scan-ignore: SEC-abc" + " \t".repeat(3000);
    const started = performance.now();
    const records = findSuppressions(line, "ts");
    const elapsed = performance.now() - started;

    assertEquals(records, []);
    assert(
      elapsed < 1000,
      `unterminated block comment took ${elapsed.toFixed(0)} ms`,
    );
  });
});

Deno.test("findSuppressions - block markers still parse across every separator form", () => {
  withAllowlist(() => {
    const cases: [string, string][] = [
      [`/* security-scan-ignore: SEC-abc123 — ${TRAILER} */`, "SEC-abc123"],
      [`/* security-scan-ignore: SEC-abc123 -- ${TRAILER} */`, "SEC-abc123"],
      [`/* security-scan-ignore: SEC-abc123 - ${TRAILER} */`, "SEC-abc123"],
      [`/* security-scan-ignore: SEC-abc123 ${TRAILER} */`, "SEC-abc123"],
      [`/*security-scan-ignore:SEC-abc123 ${TRAILER}*/`, "SEC-abc123"],
      [`/* best-practice-ignore: BP-SHA-PIN-x — ${TRAILER} */`, "BP-SHA-PIN-x"],
      [`/* orphan-deps-ignore: BP-abc123 — ${TRAILER} */`, "BP-abc123"],
    ];
    for (const [line, expectedId] of cases) {
      const records = findSuppressions(line, "ts");
      assertEquals(records.length, 1, `no record parsed from: ${line}`);
      assertEquals(records[0]?.id, expectedId);
      assertEquals(records[0]?.author, "nigel");
      assertEquals(records[0]?.expiry, "2099-12-31");
      assertEquals(records[0]?.reason, "finished with it");
      assertEquals(records[0]?.valid, true, `rejected: ${line}`);
    }
  });
});

Deno.test("findSuppressions - reason text containing an asterisk still parses", () => {
  withAllowlist(() => {
    const line =
      `/* security-scan-ignore: SEC-abc123 — author=nigel expires=2099-12-31 glob a*b is fine */`;
    const records = findSuppressions(line, "ts");
    assertEquals(records.length, 1);
    assertEquals(records[0]?.reason, "glob a*b is fine");
  });
});

Deno.test("findSuppressions - an id immediately followed by a non-separator is not a marker", () => {
  withAllowlist(() => {
    // Pre-existing behaviour: the id must be delimited by a separator or the
    // closing `*/`, so trailing junk does not silently become the reason.
    const records = findSuppressions(
      "/* security-scan-ignore: SEC-abcZZZ */",
      "ts",
    );
    assertEquals(records, []);
  });
});

Deno.test("findSuppressions - lines longer than the cap are skipped entirely", () => {
  withAllowlist(() => {
    const marker =
      `/* security-scan-ignore: SEC-abc123 — ${TRAILER} */ // trailing`;
    const short = marker + "x".repeat(MAX_SUPPRESSION_LINE_CHARS - 200);
    assertEquals(
      findSuppressions(short, "ts").length,
      1,
      "a line inside the cap must still be scanned",
    );

    const long = marker + "x".repeat(MAX_SUPPRESSION_LINE_CHARS + 1);
    assertEquals(
      findSuppressions(long, "ts"),
      [],
      "a line beyond the cap must not be scanned",
    );
  });
});

Deno.test("findSuppressions - the line cap does not stop later lines being scanned", () => {
  withAllowlist(() => {
    const content = [
      "x".repeat(MAX_SUPPRESSION_LINE_CHARS + 1),
      `// security-scan-ignore: SEC-abc123 — ${TRAILER}`,
    ].join("\n");
    const records = findSuppressions(content, "ts");
    assertEquals(records.length, 1);
    assertEquals(records[0]?.line, 2);
  });
});
