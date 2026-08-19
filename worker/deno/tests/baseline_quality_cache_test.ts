/**
 * Tests for the content-keyed baseline quality cache (Issue #4283).
 *
 * The baseline gate re-ran the whole suite for every issue even though the
 * checkout was byte-identical to the previous run. The cache reuses the
 * recorded outcome when — and only when — the tree content is provably the
 * same: same repo, same HEAD SHA, and a clean working tree.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  BASELINE_QUALITY_CACHE_TTL_MS,
  baselineQualityCachePath,
  computeBaselineQualityCacheKey,
  isBaselineQualityCacheEnabled,
  MAX_BASELINE_QUALITY_CACHE_ENTRIES,
  MAX_CACHED_OUTPUT_CHARS,
  readBaselineQualityCache,
  writeBaselineQualityCache,
} from "../lib/baseline_quality_cache.ts";
import type { Result } from "../types.ts";
import type { GitCommandOutput } from "../lib/git_timeout.ts";

async function tempCachePath(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-bqcache-" });
  return `${dir}/baseline-quality-cache.json`;
}

/** Build a git runner returning canned output per subcommand. */
function gitRunner(
  responses: Record<string, Partial<GitCommandOutput> | Error>,
): (
  args: string[],
  options?: { cwd?: string },
) => Promise<Result<GitCommandOutput>> {
  return (args) => {
    const key = args.join(" ");
    const response = responses[key];
    if (response === undefined) {
      return Promise.resolve({
        ok: false,
        error: new Error(`unexpected git command: ${key}`),
      });
    }
    if (response instanceof Error) {
      return Promise.resolve({ ok: false, error: response });
    }
    return Promise.resolve({
      ok: true,
      value: { code: 0, stdout: "", stderr: "", ...response },
    });
  };
}

const CLEAN_TREE = {
  "rev-parse HEAD": { stdout: "abc123def456\n" },
  "status --porcelain": { stdout: "" },
};

// ---------------------------------------------------------------------------
// computeBaselineQualityCacheKey
// ---------------------------------------------------------------------------

Deno.test("baseline_quality_cache - key combines repo and HEAD SHA on a clean tree", async () => {
  const key = await computeBaselineQualityCacheKey(
    "owner/repo",
    "/tmp/repo",
    gitRunner(CLEAN_TREE),
  );
  assertEquals(key, "owner/repo@abc123def456");
});

Deno.test("baseline_quality_cache - different repos at the same SHA get different keys", async () => {
  const runner = gitRunner(CLEAN_TREE);
  const a = await computeBaselineQualityCacheKey("owner/a", "/tmp/a", runner);
  const b = await computeBaselineQualityCacheKey("owner/b", "/tmp/b", runner);
  assertNotEquals(a, b);
});

Deno.test("baseline_quality_cache - no key when the working tree is dirty", async () => {
  const key = await computeBaselineQualityCacheKey(
    "owner/repo",
    "/tmp/repo",
    gitRunner({
      ...CLEAN_TREE,
      "status --porcelain": { stdout: " M worker/deno/lib/foo.ts\n" },
    }),
  );
  assertEquals(key, null);
});

Deno.test("baseline_quality_cache - no key when an untracked file is present", async () => {
  const key = await computeBaselineQualityCacheKey(
    "owner/repo",
    "/tmp/repo",
    gitRunner({
      ...CLEAN_TREE,
      "status --porcelain": { stdout: "?? scratch.txt\n" },
    }),
  );
  assertEquals(key, null);
});

Deno.test("baseline_quality_cache - no key when rev-parse fails", async () => {
  const key = await computeBaselineQualityCacheKey(
    "owner/repo",
    "/tmp/repo",
    gitRunner({
      ...CLEAN_TREE,
      "rev-parse HEAD": new Error("not a git repository"),
    }),
  );
  assertEquals(key, null);
});

