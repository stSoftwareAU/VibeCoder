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
import { listRepoFiles, renderCodebaseMap } from "../lib/codebase_map.ts";
import type { BriefRunner, BriefRunResult } from "../lib/brief_toolchain.ts";

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

// ---------------------------------------------------------------------------
// brief runner (Issue #2602)
// ---------------------------------------------------------------------------

/** A stub runner that counts its calls and replies with `reply`. */
function stubRunner(
  reply: BriefRunResult,
): { runner: BriefRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runner: (repoDir) => {
      calls.push(repoDir);
      return Promise.resolve(reply);
    },
  };
}

const BRIEF_OK: BriefRunResult = {
  status: "ok",
  commands: ["cargo test", "cargo clippy"],
  seconds: 1.5,
};

const CARGO_BLOCK =
  "## Cargo commands (from brief)\n\n- `cargo test`\n- `cargo clippy`";

async function addCargoToml(repoDir: string): Promise<void> {
  await Deno.writeTextFile(`${repoDir}/Cargo.toml`, '[package]\nname = "x"\n');
}

/** Today's map for the checkout, rendered with no brief involvement. */
async function plainMap(repoDir: string): Promise<string> {
  const files = await listRepoFiles(repoDir);
  assert(files.ok);
  const rendered = await renderCodebaseMap(repoDir, files.value);
  assert(rendered.ok);
  return rendered.value.content;
}

Deno.test("getOrGenerateCodebaseMap - with no runner the map, key and outcome are today's", async () => {
  for (const rust of [false, true]) {
    await withRepoAndCacheDir(async (repoDir, cacheDir) => {
      if (rust) await addCargoToml(repoDir);
      const cache = new PromptCache({ cacheDir, ttlSeconds: 3600 });

      const result = await getOrGenerateCodebaseMap({
        repo: "org/repo",
        repoDir,
        cache,
      });

      assert(result.ok);
      assertEquals(result.value.content, await plainMap(repoDir));
      assertEquals(result.value.brief, { status: "off", reason: "no runner" });
      // The cache key is still the bare tree hash.
      const stored = await cache.get("org/repo", result.value.treeHash);
      assert(stored.ok);
      assertEquals(stored.value, result.value.content);
    });
  }
});

Deno.test("getOrGenerateCodebaseMap - an ok brief run adds the Cargo block and reports seconds", async () => {
  await withRepoAndCacheDir(async (repoDir, cacheDir) => {
    await addCargoToml(repoDir);
    const { runner, calls } = stubRunner(BRIEF_OK);

    const result = await getOrGenerateCodebaseMap({
      repo: "org/repo",
      repoDir,
      cacheDir,
      brief: { runner, version: "0.13.0" },
    });

    assert(result.ok);
    assertEquals(calls, [repoDir]);
    assertStringIncludes(result.value.content, CARGO_BLOCK);
    assertEquals(result.value.brief, { status: "ok", seconds: 1.5 });
    assertEquals(result.value.cacheHit, false);
  });
});

Deno.test("getOrGenerateCodebaseMap - no Cargo.toml never calls the runner", async () => {
  await withRepoAndCacheDir(async (repoDir, cacheDir) => {
    const { runner, calls } = stubRunner(BRIEF_OK);

    const result = await getOrGenerateCodebaseMap({
      repo: "org/repo",
      repoDir,
      cacheDir,
      brief: { runner, version: "0.13.0" },
    });

    assert(result.ok);
    assertEquals(calls.length, 0);
    assertEquals(result.value.content, await plainMap(repoDir));
    assertEquals(result.value.brief, {
      status: "off",
      reason: "no Cargo.toml",
    });
  });
});

