/**
 * Tests for the host build-cache reclaim (Issue #4498).
 *
 * Every test works in a real temporary directory made with
 * `Deno.makeTempDir`, never a fixed `/tmp` path. The process table and the
 * directory sizes are injected, so no test runs `ps`, `lsof` or `du`, and the
 * command tests replace the built-in roots so the real `/tmp` is never walked.
 *
 * Australian English spelling throughout (behaviour, artefact, etc.).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  CACHEDIR_TAG_FILENAME,
  CACHEDIR_TAG_SIGNATURE,
  DEFAULT_HOST_CACHE_RECLAIM_CONFIG,
  defaultCacheRoots,
  defaultDirSizeBytes,
  defaultProcessSnapshot,
  type FsStat,
  type HostCacheFs,
  type HostCacheReclaimDeps,
  type HostCacheReclaimOptions,
  largestHostDirectories,
  lsofDescriptors,
  namesPath,
  parseHostCacheReclaimConfig,
  readHostCacheReclaimConfig,
  realHostCacheFs,
  reclaimHostCaches,
  TAG_READ_BYTES,
  walkDirSizeBytes,
} from "../lib/host_cache_reclaim.ts";
import {
  HOST_CACHE_RECLAIM_TAG,
  reclaimHostCachesCommand,
  type ReclaimHostCachesDeps,
  runReclaimHostCaches,
} from "../commands/reclaim_host_caches.ts";

const GIB = 1_073_741_824;
const KIB_PER_GIB = 1_048_576;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Older than the 24 h minimum age, so a cache this old is eligible. */
const STALE_MS = 2 * DAY;
/** Older than the oldest-first test's stale pair, so ordering is provable. */
const VERY_STALE_MS = 10 * DAY;
const MIDDLE_STALE_MS = 3 * DAY;
const NO_PROCESSES = async () => ["/usr/bin/some-idle-process --flag"];

function join(...parts: string[]): string {
  return parts.join("/");
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  // Resolved, so paths the walk reports compare equal on any host, including
  // one whose TMPDIR is a symlink.
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "host_cache_reclaim_test_" }),
  );
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Set the times of a directory and its children and grandchildren. */
async function ageTree(dir: string, ageMs: number): Promise<void> {
  const at = new Date(Date.now() - ageMs);
  await Deno.utime(dir, at, at);
  for await (const child of Deno.readDir(dir)) {
    const childPath = join(dir, child.name);
    await Deno.utime(childPath, at, at);
    if (child.isDirectory) {
      for await (const grand of Deno.readDir(childPath)) {
        await Deno.utime(join(childPath, grand.name), at, at);
      }
    }
  }
}

interface CacheOptions {
  /** Age the tree this far into the past. Omit for a fresh tree. */
  ageMs?: number;
  /** The first line of CACHEDIR.TAG. `null` means no tag file at all. */
  signature?: string | null;
}

/**
 * Create `path` and any missing parents, and set each directory this call
 * creates to 0755 (Issue #4498 review). The removal check skips a cache that
 * is group- or other-writable, so a fixture made under the process umask
 * (0775 under umask 002) would be skipped on some hosts and removed on others.
 * Pinning the mode makes the fixture the same on every host.
 */
async function mkdirOwned(path: string): Promise<void> {
  const created: string[] = [];
  for (let at = path; at !== "" && !(await exists(at));) {
    created.unshift(at);
    at = at.slice(0, at.lastIndexOf("/"));
  }
  await Deno.mkdir(path, { recursive: true });
  if (Deno.build.os === "windows") return;
  for (const dir of created) await Deno.chmod(dir, 0o755);
}

/** A directory shaped like a cargo target: `debug/` plus a CACHEDIR.TAG. */
async function makeCache(
  parent: string,
  name: string,
  options: CacheOptions = {},
): Promise<string> {
  const dir = join(parent, name);
  await mkdirOwned(join(dir, "debug"));
  // The cache itself may already exist (a test can make it first); pin it too.
  if (Deno.build.os !== "windows") await Deno.chmod(dir, 0o755);
  await Deno.writeTextFile(join(dir, "debug", "libdep.rlib"), "artefact");
  const signature = options.signature === undefined
    ? CACHEDIR_TAG_SIGNATURE
    : options.signature;
  if (signature !== null) {
    await Deno.writeTextFile(
      join(dir, CACHEDIR_TAG_FILENAME),
      `${signature}\n# This is a cache directory.\n`,
    );
  }
  if (options.ageMs !== undefined) await ageTree(dir, options.ageMs);
  return dir;
}

/** A floor one gigabyte above zero free, with no headroom, one 1 GiB cache. */
function oneGibOptions(
  roots: string[],
  overrides: Partial<HostCacheReclaimOptions> = {},
): HostCacheReclaimOptions {
  return {
    freeBytes: 0,
    floorBytes: GIB,
    headroomBytes: 0,
    minAgeMs: DAY,
    roots,
    protect: [],
    ...overrides,
  };
}

/**
 * The uid that owns the directories this test creates, read with lstat from a
 * temporary directory the test makes itself (Issue #4498 review). The
 * production default, `resolveOwnUid()`, stats the real `$HOME`, so a test
 * relying on it would give a different answer when `$HOME` is unset or owned
 * by another account. Every `withRoot` root is made the same way by the same
 * process, so it has this owner too.
 */
const TEST_OWNER_UID: number | null = await (async () => {
  const probe = await Deno.makeTempDir({ prefix: "host_cache_reclaim_uid_" });
  try {
    return (await Deno.lstat(probe)).uid;
  } finally {
    await Deno.remove(probe);
  }
})();

function reclaimDeps(
  overrides: Partial<HostCacheReclaimDeps> = {},
): Partial<HostCacheReclaimDeps> {
  return {
    processSnapshot: NO_PROCESSES,
    dirSizeBytes: async () => GIB,
    ownerUid: TEST_OWNER_UID,
    ...overrides,
  };
}

function removedPaths(result: { removed: { path: string }[] }): string[] {
  return result.removed.map((r) => r.path);
}

// ---------------------------------------------------------------------------
// Acceptance: the fixture tree the issue describes.
// ---------------------------------------------------------------------------

Deno.test("acceptance: only the stale, tagged, unheld cache is removed", async () => {
  await withRoot(async (root) => {
    // The untagged directory is the oldest, and the floor needs more than one
    // removal, so a broken untagged guard would remove it first and be seen.
    const untagged = await makeCache(root, "untagged-stale", {
      signature: null,
      ageMs: VERY_STALE_MS,
    });
    const stale = await makeCache(root, "stale-target", { ageMs: STALE_MS });
    const fresh = await makeCache(root, "fresh-target");
    const held = await makeCache(root, "held-target", { ageMs: STALE_MS });

    const result = await reclaimHostCaches(
      oneGibOptions([root], { floorBytes: 2 * GIB }),
      reclaimDeps({
        processSnapshot: async () => [
          "cargo build",
          `rustc --out-dir ${held}/debug`,
        ],
      }),
    );

    assertEquals(await exists(stale), false, "stale tagged cache is removed");
    assertEquals(await exists(fresh), true, "fresh tagged cache is kept");
    assertEquals(await exists(untagged), true, "untagged stale dir is kept");
    assertEquals(await exists(held), true, "held-open cache is kept");
    assertEquals(removedPaths(result), [stale]);
    assertEquals(result.shortBytes, GIB, "the floor is still one GiB short");
    const skipReasons = Object.fromEntries(
      result.skipped.map((s) => [s.path, s.reason]),
    );
    assertStringIncludes(skipReasons[fresh] ?? "", "fresh");
    assertStringIncludes(skipReasons[held] ?? "", "held open");
  });
});

Deno.test("acceptance positive control: the same stale cache is removed when no process names it", async () => {
  await withRoot(async (root) => {
    const stale = await makeCache(root, "stale-target", { ageMs: STALE_MS });
    const result = await reclaimHostCaches(
      oneGibOptions([root]),
      reclaimDeps({
        processSnapshot: async () => ["cargo build /somewhere/else/debug"],
      }),
    );
    assertEquals(await exists(stale), false);
    assertEquals(removedPaths(result), [stale]);
  });
});

