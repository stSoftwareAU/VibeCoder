/**
 * Tests for worker build/version stamping (Issue #3138).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  BUILD_COMMIT_PATTERN,
  type BuildCommitGitRunner,
  formatBuildBanner,
  formatBuildStamp,
  getWorkerBuildInfo,
  resolveBuildCommit,
  resolveBuildCommitStamp,
} from "../lib/worker_build_info.ts";
import type { GitCommandOutput } from "../lib/git_timeout.ts";
import type { Result } from "../types.ts";

Deno.test("getWorkerBuildInfo - reads commit from VIBE_BUILD_COMMIT", () => {
  const info = getWorkerBuildInfo(
    "1.2.3",
    (k) => k === "VIBE_BUILD_COMMIT" ? "abcdef0123456789" : undefined,
  );
  assertEquals(info.version, "1.2.3");
  assertEquals(info.commit, "abcdef0123456789");
});

Deno.test("getWorkerBuildInfo - unset commit is 'unknown'", () => {
  const info = getWorkerBuildInfo("1.2.3", () => undefined);
  assertEquals(info.commit, "unknown");
});

Deno.test("getWorkerBuildInfo - blank commit is 'unknown'", () => {
  const info = getWorkerBuildInfo("1.2.3", () => "   ");
  assertEquals(info.commit, "unknown");
});

Deno.test("getWorkerBuildInfo - blank version is 'unknown'", () => {
  const info = getWorkerBuildInfo("", () => "abc");
  assertEquals(info.version, "unknown");
});

Deno.test("formatBuildStamp - truncates long commit to 12 chars", () => {
  const stamp = formatBuildStamp({
    version: "1.2.3",
    commit: "abcdef0123456789deadbeef",
  });
  assertEquals(stamp, "version=1.2.3 commit=abcdef012345");
});

Deno.test("formatBuildStamp - passes through unknown commit verbatim", () => {
  const stamp = formatBuildStamp({ version: "1.2.3", commit: "unknown" });
  assertEquals(stamp, "version=1.2.3 commit=unknown");
});

Deno.test("formatBuildBanner - prefixes with [worker-build]", () => {
  const banner = formatBuildBanner({ version: "1.2.3", commit: "abc123" });
  assertEquals(banner, "[worker-build] version=1.2.3 commit=abc123");
});

// --------------------------------------------------------------------------
// Issue #1572 — the stamp must be able to report a real commit.
//
// `VIBE_BUILD_COMMIT` was read but never set, so `commit=unknown` was the
// only value the stamp could ever take. These tests cover the producing half:
// the launch-time resolution of the staged checkout's HEAD, the `-dirty`
// marker when that checkout carries uncommitted changes, and the refusal to
// claim a clean commit when the worktree state cannot be read.
// --------------------------------------------------------------------------

const CLEAN_SHA = "0123456789abcdef0123456789abcdef01234567";

/** A git runner that answers `rev-parse` then `status` from a script. */
function scriptedGit(
  responses: Array<Result<GitCommandOutput>>,
): { run: BuildCommitGitRunner; calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  return {
    calls,
    run: (args: string[]) => {
      calls.push(args);
      const next = responses[index++];
      if (!next) throw new Error(`unexpected git call: ${args.join(" ")}`);
      return Promise.resolve(next);
    },
  };
}

/** A successful git invocation carrying `stdout`. */
function gitOk(stdout: string, code = 0): Result<GitCommandOutput> {
  return { ok: true, value: { code, stdout, stderr: "" } };
}

Deno.test("resolveBuildCommit - stamps a clean checkout with its HEAD sha", async () => {
  const git = scriptedGit([gitOk(`${CLEAN_SHA}\n`), gitOk("")]);
  const resolved = await resolveBuildCommit("/opt/VibeCoder", git.run);
  assertEquals(resolved.commit, CLEAN_SHA);
  assertEquals(resolved.reason, undefined);
  // The checkout being stamped is named explicitly, never the process cwd.
  assertEquals(git.calls[0], ["-C", "/opt/VibeCoder", "rev-parse", "HEAD"]);
});

Deno.test("resolveBuildCommit - marks a modified checkout dirty", async () => {
  // A stamp that says a clean commit while running modified code is worse
  // than `unknown`, so uncommitted changes are carried in the stamp.
  const git = scriptedGit([
    gitOk(`${CLEAN_SHA}\n`),
    gitOk(" M worker/deno/lib/run_core.ts\n"),
  ]);
  const resolved = await resolveBuildCommit("/opt/VibeCoder", git.run);
  assertEquals(resolved.commit, `${CLEAN_SHA}-dirty`);
});

