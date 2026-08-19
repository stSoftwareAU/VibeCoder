/**
 * Tests for the idle-task dedup helper.
 *
 * Issue #2077: wrappers are human-style (no marker), so dedup is now
 * pure label-only — any open `idle-task` issue blocks further filing,
 * regardless of who filed it. `buildIdleTaskBody` /
 * `parseIdleTaskBody` were retired alongside the marker, and the
 * `idle-task-pending` label that lived next to `IDLE_TASK_LABEL` was
 * deprecated.
 *
 * Australian English spelling used throughout.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  findAnyOpenIdleTaskWrapper,
  findExistingIdleTaskIssue,
  IDLE_TASK_LABEL,
} from "../lib/idle_task_issue.ts";

// ---------------------------------------------------------------------------
// findExistingIdleTaskIssue — mocked gh
// ---------------------------------------------------------------------------

interface GhCall {
  args: string[];
}

interface ListEntry {
  number: number;
  url: string;
}

function makeMockGh(entries: ListEntry[]) {
  const calls: GhCall[] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push({ args: [...args] });
    return Promise.resolve(JSON.stringify(entries));
  };
  return { fn, calls };
}

Deno.test("IDLE_TASK_LABEL - exposes the canonical idle-task label name", () => {
  assertEquals(IDLE_TASK_LABEL, "idle-task");
});

Deno.test(
  "findExistingIdleTaskIssue - returns the first open idle-task issue in the repo",
  async () => {
    const { fn, calls } = makeMockGh([
      { number: 42, url: "https://github.com/org/repo/issues/42" },
      { number: 43, url: "https://github.com/org/repo/issues/43" },
    ]);
    const result = await findExistingIdleTaskIssue({
      repo: "org/repo",
      ghCommandFn: fn,
    });
    assertEquals(result, {
      number: 42,
      url: "https://github.com/org/repo/issues/42",
    });
    assertEquals(calls.length, 1);
    const args = calls[0]!.args;
    assertEquals(args[0], "issue");
    assertEquals(args[1], "list");
    assertStringIncludes(args.join(" "), "--repo org/repo");
    assertStringIncludes(args.join(" "), "--label idle-task");
    assertStringIncludes(args.join(" "), "--state open");
    assertStringIncludes(args.join(" "), "--json");
  },
);

Deno.test(
  "findExistingIdleTaskIssue - returns the first open idle-task regardless of how it was filed (#2077)",
  async () => {
    // A human-typed idle-task issue (no body marker) must block dedup
    // exactly like a worker-filed one — the wrapper is human-style under
    // Issue #2077, so the dedup query no longer requires a marker.
    const { fn } = makeMockGh([
      { number: 7, url: "https://github.com/org/repo/issues/7" },
    ]);
    const result = await findExistingIdleTaskIssue({
      repo: "org/repo",
      ghCommandFn: fn,
    });
    assertEquals(result, {
      number: 7,
      url: "https://github.com/org/repo/issues/7",
    });
  },
);

Deno.test("findExistingIdleTaskIssue - template arg is tolerated for backwards compat", async () => {
  const { fn } = makeMockGh([
    { number: 42, url: "https://github.com/org/repo/issues/42" },
  ]);
  const result = await findExistingIdleTaskIssue({
    repo: "org/repo",
    template: "security-scan",
    ghCommandFn: fn,
  });
  assertEquals(result, {
    number: 42,
    url: "https://github.com/org/repo/issues/42",
  });
});

Deno.test(
  "findExistingIdleTaskIssue - returns null when gh returns an empty list",
  async () => {
    const { fn } = makeMockGh([]);
    const result = await findExistingIdleTaskIssue({
      repo: "org/repo",
      ghCommandFn: fn,
    });
    assertEquals(result, null);
  },
);

Deno.test(
  "findExistingIdleTaskIssue - returns null when gh output is not valid JSON",
  async () => {
    const fn = (_args: string[]): Promise<string> =>
      Promise.resolve("not json");
    const result = await findExistingIdleTaskIssue({
      repo: "org/repo",
      ghCommandFn: fn,
    });
    assertEquals(result, null);
  },
);

// ---------------------------------------------------------------------------
// findAnyOpenIdleTaskWrapper — cross-repo scan (Issue #2092)
// ---------------------------------------------------------------------------

/**
 * Per-repo mock gh runner: `entriesByRepo` maps each repo to the JSON
 * payload `gh issue list` should return for that repo. If the repo is
 * not in the map and `errorRepos` includes it, the call rejects;
 * otherwise an empty list is returned.
 */
