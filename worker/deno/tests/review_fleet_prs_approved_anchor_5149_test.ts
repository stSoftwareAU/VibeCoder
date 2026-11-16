/**
 * The approval anchor of the review-fleet-prs gate (Issue #5149): when a PR's
 * latest review approved an earlier head, the gate carries that head as
 * `approvedAt`, so the re-review reads what changed since that approval.
 */
import { assertEquals } from "@std/assert";
import { pass } from "../../../.claude/skills/review-fleet-prs/scripts/gate.ts";
import {
  earlierApprovedHead,
  LOG_FILE,
  type LogRecord,
} from "../../../.claude/skills/review-fleet-prs/scripts/review_log.ts";

const record = (over: Partial<LogRecord>): LogRecord => ({
  at: "2026-11-01T10:00:00.000Z",
  repo: "acme/app",
  number: 7,
  title: "PR 7",
  url: "https://github.com/acme/app/pull/7",
  headSha: "approved-head",
  outcome: "approved",
  summary: "fine",
  findings: [],
  testChangeNotes: [],
  removedTests: [],
  ...over,
});

Deno.test("earlierApprovedHead: returns the approved head when the latest review approved an older head (Issue #5149)", () => {
  assertEquals(
    earlierApprovedHead([record({})], "acme/app", 7, "current-head"),
    "approved-head",
  );
});

Deno.test("earlierApprovedHead: null when the latest approval is at the current head (Issue #5149)", () => {
  assertEquals(
    earlierApprovedHead(
      [record({ headSha: "current-head" })],
      "acme/app",
      7,
      "current-head",
    ),
    null,
  );
});

Deno.test("earlierApprovedHead: null when a later changes_requested follows the approval (Issue #5149)", () => {
  const approval = record({ headSha: "approved-head" });
  const sentBack = record({
    at: "2026-11-02T10:00:00.000Z",
    headSha: "sent-back-head",
    outcome: "changes_requested",
    findings: [{
      file: "src/app.ts",
      line: 3,
      problem: "Fix the lookup.",
    }],
  });
  // Positive control: the approval alone is the anchor.
  assertEquals(
    earlierApprovedHead([approval], "acme/app", 7, "current-head"),
    "approved-head",
  );
  assertEquals(
    earlierApprovedHead([approval, sentBack], "acme/app", 7, "current-head"),
    null,
  );
});

Deno.test("earlierApprovedHead: null when a later held review follows the approval (Issue #5149)", () => {
  const approval = record({ headSha: "approved-head" });
  const held = record({
    at: "2026-11-02T10:00:00.000Z",
    headSha: "held-head",
    outcome: "held",
  });
  assertEquals(
    earlierApprovedHead([approval, held], "acme/app", 7, "current-head"),
    null,
  );
});

Deno.test("earlierApprovedHead: null for another PR number in the same repo (Issue #5149)", () => {
  assertEquals(
    earlierApprovedHead(
      [record({ number: 8 })],
      "acme/app",
      7,
      "current-head",
    ),
    null,
  );
});

Deno.test("earlierApprovedHead: null for the same PR number in another repo (Issue #5149)", () => {
  assertEquals(
    earlierApprovedHead(
      [record({ repo: "acme/other" })],
      "acme/app",
      7,
      "current-head",
    ),
    null,
  );
});

Deno.test("earlierApprovedHead: null for an empty log (Issue #5149)", () => {
  assertEquals(earlierApprovedHead([], "acme/app", 7, "current-head"), null);
});

Deno.test("earlierApprovedHead: two approvals at older heads anchor to the latest one (Issue #5149)", () => {
  assertEquals(
    earlierApprovedHead(
      [
        record({ at: "2026-11-01T10:00:00.000Z", headSha: "first-head" }),
        record({ at: "2026-11-02T10:00:00.000Z", headSha: "second-head" }),
      ],
      "acme/app",
      7,
      "current-head",
    ),
    "second-head",
  );
});

// The gate harness below follows review_fleet_prs_checklists_3594_test.ts:
// a fake gh answers the search, the changed-file list, the contents fetch and
// the PR comments, and the gate runs against a temp state directory.

const CHECKLISTS = JSON.stringify({
  checklists: [{
    name: "money",
    paths: ["src/money/**"],
    items: ["Rounding is tested"],
  }],
});
const b64 = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const contents = (text: string) =>
  JSON.stringify({
    encoding: "base64",
    content: b64(text).replace(/.{60}/g, "$&\n"),
  });

function pr(baseRefName = "main") {
  return {
    number: 7,
    title: "PR 7",
    url: "https://github.com/acme/app/pull/7",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    autoMergeRequest: { enabledAt: "2026-10-05T00:00:00Z" },
    headRefOid: "head-7",
    baseRefName,
    repository: {
      nameWithOwner: "acme/app",
      defaultBranchRef: { name: baseRefName },
    },
    author: { login: "VibeCoderST" },
    commits: {
      nodes: [{
        commit: {
          statusCheckRollup: { state: "SUCCESS" },
          checkSuites: { nodes: [] },
        },
      }],
    },
    reviews: { nodes: [] },
  };
}

async function runGate(log?: LogRecord[]) {
  const gh = (args: string[]): Promise<string> => {
    if (args[1] === "graphql") {
      return Promise.resolve(JSON.stringify({
        data: {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ ...pr(), body: "" }],
          },
        },
      }));
    }
    if (args[1]?.endsWith("/files")) {
      return Promise.resolve(JSON.stringify([{
        filename: "src/app.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
      }]));
    }
    if (args[1]?.includes("/contents/")) {
      return Promise.resolve(contents(CHECKLISTS));
    }
    // No PR comments: gh prints an empty JSON list (Issue #4398).
    if (args[1]?.endsWith("/comments")) return Promise.resolve("[]");
    return Promise.resolve("");
  };
  const dir = await Deno.makeTempDir();
  try {
    if (log !== undefined) {
      await Deno.writeTextFile(
        `${dir}/${LOG_FILE}`,
        log.map((r) => JSON.stringify(r)).join("\n") + "\n",
      );
    }
    const result = await pass(
      new Set(["acme/app"]),
      new Set(["VibeCoderST"]),
      "nleck",
      { gh, dir },
    );
    return result.ready;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("gate: an approval at an earlier head is carried as approvedAt, with no previous findings (Issue #5149)", async () => {
  const ready = await runGate([
    record({ headSha: "approved-head" }),
  ]);
  assertEquals(ready.length, 1);
  assertEquals(ready[0]!.approvedAt, "approved-head");
  assertEquals(ready[0]!.previousFindings, []);
});

Deno.test("gate: no review log gives approvedAt null (Issue #5149)", async () => {
  const ready = await runGate();
  assertEquals(ready.length, 1);
  assertEquals(ready[0]!.approvedAt, null);
});

Deno.test("gate: an approval at the current head gives approvedAt null (Issue #5149)", async () => {
  const ready = await runGate([
    record({ headSha: "head-7" }),
  ]);
  assertEquals(ready.length, 1);
  assertEquals(ready[0]!.approvedAt, null);
});
