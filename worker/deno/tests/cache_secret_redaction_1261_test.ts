/**
 * On-disk cache redaction and directory gating (Issue #1261, SEC-1217-10).
 *
 * Two caches under the work volume used to persist text no redactor had
 * seen: `baseline_quality_cache.ts` stored a tail of the aggregated
 * `./quality.sh` subprocess output, and `issue_cache.ts` stored GitHub issue
 * and PR JSON verbatim — so a token pasted into an issue body was written to
 * disk and read back into a later prompt. Neither directory was checked for
 * ownership either, so a planted entry could be served back as a cache hit.
 *
 * These tests drive the real classes against a real filesystem: they write
 * secret-bearing text through the public API and then read the raw bytes off
 * disk, so they fail against the unredacted code and pass after the fix.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  readBaselineQualityCache,
  writeBaselineQualityCache,
} from "../lib/baseline_quality_cache.ts";
import { isSharedTmpPath } from "../lib/private_cache_dir.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";

/** A syntactically valid — and entirely fake — GitHub classic token. */
const TOKEN = `ghp_${"A1b2C3d4E5".repeat(4)}`;

/** Run `body` with a fresh temporary directory, removing it afterwards. */
async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "cache-redaction-1261-" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
}

/**
 * Run `body` with a fresh directory on the *work volume* rather than under
 * the shared temporary root — the production shape of both caches, and the
 * one that used to skip the ownership check entirely.
 */
async function withWorkVolumeDir(
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "cache-redaction-1261-",
  });
  try {
    assert(
      !isSharedTmpPath(dir),
      `expected a work-volume directory, got a shared-tmp path: ${dir}`,
    );
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test("baseline quality cache - a token in the gate output never reaches disk", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/baseline-quality-cache.json`;
    await writeBaselineQualityCache("owner/repo@abc123", {
      passed: false,
      output: `npm ERR! failed with GITHUB_TOKEN=${TOKEN}\ncheck failed`,
    }, path);

    const raw = await Deno.readTextFile(path);
    assert(!raw.includes(TOKEN), "the gate output was persisted unredacted");
    assert(
      raw.includes(REDACTION_PLACEHOLDER),
      "the secret was neither redacted nor dropped",
    );

    // The surrounding output is still cached — redaction masks the secret,
    // it does not discard the entry.
    const entry = await readBaselineQualityCache("owner/repo@abc123", path);
    assert(entry?.output.includes("check failed"));
  });
});

Deno.test("baseline quality cache - findings carrying a secret are not persisted", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/baseline-quality-cache.json`;
    await writeBaselineQualityCache("owner/repo@abc123", {
      passed: false,
      output: "gate failed",
      findings: [{
        check: "markdownlint",
        key: `markdownlint|docs/x.md|MD013|line too long: ${TOKEN}`,
        display: `docs/x.md MD013 ${TOKEN}`,
      }],
    }, path);

    const raw = await Deno.readTextFile(path);
    assert(!raw.includes(TOKEN), "a finding was persisted unredacted");

    // The findings list is dropped rather than rewritten: a finding's `key`
    // is its identity for the baseline diff, so masking it would make a
    // pre-existing finding look new. Dropping it makes the caller re-run.
    const entry = await readBaselineQualityCache("owner/repo@abc123", path);
    assertEquals(entry?.findings, undefined);
    assertEquals(entry?.passed, false);
  });
});

Deno.test("baseline quality cache - refuses a world-writable cache directory", async () => {
  await withDir(async (root) => {
    const dir = `${root}/vibe-cache`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.chmod(dir, 0o777);
    const path = `${dir}/baseline-quality-cache.json`;

    // A planted entry another account could have written is never served.
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        "owner/repo@abc123": {
          version: 1,
          passed: true,
          output: "",
          storedAt: Date.now(),
        },
      }),
    );
    assertEquals(
      await readBaselineQualityCache("owner/repo@abc123", path),
      null,
      "a world-writable cache must not be trusted",
    );

    // Nor is a new outcome written into it.
    await Deno.remove(path);
    await writeBaselineQualityCache(
      "owner/repo@abc123",
      { passed: false, output: "gate failed" },
      path,
    );
    assertEquals([...Deno.readDirSync(dir)].length, 0);
  });
});

Deno.test("baseline quality cache - writes the cache file owner-only", async () => {
  await withDir(async (root) => {
    const path = `${root}/vibe-cache/baseline-quality-cache.json`;
    await writeBaselineQualityCache(
      "owner/repo@abc123",
      { passed: true, output: "" },
      path,
    );
    assertEquals((Deno.statSync(path).mode ?? 0) & 0o777, 0o600);
    assertEquals(
      (Deno.statSync(`${root}/vibe-cache`).mode ?? 0) & 0o777,
      0o700,
    );
  });
});

Deno.test("issue cache - a token in a cached issue body never reaches disk", async () => {
  await withDir(async (dir) => {
    const cache = new IssueCache(dir, 600);
    await cache.write("owner/repo", "issues", [{
      number: 7,
      title: "Deploy fails",
      body: `run it with GITHUB_TOKEN=${TOKEN} to reproduce`,
    }]);

    for (const entry of Deno.readDirSync(dir)) {
      const raw = await Deno.readTextFile(`${dir}/${entry.name}`);
      assert(!raw.includes(TOKEN), `issue JSON persisted unredacted: ${raw}`);
      assert(raw.includes(REDACTION_PLACEHOLDER));
    }

    // The rest of the entry survives the redaction and still round-trips.
    const read = await cache.read<{ number: number; body: string }[]>(
      "owner/repo",
      "issues",
    );
    assertEquals(read?.[0]?.number, 7);
    assert(read?.[0]?.body.startsWith("run it with"));
  });
});

Deno.test("issue cache - gates a work-volume directory it was handed", async () => {
  await withWorkVolumeDir(async (root) => {
    const dir = `${root}/.gh-scan-cache`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.chmod(dir, 0o777);
    await Deno.writeTextFile(
      `${dir}/owner_repo_issues.cache.json`,
      JSON.stringify({
        timestamp: Math.floor(Date.now() / 1000),
        data: [{ number: 99, title: "planted by another account" }],
      }),
    );

    assertEquals(
      await new IssueCache(dir).read<unknown[]>("owner/repo", "issues"),
      null,
      "a world-writable work-volume cache must not be trusted",
    );

    await new IssueCache(dir).write("owner/repo", "prs", { count: 1 });
    assertEquals([...Deno.readDirSync(dir)].length, 1);
  });
});

Deno.test("issue cache - tightens a work-volume directory left group-readable", async () => {
  await withWorkVolumeDir(async (root) => {
    const dir = `${root}/.gh-scan-cache`;
    // The umask default a previous release created it with: ours, and no
    // other account could have written to it, so it is narrowed and used.
    await Deno.mkdir(dir, { recursive: true });
    await Deno.chmod(dir, 0o755);

    const cache = new IssueCache(dir);
    await cache.write("owner/repo", "issues", { count: 42 });

    assertEquals((Deno.statSync(dir).mode ?? 0) & 0o777, 0o700);
    assertEquals(
      (await cache.read<{ count: number }>("owner/repo", "issues"))?.count,
      42,
    );
  });
});
