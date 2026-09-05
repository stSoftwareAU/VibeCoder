/**
 * Input-cap tests for the orphan-deps suppression scan (Issue #3942).
 *
 * The scan reads nine dependency manifests — including `package-lock.json`,
 * `yarn.lock`, `pnpm-lock.yaml`, `deno.lock` and `Cargo.lock` — with no size
 * bound, and feeds every line to the suppression parser. A fork PR adding one
 * very long line to a lockfile was enough to hold the worker's only thread.
 * The scan now caps the text it parses per manifest.
 *
 * The cap fails closed: a marker past the cut is simply not honoured, so the
 * finding it would have waived stays visible.
 *
 * Both cases assert on the ids the scan returns, not on how long it takes: a
 * pattern that backtracks catastrophically never returns at all, so the test
 * runner's own timeout is the regression signal.
 *
 * Australian English spelling used throughout.
 */

import { assertEquals } from "@std/assert";
import {
  collectInSourceSuppressedIds,
  MAX_MANIFEST_SCAN_CHARS,
} from "../lib/orphan_deps_suppression_scan.ts";
import {
  _resetSuppressionAuthorAllowlist,
  _resetSuppressionCommitAuthors,
  resetSuppressionRegistry,
  setSuppressionAuthorAllowlist,
  setSuppressionCommitAuthors,
} from "../lib/suppression_comments.ts";

const MARKER = (id: string) =>
  `// orphan-deps-ignore: ${id} — author=nigel expires=2099-12-31 vendored`;

function reader(files: Record<string, string>) {
  return (path: string): Promise<string> => {
    const text = files[path];
    if (text === undefined) return Promise.reject(new Error("ENOENT"));
    return Promise.resolve(text);
  };
}

Deno.test("collectInSourceSuppressedIds - honours markers inside the cap, drops those past it", async () => {
  _resetSuppressionAuthorAllowlist();
  _resetSuppressionCommitAuthors();
  resetSuppressionRegistry();
  setSuppressionAuthorAllowlist(["nigel"]);
  setSuppressionCommitAuthors(["nigel"]);
  try {
    const filler = "x".repeat(MAX_MANIFEST_SCAN_CHARS);
    const text = `${MARKER("BP-aaaaaaaaaaaa")}\n${filler}\n${
      MARKER("BP-bbbbbbbbbbbb")
    }\n`;
    const ids = await collectInSourceSuppressedIds("/repo", {
      readTextFileFn: reader({ "/repo/deno.json": text }),
    });
    assertEquals(ids, ["BP-aaaaaaaaaaaa"]);
  } finally {
    _resetSuppressionAuthorAllowlist();
    _resetSuppressionCommitAuthors();
    resetSuppressionRegistry();
  }
});

Deno.test("collectInSourceSuppressedIds - an adversarial lockfile line yields no suppression ids", async () => {
  _resetSuppressionAuthorAllowlist();
  _resetSuppressionCommitAuthors();
  resetSuppressionRegistry();
  setSuppressionAuthorAllowlist(["nigel"]);
  setSuppressionCommitAuthors(["nigel"]);
  try {
    // The exact shape from the finding: an unclosed block marker followed by
    // a long whitespace tail, repeated well past the cap.
    const hostile = ("/* orphan-deps-ignore: BP-a" + " ".repeat(40_000) + "\n")
      .repeat(20);
    const ids = await collectInSourceSuppressedIds("/repo", {
      readTextFileFn: reader({ "/repo/package-lock.json": hostile }),
    });
    assertEquals(ids, [], "the adversarial line waives nothing");
  } finally {
    _resetSuppressionAuthorAllowlist();
    _resetSuppressionCommitAuthors();
    resetSuppressionRegistry();
  }
});
