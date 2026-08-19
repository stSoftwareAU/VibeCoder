/**
 * Tests for the `setupRepo` fast-path that skips `git fetch origin` when
 * the local clone already matches the remote tip (Issue #1810, parent #1804).
 *
 * The logic lives in `lib/remote_sha_cache.ts`. We exercise it directly
 * against a local file://-protocol fixture so the tests do not need any
 * network or GitHub access.
 *
 * Coverage:
 *   - matching SHA → `upToDate: true`, no fetch needed
 *   - diverging SHA → `upToDate: false`
 *   - ls-remote failure (broken remote) → falls back, no crash
 *   - cache hit within TTL → no second `git ls-remote` call
 *   - cache miss after TTL expiry → fresh lookup
 *   - missing local origin/<branch> ref → `upToDate: false`
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  clearRemoteShaCache,
  getLocalRemoteTrackingSha,
  getRemoteHeadSha,
  invalidateRemoteShaCache,
  isLocalDefaultBranchUpToDate,
  setRemoteShaCacheClockForTesting,
} from "../lib/remote_sha_cache.ts";
import { setupRepo } from "../commands/git_operations.ts";

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(
  args: string[],
  cwd: string,
): Promise<GitRunResult> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/**
 * Build a tiny upstream/downstream fixture. Returns paths and helpers.
 *
 * The downstream is a shallow clone of the upstream, mirroring the
 * production `--depth=1 --no-single-branch` shape.
 */
async function buildFixture(): Promise<{
  tmp: string;
  upstream: string;
  downstream: string;
  cleanup: () => Promise<void>;
}> {
  const tmp = await Deno.makeTempDir({ prefix: "skip_fetch_test_" });
  const upstream = `${tmp}/upstream`;
  const downstream = `${tmp}/downstream`;
  await Deno.mkdir(upstream, { recursive: true });

  assertEquals((await runGit(["init", "-b", "main"], upstream)).code, 0);
  await runGit(["config", "user.email", "t@t"], upstream);
  await runGit(["config", "user.name", "t"], upstream);
  await Deno.writeTextFile(`${upstream}/file.txt`, "first\n");
  await runGit(["add", "file.txt"], upstream);
  await runGit(["commit", "-m", "first"], upstream);

  const clone = await runGit(
    [
      "clone",
      "--depth=1",
      "--no-single-branch",
      `file://${upstream}`,
      downstream,
    ],
    tmp,
  );
  assertEquals(clone.code, 0, `clone failed: ${clone.stderr}`);

  return {
    tmp,
    upstream,
    downstream,
    cleanup: async () => {
      await Deno.remove(tmp, { recursive: true });
    },
  };
}

// ---------------------------------------------------------------------------
// getLocalRemoteTrackingSha
// ---------------------------------------------------------------------------

