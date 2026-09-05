/**
 * Regression tests for the two super-linear regexes that could stall the
 * single-threaded worker (Issue #3942).
 *
 * Both regexes ran synchronously on the main thread against
 * attacker-influenced text, so a catastrophic-backtracking match froze the
 * whole Deno event loop — timers, heartbeats and the Claude timeout could not
 * fire because they were queued behind the regex.
 *
 *  (a) `suppression_comments.ts` block-comment markers backtracked cubically
 *      when the opening `/*` and the finding id were present but the closing
 *      marker was absent. Reachable from any lockfile line, because the
 *      orphan-deps scan applies the `ts` (block-comment) language to every
 *      line of every manifest it reads.
 *  (b) `secret_redaction.ts` `url-userinfo` and `secret-cli-flag` backtracked
 *      quadratically over a long alphanumeric (respectively hyphen) run,
 *      reachable from uncapped model output via `publishableSnippet`.
 *
 * The guard is behavioural, not a stopwatch (PR #1170). Every case below
 * feeds the adversarial input and asserts what the parser or the redactor
 * *produces*. That is the whole detector: catastrophic backtracking on these
 * inputs does not cost a little more than a budget, it never returns — the
 * unfixed code needed tens of seconds on inputs the fixed code answers in
 * single-digit milliseconds, and a regression would hang the case until the
 * runner kills it. An elapsed-time comparison against a constant would add
 * nothing to that and would go red on any loaded machine, which is what a
 * wall-clock budget did here on the fleet.
 *
 * Australian English spelling used throughout (behaviour, authorised).
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
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";
import {
  collectInSourceSuppressedIds,
  MAX_MANIFEST_SCAN_CHARS,
} from "../lib/orphan_deps_suppression_scan.ts";

// ---------------------------------------------------------------------------
// (a) Suppression block-comment parser
// ---------------------------------------------------------------------------

Deno.test("findSuppressions - unclosed block marker does not backtrack", () => {
  // `/*` + keyword + id present, closing `*/` absent, long whitespace tail.
  const line = "/* orphan-deps-ignore: BP-a" + " ".repeat(20_000);
  assertEquals(findSuppressions(line, "ts"), []);
});

Deno.test("findSuppressions - unclosed SEC block marker does not backtrack", () => {
  const line = "/* security-scan-ignore: SEC-abc" + "\t".repeat(20_000);
  assertEquals(findSuppressions(line, "ts"), []);
});

Deno.test("findSuppressions - 400 unclosed markers are all rejected", () => {
  const source = Array.from(
    { length: 400 },
    () => "/* orphan-deps-ignore: BP-a" + " ".repeat(200),
  ).join("\n");
  assertEquals(findSuppressions(source, "ts"), []);
});

Deno.test("findSuppressions - lines longer than the scan cap are bounded", () => {
  // A marker pushed past the per-line cap is not honoured: missing a
  // suppression leaves the finding visible, which is the fail-safe direction.
  const padding = "x".repeat(MAX_SUPPRESSION_LINE_CHARS + 10);
  const line =
    `${padding} /* orphan-deps-ignore: BP-abcdef — author=alice expires=2999-01-01 stale */`;
  assertEquals(findSuppressions(line, "ts"), []);

  // The same marker inside the cap is still recognised.
  const short =
    "/* orphan-deps-ignore: BP-abcdef — author=alice expires=2999-01-01 stale */";
  assertEquals(findSuppressions(short, "ts").length, 1);
});

Deno.test("collectInSourceSuppressedIds - oversized manifest is capped", async () => {
  const marker =
    "// orphan-deps-ignore: BP-beyondcap — author=alice expires=2999-01-01 stale\n";
  const filler = "// filler line\n".repeat(
    Math.ceil(MAX_MANIFEST_SCAN_CHARS / 15) + 100,
  );
  // Commentable manifests: a lockfile or strict JSON is never opened (#3947).
  const files: Record<string, string> = {
    "/repo/deno.json": filler + marker,
    "/repo/deno.jsonc":
      "// orphan-deps-ignore: BP-withincap — author=alice expires=2999-01-01 stale\n{}",
  };
  const read = (path: string): Promise<string> => {
    const text = files[path];
    if (text === undefined) return Promise.reject(new Error("ENOENT"));
    return Promise.resolve(text);
  };

  // Only a governed marker reaches the id list (Issue #3941).
  _resetSuppressionAuthorAllowlist();
  _resetSuppressionCommitAuthors();
  setSuppressionAuthorAllowlist(["alice"]);
  setSuppressionCommitAuthors(["alice"]);
  resetSuppressionRegistry();
  try {
    const ids = await collectInSourceSuppressedIds("/repo", {
      readTextFileFn: read,
      logFn: () => {},
    });
    assertEquals(ids, ["BP-withincap"]);
  } finally {
    _resetSuppressionAuthorAllowlist();
    _resetSuppressionCommitAuthors();
    resetSuppressionRegistry();
  }
});

Deno.test("collectInSourceSuppressedIds - pathological lockfile line is bounded", async () => {
  const hostile = "/* orphan-deps-ignore: BP-a" + " ".repeat(60_000);
  const read = (path: string): Promise<string> =>
    path.endsWith("/deno.lock")
      ? Promise.resolve(hostile)
      : Promise.reject(new Error("ENOENT"));

  assertEquals(
    await collectInSourceSuppressedIds("/repo", { readTextFileFn: read }),
    [],
  );
});

// ---------------------------------------------------------------------------
// (b) redactSecrets
// ---------------------------------------------------------------------------

Deno.test("redactSecrets - long alphanumeric run does not backtrack", () => {
  const text = "a".repeat(500_000);
  assertEquals(redactSecrets(text), text);
});

Deno.test("redactSecrets - long hyphen run does not backtrack", () => {
  const text = "-".repeat(200_000);
  assertEquals(redactSecrets(text), text);
});

Deno.test("redactSecrets - mixed scheme-like run does not backtrack", () => {
  // Alphanumerics interleaved with the scheme charset (`+`, `.`, `-`), each of
  // which is a candidate start position for the url-userinfo rule.
  const text = "a.b+c-d".repeat(30_000);
  assertEquals(redactSecrets(text), text);
});

Deno.test("redactSecrets - long base64 block does not backtrack", () => {
  const text = ("A".repeat(64) + "\n").repeat(4_000);
  assertStringIncludes(redactSecrets(text), REDACTION_PLACEHOLDER);
});

Deno.test("redactSecrets - still masks a secret buried in a long run", () => {
  // The cost fix must not create a redaction hole: a secret at the far end of
  // a large payload is still masked (SECURITY.md "redact before you truncate").
  const noise = "a".repeat(400_000);
  const out = redactSecrets(
    `${noise} https://user:hunter2@example.com/repo.git ${noise}`,
  );
  assertEquals(out.includes("hunter2"), false);
  assertStringIncludes(out, `https://user:${REDACTION_PLACEHOLDER}@`);
});