function makeMockGhPerRepo(opts: {
  entriesByRepo?: Record<string, ListEntry[]>;
  errorRepos?: Set<string>;
}) {
  const calls: GhCall[] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push({ args: [...args] });
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx >= 0 ? args[repoIdx + 1] ?? "" : "";
    if (opts.errorRepos !== undefined && opts.errorRepos.has(repo)) {
      return Promise.reject(new Error(`gh blew up for ${repo}`));
    }
    const entries = opts.entriesByRepo?.[repo] ?? [];
    return Promise.resolve(JSON.stringify(entries));
  };
  return { fn, calls };
}

Deno.test(
  "findAnyOpenIdleTaskWrapper - returns null for an empty repo list",
  async () => {
    const { fn, calls } = makeMockGhPerRepo({});
    const result = await findAnyOpenIdleTaskWrapper([], { ghCommandFn: fn });
    assertEquals(result, null);
    assertEquals(calls.length, 0);
  },
);

Deno.test(
  "findAnyOpenIdleTaskWrapper - returns null when every repo is clean",
  async () => {
    const { fn } = makeMockGhPerRepo({
      entriesByRepo: { "a/b": [], "c/d": [] },
    });
    const result = await findAnyOpenIdleTaskWrapper(["a/b", "c/d"], {
      ghCommandFn: fn,
    });
    assertEquals(result, null);
  },
);

Deno.test(
  "findAnyOpenIdleTaskWrapper - returns the wrapper from the first repo that has one",
  async () => {
    const { fn } = makeMockGhPerRepo({
      entriesByRepo: {
        "a/b": [
          { number: 104, url: "https://github.com/a/b/issues/104" },
        ],
        "c/d": [],
      },
    });
    const result = await findAnyOpenIdleTaskWrapper(["a/b", "c/d"], {
      ghCommandFn: fn,
    });
    assertEquals(result, {
      repo: "a/b",
      number: 104,
      url: "https://github.com/a/b/issues/104",
    });
  },
);

Deno.test(
  "findAnyOpenIdleTaskWrapper - returns the first found in caller order when multiple repos have wrappers",
  async () => {
    const { fn } = makeMockGhPerRepo({
      entriesByRepo: {
        "a/b": [{ number: 1, url: "https://github.com/a/b/issues/1" }],
        "c/d": [{ number: 2, url: "https://github.com/c/d/issues/2" }],
      },
    });
    const result = await findAnyOpenIdleTaskWrapper(["a/b", "c/d"], {
      ghCommandFn: fn,
    });
    assertEquals(result, {
      repo: "a/b",
      number: 1,
      url: "https://github.com/a/b/issues/1",
    });
  },
);

Deno.test(
  "findAnyOpenIdleTaskWrapper - a gh error on one repo is logged but does not abort the scan",
  async () => {
    const { fn } = makeMockGhPerRepo({
      entriesByRepo: {
        "c/d": [{ number: 7, url: "https://github.com/c/d/issues/7" }],
      },
      errorRepos: new Set(["a/b"]),
    });
    const warnings: string[] = [];
    const result = await findAnyOpenIdleTaskWrapper(["a/b", "c/d"], {
      ghCommandFn: fn,
      warn: (m: string) => warnings.push(m),
    });
    assertEquals(result, {
      repo: "c/d",
      number: 7,
      url: "https://github.com/c/d/issues/7",
    });
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "repo=a/b");
    assertStringIncludes(warnings[0]!, "cross_repo_check_failed");
  },
);

Deno.test(
  "findAnyOpenIdleTaskWrapper - all repos erroring returns null (treated as clean)",
  async () => {
    const { fn } = makeMockGhPerRepo({
      errorRepos: new Set(["a/b", "c/d"]),
    });
    const warnings: string[] = [];
    const result = await findAnyOpenIdleTaskWrapper(["a/b", "c/d"], {
      ghCommandFn: fn,
      warn: (m: string) => warnings.push(m),
    });
    assertEquals(result, null);
    assertEquals(warnings.length, 2);
  },
);

Deno.test(
  "findExistingIdleTaskIssue - skips malformed entries lacking number/url",
  async () => {
    const fn = (_args: string[]): Promise<string> =>
      Promise.resolve(JSON.stringify([
        { wrongShape: true },
        { number: 99, url: "https://github.com/org/repo/issues/99" },
      ]));
    const result = await findExistingIdleTaskIssue({
      repo: "org/repo",
      ghCommandFn: fn,
    });
    assertEquals(result, {
      number: 99,
      url: "https://github.com/org/repo/issues/99",
    });
  },
);
