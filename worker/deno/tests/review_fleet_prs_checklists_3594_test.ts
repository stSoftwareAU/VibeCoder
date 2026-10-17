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
  reviewForPost,
} from "../../../.claude/skills/review-fleet-prs/scripts/post.ts";
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
  contentsReply: (ref: string) => string,
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
        return Promise.resolve(contentsReply(args[1].split("?ref=")[1]!));
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
    return {
      ready: result.ready,
      calls,
      skipped: result.skipped,
      upkeep: result.upkeep,
    };
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

Deno.test("gate: a non-404 gh failure is retried next pass: the PR is skipped, not handed to the reviewer", async () => {
  for (
    const message of [
      "gh api x: gh: Bad Gateway (HTTP 502)\nstack",
      "gh api x: gh: Secondary rate limit (HTTP 403)",
      "gh timed out after 120s",
    ]
  ) {
    const { ready, skipped, upkeep } = await runGate(["README.md"], () => {
      throw new Error(message);
    });
    assertEquals(ready, [], message);
    assertEquals(skipped["checklist-unreadable"], 1, message);
    assertEquals(upkeep.length, 1);
    assertStringIncludes(upkeep[0]!, "retried next pass");
  }
  // Control: the same PR with a readable (here absent) file is reviewed.
  const ok = await runGate(["README.md"], () => {
    throw new Error("gh api x: gh: Not Found (HTTP 404)");
  });
  assertEquals(ok.ready.length, 1);
  assertEquals(ok.skipped["checklist-unreadable"], undefined);
});

Deno.test("gate: an undecodable contents reply is a loud unreadable section and a checklist problem, not absent", async () => {
  const { ready } = await runGate(["README.md"], () => "not json");
  assertStringIncludes(ready[0]!.reviewChecklists, "could not be read");
  assertStringIncludes(ready[0]!.reviewChecklists, "BLOCKING");
  assertStringIncludes(
    ready[0]!.checklistState.problem ?? "",
    "could not be read",
  );
});

Deno.test("gate: checklistState carries the problem for a malformed file and the expected items for a match", async () => {
  const bad = await runGate(["README.md"], () => contents("{ nope"));
  assertStringIncludes(
    bad.ready[0]!.checklistState.problem ?? "",
    "is malformed",
  );
  const match = await runGate(
    ["src/money/fees.rs"],
    () => contents(CHECKLISTS),
  );
  assertEquals(match.ready[0]!.checklistState, {
    problem: null,
    expected: [
      { checklist: "money", item: "Rounding is tested" },
      { checklist: "money", item: "Fees are idempotent" },
    ],
  });
  const none = await runGate(["README.md"], () => contents(CHECKLISTS));
  assertEquals(none.ready[0]!.checklistState, { problem: null, expected: [] });
});

