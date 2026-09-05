/**
 * Regression tests for SEC-82bf6e57e20d (Issue #3942) — two uncapped
 * super-linear regexes that stalled the single-threaded worker.
 *
 * (a) `suppression_comments.ts` `blockGeneric` backtracked cubically on an
 *     unterminated `/* … ` comment with a long whitespace tail, and the
 *     orphan-deps manifest scan fed it every line of an uncapped lockfile.
 * (b) `secret_redaction.ts` `url-userinfo` and `secret-cli-flag` backtracked
 *     quadratically on a long alphanumeric / hyphen run, and `redactSecrets`
 *     is applied to whole, uncapped model stdout.
 *
 * The guards here are behavioural, not benchmarks: the adversarial input is
 * scanned and the output asserted, so a pattern cannot be "fixed" by matching
 * nothing. No wall-clock reading is taken or compared — a super-linear pattern
 * on inputs this size never returns, so the test runner's own timeout fails
 * the case on every machine under every load, whereas a timing budget would
 * only be flaky across machines and loads.
 *
 * Australian English spelling used throughout.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  _resetSuppressionAuthorAllowlist,
  _resetSuppressionCommitAuthors,
  findSuppressions,
  MAX_SUPPRESSION_LINE_CHARS,
  resetSuppressionRegistry,
  setSuppressionAuthorAllowlist,
  setSuppressionCommitAuthors,
} from "../lib/suppression_comments.ts";
import {
  collectInSourceSuppressedIds,
  MAX_MANIFEST_SCAN_CHARS,
} from "../lib/orphan_deps_suppression_scan.ts";
import {
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";

// ---------------------------------------------------------------------------
// (a) Suppression block-comment parsing
// ---------------------------------------------------------------------------

Deno.test("SEC-82bf6e57e20d - unterminated block comments yield no suppressions", () => {
  // Each line is an opening marker with no closing `*/` and a long whitespace
  // tail — the cubic trigger. Every line sits under the per-line cap, so this
  // measures the pattern itself rather than the cap. Unfixed: ~3.5 s for one
  // 2,000-char line, so ~6 minutes for 100 of them.
  const line = "/* orphan-deps-ignore: BP-a" +
    " ".repeat(MAX_SUPPRESSION_LINE_CHARS - 100);
  const source = Array.from({ length: 100 }, () => line).join("\n");

  assertEquals(findSuppressions(source, "ts"), []);
});

Deno.test("SEC-82bf6e57e20d - a line longer than the cap is skipped, not parsed", () => {
  _resetSuppressionAuthorAllowlist();
  _resetSuppressionCommitAuthors();
  setSuppressionAuthorAllowlist(["nigel"]);
  setSuppressionCommitAuthors(["nigel"]);
  try {
    const marker =
      "/* security-scan-ignore: SEC-aabbcc — author=nigel expires=2099-12-31 known */";
    const padded = " ".repeat(MAX_SUPPRESSION_LINE_CHARS) + marker;

    assertEquals(
      findSuppressions(padded, "ts"),
      [],
      "an over-long line must contribute no suppression",
    );

    // The same marker on a line inside the cap still parses and still governs.
    const withinCap = " ".repeat(10) + marker;
    const records = findSuppressions(withinCap, "ts");
    assertEquals(records.length, 1);
    assertEquals(records[0]?.id, "SEC-aabbcc");
    assertEquals(records[0]?.valid, true);
  } finally {
    _resetSuppressionAuthorAllowlist();
    _resetSuppressionCommitAuthors();
  }
});

Deno.test("SEC-82bf6e57e20d - block-comment reasons still parse unchanged", () => {
  const cases: [string, string, string][] = [
    [
      "/* security-scan-ignore: SEC-bb11cc — see ticket 42 */",
      "SEC-bb11cc",
      "see ticket 42",
    ],
    ["/* security-scan-ignore: SEC-bb11cc */", "SEC-bb11cc", ""],
    ["/*security-scan-ignore:SEC-bb11cc*/", "SEC-bb11cc", ""],
    [
      "/* security-scan-ignore: SEC-bb11cc -- dashed reason */",
      "SEC-bb11cc",
      "dashed reason",
    ],
    [
      "/* security-scan-ignore: SEC-bb11cc plain reason */",
      "SEC-bb11cc",
      "plain reason",
    ],
    [
      "/* security-scan-ignore: SEC-bb11cc — a * star inside */",
      "SEC-bb11cc",
      "a * star inside",
    ],
    [
      "/* security-scan-ignore: SEC-bb11cc — padded    */",
      "SEC-bb11cc",
      "padded",
    ],
    [
      "code(); /* orphan-deps-ignore: BP-SHA-PIN-actions — why */ more",
      "BP-SHA-PIN-actions",
      "why",
    ],
  ];

  for (const [source, id, reason] of cases) {
    const records = findSuppressions(source, "ts");
    assertEquals(records.length, 1, source);
    assertEquals(records[0]?.id, id, source);
    assertEquals(records[0]?.reason, reason, source);
  }
});

Deno.test("SEC-82bf6e57e20d - the manifest scan caps oversized lockfiles", async () => {
  _resetSuppressionAuthorAllowlist();
  _resetSuppressionCommitAuthors();
  setSuppressionAuthorAllowlist(["nigel"]);
  setSuppressionCommitAuthors(["nigel"]);
  resetSuppressionRegistry();
  try {
    const marker = (id: string) =>
      `// orphan-deps-ignore: ${id} — author=nigel expires=2099-12-31 finished\n`;
    // A marker in the head is honoured; one pushed past the cap by megabytes
    // of filler is not scanned at all.
    const head = marker("BP-aaaaaaaaaaaa");
    const filler = "x".repeat(MAX_MANIFEST_SCAN_CHARS) + "\n";
    const text = head + filler + marker("BP-bbbbbbbbbbbb");

    // A commentable manifest: a lockfile is never opened at all (#3947).
    const read = (path: string): Promise<string> =>
      path === "/repo/deno.json"
        ? Promise.resolve(text)
        : Promise.reject(new Error("ENOENT"));

    const ids = await collectInSourceSuppressedIds("/repo", {
      readTextFileFn: read,
      logFn: () => {},
    });
    assertEquals(ids, ["BP-aaaaaaaaaaaa"]);
  } finally {
    resetSuppressionRegistry();
    _resetSuppressionAuthorAllowlist();
    _resetSuppressionCommitAuthors();
  }
});

