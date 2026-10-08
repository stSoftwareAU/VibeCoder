/**
 * The review gate and a red dependency audit (Issue #3142, parent #3116).
 *
 * A red rollup is the fleet's to fix, so the gate posts nothing. The one
 * exception: a dependency-audit check still red after CI-fix has replied at
 * the PR's current head is sent back once with a ready-made request for
 * changes (`auditBlocked`). A red audit is never `ready`, so it is never
 * approved.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  pass,
  type RollupContextNode,
} from "../../../.claude/skills/review-fleet-prs/scripts/gate.ts";
import {
  decideOutcome,
  reviewBody,
} from "../../../.claude/skills/review-fleet-prs/scripts/review_log.ts";
import { buildCiFixAttemptMarker } from "../lib/ci_fix_attempt_markers.ts";

const REVIEWER = "stsoftware-pr-reviewer[bot]";
const FLEET_LOGIN = "VibeCoderST";
const FLEET = new Set([FLEET_LOGIN]);
const REPOS = new Set(["acme/app"]);
const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);
const AUDIT = "audit (Deno Audit)";

const auditRed: RollupContextNode[] = [
  { __typename: "CheckRun", name: AUDIT, conclusion: "FAILURE" },
  { __typename: "CheckRun", name: "lint", conclusion: "SUCCESS" },
];

const lintRed: RollupContextNode[] = [
  { __typename: "CheckRun", name: "lint", conclusion: "FAILURE" },
  { __typename: "CheckRun", name: AUDIT, conclusion: "SUCCESS" },
];

interface Review {
  author: { login: string };
  state: string;
  body: string;
  commit: { oid: string };
}

function fleetPr(contexts: RollupContextNode[], reviews: Review[] = []) {
  return {
    number: 41,
    title: "feat: add widget",
    url: "https://github.com/acme/app/pull/41",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    autoMergeRequest: null,
    headRefOid: HEAD,
    baseRefName: "main",
    repository: {
      nameWithOwner: "acme/app",
      defaultBranchRef: { name: "main" },
    },
    author: { login: FLEET_LOGIN },
    commits: {
      nodes: [{
        commit: {
          statusCheckRollup: {
            state: "FAILURE",
            contexts: { nodes: contexts },
          },
        },
      }],
    },
    reviews: { nodes: reviews },
  };
}

/** One CI-fix comment carrying an attempt marker. */
function ciFixComment(
  author: string,
  options: { check?: string; head?: string } = {},
) {
  const marker = buildCiFixAttemptMarker({
    signature: "abe7d51c7246e6b3",
    checkName: options.check ?? AUDIT,
    head: options.head ?? HEAD,
    attempt: 1,
    outcome: "no-change",
  });
  return {
    id: 9,
    user: { login: author },
    body: `No change required for audit.\n\n${marker}`,
    created_at: "2026-10-04T00:00:00Z",
  };
}

