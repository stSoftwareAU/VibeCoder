/**
 * Tests for the input caps on the orphan-deps suppression scan (Issue #3942).
 *
 * The scan reads nine dependency manifests from a cloned repository — a fork
 * PR controls every byte of them — and hands each line to the suppression
 * parser. It had no size bound at all, so a single generated lockfile line
 * became unbounded regex work on the worker's only thread. The caps below are
 * defence in depth alongside the now-linear patterns, mirroring
 * `security_fix_gate.ts`'s `MAX_SCAN_CHARS`.
 *
 * Dropping text fails safe: a suppression that is not collected leaves its
 * finding visible. Every drop is reported through `logFn` so the cap is never
 * silent.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  collectInSourceSuppressedIds,
  MAX_MANIFEST_SCAN_CHARS,
  MAX_MANIFEST_SCAN_LINE_CHARS,
} from "../lib/orphan_deps_suppression_scan.ts";
import {
  _resetSuppressionAuthorAllowlist,
  _resetSuppressionCommitAuthors,
  resetSuppressionRegistry,
  setSuppressionAuthorAllowlist,
  setSuppressionCommitAuthors,
} from "../lib/suppression_comments.ts";

const TRAILER = "author=nigel expires=2099-12-31 vendored on purpose";

/** Reader stub: serves `files` and rejects anything else, like ENOENT. */
function reader(
  files: Record<string, string>,
): (path: string) => Promise<string> {
  return (path: string) => {
    const text = files[path];
    if (text === undefined) return Promise.reject(new Error("ENOENT"));
    return Promise.resolve(text);
  };
}

async function withAllowlist(fn: () => Promise<void>): Promise<void> {
  _resetSuppressionAuthorAllowlist();
  _resetSuppressionCommitAuthors();
  setSuppressionAuthorAllowlist(["nigel"]);
  setSuppressionCommitAuthors(["nigel"]);
  resetSuppressionRegistry();
  try {
    await fn();
  } finally {
    _resetSuppressionAuthorAllowlist();
    _resetSuppressionCommitAuthors();
    resetSuppressionRegistry();
  }
}

Deno.test("collectInSourceSuppressedIds - skips a line longer than the per-line cap", async () => {
  await withAllowlist(async () => {
    const messages: string[] = [];
    const longMarker = `// orphan-deps-ignore: BP-aaaaaaaaaaaa — ${TRAILER}` +
      " ".repeat(MAX_MANIFEST_SCAN_LINE_CHARS);
    const ids = await collectInSourceSuppressedIds("/repo", {
      readTextFileFn: reader({
        "/repo/deno.json":
          `${longMarker}\n// orphan-deps-ignore: BP-bbbbbbbbbbbb — ${TRAILER}`,
      }),
      logFn: (m) => messages.push(m),
    });
    // The over-long line is dropped; the ordinary marker beside it survives.
    assertEquals(ids, ["BP-bbbbbbbbbbbb"]);
    assert(
      messages.some((m) => m.includes("deno.json") && m.includes("line")),
      `no drop notice logged: ${JSON.stringify(messages)}`,
    );
  });
});

Deno.test("collectInSourceSuppressedIds - truncates a manifest larger than the total cap", async () => {
  await withAllowlist(async () => {
    const messages: string[] = [];
    const filler = "x\n".repeat(MAX_MANIFEST_SCAN_CHARS);
    const ids = await collectInSourceSuppressedIds("/repo", {
      readTextFileFn: reader({
        // A commentable manifest: a lockfile is never opened at all (#3947).
        "/repo/deno.json":
          `// orphan-deps-ignore: BP-aaaaaaaaaaaa — ${TRAILER}\n${filler}` +
          `// orphan-deps-ignore: BP-cccccccccccc — ${TRAILER}\n`,
      }),
      logFn: (m) => messages.push(m),
    });
    // Markers before the cap are honoured; the tail past it is dropped.
    assertEquals(ids, ["BP-aaaaaaaaaaaa"]);
    assert(
      messages.some((m) => m.includes("deno.json") && m.includes("truncated")),
      `no truncation notice logged: ${JSON.stringify(messages)}`,
    );
  });
});

Deno.test("collectInSourceSuppressedIds - an adversarial lockfile line does not stall the scan", async () => {
  await withAllowlist(async () => {
    // The exploit shape from the finding: one unclosed block comment with a
    // very long whitespace tail, in a manifest a fork PR controls.
    const line = "/* orphan-deps-ignore: BP-a" + " ".repeat(200_000);
    const started = performance.now();
    const ids = await collectInSourceSuppressedIds("/repo", {
      readTextFileFn: reader({ "/repo/deno.json": line }),
      logFn: () => {},
    });
    const elapsed = performance.now() - started;
    assertEquals(ids, []);
    assert(elapsed < 5_000, `scan took ${elapsed.toFixed(0)} ms`);
  });
});

Deno.test("collectInSourceSuppressedIds - ordinary manifests are unaffected by the caps", async () => {
  await withAllowlist(async () => {
    const messages: string[] = [];
    const ids = await collectInSourceSuppressedIds("/repo", {
      readTextFileFn: reader({
        "/repo/deno.jsonc":
          `{\n  // orphan-deps-ignore: BP-aaaaaaaaaaaa — ${TRAILER}\n}`,
        "/repo/Cargo.toml":
          `# best-practice-ignore: BP-bbbbbbbbbbbb — ${TRAILER}\n`,
      }),
      logFn: (m) => messages.push(m),
    });
    assertEquals(ids.sort(), ["BP-aaaaaaaaaaaa", "BP-bbbbbbbbbbbb"]);
    assertEquals(messages, []);
  });
});