Deno.test("resolveBuildCommit - an untracked file is a dirty checkout too", async () => {
  // Git's own reading of "clean": `git status` reports an untracked file, so
  // a tree carrying one is not the commit it names.
  const git = scriptedGit([
    gitOk(`${CLEAN_SHA}\n`),
    gitOk("?? worker/deno/lib/scratch.ts\n"),
  ]);
  const resolved = await resolveBuildCommit("/opt/VibeCoder", git.run);
  assertEquals(resolved.commit, `${CLEAN_SHA}-dirty`);
});

Deno.test("resolveBuildCommit - reports why a non-repository cannot be stamped", async () => {
  const git = scriptedGit([
    { ok: true, value: { code: 128, stdout: "", stderr: "not a git repo\n" } },
  ]);
  const resolved = await resolveBuildCommit("/tmp/not-a-checkout", git.run);
  assertEquals(resolved.commit, undefined);
  assert(resolved.reason !== undefined && resolved.reason.length > 0);
});

Deno.test("resolveBuildCommit - refuses output that is not a commit sha", async () => {
  // A truncated or decorated rev-parse output would stamp a commit that
  // cannot be looked up; it is reported as unstamped instead.
  const git = scriptedGit([gitOk("HEAD\n")]);
  const resolved = await resolveBuildCommit("/opt/VibeCoder", git.run);
  assertEquals(resolved.commit, undefined);
  assertStringIncludes(resolved.reason ?? "", "HEAD");
});

Deno.test("resolveBuildCommit - never claims clean when the worktree state is unreadable", async () => {
  const git = scriptedGit([
    gitOk(`${CLEAN_SHA}\n`),
    { ok: false, error: new Error("git status timed out") },
  ]);
  const resolved = await resolveBuildCommit("/opt/VibeCoder", git.run);
  assertEquals(resolved.commit, undefined);
  assertStringIncludes(resolved.reason ?? "", "status");
});

Deno.test("resolveBuildCommit - a failing status exit never stamps clean", async () => {
  const git = scriptedGit([
    gitOk(`${CLEAN_SHA}\n`),
    { ok: true, value: { code: 128, stdout: "", stderr: "" } },
  ]);
  const resolved = await resolveBuildCommit("/opt/VibeCoder", git.run);
  assertEquals(resolved.commit, undefined);
  assertStringIncludes(resolved.reason ?? "", "exit 128");
});

Deno.test("resolveBuildCommitStamp - hands the launch plan the resolved commit", async () => {
  const git = scriptedGit([gitOk(`${CLEAN_SHA}\n`), gitOk("")]);
  const logged: string[] = [];
  const stamp = await resolveBuildCommitStamp("/opt/VibeCoder", {
    runGit: git.run,
    log: (message) => logged.push(message),
  });
  assertEquals(stamp, CLEAN_SHA);
  assertEquals(logged, []);
});

Deno.test("resolveBuildCommitStamp - an unstampable checkout says why and stamps unknown", async () => {
  // The fallback is loud: `unknown` reaching a fleet log must be traceable to
  // a stated reason, not to a launcher that silently stopped stamping.
  const git = scriptedGit([
    { ok: true, value: { code: 128, stdout: "", stderr: "not a git repo\n" } },
  ]);
  const logged: string[] = [];
  const stamp = await resolveBuildCommitStamp("/tmp/not-a-checkout", {
    runGit: git.run,
    log: (message) => logged.push(message),
  });
  assertEquals(stamp, "unknown");
  assertEquals(logged.length, 1);
  assertStringIncludes(logged[0] ?? "", "not a git repo");
});

Deno.test("resolveBuildCommit - the production path resolves this checkout to a real commit", async () => {
  // The regression test Issue #1572 asks for: the resolution the launch plan
  // runs, against the real checkout, through the real git chokepoint. It
  // fails if the resolver stops producing a commit — which is the state that
  // made `commit=unknown` the only value the stamp could take.
  //
  // It reads the surrounding checkout on purpose, where most unit tests would
  // build a fixture: a checkout the launch plan cannot stamp is the defect
  // itself, so a red here is the signal being asked for rather than host
  // flakiness.
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  const resolved = await resolveBuildCommit(repoRoot);
  assertEquals(
    resolved.reason,
    undefined,
    `the checkout must be stampable: ${resolved.reason}`,
  );
  assert(
    BUILD_COMMIT_PATTERN.test(resolved.commit ?? ""),
    `expected a 40-hex commit (optionally -dirty), got ${resolved.commit}`,
  );
  // And the value the launch plan actually passes to the container is that
  // commit, never the `unknown` sentinel.
  assertEquals(await resolveBuildCommitStamp(repoRoot), resolved.commit);
});

Deno.test("formatBuildStamp - keeps the dirty marker when truncating", () => {
  const stamp = formatBuildStamp({
    version: "1.2.3",
    commit: `${CLEAN_SHA}-dirty`,
  });
  assertEquals(stamp, "version=1.2.3 commit=0123456789ab-dirty");
});