/** Runs one gate pass against a stubbed `gh`; records every call. */
async function runPass(
  pr: ReturnType<typeof fleetPr>,
  comments: unknown[],
) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "graphql") {
      return Promise.resolve(JSON.stringify({
        data: {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [pr],
          },
        },
      }));
    }
    if (args[0] === "api" && args[1] === "repos/acme/app/issues/41/comments") {
      return Promise.resolve(JSON.stringify(comments));
    }
    if (args[0] === "api" && args[1] === "repos/acme/app/pulls/41/files") {
      return Promise.resolve("[]");
    }
    return Promise.resolve("");
  };
  const dir = await Deno.makeTempDir();
  try {
    const result = await pass(REPOS, FLEET, REVIEWER, { gh, dir });
    return { result, calls };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** True when the gate posted anything itself (it never may). */
function postedAnything(calls: string[][]): boolean {
  return calls.some((c) =>
    (c[0] === "pr" && (c[1] === "review" || c[1] === "comment")) ||
    c.includes("POST")
  );
}

Deno.test("gate: a red audit with no CI-fix reply at the head is ci-failed and nothing is posted (Issue #3142)", async () => {
  const { result, calls } = await runPass(fleetPr(auditRed), []);
  assertEquals(result.auditBlocked ?? [], []);
  assertEquals(result.ready, []);
  assertEquals(result.skipped["ci-failed"], 1);
  assertEquals(postedAnything(calls), false);
});

Deno.test("gate: a red audit CI-fix replied to at the head goes to auditBlocked with one finding naming the check (Issue #3142)", async () => {
  const { result, calls } = await runPass(fleetPr(auditRed), [
    ciFixComment(FLEET_LOGIN),
  ]);
  assertEquals(result.ready, []);
  assertEquals(result.skipped["ci-failed"], undefined);
  assertEquals(result.auditBlocked?.length, 1);
  const entry = result.auditBlocked![0]!;
  assertEquals(entry.repo, "acme/app");
  assertEquals(entry.number, 41);
  assertEquals(entry.headSha, HEAD);
  assertEquals(entry.check, AUDIT);
  // The gate itself still posts nothing: post.ts does.
  assertEquals(postedAnything(calls), false);

  // What post.ts makes of the ready-made review: one request for changes.
  assertEquals(entry.review.findings.length, 1);
  assertEquals(
    decideOutcome(entry.review, entry.testChanges.removed),
    "changes_requested",
  );
  const body = reviewBody(
    "changes_requested",
    entry.review,
    entry.testChanges.removed,
  );
  assertStringIncludes(body, AUDIT);
  assertStringIncludes(body, "in this PR");
  assertStringIncludes(body, "ignore entry");
  assertStringIncludes(body, "workflow");
});

Deno.test("gate: a CI-fix marker at an older head, from a non-fleet author, or for another check leaves the red audit ci-failed (Issue #3142)", async () => {
  for (
    const comment of [
      ciFixComment(FLEET_LOGIN, { head: OLD_HEAD }),
      ciFixComment("someone-else"),
      ciFixComment(FLEET_LOGIN, { check: "lint" }),
    ]
  ) {
    const { result, calls } = await runPass(fleetPr(auditRed), [comment]);
    assertEquals(result.auditBlocked ?? [], [], JSON.stringify(comment));
    assertEquals(result.ready, []);
    assertEquals(result.skipped["ci-failed"], 1);
    assertEquals(postedAnything(calls), false);
  }
});

Deno.test("gate: a red non-audit check with a CI-fix marker at the head stays ci-failed and its comments are never read (Issue #3142)", async () => {
  const { result, calls } = await runPass(fleetPr(lintRed), [
    ciFixComment(FLEET_LOGIN, { check: "lint" }),
  ]);
  assertEquals(result.auditBlocked ?? [], []);
  assertEquals(result.ready, []);
  assertEquals(result.skipped["ci-failed"], 1);
  assertEquals(
    calls.some((c) => String(c[1]).endsWith("/comments")),
    false,
  );
});

Deno.test("gate: a red audit already reviewed at this head is not sent back again (Issue #3142)", async () => {
  const reviewed: Review[] = [{
    author: { login: REVIEWER },
    state: "CHANGES_REQUESTED",
    body: "audit still red",
    commit: { oid: HEAD },
  }];
  const { result } = await runPass(fleetPr(auditRed, reviewed), [
    ciFixComment(FLEET_LOGIN),
  ]);
  assertEquals(result.auditBlocked ?? [], []);
  assertEquals(result.ready, []);
  assertEquals(result.skipped["ci-failed"], 1);
});

Deno.test("gate: a red audit at a new head after an earlier send-back is sent back again once CI-fix replies there (Issue #3142)", async () => {
  const earlier: Review[] = [{
    author: { login: REVIEWER },
    state: "CHANGES_REQUESTED",
    body: "audit still red",
    commit: { oid: OLD_HEAD },
  }];
  const { result } = await runPass(fleetPr(auditRed, earlier), [
    ciFixComment(FLEET_LOGIN),
  ]);
  assertEquals(result.auditBlocked?.length, 1);
});

Deno.test("gate: a red audit reported by a commit-status context is recognised by its context name (Issue #3142)", async () => {
  const statusRed: RollupContextNode[] = [
    { __typename: "StatusContext", context: "cargo audit", state: "FAILURE" },
  ];
  const { result } = await runPass(fleetPr(statusRed), [
    ciFixComment(FLEET_LOGIN, { check: "cargo audit" }),
  ]);
  assertEquals(result.auditBlocked?.length, 1);
  assertEquals(result.auditBlocked![0]!.check, "cargo audit");
  assertEquals(result.ready, []);
});
