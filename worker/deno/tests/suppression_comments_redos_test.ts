/**
 * Regression tests for Issue #3942 — the block-comment suppression patterns
 * backtracked cubically on attacker-supplied text.
 *
 * `blockGeneric` nested three ambiguous whitespace quantifiers (`\s*` in the
 * separator, the lazy `(.*?)` reason, and the `\s*` before `*\/`). With the
 * opening `/*` and a finding id present but no closing `*\/`, every split of
 * the whitespace tail was tried: 4,000 trailing spaces took ~17 s on the
 * reference machine, and ~40 KB extrapolated to hours. `orphan_deps_*` feeds
 * every line of `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`,
 * `deno.lock` and `Cargo.lock` through this parser as a block-comment
 * language, so a fork PR adding one long line was enough to stall the
 * single-threaded worker.
 *
 * The guard is behavioural rather than a timing budget: each hostile shape is
 * fed to the real parser and the returned records are asserted. A super-linear
 * pattern on inputs this size never returns, so the test runner's own timeout
 * fails the case — on every machine, under every load — while a wall-clock
 * budget would only be flaky. The remaining tests cover the per-line cap and
 * that every marker form still parses exactly as before.
 *
 * Australian English spelling used throughout (behaviour, authorised).
 */

import { assertEquals } from "@std/assert";
import {
  _resetSuppressionAuthorAllowlist,
  _resetSuppressionCommitAuthors,
  findSuppressions,
  MAX_SUPPRESSION_LINE_CHARS,
  setSuppressionAuthorAllowlist,
  setSuppressionCommitAuthors,
} from "../lib/suppression_comments.ts";

Deno.test("findSuppressions - unterminated block comment with a long whitespace tail yields no records (Issue #3942)", () => {
  const hostile = "/* orphan-deps-ignore: BP-a" + " ".repeat(200_000);
  assertEquals(findSuppressions(hostile, "ts"), []);
});

Deno.test("findSuppressions - unterminated security-scan block comment yields no records (Issue #3942)", () => {
  const hostile = "/* security-scan-ignore: SEC-abc123 " + "\t".repeat(200_000);
  assertEquals(findSuppressions(hostile, "ts"), []);
});

Deno.test("findSuppressions - a long finding id followed by a whitespace tail yields no records (Issue #3942)", () => {
  // The id charsets are greedy too: without a length bound, backtracking the
  // id multiplied the cost of every reason-body scan.
  const hostile = "/* orphan-deps-ignore: BP-" + "a-".repeat(50_000) +
    " ".repeat(50_000);
  assertEquals(findSuppressions(hostile, "ts"), []);
});

Deno.test("findSuppressions - a whole hostile lockfile of long lines yields no records (Issue #3942)", () => {
  // The reachable path: nine manifests, every line fed to the parser.
  const line = "/* orphan-deps-ignore: BP-a" + " ".repeat(5_000);
  const hostile = Array.from({ length: 200 }, () => line).join("\n");
  assertEquals(findSuppressions(hostile, "ts"), []);
});

Deno.test("findSuppressions - a line longer than MAX_SUPPRESSION_LINE_CHARS is skipped whole (Issue #3942)", () => {
  _resetSuppressionAuthorAllowlist();
  _resetSuppressionCommitAuthors();
  setSuppressionAuthorAllowlist(["nigel"]);
  setSuppressionCommitAuthors(["nigel"]);
  try {
    const marker =
      "/* orphan-deps-ignore: BP-aaaaaaaaaaaa — author=nigel expires=2099-12-31 finished lib */";

    // Inside the cap the marker is honoured, whatever pads it.
    const withinCap = " ".repeat(MAX_SUPPRESSION_LINE_CHARS - marker.length) +
      marker;
    const found = findSuppressions(withinCap, "ts");
    assertEquals(found.length, 1);
    assertEquals(found[0]?.id, "BP-aaaaaaaaaaaa");
    assertEquals(found[0]?.valid, true);

    // Over the cap the whole line is skipped — the marker's position on it
    // makes no difference, because the line is never handed to a pattern.
    const padding = " ".repeat(MAX_SUPPRESSION_LINE_CHARS);
    assertEquals(findSuppressions(marker + padding, "ts"), []);
    assertEquals(findSuppressions(padding + marker, "ts"), []);
  } finally {
    _resetSuppressionAuthorAllowlist();
    _resetSuppressionCommitAuthors();
  }
});

Deno.test("findSuppressions - block-comment marker forms are unchanged by the rewrite (Issue #3942)", () => {
  const cases: { source: string; id: string; reason: string }[] = [
    {
      source: "/* security-scan-ignore: SEC-bb11cc — see ticket 42 */",
      id: "SEC-bb11cc",
      reason: "see ticket 42",
    },
    {
      source: "/* security-scan-ignore: SEC-bb11cc -- double hyphen */",
      id: "SEC-bb11cc",
      reason: "double hyphen",
    },
    {
      source: "/* security-scan-ignore: SEC-bb11cc - single hyphen */",
      id: "SEC-bb11cc",
      reason: "single hyphen",
    },
    {
      source: "/* security-scan-ignore: SEC-bb11cc whitespace only */",
      id: "SEC-bb11cc",
      reason: "whitespace only",
    },
    {
      source: "/* security-scan-ignore: SEC-bb11cc—no spaces */",
      id: "SEC-bb11cc",
      reason: "no spaces",
    },
    {
      source: "/* security-scan-ignore: SEC-bb11cc */",
      id: "SEC-bb11cc",
      reason: "",
    },
    {
      source: "/*security-scan-ignore:SEC-bb11cc*/",
      id: "SEC-bb11cc",
      reason: "",
    },
    {
      source: "/* orphan-deps-ignore: BP-SHA-PIN-actions-checkout — pinned */",
      id: "BP-SHA-PIN-actions-checkout",
      reason: "pinned",
    },
    {
      source: "/* best-practice-ignore: BP-abc123 — reason with * star */",
      id: "BP-abc123",
      reason: "reason with * star",
    },
    {
      source: "code(); /* security-scan-ignore: SEC-99ff00 — trailing */ more",
      id: "SEC-99ff00",
      reason: "trailing",
    },
  ];

  for (const { source, id, reason } of cases) {
    const result = findSuppressions(source, "ts");
    assertEquals(result.length, 1, `expected one record for ${source}`);
    assertEquals(result[0]?.id, id, `id for ${source}`);
    assertEquals(result[0]?.reason, reason, `reason for ${source}`);
  }
});

Deno.test("findSuppressions - an unterminated block comment never matches (Issue #3942)", () => {
  // Closing `*\/` is mandatory: without it there is no block comment, so the
  // text is not a marker no matter how it is padded.
  assertEquals(
    findSuppressions("/* security-scan-ignore: SEC-bb11cc — no close", "ts"),
    [],
  );
});