Deno.test("baseline_quality_cache - no key when rev-parse exits non-zero", async () => {
  const key = await computeBaselineQualityCacheKey(
    "owner/repo",
    "/tmp/repo",
    gitRunner({
      ...CLEAN_TREE,
      "rev-parse HEAD": { code: 128, stdout: "", stderr: "fatal" },
    }),
  );
  assertEquals(key, null);
});

Deno.test("baseline_quality_cache - no key when status exits non-zero", async () => {
  const key = await computeBaselineQualityCacheKey(
    "owner/repo",
    "/tmp/repo",
    gitRunner({
      ...CLEAN_TREE,
      "status --porcelain": { code: 128, stdout: "", stderr: "fatal" },
    }),
  );
  assertEquals(key, null);
});

Deno.test("baseline_quality_cache - no key when the SHA looks malformed", async () => {
  const key = await computeBaselineQualityCacheKey(
    "owner/repo",
    "/tmp/repo",
    gitRunner({
      ...CLEAN_TREE,
      "rev-parse HEAD": { stdout: "not a sha\n" },
    }),
  );
  assertEquals(key, null);
});

Deno.test("baseline_quality_cache - kill switch suppresses the key", async () => {
  const key = await computeBaselineQualityCacheKey(
    "owner/repo",
    "/tmp/repo",
    gitRunner(CLEAN_TREE),
    {
      readEnv: (k) =>
        k === "VIBE_CODER_BASELINE_QUALITY_CACHE" ? "0" : undefined,
    },
  );
  assertEquals(key, null);
});

// ---------------------------------------------------------------------------
// isBaselineQualityCacheEnabled
// ---------------------------------------------------------------------------

Deno.test("baseline_quality_cache - enabled by default", () => {
  assertEquals(isBaselineQualityCacheEnabled(() => undefined), true);
});

Deno.test("baseline_quality_cache - disabled by falsy env values", () => {
  for (const value of ["0", "false", "FALSE", "off", "no", " no "]) {
    assertEquals(
      isBaselineQualityCacheEnabled(() => value),
      false,
      `expected ${JSON.stringify(value)} to disable the cache`,
    );
  }
});

Deno.test("baseline_quality_cache - other env values leave it enabled", () => {
  for (const value of ["1", "true", "on", ""]) {
    assertEquals(isBaselineQualityCacheEnabled(() => value), true);
  }
});

// ---------------------------------------------------------------------------
// read / write
// ---------------------------------------------------------------------------

Deno.test("baseline_quality_cache - read returns null when the file is missing", async () => {
  const path = await tempCachePath();
  assertEquals(await readBaselineQualityCache("owner/repo@sha", path), null);
});

Deno.test("baseline_quality_cache - write then read round-trips the outcome", async () => {
  const path = await tempCachePath();
  await writeBaselineQualityCache(
    "owner/repo@sha",
    { passed: false, output: "deno lint: FAILED", findings: [] },
    path,
  );

  const entry = await readBaselineQualityCache("owner/repo@sha", path);
  assertEquals(entry?.passed, false);
  assertEquals(entry?.output, "deno lint: FAILED");
  assertEquals(entry?.findings, []);
});

Deno.test("baseline_quality_cache - diffable findings survive the round-trip", async () => {
  const path = await tempCachePath();
  const findings = [
    { check: "mermaid" as const, key: "docs/a.md:flowchart", display: "a" },
    { check: "markdownlint" as const, key: "docs/b.md:MD013", display: "b" },
  ];
  await writeBaselineQualityCache(
    "owner/repo@sha",
    { passed: false, output: "", findings },
    path,
  );

  const entry = await readBaselineQualityCache("owner/repo@sha", path);
  assertEquals(entry?.findings, findings);
});

Deno.test("baseline_quality_cache - findings stay undefined when not captured", async () => {
  const path = await tempCachePath();
  await writeBaselineQualityCache(
    "owner/repo@sha",
    { passed: true, output: "" },
    path,
  );

  const entry = await readBaselineQualityCache("owner/repo@sha", path);
  assertEquals(entry?.findings, undefined);
});

