/**
 * Regression tests for the uncapped manifest reads that fed the cubic
 * suppression parser (Issue #3942).
 *
 * `collectInSourceSuppressedIds` reads nine manifests — including
 * `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `deno.lock` and
 * `Cargo.lock` — with no size or line-length cap, and scans every line as a
 * block-comment language. A fork PR adding one very long line to a lockfile
 * was enough to stall the single-threaded worker for hours.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  collectInSourceSuppressedIds,
  MAX_MANIFEST_SCAN_CHARS,
} from "../lib/orphan_deps_suppression_scan.ts";
import {
  _resetSuppressionAuthorAllowlist,
  resetSuppressionRegistry,
  setSuppressionAuthorAllowlist,
} from "../lib/suppression_comments.ts";

const MARKER =
  "// orphan-deps-ignore: BP-aaaaaaaaaaaa — author=nigel expires=2099-12-31 " +
  "dependency removed";

/** Stub reader serving `files`; anything else rejects like a missing file. */
function reader(files: Record<string, string>) {
  return (path: string): Promise<string> => {
    const text = files[path];
    if (text === undefined) return Promise.reject(new Error("ENOENT"));
    return Promise.resolve(text);
  };
}

async function withAllowlist<T>(fn: () => Promise<T>): Promise<T> {
  _resetSuppressionAuthorAllowlist();
  resetSuppressionRegistry();
  setSuppressionAuthorAllowlist(["nigel"]);
  try {
    return await fn();
  } finally {
    _resetSuppressionAuthorAllowlist();
    resetSuppressionRegistry();
  }
}

Deno.test("collectInSourceSuppressedIds - a hostile lockfile line does not stall the scan", async () => {
  await withAllowlist(async () => {
    // Issue #3942's measured payload: 8x this input took 278x the time.
    const hostile = "/* orphan-deps-ignore: BP-a" + " ".repeat(4000);
    const read = reader({
      "/repo/deno.lock": hostile,
      "/repo/deno.jsonc": `{\n  ${MARKER}\n}`,
    });

    const started = performance.now();
    const ids = await collectInSourceSuppressedIds("/repo", {
      readTextFileFn: read,
    });
    const elapsed = performance.now() - started;

    assertEquals(ids, ["BP-aaaaaaaaaaaa"], "the genuine marker still resolves");
    assert(
      elapsed < 1000,
      `scan took ${elapsed.toFixed(0)} ms — still super-linear`,
    );
  });
});

Deno.test("collectInSourceSuppressedIds - text beyond the size cap is dropped, loudly", async () => {
  await withAllowlist(async () => {
    // A marker past the total cap is never parsed; one before it survives.
    const oversized = `${MARKER}\n` +
      "y\n".repeat(MAX_MANIFEST_SCAN_CHARS) +
      "// orphan-deps-ignore: BP-pastthecap — author=nigel expires=2099-12-31 x";
    const read = reader({ "/repo/deno.json": oversized });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const ids = await collectInSourceSuppressedIds("/repo", {
        readTextFileFn: read,
      });
      assertEquals(
        ids,
        ["BP-aaaaaaaaaaaa"],
        "only markers inside the cap contribute ids",
      );
    } finally {
      console.warn = originalWarn;
    }

    assertEquals(warnings.length, 1, "the drop must be reported, not silent");
    assert(
      warnings[0]?.includes("deno.json"),
      `warning did not name the manifest: ${warnings[0]}`,
    );
  });
});

Deno.test("collectInSourceSuppressedIds - a manifest inside the size cap is scanned", async () => {
  await withAllowlist(async () => {
    const sized = `${MARKER}\n` + "y".repeat(1000);
    const read = reader({ "/repo/deno.jsonc": sized });
    const ids = await collectInSourceSuppressedIds("/repo", {
      readTextFileFn: read,
    });
    assertEquals(ids, ["BP-aaaaaaaaaaaa"]);
  });
});