Deno.test("a process naming only a longer sibling path does not hold a cache open", async () => {
  await withRoot(async (root) => {
    const stale = await makeCache(root, "stale-target", { ageMs: STALE_MS });
    const result = await reclaimHostCaches(
      oneGibOptions([root]),
      reclaimDeps({
        processSnapshot: async () => [`cargo build ${stale}-old/debug`],
      }),
    );
    assertEquals(await exists(stale), false);
    assertEquals(removedPaths(result), [stale]);
  });
});

Deno.test("a cache a process has as its working directory is held open", async () => {
  await withRoot(async (root) => {
    const stale = await makeCache(root, "stale-target", { ageMs: STALE_MS });
    const result = await reclaimHostCaches(
      oneGibOptions([root]),
      reclaimDeps({ processSnapshot: async () => [`cwd=${stale}`] }),
    );
    assertEquals(await exists(stale), true);
    assertEquals(result.removed.length, 0);
  });
});

/**
 * A stand-in for `ps` and `lsof` (#4500 review). The process is a server
 * started two days ago as `./target/release/server` from `cwd`: ps shows the
 * relative argv, and lsof reports the cwd, the program text (`txt`) and a
 * memory-mapped file (`mem`). Like the real lsof, it reports only the
 * descriptor types named by `-d`, so the guard sees the executable path only
 * when it asks for `txt`. Records every call so a test can see the arguments.
 */
function fakeProcessTable(cwd: string, executable: string, mapped: string) {
  const calls: { executable: string; args: string[] }[] = [];
  const records: [string, string][] = [
    ["cwd", cwd],
    ["txt", executable],
    ["mem", mapped],
  ];
  const run = async (exe: string, args: string[]) => {
    calls.push({ executable: exe, args });
    let stdout = "";
    if (exe === "ps") stdout = "./target/release/server --port 8080\n";
    if (exe === "lsof") {
      const wanted = (args[args.indexOf("-d") + 1] ?? "").split(",");
      stdout = "p4242\n" + records
        .filter(([fd]) => wanted.includes(fd))
        .map(([fd, name]) => `f${fd}\nn${name}\n`)
        .join("");
    }
    return {
      ok: true as const,
      value: { timedOut: false, stdout, stderr: "", success: true, code: 0 },
    };
  };
  // The stand-in answers only the fields the snapshot reads.
  type Runner = NonNullable<Parameters<typeof defaultProcessSnapshot>[1]>;
  return { run: run as unknown as Runner, calls };
}

Deno.test("a running executable inside a stale cache holds it open through lsof's txt line, though its argv is relative (#4500 review)", async () => {
  await withRoot(async (root) => {
    const repo = join(root, "repo");
    const cache = await makeCache(repo, "target", { ageMs: STALE_MS });
    await mkdirOwned(join(cache, "release"));
    await ageTree(cache, STALE_MS);
    const { run, calls } = fakeProcessTable(
      repo,
      join(cache, "release", "server"),
      "/usr/lib/libc.so.6",
    );

    for (const os of ["darwin", "linux"] as const) {
      const result = await reclaimHostCaches(
        oneGibOptions([root]),
        reclaimDeps({
          processSnapshot: () => defaultProcessSnapshot("posix", run, os),
        }),
      );
      assertEquals(result.removed.length, 0, `${os}: the cache is kept`);
      assertEquals(await exists(cache), true, `${os}: the cache is kept`);
      assertStringIncludes(
        result.skipped.find((s) => s.path === cache)?.reason ?? "",
        "held open",
      );
    }
    const lsofCalls = calls.filter((c) => c.executable === "lsof");
    assertEquals(lsofCalls.map((c) => c.args), [
      ["-w", "-a", "-d", "cwd,txt", "-Fn"],
      ["-w", "-a", "-d", "cwd,txt,mem", "-Fn"],
    ]);
  });
});

Deno.test("a file only memory-mapped from a stale cache holds it open on Linux, and the p and f lines are not names (#4500 review)", async () => {
  await withRoot(async (root) => {
    const cache = await makeCache(root, "target", { ageMs: STALE_MS });
    const { run } = fakeProcessTable(
      "/somewhere/else",
      "/usr/bin/python3",
      join(cache, "release", "libplugin.so"),
    );
    const lines = await defaultProcessSnapshot("posix", run, "linux");
    assertEquals(lines.filter((l) => l !== ""), [
      "./target/release/server --port 8080",
      "/somewhere/else",
      "/usr/bin/python3",
      join(cache, "release", "libplugin.so"),
    ]);
    const result = await reclaimHostCaches(
      oneGibOptions([root]),
      reclaimDeps({ processSnapshot: async () => lines }),
    );
    assertEquals(await exists(cache), true);
    assertEquals(result.removed.length, 0);
  });
});

Deno.test("positive control: the same stale cache is removed when lsof names nothing inside it (#4500 review)", async () => {
  await withRoot(async (root) => {
    const repo = join(root, "repo");
    const cache = await makeCache(repo, "target", { ageMs: STALE_MS });
    const { run } = fakeProcessTable(
      repo,
      "/usr/local/bin/server",
      "/usr/lib/libc.so.6",
    );
    const result = await reclaimHostCaches(
      oneGibOptions([root]),
      reclaimDeps({
        processSnapshot: () => defaultProcessSnapshot("posix", run, "linux"),
      }),
    );
    assertEquals(removedPaths(result), [cache]);
    assertEquals(await exists(cache), false);
  });
});

Deno.test("lsofDescriptors reads cwd and txt everywhere, and mem on Linux", () => {
  assertEquals(lsofDescriptors("darwin"), "cwd,txt");
  assertEquals(lsofDescriptors("linux"), "cwd,txt,mem");
});

// ---------------------------------------------------------------------------
// Ordering, the stop condition, and the estimate.
// ---------------------------------------------------------------------------

Deno.test("oldest first, and stops once floor plus headroom is met", async () => {
  await withRoot(async (root) => {
    const older = await makeCache(root, "older-target", {
      ageMs: VERY_STALE_MS,
    });
    const newer = await makeCache(root, "newer-target", {
      ageMs: MIDDLE_STALE_MS,
    });

    const result = await reclaimHostCaches(
      {
        freeBytes: 5 * GIB,
        floorBytes: 10 * GIB,
        headroomBytes: 1 * GIB,
        minAgeMs: DAY,
        roots: [root],
        protect: [],
      },
      reclaimDeps({ dirSizeBytes: async () => 8 * GIB }),
    );

    assertEquals(removedPaths(result), [older], "only the oldest is needed");
    assertEquals(await exists(older), false);
    assertEquals(await exists(newer), true, "the newer cache survives");
    assertEquals(result.freeBytesAfter, 13 * GIB);
    assertEquals(result.targetBytes, 11 * GIB);
    assertEquals(result.shortBytes, 0);
  });
});

Deno.test("free space already at or above the floor removes nothing and does not read the process table", async () => {
  await withRoot(async (root) => {
    const stale = await makeCache(root, "stale-target", { ageMs: STALE_MS });
    let processTableRead = false;
    const result = await reclaimHostCaches(
      oneGibOptions([root], { freeBytes: 2 * GIB }),
      reclaimDeps({
        processSnapshot: async () => {
          processTableRead = true;
          return ["cargo"];
        },
      }),
    );
    assertEquals(await exists(stale), true);
    assertEquals(result.removed.length, 0);
    assertEquals(processTableRead, false);
  });
});

Deno.test("a recent write to a grandchild keeps an otherwise stale cache fresh", async () => {
  await withRoot(async (root) => {
    const cache = await makeCache(root, "active-target", { ageMs: STALE_MS });
    // Only a grandchild is touched now; the directory and its child stay old.
    await Deno.utime(
      join(cache, "debug", "libdep.rlib"),
      new Date(),
      new Date(),
    );
    const result = await reclaimHostCaches(
      oneGibOptions([root]),
      reclaimDeps(),
    );
    assertEquals(
      await exists(cache),
      true,
      "a recent grandchild keeps it fresh",
    );
    assertEquals(result.removed.length, 0);
  });
});

// ---------------------------------------------------------------------------
// The process table.
// ---------------------------------------------------------------------------