Deno.test("baseline_quality_cache - a different key misses", async () => {
  const path = await tempCachePath();
  await writeBaselineQualityCache(
    "owner/repo@sha1",
    { passed: true, output: "" },
    path,
  );
  assertEquals(await readBaselineQualityCache("owner/repo@sha2", path), null);
});

Deno.test("baseline_quality_cache - entries older than the TTL miss", async () => {
  const path = await tempCachePath();
  const stale = {
    "owner/repo@sha": {
      version: 1,
      passed: true,
      output: "",
      storedAt: Date.now() - BASELINE_QUALITY_CACHE_TTL_MS - 1,
    },
  };
  await Deno.writeTextFile(path, JSON.stringify(stale));
  assertEquals(await readBaselineQualityCache("owner/repo@sha", path), null);
});

Deno.test("baseline_quality_cache - entries from an older cache version miss", async () => {
  const path = await tempCachePath();
  const old = {
    "owner/repo@sha": {
      version: 0,
      passed: true,
      output: "",
      storedAt: Date.now(),
    },
  };
  await Deno.writeTextFile(path, JSON.stringify(old));
  assertEquals(await readBaselineQualityCache("owner/repo@sha", path), null);
});

Deno.test("baseline_quality_cache - a corrupt cache file reads as a miss", async () => {
  const path = await tempCachePath();
  await Deno.writeTextFile(path, "{ not json");
  assertEquals(await readBaselineQualityCache("owner/repo@sha", path), null);

  await Deno.writeTextFile(path, JSON.stringify({ "k": { passed: "yes" } }));
  assertEquals(await readBaselineQualityCache("k", path), null);
});

Deno.test("baseline_quality_cache - a corrupt cache file does not block later writes", async () => {
  const path = await tempCachePath();
  await Deno.writeTextFile(path, "{ not json");
  await writeBaselineQualityCache("k", { passed: true, output: "" }, path);
  assertEquals((await readBaselineQualityCache("k", path))?.passed, true);
});

Deno.test("baseline_quality_cache - stored output is truncated to its tail", async () => {
  const path = await tempCachePath();
  const output = "x".repeat(MAX_CACHED_OUTPUT_CHARS + 500) + "TAIL";
  await writeBaselineQualityCache("k", { passed: false, output }, path);

  const entry = await readBaselineQualityCache("k", path);
  assertEquals(entry?.output.length, MAX_CACHED_OUTPUT_CHARS);
  assertEquals(entry?.output.endsWith("TAIL"), true);
});

Deno.test("baseline_quality_cache - the cache is bounded to the newest entries", async () => {
  const path = await tempCachePath();
  const total = MAX_BASELINE_QUALITY_CACHE_ENTRIES + 5;
  for (let i = 0; i < total; i++) {
    await writeBaselineQualityCache(`owner/repo@sha${i}`, {
      passed: true,
      output: "",
    }, path);
  }

  const raw = JSON.parse(await Deno.readTextFile(path)) as Record<
    string,
    unknown
  >;
  assertEquals(
    Object.keys(raw).length,
    MAX_BASELINE_QUALITY_CACHE_ENTRIES,
  );
  // The most recent write survives; the oldest was pruned.
  assertEquals(`owner/repo@sha${total - 1}` in raw, true);
  assertEquals("owner/repo@sha0" in raw, false);
});

