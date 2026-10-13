/**
 * Repo review checklists in the review-fleet-prs skill (Issue #3594): the gate
 * reads `review-checklists.json` at the PR's base ref and renders the section
 * for the reviewer; the reply's per-item verdicts decide and fill the review.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { CHECKLIST_FILE_LIST_LIMIT } from "../lib/review_checklists.ts";
import {
  pass,
  type SearchPr,
} from "../../../.claude/skills/review-fleet-prs/scripts/gate.ts";
import {
  decideOutcome,
  type FableReview,
  parseFableReview,
  reviewBody,
} from "../../../.claude/skills/review-fleet-prs/scripts/review_log.ts";

const CHECKLISTS = JSON.stringify({
  checklists: [{
    name: "money",
    paths: ["src/money/**"],
    items: ["Rounding is tested", "Fees are idempotent"],
  }],
});
const b64 = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const contents = (text: string) =>
  JSON.stringify({
    encoding: "base64",
    content: b64(text).replace(/.{60}/g, "$&\n"),
  });

function pr(baseRefName = "main"): SearchPr {
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
      nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }],
    },
    reviews: { nodes: [] },
  };
}

async function runGate(
  files: string[],
  contentsReply: () => string,
  baseRef = "main",
) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[1] === "graphql") {
      return Promise.resolve(JSON.stringify({
        data: {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [pr(baseRef)],
          },
        },
      }));
    }
    if (args[1]?.endsWith("/files")) {
      return Promise.resolve(JSON.stringify(
        files.map((filename) => ({
          filename,
          status: "modified",
          additions: 1,
          deletions: 0,
        })),
      ));
    }
    if (args[1]?.includes("/contents/")) {
      try {
        return Promise.resolve(contentsReply());
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return Promise.resolve("");
  };
  const dir = await Deno.makeTempDir();
  try {
    const result = await pass(
      new Set(["acme/app"]),
      new Set(["VibeCoderST"]),
      "nleck",
      { gh, dir },
    );
    return { ready: result.ready, calls };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("gate: a PR touching a checklist's paths gets every item in reviewChecklists", async () => {
  const { ready } = await runGate(
    ["src/money/fees.rs"],
    () => contents(CHECKLISTS),
  );
  assertEquals(ready.length, 1);
  assertStringIncludes(ready[0]!.reviewChecklists, "Rounding is tested");
  assertStringIncludes(ready[0]!.reviewChecklists, "Fees are idempotent");
});

Deno.test("gate: the checklist file is read at the PR's base ref, refs with a slash kept", async () => {
  const { calls } = await runGate(
    ["README.md"],
    () => contents(CHECKLISTS),
    "milestone/v2",
  );
  const read = calls.find((c) => c[1]?.includes("/contents/"))!;
  assertEquals(
    read[1],
    "repos/acme/app/contents/review-checklists.json?ref=milestone/v2",
  );
});

Deno.test("gate: a PR touching no checklist path, or a repo without the file, gets an empty section", async () => {
  const unmatched = await runGate(["README.md"], () => contents(CHECKLISTS));
  assertEquals(unmatched.ready[0]!.reviewChecklists, "");
  const absent = await runGate(["src/money/fees.rs"], () => {
    throw new Error(
      "gh api repos/acme/app/contents/x: gh: Not Found (HTTP 404)",
    );
  });
  assertEquals(absent.ready[0]!.reviewChecklists, "");
});

Deno.test("gate: a malformed checklist file gives a loud blocking section", async () => {
  const { ready } = await runGate(["README.md"], () => contents("{ nope"));
  const section = ready[0]!.reviewChecklists;
  assertStringIncludes(section, "is malformed");
  assertStringIncludes(section, "BLOCKING");
});

Deno.test("gate: a non-404 gh failure or an undecodable reply is a loud unreadable section, not absent", async () => {
  const failed = await runGate(["README.md"], () => {
    throw new Error("gh api x: gh: Bad Gateway (HTTP 502)\nstack");
  });
  assertStringIncludes(failed.ready[0]!.reviewChecklists, "could not be read");
  assertStringIncludes(failed.ready[0]!.reviewChecklists, "HTTP 502");
  assertStringIncludes(failed.ready[0]!.reviewChecklists, "BLOCKING");
  const garbled = await runGate(["README.md"], () => "not json");
  assertStringIncludes(garbled.ready[0]!.reviewChecklists, "could not be read");
});

Deno.test("gate: a changed-file list at the limit is reported as not checked", async () => {
  const files = Array.from(
    { length: CHECKLIST_FILE_LIST_LIMIT },
    (_, i) => `f${i}.txt`,
  );
  const { ready } = await runGate(files, () => contents(CHECKLISTS));
  assertStringIncludes(ready[0]!.reviewChecklists, "NOT checked");
});

const review = (over: Partial<FableReview> = {}): FableReview => ({
  summary: "Looks right.",
  findings: [],
  testChanges: "none",
  testChangeNotes: [],
  unrelatedIssues: [],
  checklist: [],
  ...over,
});
const verdicts = [
  {
    checklist: "money",
    item: "Rounding is tested",
    verdict: "met",
    note: "see fees_test",
  },
  {
    checklist: "money",
    item: "Fees are idempotent",
    verdict: "missing",
    note: "retry doubles <b>fee</b>",
  },
  {
    checklist: "docs",
    item: "Docs updated",
    verdict: "not applicable",
    note: "",
  },
] as const;

Deno.test("decideOutcome: a missing checklist item sends it back; met and not applicable change nothing", () => {
  assertEquals(
    decideOutcome(review({ checklist: [...verdicts] }), []),
    "changes_requested",
  );
  assertEquals(
    decideOutcome(review({ checklist: [verdicts[0], verdicts[2]] }), []),
    "approved",
  );
  assertEquals(
    decideOutcome(
      review({ checklist: [verdicts[0]], testChanges: "meaningful" }),
      [],
    ),
    "held",
  );
});

Deno.test("reviewBody: lists every checklist item with its verdict on approved and changes_requested, none when empty", () => {
  const full = review({ checklist: [...verdicts] });
  for (const outcome of ["approved", "changes_requested"] as const) {
    const body = reviewBody(outcome, full, []);
    assertStringIncludes(body, "### Repository review checklists");
    assertStringIncludes(body, "**money**");
    assertStringIncludes(body, "Rounding is tested — ✅ met: see fees_test");
    assertStringIncludes(body, "Fees are idempotent — ❌ missing");
    assertStringIncludes(body, "Docs updated — ➖ not applicable");
    assert(!body.includes("<b>"), "untrusted note is neutralised");
  }
  const none = reviewBody("approved", review(), []);
  assert(!none.includes("Repository review checklists"));
});

Deno.test("post path: a parsed reply with a missing item is sent back with the checklist in the body", () => {
  const parsed = parseFableReview(JSON.stringify({
    summary: "Mostly fine.",
    findings: [],
    testChanges: "none",
    checklist: [{
      checklist: "money",
      item: "Fees are idempotent",
      verdict: "missing",
      note: "no guard",
    }],
  }));
  const outcome = decideOutcome(parsed, []);
  assertEquals(outcome, "changes_requested");
  assertStringIncludes(
    reviewBody(outcome, parsed, []),
    "Fees are idempotent — ❌ missing: no guard",
  );
});