Deno.test("a process table that throws removes nothing and reports the error", async () => {
  await withRoot(async (root) => {
    const stale = await makeCache(root, "stale-target", { ageMs: STALE_MS });
    const result = await reclaimHostCaches(
      oneGibOptions([root]),
      reclaimDeps({
        processSnapshot: async () => {
          throw new Error("ps: command not found");
        },
      }),
    );
    assertEquals(await exists(stale), true, "nothing is deleted");
    assertEquals(result.removed.length, 0);
    assertStringIncludes(
      result.processTableError ?? "",
      "ps: command not found",
    );
  });
});

Deno.test("a process table with nothing usable in it removes nothing", async () => {
  await withRoot(async (root) => {
    const stale = await makeCache(root, "stale-target", { ageMs: STALE_MS });
    const result = await reclaimHostCaches(
      oneGibOptions([root]),
      reclaimDeps({ processSnapshot: async () => [] }),
    );
    assertEquals(await exists(stale), true);
    assertEquals(result.removed.length, 0);
    assert(result.processTableError !== undefined);
  });
});

// ---------------------------------------------------------------------------
// Structural guards: symlinks, roots, depth, tagged-directory descent.
// ---------------------------------------------------------------------------

Deno.test("a symlink to a stale tagged cache outside the root is not followed or removed", async () => {
  await withRoot(async (outside) => {
    const target = await makeCache(outside, "outside-target", {
      ageMs: STALE_MS,
    });
    await withRoot(async (root) => {
      const link = join(root, "linked-target");
      await Deno.symlink(target, link);
      const result = await reclaimHostCaches(
        oneGibOptions([root]),
        reclaimDeps(),
      );
      assertEquals(await exists(target), true, "the real target survives");
      assertEquals(result.removed.length, 0);
    });
  });
});

Deno.test("a tagged directory containing .git is kept", async () => {
  await withRoot(async (root) => {
    const cache = await makeCache(root, "repo-target", { ageMs: STALE_MS });
    await Deno.mkdir(join(cache, ".git"));
    await ageTree(cache, STALE_MS);
    const result = await reclaimHostCaches(
      oneGibOptions([root]),
      reclaimDeps(),
    );
    assertEquals(await exists(cache), true);
    assertEquals(result.removed.length, 0);
    assertStringIncludes(
      result.skipped.find((s) => s.path === cache)?.reason ?? "",
      ".git",
    );
  });
});

Deno.test("a cache equal to a protected path is kept", async () => {
  await withRoot(async (root) => {
    const cache = await makeCache(root, "stale-target", { ageMs: STALE_MS });
    const result = await reclaimHostCaches(
      oneGibOptions([root], { protect: [cache] }),
      reclaimDeps(),
    );
    assertEquals(await exists(cache), true);
    assertEquals(result.removed.length, 0);
  });
});

Deno.test("a cache containing a protected path is kept", async () => {
  await withRoot(async (root) => {
    const cache = await makeCache(root, "stale-target", { ageMs: STALE_MS });
    const result = await reclaimHostCaches(
      oneGibOptions([root], { protect: [join(cache, "debug")] }),
      reclaimDeps(),
    );
    assertEquals(await exists(cache), true);
    assertEquals(result.removed.length, 0);
  });
});

Deno.test("a protected path elsewhere does not protect an unrelated cache", async () => {
  await withRoot(async (root) => {
    const cache = await makeCache(root, "stale-target", { ageMs: STALE_MS });
    const result = await reclaimHostCaches(
      oneGibOptions([root], { protect: [join(root, "unrelated-dir")] }),
      reclaimDeps(),
    );
    assertEquals(await exists(cache), false);
    assertEquals(removedPaths(result), [cache]);
  });
});

Deno.test("a wrong-signature tag is kept and the reason names the signature", async () => {
  await withRoot(async (root) => {
    const cache = await makeCache(root, "stale-target", {
      ageMs: STALE_MS,
      signature: "Signature: 00000000000000000000000000000000",
    });
    const result = await reclaimHostCaches(
      oneGibOptions([root]),
      reclaimDeps(),
    );
    assertEquals(await exists(cache), true);
    assertEquals(result.removed.length, 0);
    assertStringIncludes(
      result.skipped.find((s) => s.path === cache)?.reason ?? "",
      "signature",
    );
  });
});

Deno.test("a root that is itself a tagged cache is never a candidate", async () => {
  await withRoot(async (parent) => {
    const cache = await makeCache(parent, "stale-target", { ageMs: STALE_MS });
    const result = await reclaimHostCaches(
      oneGibOptions([cache]),
      reclaimDeps(),
    );
    assertEquals(await exists(cache), true);
    assertEquals(result.removed.length, 0);
  });
});

Deno.test("nothing inside a tagged directory is walked, even a cache nested in it", async () => {
  await withRoot(async (root) => {
    // The nested cache is created fresh on purpose: if the walk ever descended
    // into the outer cache it would show up as a fresh skip, and the test
    // would fail.
    const outer = await makeCache(root, "outer-target");
    const nested = await makeCache(join(outer, "debug"), "inner-target");
    await ageTree(outer, STALE_MS);
    const result = await reclaimHostCaches(
      oneGibOptions([root], { protect: [outer] }),
      reclaimDeps(),
    );
    assertEquals(await exists(nested), true, "the nested cache is not reached");
    assertEquals(result.skipped.some((s) => s.path === nested), false);
    assertEquals(result.removed.length, 0);
  });
});

Deno.test("the walk stops at depth four: a cache at depth four is found, one at depth five is not", async () => {
  await withRoot(async (root) => {
    const near = await makeCache(join(root, "a", "b", "c"), "d-target", {
      ageMs: STALE_MS,
    });
    const far = await makeCache(join(root, "x", "y", "z", "w"), "v-target", {
      ageMs: STALE_MS,
    });
    const result = await reclaimHostCaches(
      oneGibOptions([root], {
        freeBytes: 0,
        floorBytes: GIB,
        headroomBytes: 0,
      }),
      reclaimDeps(),
    );
    assertEquals(removedPaths(result), [near], "depth four is removed");
    assertEquals(await exists(far), true, "depth five is outside the walk");
  });
});

Deno.test("a missing root is dropped silently", async () => {
  await withRoot(async (root) => {
    const result = await reclaimHostCaches(
      oneGibOptions([join(root, "does-not-exist")]),
      reclaimDeps(),
    );
    assertEquals(result.removed.length, 0);
    assertEquals(
      result.skipped.length,
      0,
      "a missing root is normal, not a skip",
    );
  });
});

Deno.test("two roots resolving to the same directory are walked once", async () => {
  await withRoot(async (root) => {
    const cache = await makeCache(root, "stale-target", { ageMs: STALE_MS });
    await withRoot(async (holder) => {
      // An alias of the root, the way macOS /tmp aliases /private/tmp.
      const alias = join(holder, "alias");
      await Deno.symlink(root, alias);
      const result = await reclaimHostCaches(
        oneGibOptions([root, alias]),
        reclaimDeps(),
      );
      assertEquals(removedPaths(result), [cache], "removed once, not twice");
      assertEquals(result.skipped.filter((s) => s.path === cache).length, 0);
    });
  });
});

Deno.test("a cache a process names through the root's alias spelling is held open (#4500 review)", async () => {
  // macOS: the root is given as /tmp (or $TMPDIR) but resolves to
  // /private/tmp. A process started under the alias names the cache that
  // way; the candidate is the resolved path. The guard must match both.
  await withRoot(async (root) => {
    const cache = await makeCache(root, "grq-a-target", { ageMs: STALE_MS });
    await withRoot(async (holder) => {
      const alias = join(holder, "tmp");
      await Deno.symlink(root, alias);
      const result = await reclaimHostCaches(
        oneGibOptions([alias]),
        reclaimDeps({
          processSnapshot: async () => [
            `${alias}/grq-a-target/release/server --serve`,
          ],
        }),
      );
      assertEquals(await exists(cache), true, "held via the alias, kept");
      assertEquals(removedPaths(result), []);
      const reason = result.skipped.find((s) => s.path === cache)?.reason;
      assertStringIncludes(reason ?? "", "held open");
    });
  });
});