Deno.test("baseline_quality_cache - prunes oldest-first when every write shares a millisecond (Issue #4342)", async () => {
  const path = await tempCachePath();
  const total = MAX_BASELINE_QUALITY_CACHE_ENTRIES + 5;
  const realNow = Date.now;
  // A host fast enough to land the whole burst in one millisecond: storedAt
  // ties on every entry, so ordering must not depend on the clock.
  Date.now = () => 1_700_000_000_000;
  try {
    for (let i = 0; i < total; i++) {
      await writeBaselineQualityCache(`owner/repo@sha${i}`, {
        passed: true,
        output: "",
      }, path);
    }
  } finally {
    Date.now = realNow;
  }

  const raw = JSON.parse(await Deno.readTextFile(path)) as Record<
    string,
    unknown
  >;
  assertEquals(Object.keys(raw).length, MAX_BASELINE_QUALITY_CACHE_ENTRIES);
  for (let i = 0; i < total; i++) {
    assertEquals(
      `owner/repo@sha${i}` in raw,
      i >= total - MAX_BASELINE_QUALITY_CACHE_ENTRIES,
      `sha${i} kept/pruned incorrectly`,
    );
  }
});

Deno.test("baseline_quality_cache - a same-millisecond rewrite of an existing key keeps it newest (Issue #4342)", async () => {
  const path = await tempCachePath();
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  try {
    for (let i = 0; i < MAX_BASELINE_QUALITY_CACHE_ENTRIES; i++) {
      await writeBaselineQualityCache(`owner/repo@sha${i}`, {
        passed: true,
        output: "",
      }, path);
    }
    // Re-record the oldest key, then fill the cache again: the refreshed key
    // is now the newest and must outlive the entries written before it.
    await writeBaselineQualityCache("owner/repo@sha0", {
      passed: false,
      output: "boom",
    }, path);
    for (let i = 0; i < MAX_BASELINE_QUALITY_CACHE_ENTRIES - 1; i++) {
      await writeBaselineQualityCache(`owner/repo@fresh${i}`, {
        passed: true,
        output: "",
      }, path);
    }
  } finally {
    Date.now = realNow;
  }

  const entry = await readBaselineQualityCache("owner/repo@sha0", path);
  assertEquals(entry?.passed, false);
  assertEquals(entry?.output, "boom");
});

Deno.test("baseline_quality_cache - legacy entries without a sequence still prune oldest-first (Issue #4342)", async () => {
  const path = await tempCachePath();
  const now = Date.now();
  // A cache file written by the previous version: no sequence field, and
  // (as that version persisted it) newest-first.
  const legacy: Record<string, unknown> = {};
  for (let i = MAX_BASELINE_QUALITY_CACHE_ENTRIES - 1; i >= 0; i--) {
    legacy[`owner/repo@legacy${i}`] = {
      version: 1,
      passed: true,
      output: "",
      storedAt: now - (MAX_BASELINE_QUALITY_CACHE_ENTRIES - i) * 60_000,
    };
  }
  await Deno.writeTextFile(path, JSON.stringify(legacy));

  await writeBaselineQualityCache("owner/repo@new", {
    passed: true,
    output: "",
  }, path);

  const raw = JSON.parse(await Deno.readTextFile(path)) as Record<
    string,
    unknown
  >;
  assertEquals(Object.keys(raw).length, MAX_BASELINE_QUALITY_CACHE_ENTRIES);
  assertEquals("owner/repo@new" in raw, true);
  // The oldest legacy entry made room for it; the newest legacy one stayed.
  assertEquals("owner/repo@legacy0" in raw, false);
  assertEquals(
    `owner/repo@legacy${MAX_BASELINE_QUALITY_CACHE_ENTRIES - 1}` in raw,
    true,
  );
});

Deno.test("baseline_quality_cache - default path lives on the work volume, not root-owned ~/.vibe-coder (Issue #4318)", () => {
  const previous = Deno.env.get("WORK_DIR");
  Deno.env.set("WORK_DIR", "/vol/auto-issue-work");
  try {
    assertEquals(
      baselineQualityCachePath(),
      "/vol/auto-issue-work/.vibe-cache/baseline-quality-cache.json",
    );
  } finally {
    if (previous !== undefined) Deno.env.set("WORK_DIR", previous);
    else Deno.env.delete("WORK_DIR");
  }
});
