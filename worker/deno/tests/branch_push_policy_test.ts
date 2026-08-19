/**
 * Tests for lib/branch_push_policy.ts — does the default branch take direct
 * pushes? (Issue #4356)
 *
 * Every test drives the real `assessBranchPushPolicy` through an injected
 * `gh` executor and asserts on the classification and the recorded calls.
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  assessBranchPushPolicy,
  commitSubject,
  DIRECT_PUSH_SAMPLE_SIZE,
  DIRECT_PUSH_TOPIC,
  isPrMergeSubject,
  NO_RULESET_MARKER_PATH,
} from "../lib/branch_push_policy.ts";
import type { GhExec } from "../lib/repo_rulesets.ts";

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

interface FakeCommit {
  sha: string;
  subject: string;
  /** `merged_at` values `GET /commits/{sha}/pulls` returns (null = open). */
  pulls?: Array<string | null>;
}

interface State {
  topics?: string[];
  marker?: boolean;
  commits?: FakeCommit[];
  /** Endpoint substrings that fail with a non-404 error. */
  failing?: string[];
}

function makeGh(state: State): { gh: GhExec; endpoints: string[] } {
  const endpoints: string[] = [];
  const gh: GhExec = (args) => {
    const endpoint = String(args[1]);
    endpoints.push(endpoint);
    if ((state.failing ?? []).some((f) => endpoint.includes(f))) {
      return Promise.reject(new Error("gh failed: server error (HTTP 500)"));
    }
    if (/\/topics$/.test(endpoint)) {
      return Promise.resolve(JSON.stringify({ names: state.topics ?? [] }));
    }
    if (endpoint.includes("/contents/")) {
      return state.marker
        ? Promise.resolve("{}")
        : Promise.reject(new Error("gh failed: Not Found (HTTP 404)"));
    }
    if (/\/commits\?sha=/.test(endpoint)) {
      return Promise.resolve(
        JSON.stringify(
          (state.commits ?? []).map((c) => ({
            sha: c.sha,
            commit: { message: `${c.subject}\n\nbody line` },
          })),
        ),
      );
    }
    const pulls = endpoint.match(/\/commits\/([^/]+)\/pulls$/);
    if (pulls) {
      const commit = (state.commits ?? []).find((c) => c.sha === pulls[1]);
      return Promise.resolve(
        JSON.stringify(
          (commit?.pulls ?? []).map((merged_at, i) => ({
            number: i + 1,
            merged_at,
          })),
        ),
      );
    }
    return Promise.reject(new Error(`unexpected endpoint: ${endpoint}`));
  };
  return { gh, endpoints };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("push_policy - isPrMergeSubject recognises squash markers and merge commits", () => {
  assert(isPrMergeSubject("fix: something (#4163)"));
  assert(isPrMergeSubject("Merge pull request #12 from org/topic"));
  assertFalse(isPrMergeSubject("Refresh of history for 2026-08-15 on host-11"));
  assertFalse(isPrMergeSubject("Merge branch 'feature' into Develop"));
  assertFalse(isPrMergeSubject("see issue #12"));
  assertFalse(isPrMergeSubject(""));
});

Deno.test("push_policy - commitSubject takes the trimmed first line only", () => {
  assertEquals(commitSubject("  subject line \n\nbody"), "subject line");
  assertEquals(commitSubject(undefined), "");
  assertEquals(commitSubject(42), "");
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

Deno.test("push_policy - every commit merged via PR is pr-only", async () => {
  const { gh, endpoints } = makeGh({
    commits: [
      { sha: "aaaaaa1", subject: "feat: x (#10)" },
      { sha: "aaaaaa2", subject: "Merge pull request #9 from org/y" },
      {
        sha: "aaaaaa3",
        subject: "rebased commit",
        pulls: ["2026-08-01T00:00:00Z"],
      },
    ],
  });

  const policy = await assessBranchPushPolicy("org/code", "main", gh);

  assertEquals(policy, { kind: "pr-only", sampled: 3 });
  // Only the marker-less commit needed the pulls read.
  assertEquals(
    endpoints.filter((e) => e.endsWith("/pulls")),
    ["repos/org/code/commits/aaaaaa3/pulls"],
  );
  assert(
    endpoints.includes(
      `repos/org/code/commits?sha=main&per_page=${DIRECT_PUSH_SAMPLE_SIZE}`,
    ),
  );
});

Deno.test("push_policy - a commit with no merged PR is direct-push, naming sha and subject", async () => {
  const { gh, endpoints } = makeGh({
    commits: [
      { sha: "aaaaaa1", subject: "feat: x (#10)" },
      {
        sha: "3493677d",
        subject: "Refresh of history for 2026-08-15 on host-11",
      },
      { sha: "aaaaaa3", subject: "never inspected" },
    ],
  });

  const policy = await assessBranchPushPolicy("org/data", "Develop", gh);

  assert(policy.kind === "direct-push");
  assertEquals(policy.sha, "3493677d");
  assertEquals(policy.subject, "Refresh of history for 2026-08-15 on host-11");
  assert(policy.detail.includes("3493677"));
  // Short-circuits on the first direct commit.
  assertFalse(endpoints.includes("repos/org/data/commits/aaaaaa3/pulls"));
});

Deno.test("push_policy - an open (unmerged) PR does not make a commit PR-driven", async () => {
  const { gh } = makeGh({
    commits: [{ sha: "bbbbbb1", subject: "wip", pulls: [null] }],
  });
  const policy = await assessBranchPushPolicy("org/code", "main", gh);
  assertEquals(policy.kind, "direct-push");
});

Deno.test("push_policy - an empty history is pr-only (no evidence of direct pushes)", async () => {
  const { gh } = makeGh({ commits: [] });
  const policy = await assessBranchPushPolicy("org/new", "main", gh);
  assertEquals(policy, { kind: "pr-only", sampled: 0 });
});

// ---------------------------------------------------------------------------
// Opt-out
// ---------------------------------------------------------------------------

Deno.test("push_policy - the direct-push topic opts out before history is read", async () => {
  const { gh, endpoints } = makeGh({
    topics: ["finance", DIRECT_PUSH_TOPIC],
    commits: [{ sha: "aaaaaa1", subject: "feat: x (#10)" }],
  });

  const policy = await assessBranchPushPolicy("org/data", "main", gh);

  assert(policy.kind === "opted-out");
  assert(policy.detail.includes(DIRECT_PUSH_TOPIC));
  assertEquals(endpoints.filter((e) => e.includes("/commits")).length, 0);
});

Deno.test("push_policy - the marker file opts out", async () => {
  const { gh, endpoints } = makeGh({ marker: true });

  const policy = await assessBranchPushPolicy("org/data", "trunk", gh);

  assert(policy.kind === "opted-out");
  assert(policy.detail.includes(NO_RULESET_MARKER_PATH));
  assert(
    endpoints.includes(
      `repos/org/data/contents/${NO_RULESET_MARKER_PATH}?ref=trunk`,
    ),
  );
});

// ---------------------------------------------------------------------------
// Uncertainty is never a licence to lock
// ---------------------------------------------------------------------------

Deno.test("push_policy - an unreadable commit list is unknown", async () => {
  const { gh } = makeGh({ failing: ["/commits?sha="] });
  const policy = await assessBranchPushPolicy("org/x", "main", gh);
  assert(policy.kind === "unknown");
  assert(policy.detail.includes("commit history unreadable"));
});

Deno.test("push_policy - an unreadable pulls lookup is unknown", async () => {
  const { gh } = makeGh({
    commits: [{ sha: "ccccccc1", subject: "no marker" }],
    failing: ["/pulls"],
  });
  const policy = await assessBranchPushPolicy("org/x", "main", gh);
  assert(policy.kind === "unknown");
  assert(policy.detail.includes("ccccccc"));
});

Deno.test("push_policy - unreadable topics or marker (non-404) are unknown", async () => {
  const topics = await assessBranchPushPolicy(
    "org/x",
    "main",
    makeGh({ failing: ["/topics"] }).gh,
  );
  assertEquals(topics.kind, "unknown");

  const marker = await assessBranchPushPolicy(
    "org/x",
    "main",
    makeGh({ failing: ["/contents/"] }).gh,
  );
  assertEquals(marker.kind, "unknown");
});

Deno.test("push_policy - a malformed commit list is unknown", async () => {
  const gh: GhExec = (args) => {
    const endpoint = String(args[1]);
    if (/\/topics$/.test(endpoint)) return Promise.resolve('{"names":[]}');
    if (endpoint.includes("/contents/")) {
      return Promise.reject(new Error("Not Found (HTTP 404)"));
    }
    return Promise.resolve(JSON.stringify([{ sha: "not a sha!" }]));
  };
  const policy = await assessBranchPushPolicy("org/x", "main", gh);
  assertEquals(policy.kind, "unknown");
});

Deno.test("push_policy - an invalid slug or branch is unknown without any gh call", async () => {
  const { gh, endpoints } = makeGh({});
  assertEquals(
    (await assessBranchPushPolicy("bad slug", "main", gh)).kind,
    "unknown",
  );
  assertEquals(
    (await assessBranchPushPolicy("org/x", "main; curl evil", gh)).kind,
    "unknown",
  );
  assertEquals(endpoints.length, 0);
});