Deno.test("a root given through an alias still removes a stale cache no process names (#4500 review)", async () => {
  // Positive control for the alias case above.
  await withRoot(async (root) => {
    const cache = await makeCache(root, "grq-a-target", { ageMs: STALE_MS });
    await withRoot(async (holder) => {
      const alias = join(holder, "tmp");
      await Deno.symlink(root, alias);
      const result = await reclaimHostCaches(
        oneGibOptions([alias]),
        reclaimDeps({
          processSnapshot: async () => [`${alias}/other-target/debug/app`],
        }),
      );
      assertEquals(removedPaths(result), [cache]);
    });
  });
});

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

Deno.test("a sparse multi-gigabyte CACHEDIR.TAG is read as a bounded prefix (#4500 review)", async () => {
  await withRoot(async (root) => {
    const dir = join(root, "oversized-target");
    await Deno.mkdir(dir);
    const tag = join(dir, CACHEDIR_TAG_FILENAME);
    await Deno.writeTextFile(tag, `${CACHEDIR_TAG_SIGNATURE}\n`);
    // 3 GiB apparent size, no blocks allocated: reading it whole would load 3 GiB.
    await Deno.truncate(tag, 3 * GIB);

    const reading = await realHostCacheFs.readTagFile(tag);
    assertEquals(reading.state, "file");
    if (reading.state !== "file") return;
    assert(
      reading.text.length <= TAG_READ_BYTES,
      `read ${reading.text.length} characters`,
    );
    // Positive control: a signature at the start is still seen in the prefix.
    assertEquals(reading.text.split("\n", 1)[0], CACHEDIR_TAG_SIGNATURE);
  });
});

Deno.test("an oversized tag whose first line has no end is skipped for its signature and the run completes (#4500 review)", async () => {
  await withRoot(async (root) => {
    const cache = await makeCache(root, "stale-target", {
      ageMs: STALE_MS,
      signature: null,
    });
    const tag = join(cache, CACHEDIR_TAG_FILENAME);
    // A first line far longer than the prefix, then sparse up to 2 GiB.
    await Deno.writeTextFile(tag, "x".repeat(TAG_READ_BYTES * 4));
    await Deno.truncate(tag, 2 * GIB);
    await ageTree(cache, STALE_MS);
    const result = await reclaimHostCaches(
      oneGibOptions([root]),
      reclaimDeps(),
    );
    assertEquals(await exists(cache), true);
    assertEquals(result.removed.length, 0);
    assertStringIncludes(
      result.skipped.find((s) => s.path === cache)?.reason ?? "",
      "signature",
    );
  });
});

Deno.test("walkDirSizeBytes sums a tree without following a symlink out of it (#4500 review)", async () => {
  await withRoot(async (root) => {
    const tree = join(root, "tree");
    const outside = join(root, "outside");
    await Deno.mkdir(join(tree, "sub"), { recursive: true });
    await Deno.mkdir(outside);
    await Deno.writeFile(join(tree, "a.bin"), new Uint8Array(100_000));
    await Deno.writeFile(join(tree, "sub", "b.bin"), new Uint8Array(100_000));
    await Deno.writeFile(join(outside, "big.bin"), new Uint8Array(5_000_000));
    await Deno.symlink(outside, join(tree, "link"));

    const bytes = await walkDirSizeBytes(tree);
    assert(bytes !== null && bytes >= 200_000, `measured ${bytes}`);
    assert(bytes < 1_000_000, `followed the symlink: ${bytes}`);
  });
});

Deno.test("walkDirSizeBytes reports an unmeasured size when the entry budget or the clock runs out, and for a missing root", async () => {
  await withRoot(async (root) => {
    const tree = join(root, "tree");
    await Deno.mkdir(tree);
    for (let i = 0; i < 5; i++) {
      await Deno.writeTextFile(join(tree, `f${i}`), "x");
    }
    assertEquals(await walkDirSizeBytes(tree, { maxEntries: 3 }), null);
    assert(await walkDirSizeBytes(tree, { maxEntries: 5 }) !== null);
    let tick = 0;
    assertEquals(
      await walkDirSizeBytes(tree, { now: () => tick++ * 100, timeoutMs: 150 }),
      null,
    );
    assertEquals(await walkDirSizeBytes(join(root, "missing")), null);
  });
});

Deno.test("defaultDirSizeBytes measures by walking when du cannot run, as on Windows (#4500 review)", async () => {
  await withRoot(async (root) => {
    await Deno.writeFile(join(root, "a.bin"), new Uint8Array(100_000));
    const noDu = async () => ({
      ok: false as const,
      error: new Error("du: command not found"),
    });
    const walked = await defaultDirSizeBytes(root, noDu);
    assert(walked !== null && walked >= 100_000, `measured ${walked}`);

    // A du timeout stays unmeasured: it is not retried with a slower walk.
    const timedOut = async () => ({
      ok: true as const,
      value: { timedOut: true, stdout: "", stderr: "", success: false },
    });
    assertEquals(
      // deno-lint-ignore no-explicit-any
      await defaultDirSizeBytes(root, timedOut as any),
      null,
    );
  });
});

