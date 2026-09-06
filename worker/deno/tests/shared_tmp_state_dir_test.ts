/**
 * Shared-tmp state directory hardening (Issue #1242, SEC-1215-06).
 *
 * Issue #1215 moved the file-backed caches onto `sharedTmpStateDir()`; five
 * further state directories still composed `${TMPDIR}/vibe-…` by hand — the
 * label cache, the Playwright MCP config, the audit journal, the repo failure
 * counters and the browser profile. Each was the same path for every account
 * on the host, so whoever created it first owned what the worker later read
 * back. The trigger the issue records is
 * `mkdir -m 777 ${TMPDIR:-/tmp}/vibe-label-cache` followed by a planted
 * `owner_repo.cache`, which made `ensureLabelExists` skip a real
 * `gh label create`.
 *
 * These tests exercise the real functions: the naming helpers are driven with
 * an injected environment lookup (never `Deno.env.set` — the suite must stay
 * parallel-safe, Issue #880), and the ownership checks are driven by planting
 * entries in a world-writable directory under the shared temporary root.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { defaultLabelCacheDir, getCachedLabels } from "../lib/label_cache.ts";
import {
  defaultMcpConfigDir,
  ensureAgentMcpConfig,
} from "../lib/agent_mcp_config.ts";
import { recordMutation, resolveBaseDir } from "../lib/audit_journal.ts";
import { stagingCandidates } from "../lib/gh_credential_stage.ts";
import {
  defaultOutputDir,
  resolveBrowserEnvironment,
} from "../setup/screenshot.ts";
import { cacheDirUserSuffix } from "../lib/private_cache_dir.ts";

/** Environment lookup that reports `TMPDIR` and nothing else. */
function tmpdirLookup(tmp: string): (key: string) => string | undefined {
  return (key) => (key === "TMPDIR" ? tmp : undefined);
}

/** Run `body` with a fresh directory, removing it afterwards. */
async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "shared-tmp-state-test-" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
}

/** A world-writable directory another account could have created first. */
async function plantedDir(root: string, name: string): Promise<string> {
  const dir = `${root}/${name}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.chmod(dir, 0o777);
  return dir;
}

/** Mode bits of a path. */
function modeOf(path: string): number {
  return (Deno.statSync(path).mode ?? 0) & 0o777;
}

Deno.test("shared tmp state dirs - every remaining default name is per-account", () => {
  const lookup = tmpdirLookup("/scratch");
  const suffix = cacheDirUserSuffix();

  assertEquals(
    defaultLabelCacheDir(lookup),
    `/scratch/vibe-label-cache-${suffix}`,
  );
  assertEquals(
    defaultMcpConfigDir({ env: lookup }),
    `/scratch/vibe-playwright-mcp-${suffix}`,
  );
  assertEquals(
    resolveBaseDir(undefined, lookup),
    `/scratch/vibe-audit-${suffix}`,
  );
  assertEquals(
    stagingCandidates(lookup).at(-1),
    `/scratch/vibe-gh-config-${suffix}`,
  );
});

Deno.test("shared tmp state dirs - the browser profile and its output dir are per-account", () => {
  const lookup = tmpdirLookup("/scratch");
  const suffix = cacheDirUserSuffix();

  const browser = resolveBrowserEnvironment({
    getEnv: lookup,
    dirExists: () => false,
    os: "linux",
  });

  assertEquals(
    browser.profileDir,
    `/scratch/vibe-playwright-profile-${suffix}`,
  );
  // The sibling output directory must not fall back to the shared path.
  assertEquals(
    defaultOutputDir(browser.profileDir, lookup),
    `/scratch/vibe-playwright-output-${suffix}`,
  );
  // An explicitly named profile directory outside the temporary root keeps
  // the plain sibling.
  assertEquals(
    defaultOutputDir("/home/vibe/state/profile", lookup),
    "/home/vibe/state/vibe-playwright-output",
  );
});

Deno.test("label cache - refuses labels planted in a world-writable directory", async () => {
  await withDir(async (root) => {
    const dir = await plantedDir(root, "vibe-label-cache");
    // The trigger from the issue: a cache file naming a label that does not
    // exist, so `ensureLabelExists` would skip the real `gh label create`.
    await Deno.writeTextFile(
      `${dir}/owner_repo.cache`,
      `${Math.floor(Date.now() / 1000)}\nplanted-label\n`,
    );

    let ghCalls = 0;
    const result = await getCachedLabels(dir, "owner/repo", 3600, () => {
      ghCalls++;
      return Promise.resolve("bug\nenhancement");
    });

    assert(result.ok);
    assertEquals(result.value, ["bug", "enhancement"]);
    assertEquals(ghCalls, 1, "the labels must come from gh, not the plant");
    // Nothing is written back into a directory another account controls.
    assertEquals([...Deno.readDirSync(dir)].length, 1);
  });
});

Deno.test("label cache - creates its directory owner-only and serves its own entries", async () => {
  await withDir(async (root) => {
    const dir = `${root}/vibe-label-cache`;

    let ghCalls = 0;
    const gh = () => {
      ghCalls++;
      return Promise.resolve("bug\nenhancement");
    };

    const first = await getCachedLabels(dir, "owner/repo", 3600, gh);
    assert(first.ok);
    assertEquals(modeOf(dir), 0o700);

    const second = await getCachedLabels(dir, "owner/repo", 3600, gh);
    assert(second.ok);
    assertEquals(second.value, ["bug", "enhancement"]);
    assertEquals(ghCalls, 1, "the second read must be served from the cache");
  });
});

Deno.test("audit journal - refuses to append into a world-writable directory", async () => {
  await withDir(async (root) => {
    const dir = await plantedDir(root, "vibe-audit");

    const result = await recordMutation({
      runId: "run-1242",
      repo: "owner/repo",
      target: "owner/repo#1",
      verb: "issue-comment",
      outcome: "success",
    }, { baseDir: dir });

    assertEquals(result.ok, false, "the trail must not be written there");
    assertEquals([...Deno.readDirSync(dir)].length, 0);
  });
});

Deno.test("agent mcp config - is not written into a world-writable directory", async () => {
  await withDir(async (root) => {
    const dir = await plantedDir(root, "vibe-playwright-mcp");

    const messages: string[] = [];
    const path = await ensureAgentMcpConfig({
      cwd: "/w/some-clone",
      configDir: dir,
      generate: () => "{}",
      log: (message) => messages.push(message),
    });

    assertEquals(path, undefined);
    assertEquals([...Deno.readDirSync(dir)].length, 0);
    assert(
      messages.some((m) => m.includes("not worker-private")),
      "the refusal must be logged, never swallowed",
    );
  });
});