Deno.test("gate: a changed-file list at the limit is reported as not checked", async () => {
  const files = Array.from(
    { length: CHECKLIST_FILE_LIST_LIMIT },
    (_, i) => `f${i}.txt`,
  );
  const { ready } = await runGate(files, () => contents(CHECKLISTS));
  assertStringIncludes(ready[0]!.reviewChecklists, "NOT checked");
  assertStringIncludes(
    ready[0]!.checklistState.problem ?? "",
    "unavailable or truncated",
  );
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

// ---- the code, not the model, owes the checklist finding (PR #3695) --------

const CLEAN_REPLY = {
  summary: "Looks right.",
  findings: [],
  testChanges: "none",
};
const MALFORMED_STATE = {
  problem: "`review-checklists.json` is malformed: trailing comma",
  expected: [],
};
const MONEY_STATE = {
  problem: null,
  expected: [
    { checklist: "money", item: "Rounding is tested" },
    { checklist: "money", item: "Fees are idempotent" },
  ],
};
const sentBack = (raw: unknown, state: typeof MONEY_STATE) => {
  const parsed = reviewForPost(raw, {
    checklistState: state,
    previousFindings: [],
  });
  const outcome = decideOutcome(parsed, []);
  return { outcome, body: reviewBody(outcome, parsed, []), parsed };
};

Deno.test("a malformed base file plus a reply with no findings and no checklist is not approved and names the problem", () => {
  const r = sentBack(CLEAN_REPLY, MALFORMED_STATE as never);
  assertEquals(r.outcome, "changes_requested");
  assertStringIncludes(r.body, "review-checklists.json:1");
  assertStringIncludes(r.body, "Repository review checklists were not applied");
  assertStringIncludes(r.body, "malformed: trailing comma");
  // Control: the same reply with no checklist problem is approved.
  assertEquals(
    sentBack(CLEAN_REPLY, { problem: null, expected: [] }).outcome,
    "approved",
  );
});

Deno.test("a reply that omits the checklist, or covers only some items, is not approved and names the unreported items", () => {
  const omitted = sentBack(CLEAN_REPLY, MONEY_STATE);
  assertEquals(omitted.outcome, "changes_requested");
  assertStringIncludes(omitted.body, "no verdict was reported for 2 of 2");
  assertStringIncludes(omitted.body, "Fees are idempotent");

  const partial = sentBack({
    ...CLEAN_REPLY,
    checklist: [{
      checklist: "money",
      item: "Rounding is tested",
      verdict: "met",
      note: "fees_test",
    }],
  }, MONEY_STATE);
  assertEquals(partial.outcome, "changes_requested");
  assertStringIncludes(partial.body, "1 of 2");
  assertStringIncludes(partial.body, "Fees are idempotent");
  // The item that did get a verdict is not reported as unreported.
  const problem = partial.parsed.findings[0]!.problem;
  assert(!problem.includes("Rounding is tested"), problem);
});

Deno.test("a reply with a verdict for every expected item is approved; numbering and case in the item text do not matter", () => {
  const full = sentBack({
    ...CLEAN_REPLY,
    checklist: [
      { checklist: "Money", item: "1. rounding is tested", verdict: "met" },
      {
        checklist: "money",
        item: "Fees are idempotent",
        verdict: "not applicable",
      },
    ],
  }, MONEY_STATE);
  assertEquals(full.outcome, "approved");
  assertEquals(full.parsed.findings, []);
});

Deno.test("reviewForPost fails loudly on a gate entry without a valid checklistState, and on a malformed reply", () => {
  for (
    const bad of [undefined, null, "x", { expected: [] }, { problem: null }]
  ) {
    let message = "";
    try {
      reviewForPost(CLEAN_REPLY, {
        checklistState: bad as never,
        previousFindings: [],
      });
    } catch (e) {
      message = (e as Error).message;
    }
    assertStringIncludes(message, "checklistState");
  }
  let reply = "";
  try {
    reviewForPost("not json", {
      checklistState: MONEY_STATE,
      previousFindings: [],
    });
  } catch (e) {
    reply = (e as Error).message;
  }
  assert(reply !== "", "a malformed reply still throws");
});

Deno.test("a hostile reason or item cannot inject markup or a mention into the posted body", () => {
  const r = sentBack(CLEAN_REPLY, {
    problem: "bad <img src=x onerror=1> @octocat `x`",
    expected: [{ checklist: "n@me", item: "<script>alert(1)</script>" }],
  } as never);
  assert(!r.body.includes("<img"), r.body);
  assert(!r.body.includes("<script>"), r.body);
  assert(!r.body.includes("@octocat"), r.body);
});

Deno.test("post.ts end to end: a malformed base file and a clean reply posts request-changes naming the problem", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "post-3594-" });
  try {
    const bin = `${tmp}/bin`;
    await Deno.mkdir(bin);
    await Deno.writeTextFile(
      `${bin}/gh`,
      `#!/bin/sh
if [ "$1 $2" = "pr view" ]; then
  echo '{"headRefOid":"head-7","state":"OPEN","mergeStateStatus":"CLEAN"}'
elif [ "$1 $2" = "pr review" ]; then
  echo "$@" > "${tmp}/review_args"
  while [ $# -gt 0 ]; do
    if [ "$1" = "--body-file" ]; then cp "$2" "${tmp}/body.md"; fi
    shift
  done
fi
`,
      { mode: 0o755 },
    );
    const input = `${tmp}/input.json`;
    await Deno.writeTextFile(
      input,
      JSON.stringify({
        pr: {
          repo: "acme/app",
          number: 7,
          title: "PR 7",
          url: "https://github.com/acme/app/pull/7",
          headSha: "head-7",
          kind: "fleet",
          testChanges: { removed: [], edited: [] },
          checklistState: MALFORMED_STATE,
          previousFindings: [],
        },
        review: CLEAN_REPLY,
      }),
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        new URL(
          "../../../.claude/skills/review-fleet-prs/scripts/post.ts",
          import.meta.url,
        ).pathname,
        `--input=${input}`,
        `--state-dir=${tmp}/state`,
      ],
      env: { PATH: `${bin}:${Deno.env.get("PATH")}`, HOME: tmp },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(out.stderr);
    assert(out.success, stderr);
    const result = JSON.parse(new TextDecoder().decode(out.stdout).trim());
    assertEquals(result.outcome, "changes_requested");
    assertStringIncludes(
      await Deno.readTextFile(`${tmp}/review_args`),
      "--request-changes",
    );
    const body = await Deno.readTextFile(`${tmp}/body.md`);
    assertStringIncludes(body, "Repository review checklists were not applied");
    assertStringIncludes(body, "trailing comma");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// ---- the change's own copy of the file (PR #3695 review) -------------------

const CHECKLIST_FILE = "review-checklists.json";
// Serve a different file at the base ref ("main") and at the PR head ("head-7").
const byRef = (base: string | null, head: string | null) => (ref: string) => {
  const text = ref === "head-7" ? head : base;
  if (text === null) {
    throw new Error("gh api x: gh: Not Found (HTTP 404)");
  }
  return contents(text);
};

Deno.test("gate: a PR that adds a malformed checklist file is judged on it and blocked, naming the parse error", async () => {
  const { ready, calls } = await runGate(
    [CHECKLIST_FILE],
    byRef(null, "{ nope"),
  );
  assertEquals(ready.length, 1);
  const state = ready[0]!.checklistState;
  assertStringIncludes(state.problem ?? "", "as changed by this PR");
  assertStringIncludes(state.problem ?? "", "is not valid JSON");
  assertStringIncludes(ready[0]!.reviewChecklists, "BLOCKING");
  // The head copy was read at the head SHA.
  assert(calls.some((c) => c[1]?.endsWith("?ref=head-7")));
  // Control: the same PR with a valid new file has no problem.
  const ok = await runGate([CHECKLIST_FILE], byRef(null, CHECKLISTS));
  assertEquals(ok.ready[0]!.checklistState.problem, null);
});

Deno.test("gate: a PR that repairs a malformed base file is not blocked by the base problem", async () => {
  const repair = await runGate(
    [CHECKLIST_FILE, "src/money/fees.rs"],
    byRef("{ nope", CHECKLISTS),
  );
  assertEquals(repair.ready.length, 1);
  const state = repair.ready[0]!.checklistState;
  assertEquals(state.problem, null);
  assertEquals(state.expected.length, 2);
  assertStringIncludes(repair.ready[0]!.reviewChecklists, "own copy");
  // Control: a PR that does not touch the file still meets the base problem,
  // and reads no head copy.
  const other = await runGate(["README.md"], byRef("{ nope", CHECKLISTS));
  assertStringIncludes(
    other.ready[0]!.checklistState.problem ?? "",
    "is malformed",
  );
  assert(!other.calls.some((c) => c[1]?.endsWith("?ref=head-7")));
  // A "repair" that is still broken stays blocked, on its own copy.
  const still = await runGate(
    [CHECKLIST_FILE],
    byRef("{ nope", "{ still nope"),
  );
  assertStringIncludes(
    still.ready[0]!.checklistState.problem ?? "",
    "as changed by this PR",
  );
});

Deno.test("gate: a PR cannot weaken a valid base checklist by editing the file", async () => {
  const weak = JSON.stringify({
    checklists: [{ name: "Weak", paths: ["nothing/**"], items: ["x"] }],
  });
  const { ready } = await runGate(
    [CHECKLIST_FILE, "src/money/fees.rs"],
    byRef(CHECKLISTS, weak),
  );
  assertEquals(ready[0]!.checklistState.expected.length, 2);
});

Deno.test("gate: a failed fetch of the head copy is retried next pass, not reviewed", async () => {
  const { ready, skipped } = await runGate([CHECKLIST_FILE], (ref) => {
    if (ref === "head-7") {
      throw new Error("gh api x: gh: Bad Gateway (HTTP 502)");
    }
    return contents(CHECKLISTS);
  });
  assertEquals(ready, []);
  assertEquals(skipped["checklist-unreadable"], 1);
});

Deno.test("post: the base-problem fix text no longer sends the author to the base branch", async () => {
  const { ready } = await runGate(["README.md"], byRef("{ nope", null));
  const r = sentBack(CLEAN_REPLY, ready[0]!.checklistState as never);
  assertStringIncludes(r.body, "in this change");
  assert(!r.body.includes("fix it on the base branch"));
});

Deno.test("fleet post - earlier findings cannot disappear from a clean reply", () => {
  const entry = {
    checklistState: { expected: [], problem: null },
    previousFindings: [{
      file: "a.ts",
      line: 2,
      problem: "two paths broken",
      fix: "fix both",
    }],
  };
  const reply = { summary: "clean", findings: [], testChanges: "none" };
  assertEquals(reviewForPost(reply, entry).findings.length, 1);
  assertEquals(
    reviewForPost({
      ...reply,
      earlierFindings: [{ index: 1, verdict: "partly", note: "only one path" }],
    }, entry).findings.length,
    1,
  );
  assertEquals(
    reviewForPost({
      ...reply,
      earlierFindings: [{
        index: 1,
        verdict: "fixed",
        note: "both paths verified",
      }],
    }, entry).findings.length,
    0,
  );
  assertEquals(
    reviewForPost(reply, {
      checklistState: entry.checklistState,
      previousFindings: [],
    }).findings
      .length,
    0,
  );
});

Deno.test("fleet post - a missing earlier-findings inventory cannot approve", () => {
  let message = "";
  try {
    reviewForPost(CLEAN_REPLY, { checklistState: MONEY_STATE } as never);
  } catch (error) {
    message = String(error);
  }
  assertStringIncludes(message, "no valid checklistState or previousFindings");
});