Deno.test(
  "getLocalRemoteTrackingSha - returns the cached origin/<branch> SHA",
  async () => {
    clearRemoteShaCache();
    const { downstream, cleanup } = await buildFixture();
    try {
      const sha = await getLocalRemoteTrackingSha(downstream, "main");
      assert(sha !== null, "expected a SHA, got null");
      if (sha) assertEquals(sha.length, 40);
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "getLocalRemoteTrackingSha - returns null for a missing ref",
  async () => {
    clearRemoteShaCache();
    const { downstream, cleanup } = await buildFixture();
    try {
      const sha = await getLocalRemoteTrackingSha(downstream, "no-such-branch");
      assertEquals(sha, null);
    } finally {
      await cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// getRemoteHeadSha — caching behaviour
// ---------------------------------------------------------------------------

Deno.test(
  "getRemoteHeadSha - first lookup is fresh, second within TTL is cached",
  async () => {
    clearRemoteShaCache();
    const { downstream, cleanup } = await buildFixture();
    try {
      const first = await getRemoteHeadSha(downstream, "main");
      assertEquals(first.source, "fresh");
      assert(first.sha !== null);

      const second = await getRemoteHeadSha(downstream, "main");
      assertEquals(second.source, "cache");
      assertEquals(second.sha, first.sha);
    } finally {
      clearRemoteShaCache();
      await cleanup();
    }
  },
);

Deno.test(
  "getRemoteHeadSha - cache expires after TTL (clock advances past 60 s)",
  async () => {
    clearRemoteShaCache();
    const { downstream, cleanup } = await buildFixture();

    // Pin the clock so we can deterministically jump past the TTL.
    let nowMs = 1_000_000;
    const restoreClock = setRemoteShaCacheClockForTesting(() => nowMs);

    try {
      const first = await getRemoteHeadSha(downstream, "main");
      assertEquals(first.source, "fresh");

      // Advance past the 60 s TTL — next call must be fresh again.
      nowMs += 60_001;
      const second = await getRemoteHeadSha(downstream, "main");
      assertEquals(second.source, "fresh");
      assertEquals(second.sha, first.sha);
    } finally {
      restoreClock();
      clearRemoteShaCache();
      await cleanup();
    }
  },
);

Deno.test(
  "getRemoteHeadSha - invalidate drops the cache entry",
  async () => {
    clearRemoteShaCache();
    const { downstream, cleanup } = await buildFixture();
    try {
      const first = await getRemoteHeadSha(downstream, "main");
      assertEquals(first.source, "fresh");

      invalidateRemoteShaCache(downstream, "main");

      const second = await getRemoteHeadSha(downstream, "main");
      assertEquals(second.source, "fresh");
    } finally {
      clearRemoteShaCache();
      await cleanup();
    }
  },
);

Deno.test(
  "getRemoteHeadSha - returns null sha when the remote is unreachable",
  async () => {
    clearRemoteShaCache();
    const tmp = await Deno.makeTempDir({ prefix: "skip_fetch_unreach_" });
    try {
      // Build a repo whose origin points at a path that does not exist.
      assertEquals((await runGit(["init", "-b", "main"], tmp)).code, 0);
      await runGit(["config", "user.email", "t@t"], tmp);
      await runGit(["config", "user.name", "t"], tmp);
      await Deno.writeTextFile(`${tmp}/x.txt`, "x");
      await runGit(["add", "x.txt"], tmp);
      await runGit(["commit", "-m", "x"], tmp);
      await runGit(
        ["remote", "add", "origin", `${tmp}/does-not-exist`],
        tmp,
      );

      const result = await getRemoteHeadSha(tmp, "main");
      assertEquals(result.sha, null);
      assert(
        (result.detail ?? "").length > 0,
        "expected a non-empty failure detail",
      );
    } finally {
      clearRemoteShaCache();
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// isLocalDefaultBranchUpToDate — the integration the caller actually uses
// ---------------------------------------------------------------------------

Deno.test(
  "isLocalDefaultBranchUpToDate - reports up-to-date when SHAs match",
  async () => {
    clearRemoteShaCache();
    const { downstream, cleanup } = await buildFixture();
    try {
      const result = await isLocalDefaultBranchUpToDate(downstream, "main");
      assertEquals(result.upToDate, true);
      assert(result.remoteSha !== null);
      assertEquals(result.localSha, result.remoteSha);
    } finally {
      clearRemoteShaCache();
      await cleanup();
    }
  },
);

Deno.test(
  "isLocalDefaultBranchUpToDate - reports diverged when upstream advances",
  async () => {
    clearRemoteShaCache();
    const { upstream, downstream, cleanup } = await buildFixture();
    try {
      // Capture the SHA the downstream knows about right now.
      const before = await isLocalDefaultBranchUpToDate(downstream, "main");
      assertEquals(before.upToDate, true);

      // Advance the upstream by one commit. The downstream's
      // `origin/main` ref still points at the old commit until a fetch
      // runs — exactly the divergence case the fast path must catch.
      await Deno.writeTextFile(`${upstream}/file.txt`, "second\n");
      await runGit(["add", "file.txt"], upstream);
      await runGit(["commit", "-m", "second"], upstream);

      // Invalidate the cached ls-remote answer, otherwise the fast path
      // would return the previous remote SHA.
      invalidateRemoteShaCache(downstream, "main");

      const after = await isLocalDefaultBranchUpToDate(downstream, "main");
      assertEquals(after.upToDate, false);
      assert(after.remoteSha !== null);
      assert(after.localSha !== null);
      assert(after.remoteSha !== after.localSha);
    } finally {
      clearRemoteShaCache();
      await cleanup();
    }
  },
);

Deno.test(
  "isLocalDefaultBranchUpToDate - falls back gracefully when ls-remote fails",
  async () => {
    clearRemoteShaCache();
    const tmp = await Deno.makeTempDir({ prefix: "skip_fetch_fallback_" });
    try {
      assertEquals((await runGit(["init", "-b", "main"], tmp)).code, 0);
      await runGit(["config", "user.email", "t@t"], tmp);
      await runGit(["config", "user.name", "t"], tmp);
      await Deno.writeTextFile(`${tmp}/x.txt`, "x");
      await runGit(["add", "x.txt"], tmp);
      await runGit(["commit", "-m", "x"], tmp);
      await runGit(
        ["remote", "add", "origin", `${tmp}/does-not-exist`],
        tmp,
      );

      const result = await isLocalDefaultBranchUpToDate(tmp, "main");
      assertEquals(result.upToDate, false);
      assertEquals(result.remoteSha, null);
      assert(result.reason.startsWith("ls-remote unavailable"));
    } finally {
      clearRemoteShaCache();
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "isLocalDefaultBranchUpToDate - reports diverged when local origin ref is missing",
  async () => {
    clearRemoteShaCache();
    const { upstream, downstream, cleanup } = await buildFixture();
    try {
      // Push a brand-new branch to upstream that downstream has never seen.
      await runGit(["checkout", "-b", "experimental"], upstream);
      await Deno.writeTextFile(`${upstream}/exp.txt`, "exp\n");
      await runGit(["add", "exp.txt"], upstream);
      await runGit(["commit", "-m", "exp"], upstream);

      const result = await isLocalDefaultBranchUpToDate(
        downstream,
        "experimental",
      );
      assertEquals(result.upToDate, false);
      assert(result.remoteSha !== null);
      assertEquals(result.localSha, null);
      assert(result.reason.includes("no local origin/experimental ref"));
    } finally {
      clearRemoteShaCache();
      await cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// setupRepo wiring — end-to-end on a local fixture
// ---------------------------------------------------------------------------

/**
 * Read FETCH_HEAD's mtime in milliseconds. Returns `null` if the file
 * does not exist (fresh clone). `git fetch` rewrites FETCH_HEAD on
 * every invocation, so comparing mtime before/after a setupRepo call is
 * a reliable signal for "did we fetch?".
 */
async function fetchHeadMtimeMs(repoPath: string): Promise<number | null> {
  try {
    const stat = await Deno.stat(`${repoPath}/.git/FETCH_HEAD`);
    return stat.mtime ? stat.mtime.getTime() : null;
  } catch {
    return null;
  }
}

Deno.test(
  "setupRepo - fast path: when local matches remote, FETCH_HEAD is not rewritten",
  async () => {
    clearRemoteShaCache();
    const { tmp, downstream, cleanup } = await buildFixture();
    try {
      // The downstream sits inside `${tmp}` already named "downstream".
      // setupRepo computes repoPath = ${workDir}/${repoName}, so we point
      // workDir at tmp and pass repo "owner/downstream".
      const workDir = tmp;
      const repo = "owner/downstream";

      // Force one fetch first so FETCH_HEAD exists with a known mtime.
      await runGit(["fetch", "origin"], downstream);
      const before = await fetchHeadMtimeMs(downstream);
      assert(before !== null, "FETCH_HEAD should exist after initial fetch");

      // Wait long enough that any subsequent fetch produces a different
      // mtime. 1.1 s is well above filesystem mtime granularity (≤ 1 s
      // on HFS+ and most network filesystems).
      await new Promise((r) => setTimeout(r, 1100));

      // Invalidate cache so isLocalDefaultBranchUpToDate runs ls-remote.
      invalidateRemoteShaCache(downstream, "main");

      const result = await setupRepo(repo, workDir);
      assertEquals(result.success, true, result.message);

      const after = await fetchHeadMtimeMs(downstream);
      assertEquals(
        after,
        before,
        "fast path must not call git fetch (FETCH_HEAD mtime changed)",
      );
    } finally {
      clearRemoteShaCache();
      await cleanup();
    }
  },
);

Deno.test(
  "setupRepo - full path: when upstream advances, fetch runs and resets local tip",
  async () => {
    clearRemoteShaCache();
    const { tmp, upstream, downstream, cleanup } = await buildFixture();
    try {
      const workDir = tmp;
      const repo = "owner/downstream";

      // Capture pre-state.
      await runGit(["fetch", "origin"], downstream);
      const before = await fetchHeadMtimeMs(downstream);
      assert(before !== null);

      // Advance upstream so the fast-path SHAs no longer match.
      await Deno.writeTextFile(`${upstream}/file.txt`, "second\n");
      await runGit(["add", "file.txt"], upstream);
      await runGit(["commit", "-m", "second"], upstream);

      const upstreamHead = (await runGit(["rev-parse", "HEAD"], upstream))
        .stdout.trim();

      // Wait for mtime tick.
      await new Promise((r) => setTimeout(r, 1100));

      // Invalidate the cache so the diverging SHA is observed fresh.
      invalidateRemoteShaCache(downstream, "main");

      const result = await setupRepo(repo, workDir);
      assertEquals(result.success, true, result.message);

      const after = await fetchHeadMtimeMs(downstream);
      assert(
        after !== null && after > before,
        "diverging path must call git fetch (FETCH_HEAD mtime did not change)",
      );

      // The downstream working tree must be reset to the new upstream tip.
      const localHead = (await runGit(["rev-parse", "HEAD"], downstream))
        .stdout.trim();
      assertEquals(
        localHead,
        upstreamHead,
        "downstream HEAD should match upstream HEAD after fetch + reset",
      );
    } finally {
      clearRemoteShaCache();
      await cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// setupRepo path-traversal guard (Issue #2692)
// ---------------------------------------------------------------------------

Deno.test(
  "setupRepo - refuses a traversal slug without mutating the parent repo",
  async () => {
    clearRemoteShaCache();
    const tmp = await Deno.makeTempDir({ prefix: "setup_repo_traversal_" });
    try {
      // Build a git working tree at the *parent* of workDir, then point
      // workDir at a child. A slug of "owner/.." derives repoName ".." so
      // the unguarded path would be `${workDir}/..` == the parent repo.
      const parentRepo = tmp;
      assertEquals((await runGit(["init", "-b", "main"], parentRepo)).code, 0);
      await runGit(["config", "user.email", "t@t"], parentRepo);
      await runGit(["config", "user.name", "t"], parentRepo);
      await Deno.writeTextFile(`${parentRepo}/tracked.txt`, "committed\n");
      await runGit(["add", "tracked.txt"], parentRepo);
      await runGit(["commit", "-m", "first"], parentRepo);
      // Uncommitted + untracked content that `git reset --hard` / `clean`
      // would destroy if the guard failed.
      await Deno.writeTextFile(`${parentRepo}/tracked.txt`, "dirty edit\n");
      await Deno.writeTextFile(`${parentRepo}/untracked.txt`, "precious\n");

      const workDir = `${parentRepo}/work`;
      await Deno.mkdir(workDir);

      const result = await setupRepo("owner/..", workDir);
      assertEquals(result.success, false);
      assert(
        result.message.includes("unsafe path segment"),
        `unexpected message: ${result.message}`,
      );

      // The parent repo's dirty + untracked files must be intact.
      assertEquals(
        await Deno.readTextFile(`${parentRepo}/tracked.txt`),
        "dirty edit\n",
      );
      assertEquals(
        await Deno.readTextFile(`${parentRepo}/untracked.txt`),
        "precious\n",
      );
    } finally {
      clearRemoteShaCache();
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "isLocalDefaultBranchUpToDate - second call within TTL is served from cache",
  async () => {
    clearRemoteShaCache();
    const { downstream, cleanup } = await buildFixture();
    try {
      const first = await isLocalDefaultBranchUpToDate(downstream, "main");
      assertEquals(first.remoteShaSource, "fresh");

      const second = await isLocalDefaultBranchUpToDate(downstream, "main");
      assertEquals(second.remoteShaSource, "cache");
      assertEquals(second.upToDate, true);
    } finally {
      clearRemoteShaCache();
      await cleanup();
    }
  },
);