Deno.test("with du unavailable, the reclaim still stops at the target and the largest list is size-ordered (#4500 review)", async () => {
  await withRoot(async (root) => {
    // Four stale caches whose size order runs against both their name order
    // and, for the removal, their age order; only the walk can size them.
    // zzz is the oldest and biggest, so it alone clears the floor.
    const specs = [
      { name: "zzz", size: 300_000, ageRank: 4 },
      { name: "mmm", size: 200_000, ageRank: 3 },
      { name: "bbb", size: 100_000, ageRank: 2 },
      { name: "aaa", size: 50_000, ageRank: 1 },
    ];
    for (const spec of specs) {
      const cache = await makeCache(root, spec.name, { ageMs: STALE_MS });
      await Deno.writeFile(join(cache, "blob.bin"), new Uint8Array(spec.size));
      await ageTree(cache, STALE_MS * spec.ageRank);
    }
    const noDu = async () => ({
      ok: false as const,
      error: new Error("du: command not found"),
    });
    const dirSizeBytes = (path: string) => defaultDirSizeBytes(path, noDu);

    const result = await reclaimHostCaches({
      freeBytes: 0,
      floorBytes: 250_000,
      headroomBytes: 0,
      minAgeMs: DAY,
      roots: [root],
      protect: [],
    }, {
      processSnapshot: NO_PROCESSES,
      dirSizeBytes,
      ownerUid: TEST_OWNER_UID,
    });
    assertEquals(removedPaths(result), [join(root, "zzz")]);
    assert(
      (result.removed[0]?.bytes ?? 0) >= 300_000,
      "the removal is sized, not null",
    );
    assertEquals(await exists(join(root, "mmm")), true);

    // Three directories remain. Size order is mmm, bbb, aaa; name order is
    // the reverse, so a name-only sort fails this, and trimming to two keeps
    // the largest rather than the alphabetically first.
    const largest = await largestHostDirectories([root], { dirSizeBytes });
    assertEquals(largest.map((d) => d.path), [
      join(root, "mmm"),
      join(root, "bbb"),
      join(root, "aaa"),
    ]);
    assert(largest.every((d) => d.bytes !== null));
    const top = await largestHostDirectories([root], { dirSizeBytes }, 2);
    assertEquals(top.map((d) => d.path), [
      join(root, "mmm"),
      join(root, "bbb"),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Removal safety on world-writable roots (#4500 review).
// ---------------------------------------------------------------------------

const POSIX_ONLY = { ignore: Deno.build.os === "windows" };

/** The real filesystem, with some paths' `lstat` or `realPath` answers replaced. */
function fsWith(
  stats: Record<string, Partial<FsStat>> = {},
  realPaths: Record<string, string | null> = {},
): HostCacheFs {
  return {
    ...realHostCacheFs,
    async lstat(path) {
      const real = await realHostCacheFs.lstat(path);
      const override = stats[path];
      return real !== null && override !== undefined
        ? { ...real, ...override }
        : real;
    },
    realPath(path) {
      return path in realPaths
        ? Promise.resolve(realPaths[path]!)
        : realHostCacheFs.realPath(path);
    },
  };
}

/** The uid that owns the test's real directories. */
async function ownUid(root: string): Promise<number> {
  const uid = (await Deno.lstat(root)).uid;
  assert(uid !== null, "a POSIX host reports a uid");
  return uid;
}

/** `root/sub/target`: a stale cache one directory below the root. */
async function nestedCache(
  root: string,
): Promise<{ sub: string; cache: string }> {
  const sub = join(root, "sub");
  await Deno.mkdir(sub);
  await Deno.chmod(sub, 0o755);
  const cache = await makeCache(sub, "target", { ageMs: STALE_MS });
  await Deno.chmod(cache, 0o755);
  return { sub, cache };
}

Deno.test({
  name:
    "removal: a candidate whose ancestor another account owns is skipped with a reason, and the same tree is removed when it is ours",
  ...POSIX_ONLY,
  fn: async () => {
    await withRoot(async (root) => {
      const { sub, cache } = await nestedCache(root);
      const ownerUid = await ownUid(root);

      const control = await reclaimHostCaches(
        oneGibOptions([root]),
        reclaimDeps({ ownerUid, fs: fsWith() }),
      );
      assertEquals(removedPaths(control), [cache], "ours: removed");

      const again = await nestedCache(await Deno.makeTempDir({ dir: root }));
      const foreign = await reclaimHostCaches(
        oneGibOptions([root]),
        reclaimDeps({
          ownerUid,
          fs: fsWith({ [again.sub]: { uid: ownerUid + 1 } }),
        }),
      );
      assertEquals(removedPaths(foreign), []);
      assertEquals(await exists(again.cache), true);
      const skip = foreign.skipped.find((s) => s.path === again.cache);
      assertStringIncludes(skip?.reason ?? "", "not removed");
      assertStringIncludes(skip?.reason ?? "", `owned by uid ${ownerUid + 1}`);
      assertEquals(sub === again.sub, false);
    });
  },
});

Deno.test({
  name:
    "removal: a foreign-owned candidate itself, and a candidate with no uid to check, are skipped",
  ...POSIX_ONLY,
  fn: async () => {
    await withRoot(async (root) => {
      const { cache } = await nestedCache(root);
      const ownerUid = await ownUid(root);
      for (const uid of [ownerUid + 1, null]) {
        const result = await reclaimHostCaches(
          oneGibOptions([root]),
          reclaimDeps({ ownerUid, fs: fsWith({ [cache]: { uid } }) }),
        );
        assertEquals(removedPaths(result), [], `uid ${uid}`);
        assertEquals(await exists(cache), true);
        assertStringIncludes(
          result.skipped.find((s) => s.path === cache)?.reason ?? "",
          "owned by uid",
        );
      }
    });
  },
});

Deno.test({
  name:
    "removal: a candidate or ancestor writable by group or others, or with no mode, is skipped; 0755 is removed",
  ...POSIX_ONLY,
  fn: async () => {
    await withRoot(async (root) => {
      const { sub, cache } = await nestedCache(root);
      const ownerUid = await ownUid(root);
      const refusals: Array<[string, Partial<FsStat>]> = [
        [sub, { mode: 0o40775 }],
        [sub, { mode: 0o40757 }],
        [cache, { mode: 0o40770 }],
        [cache, { mode: 0o40707 }],
        [cache, { mode: null }],
      ];
      for (const [path, override] of refusals) {
        const result = await reclaimHostCaches(
          oneGibOptions([root]),
          reclaimDeps({ ownerUid, fs: fsWith({ [path]: override }) }),
        );
        assertEquals(removedPaths(result), [], JSON.stringify(override));
        assertEquals(await exists(cache), true);
        assertStringIncludes(
          result.skipped.find((s) => s.path === cache)?.reason ?? "",
          "writable by its group or others",
        );
      }
      const control = await reclaimHostCaches(
        oneGibOptions([root]),
        reclaimDeps({ ownerUid, fs: fsWith({ [cache]: { mode: 0o40755 } }) }),
      );
      assertEquals(removedPaths(control), [cache]);
    });
  },
});

Deno.test({
  name:
    "removal: a candidate reached from two roots is judged from the shallower root, whichever root is listed first",
  ...POSIX_ONLY,
  fn: async () => {
    for (const shallowFirst of [true, false]) {
      await withRoot(async (root) => {
        const { sub, cache } = await nestedCache(root);
        const ownerUid = await ownUid(root);
        // `sub` is foreign-owned: judged when it is an ancestor (root is the
        // root), exempt when it is itself the root.
        const roots = shallowFirst ? [root, sub] : [sub, root];
        const result = await reclaimHostCaches(
          oneGibOptions(roots),
          reclaimDeps({
            ownerUid,
            fs: fsWith({ [sub]: { uid: ownerUid + 1 } }),
          }),
        );
        assertEquals(removedPaths(result), [], `shallowFirst ${shallowFirst}`);
        assertEquals(await exists(cache), true);
        assertStringIncludes(
          result.skipped.find((s) => s.path === cache)?.reason ?? "",
          `owned by uid ${ownerUid + 1}`,
        );
      });
    }
  },
});

Deno.test({
  name:
    "fs: the real lstat reports the permission bits and the owner of a directory",
  ...POSIX_ONLY,
  fn: async () => {
    await withRoot(async (root) => {
      const dir = join(root, "perm");
      await Deno.mkdir(dir);
      await Deno.chmod(dir, 0o750);
      const stat = await realHostCacheFs.lstat(dir);
      assert(stat !== null);
      assertEquals(stat.mode === null ? null : stat.mode & 0o777, 0o750);
      assertEquals(stat.uid, await ownUid(root));
    });
  },
});

Deno.test({
  name:
    "removal: the root itself is the boundary and is not judged, even when it is world-writable and foreign-owned like /tmp",
  ...POSIX_ONLY,
  fn: async () => {
    await withRoot(async (root) => {
      const cache = await makeCache(root, "target", { ageMs: STALE_MS });
      await Deno.chmod(cache, 0o755);
      const ownerUid = await ownUid(root);
      const result = await reclaimHostCaches(
        oneGibOptions([root]),
        reclaimDeps({
          ownerUid,
          fs: fsWith({ [root]: { uid: 0, mode: 0o41777 } }),
        }),
      );
      assertEquals(removedPaths(result), [cache]);
    });
  },
});

Deno.test({
  name: "removal: with no running uid known on a POSIX host nothing is removed",
  ...POSIX_ONLY,
  fn: async () => {
    await withRoot(async (root) => {
      const { cache } = await nestedCache(root);
      const result = await reclaimHostCaches(
        oneGibOptions([root]),
        reclaimDeps({ ownerUid: null, fs: fsWith() }),
      );
      assertEquals(removedPaths(result), []);
      assertEquals(await exists(cache), true);
      assertStringIncludes(
        result.skipped.find((s) => s.path === cache)?.reason ?? "",
        "running user could not be determined",
      );
    });
  },
});

Deno.test({
  name:
    "removal: a candidate whose real path has moved, or vanished, since the walk is skipped",
  ...POSIX_ONLY,
  fn: async () => {
    await withRoot(async (root) => {
      const { cache } = await nestedCache(root);
      const ownerUid = await ownUid(root);
      for (const moved of ["/elsewhere/target", null]) {
        const result = await reclaimHostCaches(
          oneGibOptions([root]),
          reclaimDeps({ ownerUid, fs: fsWith({}, { [cache]: moved }) }),
        );
        assertEquals(removedPaths(result), [], String(moved));
        assertEquals(await exists(cache), true);
        const reason = result.skipped.find((s) => s.path === cache)?.reason ??
          "";
        assertStringIncludes(reason, "now resolves to");
        assertStringIncludes(reason, moved ?? "nothing");
      }
    });
  },
});

Deno.test({
  name:
    "removal: an ancestor swapped for a symlink during the size measurement does not redirect the delete outside the root",
  ...POSIX_ONLY,
  fn: async () => {
    await withRoot(async (root) => {
      // `root/sub/target` is the candidate; `outside/target` is a same-named
      // directory the swap would point the delete at.
      const { sub, cache } = await nestedCache(root);
      const outsideDir = await Deno.makeTempDir({
        prefix: "host_cache_reclaim_outside_",
      });
      try {
        const outside = join(outsideDir, "target");
        // 0755, so only the symlink check can be what stops the delete.
        await mkdirOwned(outside);
        await Deno.writeTextFile(join(outside, "precious"), "keep");
        const ownerUid = await ownUid(root);

        const result = await reclaimHostCaches(
          oneGibOptions([root]),
          reclaimDeps({
            ownerUid,
            // The size measurement is the window the attacker has: swap the
            // ancestor for a symlink to a directory holding a same-named one.
            dirSizeBytes: async () => {
              await Deno.rename(sub, join(root, "sub.moved"));
              await Deno.symlink(outsideDir, sub);
              return GIB;
            },
          }),
        );
        assertEquals(removedPaths(result), []);
        assertEquals(await exists(join(outside, "precious")), true);
        assertStringIncludes(
          result.skipped.find((s) => s.path === cache)?.reason ?? "",
          "is a symbolic link",
        );
      } finally {
        await Deno.remove(outsideDir, { recursive: true });
      }
    });
  },
});

Deno.test("namesPath matches only at a path boundary", () => {
  assertEquals(namesPath("cargo --target /tmp/a/debug", "/tmp/a"), true);
  assertEquals(namesPath("cwd=/tmp/a", "/tmp/a"), true);
  assertEquals(namesPath("/tmp/ab", "/tmp/a"), false);
  assertEquals(namesPath("/tmp/a.old/debug", "/tmp/a"), false);
  assertEquals(namesPath("x/tmp/a", "/tmp/a"), false);
  assertEquals(namesPath("anything", ""), false);
});

Deno.test("largestHostDirectories sorts by size, keeps unmeasured entries last, and trims to n", async () => {
  await withRoot(async (root) => {
    // Sizes run against name order, and there are more directories than n, so
    // a sort by name alone, or a trim that keeps the first names, fails.
    const sizes: Record<string, number | null> = {
      [join(root, "aaa")]: GIB,
      [join(root, "bbb")]: null,
      [join(root, "ddd")]: 3 * GIB,
      [join(root, "mmm")]: 9 * GIB,
      [join(root, "zzz")]: 5 * GIB,
    };
    for (const dir of Object.keys(sizes)) await Deno.mkdir(dir);
    const dirSizeBytes = async (path: string) => sizes[path] ?? null;

    const all = await largestHostDirectories([root], { dirSizeBytes });
    assertEquals(
      all.map((d) => d.path),
      ["mmm", "zzz", "ddd", "aaa", "bbb"].map((name) => join(root, name)),
    );
    assertEquals(all[4]?.bytes, null, "unmeasured is reported, not dropped");

    const top = await largestHostDirectories([root], { dirSizeBytes }, 2);
    assertEquals(top.map((d) => d.path), [
      join(root, "mmm"),
      join(root, "zzz"),
    ]);
  });
});

Deno.test("defaultCacheRoots lists home src, tmp, the temp variables, then extras", () => {
  const env = (name: string) =>
    name === "TMPDIR" ? "/var/folders/tmp" : undefined;
  assertEquals(
    defaultCacheRoots("/home/u", env, ["/srv/builds"], "posix"),
    [
      "/home/u/src",
      "/tmp",
      "/private/tmp",
      "/var/folders/tmp",
      "/srv/builds",
    ],
  );
});

// ---------------------------------------------------------------------------
// Configuration.
// ---------------------------------------------------------------------------

Deno.test("config: an absent file means the defaults, with the reclaim on", async () => {
  await withRoot(async (root) => {
    const config = await readHostCacheReclaimConfig(join(root, "absent.json"));
    assertEquals(config.enabled, true);
    assertEquals(config.minAgeHours, 24);
    assertEquals(config.headroomGb, 10);
    assertEquals(config.extraRoots, []);
    assertEquals(config, DEFAULT_HOST_CACHE_RECLAIM_CONFIG);
  });
});

Deno.test("config: the four keys are read when present", () => {
  const config = parseHostCacheReclaimConfig({
    host_cache_reclaim_enabled: false,
    host_cache_reclaim_min_age_hours: 6,
    host_cache_reclaim_headroom_gb: 2.5,
    host_cache_reclaim_roots: ["/srv/builds"],
  });
  assertEquals(config.enabled, false);
  assertEquals(config.minAgeHours, 6);
  assertEquals(config.headroomGb, 2.5);
  assertEquals(config.extraRoots, ["/srv/builds"]);
});

Deno.test("config: a wrong-typed enabled key throws and names it", () => {
  assertThrows(
    () => parseHostCacheReclaimConfig({ host_cache_reclaim_enabled: "yes" }),
    Error,
    "host_cache_reclaim_enabled",
  );
});

Deno.test("config: a string minimum age throws and names the key", () => {
  assertThrows(
    () =>
      parseHostCacheReclaimConfig({ host_cache_reclaim_min_age_hours: "24" }),
    Error,
    "host_cache_reclaim_min_age_hours",
  );
});

Deno.test("config: a zero minimum age throws, as the key must be positive", () => {
  assertThrows(
    () => parseHostCacheReclaimConfig({ host_cache_reclaim_min_age_hours: 0 }),
    Error,
    "host_cache_reclaim_min_age_hours",
  );
});

Deno.test("config: a negative headroom throws and names the key", () => {
  assertThrows(
    () => parseHostCacheReclaimConfig({ host_cache_reclaim_headroom_gb: -1 }),
    Error,
    "host_cache_reclaim_headroom_gb",
  );
});

Deno.test("config: a relative extra root throws and names the key", () => {
  assertThrows(
    () => parseHostCacheReclaimConfig({ host_cache_reclaim_roots: ["builds"] }),
    Error,
    "host_cache_reclaim_roots",
  );
});

Deno.test("config: an unparseable file throws rather than defaulting", async () => {
  await withRoot(async (root) => {
    const file = join(root, ".config.json");
    await Deno.writeTextFile(file, "{ not json");
    let message = "";
    try {
      await readHostCacheReclaimConfig(file);
    } catch (error) {
      message = (error as Error).message;
    }
    assertStringIncludes(message, "not valid JSON");
  });
});

// ---------------------------------------------------------------------------
// The command: arguments, the disabled switch, and the message format.
// ---------------------------------------------------------------------------

/** Command deps that never touch the real `/tmp`, `ps` or `du`. */
function commandDeps(
  reclaim: Partial<HostCacheReclaimDeps> = {},
): ReclaimHostCachesDeps {
  return {
    env: () => undefined,
    defaultRoots: [],
    reclaim: reclaimDeps(reclaim),
  };
}

async function writeConfig(
  dir: string,
  record: Record<string, unknown>,
): Promise<string> {
  const path = join(dir, ".config.json");
  await Deno.writeTextFile(path, JSON.stringify(record));
  return path;
}

Deno.test("the command is registered under its own name", () => {
  assertEquals(reclaimHostCachesCommand.name, "reclaim-host-caches");
});

Deno.test("command: a disabled config removes nothing and says so", async () => {
  await withRoot(async (root) => {
    const cache = await makeCache(root, "stale-target", { ageMs: STALE_MS });
    const config = await writeConfig(root, {
      host_cache_reclaim_enabled: false,
      host_cache_reclaim_roots: [root],
    });
    const result = await runReclaimHostCaches(
      { config, "free-kb": "0", "floor-kb": String(KIB_PER_GIB) },
      commandDeps(),
    );
    assertEquals(result.success, true);
    assertEquals(
      result.message,
      `${HOST_CACHE_RECLAIM_TAG} disabled by host_cache_reclaim_enabled=false in ${config}`,
    );
    assertEquals(await exists(cache), true);
  });
});

Deno.test("command: free space above the floor says there is nothing to do", async () => {
  await withRoot(async (root) => {
    const cache = await makeCache(root, "stale-target", { ageMs: STALE_MS });
    const config = await writeConfig(root, {
      host_cache_reclaim_roots: [root],
    });
    const result = await runReclaimHostCaches(
      {
        config,
        "free-kb": String(2 * KIB_PER_GIB),
        "floor-kb": String(KIB_PER_GIB),
      },
      commandDeps(),
    );
    assertEquals(result.success, true);
    assertStringIncludes(result.message, "nothing to do");
    assertEquals(await exists(cache), true);
  });
});

Deno.test("command: each removal and the summary are logged, one tagged line each", async () => {
  await withRoot(async (root) => {
    const cache = await makeCache(root, "stale-target", { ageMs: STALE_MS });
    const config = await writeConfig(root, {
      host_cache_reclaim_roots: [root],
    });
    const result = await runReclaimHostCaches(
      { config, "free-kb": "0", "floor-kb": String(KIB_PER_GIB) },
      commandDeps({ dirSizeBytes: async () => 8 * GIB }),
    );
    assertEquals(result.success, true);
    assertEquals(await exists(cache), false);
    const lines = result.message.split("\n");
    assert(
      lines.every((line) => line.startsWith(HOST_CACHE_RECLAIM_TAG)),
      "every line carries the tag",
    );
    assertStringIncludes(
      result.message,
      `${HOST_CACHE_RECLAIM_TAG} removed ${cache} (8192.0 MB, idle 48.0 h)`,
    );
    assertStringIncludes(
      result.message,
      `${HOST_CACHE_RECLAIM_TAG} freed 8192.0 MB; est. free 8192.0 MB vs floor 1024.0 MB`,
    );
    assertEquals(
      result.message.includes("largest host directories"),
      false,
      "the floor is covered, so no largest-directories line",
    );
  });
});

Deno.test("command: still short after reclaim names the largest host directories, largest first", async () => {
  await withRoot(async (root) => {
    await makeCache(root, "stale-target", { ageMs: STALE_MS });
    // Ten directories, more than the eight the line names, whose size grows
    // with the name: the line must hold the eight largest, d9 first, and leave
    // out d0 and d1, which a name-ordered list would put first.
    for (let i = 0; i < 10; i++) await Deno.mkdir(join(root, `d${i}`));
    const config = await writeConfig(root, {
      host_cache_reclaim_roots: [root],
    });
    const result = await runReclaimHostCaches(
      { config, "free-kb": "0", "floor-kb": String(100 * KIB_PER_GIB) },
      commandDeps({
        dirSizeBytes: async (path) => {
          const index = /\/d(\d)$/.exec(path)?.[1];
          return index === undefined ? GIB / 2 : (Number(index) + 1) * GIB;
        },
      }),
    );
    assertEquals(result.success, true, "still short is a successful run");
    const largest = result.message
      .split("\n")
      .find((line) => line.includes("largest host directories: "));
    assert(largest !== undefined, "the largest-directories line is present");
    assertStringIncludes(
      largest,
      `${HOST_CACHE_RECLAIM_TAG} largest host directories: `,
    );
    const named = largest.split("largest host directories: ")[1]!.split("; ");
    assertEquals(
      named.map((entry) => entry.slice(root.length + 1, root.length + 3)),
      ["d9", "d8", "d7", "d6", "d5", "d4", "d3", "d2"],
    );
    assertStringIncludes(named[0]!, "(10.0 GB)");
    assertEquals(largest.includes(join(root, "d1")), false);
  });
});

Deno.test("command: a process table failure is an unsuccessful run that removes nothing", async () => {
  await withRoot(async (root) => {
    const cache = await makeCache(root, "stale-target", { ageMs: STALE_MS });
    const config = await writeConfig(root, {
      host_cache_reclaim_roots: [root],
    });
    const result = await runReclaimHostCaches(
      { config, "free-kb": "0", "floor-kb": String(KIB_PER_GIB) },
      commandDeps({
        processSnapshot: async () => {
          throw new Error("ps exited 1");
        },
      }),
    );
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "ps exited 1");
    assertEquals(await exists(cache), true);
  });
});

Deno.test("command: --protect given as an array keeps the named cache", async () => {
  await withRoot(async (root) => {
    const cache = await makeCache(root, "stale-target", { ageMs: STALE_MS });
    const config = await writeConfig(root, {
      host_cache_reclaim_roots: [root],
    });
    const result = await runReclaimHostCaches(
      {
        config,
        "free-kb": "0",
        "floor-kb": String(KIB_PER_GIB),
        protect: [cache],
      },
      commandDeps(),
    );
    assertEquals(result.success, true);
    assertEquals(await exists(cache), true);
    assertStringIncludes(
      result.message,
      `${HOST_CACHE_RECLAIM_TAG} skipped ${cache}: contains or equals the protected path`,
    );
  });
});

Deno.test("command: --protect given as a single string keeps the named cache", async () => {
  await withRoot(async (root) => {
    const cache = await makeCache(root, "stale-target", { ageMs: STALE_MS });
    const config = await writeConfig(root, {
      host_cache_reclaim_roots: [root],
    });
    const result = await runReclaimHostCaches(
      {
        config,
        "free-kb": "0",
        "floor-kb": String(KIB_PER_GIB),
        protect: cache,
      },
      commandDeps(),
    );
    assertEquals(result.success, true);
    assertEquals(await exists(cache), true);
  });
});

Deno.test("command: a missing --config is refused", async () => {
  const result = await runReclaimHostCaches(
    { "free-kb": "0", "floor-kb": "1" },
    commandDeps(),
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--config");
});

/** A checkout with an enabled `.config.json`, and a moved config beside it. */
async function movedConfigFixture(
  root: string,
  moved: Record<string, unknown>,
): Promise<{ baseDir: string; movedPath: string; cache: string }> {
  const baseDir = join(root, "checkout");
  await Deno.mkdir(baseDir);
  await writeConfig(baseDir, { host_cache_reclaim_enabled: true });
  const movedDir = join(root, "moved");
  await Deno.mkdir(movedDir);
  const movedPath = join(movedDir, "config.json");
  await Deno.writeTextFile(movedPath, JSON.stringify(moved));
  const cache = await makeCache(root, "stale-target", { ageMs: STALE_MS });
  return { baseDir, movedPath, cache };
}

for (const variable of ["CONFIG_FILE", "CONFIG_PATH"]) {
  Deno.test(`command: a config moved with ${variable} is the one read, so a disabled reclaim removes nothing (Issue #750)`, async () => {
    await withRoot(async (root) => {
      const { baseDir, movedPath, cache } = await movedConfigFixture(root, {
        host_cache_reclaim_enabled: false,
      });
      const args = {
        "base-dir": baseDir,
        "free-kb": "0",
        "floor-kb": String(KIB_PER_GIB),
      };
      const deps = (path: string): ReclaimHostCachesDeps => ({
        ...commandDeps(),
        env: (name) => name === variable ? path : undefined,
        defaultRoots: [root],
      });

      const result = await runReclaimHostCaches(args, deps(movedPath));
      assertEquals(result.success, true);
      assertStringIncludes(result.message, "disabled by");
      assertStringIncludes(result.message, movedPath);
      assertEquals(await exists(cache), true, "nothing is removed");

      // Positive control: with no variable the checkout's enabled file is
      // read, and the same cache is removed, so the disabled file above is
      // what stopped it.
      const control = await runReclaimHostCaches(args, {
        ...commandDeps(),
        defaultRoots: [root],
      });
      assertEquals(control.success, true);
      assertEquals(await exists(cache), false, "the checkout's config applies");
    });
  });
}

Deno.test("command: --base-dir resolves a relative CONFIG_FILE against the checkout, and two different files are refused (Issue #750)", async () => {
  await withRoot(async (root) => {
    const { baseDir, cache } = await movedConfigFixture(root, {
      host_cache_reclaim_enabled: false,
    });
    const args = {
      "base-dir": baseDir,
      "free-kb": "0",
      "floor-kb": String(KIB_PER_GIB),
    };
    const relative = await runReclaimHostCaches(args, {
      ...commandDeps(),
      env: (name) =>
        name === "CONFIG_FILE" ? "../moved/config.json" : undefined,
      defaultRoots: [root],
    });
    assertStringIncludes(relative.message, "disabled by");
    assertEquals(await exists(cache), true);

    const split = await runReclaimHostCaches(args, {
      ...commandDeps(),
      env: (name) =>
        name === "CONFIG_FILE"
          ? join(root, "moved", "config.json")
          : name === "CONFIG_PATH"
          ? join(baseDir, ".config.json")
          : undefined,
      defaultRoots: [root],
    });
    assertEquals(split.success, false);
    assertStringIncludes(split.message, "CONFIG_FILE and CONFIG_PATH");
    assertEquals(await exists(cache), true, "a split config removes nothing");
  });
});

Deno.test("command: execute delegates to runReclaimHostCaches", async () => {
  // The command ignores the worker config, so an empty stand-in suffices.
  const result = await reclaimHostCachesCommand.execute(
    { "free-kb": "0", "floor-kb": "1" },
    {} as Parameters<typeof reclaimHostCachesCommand.execute>[1],
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--config");
});

Deno.test("command: garbage numeric flags are refused", async () => {
  await withRoot(async (root) => {
    const config = await writeConfig(root, {});
    const badValues: Array<[Record<string, unknown>, string]> = [
      [{ "free-kb": "abc", "floor-kb": "1" }, "--free-kb"],
      [{ "free-kb": "0", "floor-kb": "-5" }, "--floor-kb"],
      [{ "free-kb": "0", "floor-kb": "1.5" }, "--floor-kb"],
      [{ "free-kb": 2.5, "floor-kb": "1" }, "--free-kb"],
      [{ "free-kb": -1, "floor-kb": "1" }, "--free-kb"],
      [{ "free-kb": 0, "floor-kb": -1 }, "--floor-kb"],
      [{ "floor-kb": "1" }, "--free-kb"],
      [{ "free-kb": true, "floor-kb": "1" }, "--free-kb"],
      [{ "free-kb": "0", "floor-kb": null }, "--floor-kb"],
    ];
    for (const [flags, flagName] of badValues) {
      const result = await runReclaimHostCaches(
        { config, ...flags },
        commandDeps(),
      );
      assertEquals(result.success, false, `refused ${JSON.stringify(flags)}`);
      assertStringIncludes(result.message, flagName);
    }
  });
});

Deno.test("command: a non-string --protect entry is refused, not dropped", async () => {
  await withRoot(async (root) => {
    const config = await writeConfig(root, {});
    const result = await runReclaimHostCaches(
      { config, "free-kb": "0", "floor-kb": "1", protect: [42] },
      commandDeps(),
    );
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "--protect");
  });
});

Deno.test("command: an unreadable config is refused", async () => {
  await withRoot(async (root) => {
    const config = join(root, ".config.json");
    await Deno.writeTextFile(config, "[1, 2, 3]");
    const result = await runReclaimHostCaches(
      { config, "free-kb": "0", "floor-kb": "1" },
      commandDeps(),
    );
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "not a JSON object");
  });
});

/** Runs `fn` with `Deno[name]` replaced, restoring it afterwards. */
async function withDenoPatch<K extends "open" | "lstat" | "readDir">(
  name: K,
  patch: (original: (typeof Deno)[K]) => (typeof Deno)[K],
  fn: () => Promise<void>,
): Promise<void> {
  const original = Deno[name];
  // deno-lint-ignore no-explicit-any
  (Deno as any)[name] = patch(original);
  try {
    await fn();
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any)[name] = original;
  }
}

Deno.test("reading a tag prefix closes the file it opened (#4500 review)", async () => {
  await withRoot(async (root) => {
    const tag = join(root, CACHEDIR_TAG_FILENAME);
    await Deno.writeTextFile(tag, `${CACHEDIR_TAG_SIGNATURE}\n`);
    let opened = 0;
    let closed = 0;
    await withDenoPatch("open", (original) =>
      // deno-lint-ignore no-explicit-any
      (async (...args: any[]) => {
        // deno-lint-ignore no-explicit-any
        const file = await (original as any)(...args);
        opened++;
        const close = file.close.bind(file);
        file.close = () => {
          closed++;
          close();
        };
        return file;
      }) as typeof Deno.open, async () => {
      const reading = await realHostCacheFs.readTagFile(tag);
      assertEquals(reading.state, "file");
    });
    assertEquals(opened, 1);
    assertEquals(closed, 1);
  });
});

Deno.test("walkDirSizeBytes counts a sparse file by its allocated blocks, and by apparent size where the platform reports none (#4500 review)", async () => {
  await withRoot(async (root) => {
    const tree = join(root, "tree");
    await Deno.mkdir(tree);
    const sparse = join(tree, "sparse.bin");
    await Deno.writeTextFile(sparse, "x");
    await Deno.truncate(sparse, 50_000_000);
    const real = await Deno.lstat(sparse);
    if (real.blocks === null) return; // a platform that reports no blocks
    const allocated = await walkDirSizeBytes(tree);
    assert(
      allocated !== null && allocated < 5_000_000,
      `counted apparent size ${allocated}`,
    );

    // Where blocks are unreported (Windows), the apparent size is summed.
    await withDenoPatch("lstat", (original) =>
      (async (path: string | URL) => {
        const info = await original(path);
        return { ...info, blocks: null } as Deno.FileInfo;
      }) as typeof Deno.lstat, async () => {
      const apparent = await walkDirSizeBytes(tree);
      assert(
        apparent !== null && apparent >= 50_000_000,
        `counted allocated blocks ${apparent}`,
      );
    });
  });
});

Deno.test("walkDirSizeBytes stops when the budget runs out inside a subdirectory, and descends only into real directories (#4500 review)", async () => {
  await withRoot(async (root) => {
    const tree = join(root, "tree");
    await Deno.mkdir(join(tree, "sub"), { recursive: true });
    for (let i = 0; i < 5; i++) {
      await Deno.writeTextFile(join(tree, "sub", `f${i}`), "x");
    }
    await Deno.writeTextFile(join(tree, "plain.txt"), "x");
    // One top-level directory, then the budget runs out among its files.
    assertEquals(await walkDirSizeBytes(tree, { maxEntries: 4 }), null);
    assert(await walkDirSizeBytes(tree, { maxEntries: 7 }) !== null);

    // Positive control above; now see which paths the walk lists.
    const listed: string[] = [];
    await withDenoPatch("readDir", (original) =>
      ((path: string | URL) => {
        listed.push(String(path));
        return original(path);
      }) as typeof Deno.readDir, async () => {
      assert(await walkDirSizeBytes(tree) !== null);
    });
    assertEquals(listed.sort(), [tree, join(tree, "sub")].sort());
  });
});

Deno.test("walkDirSizeBytes skips an unreadable subdirectory but not an unreadable root (#4500 review)", async () => {
  await withRoot(async (root) => {
    const tree = join(root, "tree");
    const locked = join(tree, "locked");
    await Deno.mkdir(locked, { recursive: true });
    await Deno.writeFile(join(tree, "a.bin"), new Uint8Array(100_000));
    await Deno.writeFile(join(locked, "hidden.bin"), new Uint8Array(100_000));
    await withDenoPatch("readDir", (original) =>
      ((path: string | URL) => {
        if (String(path) === locked) {
          throw new Deno.errors.PermissionDenied("locked");
        }
        return original(path);
      }) as typeof Deno.readDir, async () => {
      const partial = await walkDirSizeBytes(tree);
      assert(partial !== null && partial >= 100_000, `measured ${partial}`);
      assert(partial < 200_000, `read the locked directory: ${partial}`);
      assertEquals(await walkDirSizeBytes(locked), null);
    });
  });
});

Deno.test("defaultDirSizeBytes takes a valid du figure and walks instead for an unusable one (#4500 review)", async () => {
  await withRoot(async (root) => {
    await Deno.writeFile(join(root, "a.bin"), new Uint8Array(100_000));
    const du = (stdout: string) => async () => ({
      ok: true as const,
      value: { timedOut: false, stdout, stderr: "", success: true },
    });
    assertEquals(
      // deno-lint-ignore no-explicit-any
      await defaultDirSizeBytes(root, du(`12\t${root}\n`) as any),
      12 * 1024,
    );
    assertEquals(
      // deno-lint-ignore no-explicit-any
      await defaultDirSizeBytes(root, du(`0\t${root}\n`) as any),
      0,
    );
    for (
      const bad of [`-5\t${root}\n`, `Infinity\t${root}\n`, "not a size\n"]
    ) {
      // deno-lint-ignore no-explicit-any
      const bytes = await defaultDirSizeBytes(root, du(bad) as any);
      assert(
        bytes !== null && Number.isFinite(bytes) && bytes >= 100_000,
        `${JSON.stringify(bad)} gave ${bytes}`,
      );
    }
  });
});