Deno.test("getOrGenerateCodebaseMap - a failed brief run warns, renders today's map and is not cached", async () => {
  const failures = [
    "brief could not be spawned: No such file or directory",
    "brief exited with code 2: boom",
    "brief timed out after 30000ms",
  ];
  for (const reason of failures) {
    await withRepoAndCacheDir(async (repoDir, cacheDir) => {
      await addCargoToml(repoDir);
      const { runner, calls } = stubRunner({ status: "failed", reason });
      const warnings: string[] = [];
      const options = {
        repo: "org/repo",
        repoDir,
        cacheDir,
        brief: { runner, version: "0.13.0" },
        warn: (m: string) => warnings.push(m),
      };

      const first = await getOrGenerateCodebaseMap(options);

      assert(first.ok);
      assertEquals(first.value.content, await plainMap(repoDir));
      assertEquals(first.value.brief, { status: "failed", reason });
      assertEquals(warnings.length, 1);
      assertStringIncludes(warnings[0] ?? "", "brief");
      assertStringIncludes(warnings[0] ?? "", reason);
      assertEquals(await countCacheFiles(cacheDir), 0, "failed map cached");

      // Nothing was cached, so the next run tries brief again.
      const second = await getOrGenerateCodebaseMap(options);
      assert(second.ok);
      assertEquals(second.value.cacheHit, false);
      assertEquals(calls.length, 2);
    });
  }
});

Deno.test("getOrGenerateCodebaseMap - a thrown runner is treated as failed", async () => {
  await withRepoAndCacheDir(async (repoDir, cacheDir) => {
    await addCargoToml(repoDir);
    const runner: BriefRunner = () => Promise.reject(new Error("kaboom"));

    const result = await getOrGenerateCodebaseMap({
      repo: "org/repo",
      repoDir,
      cacheDir,
      brief: { runner, version: "0.13.0" },
      warn: () => {},
    });

    assert(result.ok);
    assertEquals(result.value.brief.status, "failed");
    assertEquals(await countCacheFiles(cacheDir), 0);
  });
});

Deno.test("getOrGenerateCodebaseMap - a brief cache hit does not spawn brief; a new version misses", async () => {
  await withRepoAndCacheDir(async (repoDir, cacheDir) => {
    await addCargoToml(repoDir);
    const { runner, calls } = stubRunner(BRIEF_OK);
    const base = { repo: "org/repo", repoDir, cacheDir };

    const first = await getOrGenerateCodebaseMap({
      ...base,
      brief: { runner, version: "0.13.0" },
    });
    assert(first.ok);

    const hit = await getOrGenerateCodebaseMap({
      ...base,
      brief: { runner, version: "0.13.0" },
    });
    assert(hit.ok);
    assertEquals(hit.value.cacheHit, true);
    assertEquals(hit.value.content, first.value.content);
    assertEquals(hit.value.brief, { status: "ok", cached: true, seconds: 0 });
    assertEquals(calls.length, 1, "a cache hit must not spawn brief");

    const bumped = await getOrGenerateCodebaseMap({
      ...base,
      brief: { runner, version: "0.14.0" },
    });
    assert(bumped.ok);
    assertEquals(bumped.value.cacheHit, false, "a new version must miss");
    assertEquals(calls.length, 2);
  });
});

Deno.test("getOrGenerateCodebaseMap - a brief map is keyed apart from today's map", async () => {
  await withRepoAndCacheDir(async (repoDir, cacheDir) => {
    await addCargoToml(repoDir);
    const cache = new PromptCache({ cacheDir, ttlSeconds: 3600 });
    const { runner } = stubRunner(BRIEF_OK);

    const withBrief = await getOrGenerateCodebaseMap({
      repo: "org/repo",
      repoDir,
      cache,
      brief: { runner, version: "0.13.0" },
    });
    assert(withBrief.ok);

    // The bare tree-hash key never serves the brief map to a brief-off run.
    const stored = await cache.get("org/repo", withBrief.value.treeHash);
    assert(stored.ok);
    assertEquals(stored.value, null);
    const off = await getOrGenerateCodebaseMap({
      repo: "org/repo",
      repoDir,
      cache,
    });
    assert(off.ok);
    assertEquals(off.value.cacheHit, false);
    assert(!off.value.content.includes("Cargo commands (from brief)"));
  });
});
