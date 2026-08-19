/**
 * Tests for the codebase map cache (Issue #4281).
 *
 * Each test drives the real cache against a real temporary git repository and
 * asserts on the returned map, the cache verdict, and the on-disk entries.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DEFAULT_CODEBASE_MAP_TTL_SECONDS,
  getOrGenerateCodebaseMap,
} from "../lib/codebase_map_cache.ts";
import { PromptCache } from "../lib/prompt_cache.ts";

async function git(dir: string, args: string[]): Promise<void> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

async function makeRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "codebase_map_cache_test_" });
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "test"]);
  await Deno.mkdir(`${dir}/src`, { recursive: true });
  await Deno.writeTextFile(`${dir}/src/one.ts`, "/** Module one. */\n");
  await Deno.writeTextFile(`${dir}/quality.sh`, "#!/bin/bash\n");
  return dir;
}

async function withRepoAndCacheDir(
  fn: (repoDir: string, cacheDir: string) => Promise<void>,
): Promise<void> {
  const repoDir = await makeRepo();
  const cacheDir = await Deno.makeTempDir({
    prefix: "codebase_map_cache_dir_",
  });
  try {
    await fn(repoDir, cacheDir);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(cacheDir, { recursive: true });
  }
}

async function countCacheFiles(cacheDir: string): Promise<number> {
  let count = 0;
  for await (const entry of Deno.readDir(cacheDir)) {
    if (entry.isFile) count++;
  }
  return count;
}

Deno.test("getOrGenerateCodebaseMap - generates on first call, serves cache on second", async () => {
  await withRepoAndCacheDir(async (repoDir, cacheDir) => {
    const first = await getOrGenerateCodebaseMap({
      repo: "org/repo",
      repoDir,
      cacheDir,
    });
    assert(first.ok, "expected the first generation to succeed");
    assertEquals(first.value.cacheHit, false);
    assertStringIncludes(first.value.content, "src/one.ts — Module one.");

    const second = await getOrGenerateCodebaseMap({
      repo: "org/repo",
      repoDir,
      cacheDir,
    });
    assert(second.ok);
    assertEquals(second.value.cacheHit, true);
    assertEquals(second.value.content, first.value.content);
    assertEquals(second.value.treeHash, first.value.treeHash);
  });
});

Deno.test("getOrGenerateCodebaseMap - a structural change invalidates the entry", async () => {
  await withRepoAndCacheDir(async (repoDir, cacheDir) => {
    const first = await getOrGenerateCodebaseMap({
      repo: "org/repo",
      repoDir,
      cacheDir,
    });
    assert(first.ok);

    await Deno.writeTextFile(`${repoDir}/src/two.ts`, "/** Module two. */\n");

    const second = await getOrGenerateCodebaseMap({
      repo: "org/repo",
      repoDir,
      cacheDir,
    });
    assert(second.ok);
    assertEquals(second.value.cacheHit, false, "new file must miss the cache");
    assert(second.value.treeHash !== first.value.treeHash);
    assertStringIncludes(second.value.content, "src/two.ts — Module two.");

    // Superseded entries are cleaned up rather than accumulating on disk.
    assertEquals(await countCacheFiles(cacheDir), 1);
  });
});

Deno.test("getOrGenerateCodebaseMap - the cadence refresh regenerates a stale entry", async () => {
  await withRepoAndCacheDir(async (repoDir, cacheDir) => {
    let clock = 1_000_000;
    const cache = new PromptCache({
      cacheDir,
      ttlSeconds: 60,
      now: () => clock,
    });

    const first = await getOrGenerateCodebaseMap({
      repo: "org/repo",
      repoDir,
      cache,
    });
    assert(first.ok);
    assertEquals(first.value.cacheHit, false);

    clock += 30;
    const withinTtl = await getOrGenerateCodebaseMap({
      repo: "org/repo",
      repoDir,
      cache,
    });
    assert(withinTtl.ok);
    assertEquals(withinTtl.value.cacheHit, true);

    // Content drift the tree hash cannot see — an edited docstring.
    clock += 100;
    await Deno.writeTextFile(
      `${repoDir}/src/one.ts`,
      "/** Module ONE v2. */\n",
    );
    const afterTtl = await getOrGenerateCodebaseMap({
      repo: "org/repo",
      repoDir,
      cache,
    });
    assert(afterTtl.ok);
    assertEquals(afterTtl.value.cacheHit, false, "TTL expiry must regenerate");
    assertStringIncludes(afterTtl.value.content, "Module ONE v2.");
  });
});

Deno.test("getOrGenerateCodebaseMap - keeps repositories separate", async () => {
  await withRepoAndCacheDir(async (repoDir, cacheDir) => {
    const a = await getOrGenerateCodebaseMap({
      repo: "org/repo-a",
      repoDir,
      cacheDir,
    });
    const b = await getOrGenerateCodebaseMap({
      repo: "org/repo-b",
      repoDir,
      cacheDir,
    });
    assert(a.ok && b.ok);
    assertEquals(a.value.cacheHit, false);
    assertEquals(b.value.cacheHit, false, "a different repo must not hit");
  });
});

Deno.test("getOrGenerateCodebaseMap - fails loud when the repo cannot be listed", async () => {
  const cacheDir = await Deno.makeTempDir({
    prefix: "codebase_map_cache_err_",
  });
  const notARepo = await Deno.makeTempDir({ prefix: "codebase_map_no_git_" });
  try {
    const result = await getOrGenerateCodebaseMap({
      repo: "org/repo",
      repoDir: notARepo,
      cacheDir,
    });
    assertEquals(result.ok, false, "a non-git directory must fail loud");
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(notARepo, { recursive: true });
  }
});

Deno.test("getOrGenerateCodebaseMap - default cadence refresh is bounded", () => {
  assert(DEFAULT_CODEBASE_MAP_TTL_SECONDS > 0);
  assert(DEFAULT_CODEBASE_MAP_TTL_SECONDS <= 86_400);
});
