/**
 * Tests for the content-addressed quality-gate cache (Issue #86).
 *
 * The security-relevant property is that a cached PASS is reused **only** when
 * the input digest is byte-identical to the run that produced it — a false
 * skip is impossible, so a real failure can never be cached away.
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  cachedPassAt,
  computeQualityInputDigest,
  invalidate,
  recordPass,
} from "../lib/quality_gate_cache.ts";

async function tempTree(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "qgc_" });
  await Deno.mkdir(`${dir}/lib`, { recursive: true });
  await Deno.writeTextFile(`${dir}/lib/a.ts`, "export const a = 1;\n");
  await Deno.writeTextFile(`${dir}/deno.json`, "{}\n");
  return dir;
}

Deno.test("computeQualityInputDigest - is stable for identical trees and changes on any edit", async () => {
  const dir = await tempTree();
  try {
    const d1 = await computeQualityInputDigest(dir);
    assert(d1 && d1.length === 64, "expected a sha-256 hex digest");
    assertEquals(
      await computeQualityInputDigest(dir),
      d1,
      "stable when unchanged",
    );

    // A one-byte content change moves the digest.
    await Deno.writeTextFile(`${dir}/lib/a.ts`, "export const a = 2;\n");
    assertNotEquals(await computeQualityInputDigest(dir), d1);

    // A rename moves it too (path is folded in with content).
    await Deno.writeTextFile(`${dir}/lib/a.ts`, "export const a = 1;\n");
    await Deno.rename(`${dir}/lib/a.ts`, `${dir}/lib/b.ts`);
    assertNotEquals(await computeQualityInputDigest(dir), d1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("computeQualityInputDigest - reacts to deno.lock / .deno-version, not only source", async () => {
  const dir = await tempTree();
  try {
    const base = await computeQualityInputDigest(dir);
    await Deno.writeTextFile(`${dir}/deno.lock`, '{"version":"4"}\n');
    assertNotEquals(await computeQualityInputDigest(dir), base, "lock counts");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cachedPassAt - a PASS is reused only when the digest matches", async () => {
  const cacheDir = await Deno.makeTempDir({ prefix: "qgcd_" });
  try {
    assertEquals(await cachedPassAt(cacheDir, "deno tests", "hashA"), null);

    await recordPass(cacheDir, "deno tests", "hashA", "2026-08-20T00:00:00Z");
    assertEquals(
      await cachedPassAt(cacheDir, "deno tests", "hashA"),
      "2026-08-20T00:00:00Z",
      "same digest → cached hit",
    );
    // A different digest (any input change) never hits — no false skip.
    assertEquals(await cachedPassAt(cacheDir, "deno tests", "hashB"), null);
    // A different dimension is independent.
    assertEquals(
      await cachedPassAt(cacheDir, "deno type check", "hashA"),
      null,
    );
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

Deno.test("invalidate - a failed dimension drops its cached PASS", async () => {
  const cacheDir = await Deno.makeTempDir({ prefix: "qgci_" });
  try {
    await recordPass(cacheDir, "deno tests", "h", "2026-08-20T00:00:00Z");
    assert(await cachedPassAt(cacheDir, "deno tests", "h"));
    await invalidate(cacheDir, "deno tests");
    assertEquals(await cachedPassAt(cacheDir, "deno tests", "h"), null);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

Deno.test("caching is off (never wrong) when the cache dir or digest is absent", async () => {
  assertEquals(await cachedPassAt(undefined, "deno tests", "h"), null);
  const cacheDir = await Deno.makeTempDir({ prefix: "qgco_" });
  try {
    await recordPass(cacheDir, "deno tests", null, "t"); // null digest → no-op
    assertEquals(await cachedPassAt(cacheDir, "deno tests", null), null);
    assertEquals(await cachedPassAt(cacheDir, "deno tests", "h"), null);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

Deno.test("a corrupt cache file is treated as empty, never a crash", async () => {
  const cacheDir = await Deno.makeTempDir({ prefix: "qgcx_" });
  try {
    await Deno.writeTextFile(
      `${cacheDir}/quality-gate-cache.json`,
      "not json{",
    );
    assertEquals(await cachedPassAt(cacheDir, "deno tests", "h"), null);
    // …and a subsequent record still works (overwrites the garbage).
    await recordPass(cacheDir, "deno tests", "h", "t");
    assertEquals(await cachedPassAt(cacheDir, "deno tests", "h"), "t");
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});