// ---------------------------------------------------------------------------
// (b) Secret redaction
// ---------------------------------------------------------------------------

Deno.test("SEC-82bf6e57e20d - redactSecrets leaves a long alphanumeric run unchanged", () => {
  // The prompt-injection payload from the finding: ~200 KB of `a`. Unfixed,
  // `url-userinfo` was quadratic and this call never came back.
  const text = "a".repeat(200_000);
  assertEquals(redactSecrets(text), text, "no secret shape is present");
});

Deno.test("SEC-82bf6e57e20d - redactSecrets leaves a long hyphen run unchanged", () => {
  // The `secret-cli-flag` trigger: a run of hyphens. Unfixed, this call never
  // came back.
  const text = "-".repeat(200_000);
  assertEquals(redactSecrets(text), text);
});

Deno.test("SEC-82bf6e57e20d - redaction coverage is unchanged by the fix", () => {
  const token = "ghp_" + "c".repeat(36);
  const cases: [string, string][] = [
    [`fatal: https://x-access-token:${token}@github.com/org/repo.git`, token],
    [
      "connecting to https://alice:s3cr3tPassw0rd@db.example.com/app",
      "s3cr3tPassw0rd",
    ],
    ["clone git+ssh://deploy:s3cr3t-ssh-pass@host/x", "s3cr3t-ssh-pass"],
    ["1.2.3-https://u:s3cr3t-after-a-version@h/", "s3cr3t-after-a-version"],
    [
      "pr-manager --imgbb-api-key 0123456789abcdef0123 --repo o/r",
      "0123456789abcdef0123",
    ],
    ['cmd --api-token "s3cret-value-here"', "s3cret-value-here"],
  ];
  for (const [line, secret] of cases) {
    const out = redactSecrets(line);
    assertEquals(out.includes(secret), false, line);
    assertStringIncludes(out, REDACTION_PLACEHOLDER);
  }

  // Non-secret text is still left byte-for-byte alone.
  const benign = "deno test --allow-read --filter foo --repo owner/name";
  assertEquals(redactSecrets(benign), benign);
});
