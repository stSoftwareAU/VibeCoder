/**
 * The `gh` callers that used to reach the binary through a variable now go
 * through the shared chokepoint (Issue #1378).
 *
 * `GH_SPAWN_PATTERN` only ever matched a literal `Deno.Command("gh", …)`, so
 * four `lib/` modules that spawned `gh` via `Deno.Command(cmd[0]!, …)` or
 * `runWithTimeout("gh", …)` ran outside the write-repo allowlist and the
 * audit journal while the quality gate reported a clean scan. Each test below
 * stubs the chokepoint's own process boundary and asserts the call arrives
 * there: against the unfixed modules the stub is never reached, because the
 * subprocess was constructed directly.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  _resetGhSpawnRunner,
  _setGhSpawnRunner,
  type GhSpawnResult,
} from "../lib/gh_spawn.ts";
import { getRepoVisibility } from "../lib/repo_visibility.ts";
import { detectRepoLanguages } from "../lib/language_detector.ts";
import { getRepoDefaultBranch } from "../lib/shell_helpers.ts";
import { createDefaultReleaseCheckDeps } from "../lib/release_check.ts";
import { collectRecentActivity } from "../lib/recent_activity.ts";

/** Every argument list the chokepoint was handed during a test. */
let seen: string[][] = [];

/**
 * Stub the `gh` process boundary — and only that boundary — answering each
 * call from `replies` by matching the first endpoint-ish argument.
 */
function stubGh(replies: (args: readonly string[]) => string): void {
  seen = [];
  _setGhSpawnRunner((args): Promise<GhSpawnResult> => {
    seen.push([...args]);
    return Promise.resolve({
      code: 0,
      success: true,
      stdout: replies(args),
      stderr: "",
    });
  });
}

Deno.test("repo_visibility - the default runner reaches the gh chokepoint", async () => {
  stubGh(() => "public");
  try {
    const result = await getRepoVisibility("owner/repo");
    assertEquals(result, { ok: true, value: "public" });
    assertEquals(seen, [["api", "repos/owner/repo", "--jq", ".visibility"]]);
  } finally {
    _resetGhSpawnRunner();
  }
});

Deno.test("language_detector - the default runner reaches the gh chokepoint", async () => {
  stubGh((args) =>
    args.some((a) => a.endsWith("/languages")) ? '{"TypeScript": 42}' : "[]"
  );
  try {
    const result = await detectRepoLanguages("owner/repo");
    assertEquals(result.ok, true);
    assertEquals(
      seen.map((args) => args[1]).sort(),
      ["repos/owner/repo/contents/", "repos/owner/repo/languages"],
    );
  } finally {
    _resetGhSpawnRunner();
  }
});

Deno.test("shell_helpers - getRepoDefaultBranch reaches the gh chokepoint", async () => {
  const cachePath = await Deno.makeTempFile();
  stubGh(() => "main");
  try {
    const result = await getRepoDefaultBranch(
      "owner/other-repo",
      undefined,
      cachePath,
    );
    assertEquals(result, { ok: true, value: "main" });
    assertEquals(seen, [[
      "api",
      "repos/owner/other-repo",
      "--jq",
      ".default_branch",
    ]]);
  } finally {
    _resetGhSpawnRunner();
    await Deno.remove(cachePath);
  }
});

Deno.test("release_check - the default deps run gh through the chokepoint", async () => {
  stubGh(() => "1.2.3");
  try {
    const deps = createDefaultReleaseCheckDeps("/tmp");
    const result = await deps.runGh(["release", "view", "--json", "tagName"]);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.success, true);
      assertEquals(result.value.stdout, "1.2.3");
      assertEquals(result.value.timedOut, false);
    }
    assertEquals(seen, [["release", "view", "--json", "tagName"]]);
  } finally {
    _resetGhSpawnRunner();
  }
});

Deno.test("recent_activity - the default runner reaches the gh chokepoint", async () => {
  stubGh(() => "[]");
  try {
    const activity = await collectRecentActivity({
      repo: "owner/repo",
      githubUser: "worker",
      mergedPrLimit: 1,
      commitLimit: 1,
    });
    assertEquals(activity.ok, true);
    if (activity.ok) assertEquals(activity.value.mergedPrs, []);
    assertEquals(
      seen.every((args) => args[0] === "pr"),
      true,
    );
    assertEquals(seen.length >= 1, true);
  } finally {
    _resetGhSpawnRunner();
  }
});
