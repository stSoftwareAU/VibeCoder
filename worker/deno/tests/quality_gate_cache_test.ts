/**
 * Tests for the content-addressed quality-gate cache (Issue #86).
 *
 * The security-relevant property is that a cached PASS is reused **only** when
 * the input digest is byte-identical to the run that produced it. A skip is
 * only as sound as its key, so the `deno tests` key covers the whole working
 * tree as git sees it (Issue #3392), not just `.ts` files.
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  cachedPassAt,
  computeQualityInputDigest,
  computeWorkingTreeDigest,
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

// =============================================================================
// computeWorkingTreeDigest (Issue #3392)
// =============================================================================

async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(
    out.success,
    `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
  );
  return new TextDecoder().decode(out.stdout);
}

async function put(root: string, rel: string, text: string): Promise<void> {
  const full = `${root}/${rel}`;
  await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(full, text);
}

async function tempRepo(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "qgc_repo_" });
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "t@example.com");
  await git(root, "config", "user.name", "T");
  await put(root, "worker/deno/lib/a.ts", "export const a = 1;\n");
  await put(root, "docs/archive/pr-summaries/pr-summary-1.md", "# one\n");
  await put(root, "prompts/issue/prompt.md", "prompt\n");
  await put(root, ".github/workflows/ci.yml", "name: ci\n");
  await put(root, "scripts/x.sh", "echo hi\n");
  await put(root, "container/Dockerfile", "FROM scratch\n");
  await put(root, ".gitignore", "ignored.log\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "init");
  return root;
}

async function withRepo(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await tempRepo();
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("computeWorkingTreeDigest - unchanged tree is stable and a recorded PASS is reused", async () => {
  await withRepo(async (root) => {
    const d1 = await computeWorkingTreeDigest(root);
    assert(d1 !== null && d1.startsWith("git-tree:"), `got ${d1}`);
    assertEquals(await computeWorkingTreeDigest(root), d1);
    const cacheDir = await Deno.makeTempDir({ prefix: "qgc_cache_" });
    try {
      await recordPass(cacheDir, "deno tests", d1, "T0");
      assertEquals(await cachedPassAt(cacheDir, "deno tests", d1), "T0");
    } finally {
      await Deno.remove(cacheDir, { recursive: true });
    }
  });
});

Deno.test("computeWorkingTreeDigest - editing only a .md busts a recorded PASS", async () => {
  for (
    const rel of [
      "docs/archive/pr-summaries/pr-summary-1.md",
      "prompts/issue/prompt.md",
    ]
  ) {
    await withRepo(async (root) => {
      const cacheDir = await Deno.makeTempDir({ prefix: "qgc_cache_" });
      try {
        const old = await computeWorkingTreeDigest(root);
        await recordPass(cacheDir, "deno tests", old, "T0");
        await put(root, rel, "edited\n");
        const fresh = await computeWorkingTreeDigest(root);
        assertNotEquals(fresh, old, rel);
        assertEquals(await cachedPassAt(cacheDir, "deno tests", fresh), null);
      } finally {
        await Deno.remove(cacheDir, { recursive: true });
      }
    });
  }
});

Deno.test("computeWorkingTreeDigest - editing only a .yml, .sh or Dockerfile changes it", async () => {
  for (
    const rel of [
      ".github/workflows/ci.yml",
      "scripts/x.sh",
      "container/Dockerfile",
    ]
  ) {
    await withRepo(async (root) => {
      const old = await computeWorkingTreeDigest(root);
      await put(root, rel, "edited\n");
      assertNotEquals(await computeWorkingTreeDigest(root), old, rel);
    });
  }
});

Deno.test("computeWorkingTreeDigest - untracked files count; ignored and excluded files do not", async () => {
  await withRepo(async (root) => {
    const base = await computeWorkingTreeDigest(root);
    await put(root, "ignored.log", "noise\n");
    await put(root, "state/worker.json", "{}\n");
    await Deno.mkdir(`${root}/.git/info`, { recursive: true });
    await Deno.writeTextFile(`${root}/.git/info/exclude`, "state/\n");
    assertEquals(await computeWorkingTreeDigest(root), base);
    await put(root, "docs/new.md", "new\n");
    assertNotEquals(await computeWorkingTreeDigest(root), base);
  });
});

Deno.test("computeWorkingTreeDigest - never touches the real index", async () => {
  await withRepo(async (root) => {
    await put(root, "docs/archive/pr-summaries/pr-summary-1.md", "edited\n");
    const before = await Deno.readFile(`${root}/.git/index`);
    assert(await computeWorkingTreeDigest(root) !== null);
    assertEquals(await Deno.readFile(`${root}/.git/index`), before);
    const status = await git(root, "status", "--porcelain");
    assertEquals(status, " M docs/archive/pr-summaries/pr-summary-1.md\n");
  });
});

Deno.test("computeWorkingTreeDigest - a non-git directory is null (caching off)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "qgc_nogit_" });
  try {
    // Make sure no enclosing repo is discovered from the temp dir.
    const prev = Deno.env.get("GIT_CEILING_DIRECTORIES");
    Deno.env.set(
      "GIT_CEILING_DIRECTORIES",
      dir.slice(0, dir.lastIndexOf("/")) || "/",
    );
    try {
      const digest = await computeWorkingTreeDigest(dir);
      assertEquals(digest, null);
      assertEquals(
        await cachedPassAt("/tmp/unused", "deno tests", digest),
        null,
      );
    } finally {
      if (prev === undefined) Deno.env.delete("GIT_CEILING_DIRECTORIES");
      else Deno.env.set("GIT_CEILING_DIRECTORIES", prev);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cachedPassAt - an old-shape bare sha-256 entry never matches a git-tree digest", async () => {
  await withRepo(async (root) => {
    const cacheDir = await Deno.makeTempDir({ prefix: "qgc_cache_" });
    try {
      const old = await computeQualityInputDigest(`${root}/worker/deno`);
      assert(old !== null && /^[0-9a-f]{64}$/.test(old));
      await Deno.writeTextFile(
        `${cacheDir}/quality-gate-cache.json`,
        JSON.stringify({
          "deno tests": { digest: old, status: "PASSED", at: "T0" },
        }),
      );
      const fresh = await computeWorkingTreeDigest(root);
      assert(fresh !== null && fresh.startsWith("git-tree:"));
      assertEquals(await cachedPassAt(cacheDir, "deno tests", fresh), null);
    } finally {
      await Deno.remove(cacheDir, { recursive: true });
    }
  });
});

Deno.test("computeWorkingTreeDigest - leaves no vibe_gate_index_ temp dir behind", async () => {
  const tmpRoot = Deno.env.get("TMPDIR") ?? "/tmp";
  const list = async () => {
    const names = new Set<string>();
    for await (const e of Deno.readDir(tmpRoot)) {
      if (e.name.startsWith("vibe_gate_index_")) names.add(e.name);
    }
    return names;
  };
  await withRepo(async (root) => {
    const before = await list();
    assert(await computeWorkingTreeDigest(root) !== null);
    const after = await list();
    for (const name of after) {
      assert(before.has(name), `leaked temp dir ${name}`);
    }
  });
});

Deno.test("computeWorkingTreeDigest - a failing git add (corrupt index) is null, not a digest", async () => {
  await withRepo(async (root) => {
    await Deno.writeTextFile(`${root}/.git/index`, "not an index\n");
    assertEquals(await computeWorkingTreeDigest(root), null);
  });
});

Deno.test({
  name:
    "computeWorkingTreeDigest - an unreadable untracked file makes git add fail, so null",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withRepo(async (root) => {
      const path = `${root}/docs/unreadable.md`;
      await put(root, "docs/unreadable.md", "secret\n");
      await Deno.chmod(path, 0o000);
      try {
        // Root reads through mode 000 (and Deno.uid() needs --allow-sys), so
        // probe instead: skip when the file is still readable.
        const readable = await Deno.readFile(path).then(
          () => true,
          () => false,
        );
        if (readable) return;
        assertEquals(await computeWorkingTreeDigest(root), null);
      } finally {
        await Deno.chmod(path, 0o644);
      }
    });
  },
});

Deno.test("computeWorkingTreeDigest - a failing git write-tree (missing blob) is null, not a digest", async () => {
  await withRepo(async (root) => {
    // Age the file so its index entry is not racily clean, refresh the entry,
    // then delete its blob: `git add -A` sees it unchanged and writes nothing,
    // so only `git write-tree` notices the object is gone.
    const past = new Date(Date.now() - 3_600_000);
    await Deno.utime(`${root}/scripts/x.sh`, past, past);
    await git(root, "add", "scripts/x.sh");
    const oid = (await git(root, "rev-parse", "HEAD:scripts/x.sh")).trim();
    const obj = `${root}/.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
    await Deno.chmod(obj, 0o644);
    await Deno.remove(obj);
    assertEquals(await computeWorkingTreeDigest(root), null);
  });
});
