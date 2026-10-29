/**
 * The review-fleet-prs gate and a third-party app it may not read.
 *
 * The Cursor app's owner has an IP allow list, so when the reviewer App
 * searches PRs that carry a Cursor check suite, GitHub returns the data with
 * a FORBIDDEN error on that suite's `app` field, and gh exits non-zero. Every
 * gate pass failed on it, and no fleet PR was reviewed. A suite whose app the
 * gate cannot read is a suite from an unknown app, which the gate already
 * ignores, so the pass goes on; any other GraphQL error still fails it.
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  GhError,
  pass,
  runWithTimeout,
  type SearchPr,
} from "../../../.claude/skills/review-fleet-prs/scripts/gate.ts";

const REVIEWER = "nleck";
const FLEET = new Set(["VibeCoderST"]);
const REPOS = new Set(["acme/app"]);

const IP_ALLOW_LIST =
  "Although you appear to have the correct authorization credentials, the `cursor` organization has an IP allow list enabled, and your IP address is not permitted to access this resource.";

const fleetPr = (number: number): SearchPr => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  autoMergeRequest: { enabledAt: "2026-10-05T00:00:00Z" },
  headRefOid: `head-${number}`,
  baseRefName: "main",
  repository: {
    nameWithOwner: "acme/app",
    defaultBranchRef: { name: "main" },
    autoMergeAllowed: true,
    squashMergeAllowed: true,
    mergeCommitAllowed: true,
  },
  author: { login: "VibeCoderST" },
  commits: {
    nodes: [{
      commit: {
        statusCheckRollup: { state: "SUCCESS" },
        checkSuites: {
          nodes: [
            {
              app: { slug: "github-actions" },
              status: "COMPLETED",
              conclusion: "SUCCESS",
            },
            // The suite GitHub would not let the App read the app of.
            { app: null, status: "QUEUED", conclusion: null },
          ],
        },
      },
    }],
  },
  reviews: { nodes: [] },
});

const forbiddenAt = (path: (string | number)[]) => ({
  type: "FORBIDDEN",
  path,
  message: IP_ALLOW_LIST,
});
const SUITE_APP = [
  "search",
  "nodes",
  0,
  "commits",
  "nodes",
  0,
  "commit",
  "checkSuites",
  "nodes",
  1,
  "app",
];

// A gh whose GraphQL search exits non-zero with these errors beside the data,
// as gh does: the body on stdout, the messages on stderr.
function failingSearch(errors: unknown[]) {
  const body = JSON.stringify({
    data: {
      search: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [fleetPr(12)],
      },
    },
    errors,
  });
  return (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1] === "graphql") {
      return Promise.reject(
        new GhError(`gh api graphql: gh: ${IP_ALLOW_LIST}`, body),
      );
    }
    if (args[0] === "api" && args[1]?.endsWith("/files")) {
      return Promise.resolve("[]");
    }
    if (args[0] === "api" && args[1]?.endsWith("/comments")) {
      return Promise.resolve("[]");
    }
    return Promise.resolve("");
  };
}

Deno.test("gate: a check suite whose app is FORBIDDEN (an IP allow list) does not fail the pass, and the PR is still reviewed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const result = await pass(REPOS, FLEET, REVIEWER, {
      gh: failingSearch([forbiddenAt(SUITE_APP), forbiddenAt(SUITE_APP)]),
      dir,
    });
    assertEquals(result.ready.map((r) => r.number), [12]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gate: any other GraphQL error still fails the pass", async () => {
  const dir = await Deno.makeTempDir();
  try {
    for (
      const errors of [
        // FORBIDDEN, but on a field the gate needs.
        [
          forbiddenAt(SUITE_APP),
          forbiddenAt(["search", "nodes", 0, "reviews"]),
        ],
        // An app field, but not a FORBIDDEN one.
        [{ type: "RATE_LIMITED", path: SUITE_APP, message: "rate limited" }],
        // No path at all.
        [{ type: "FORBIDDEN", message: IP_ALLOW_LIST }],
      ]
    ) {
      await assertRejects(
        () => pass(REPOS, FLEET, REVIEWER, { gh: failingSearch(errors), dir }),
        GhError,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runWithTimeout keeps a failed command's stdout on the error it throws", async () => {
  const err = await assertRejects(
    () =>
      runWithTimeout("sh", ["-c", "echo body; echo oops >&2; exit 1"], 5000),
    GhError,
    "oops",
  );
  assertEquals(err.stdout, "body\n");
});
