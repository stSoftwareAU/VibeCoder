/**
 * A timed-out run keeps a draft PR and the issue continues (Issue #4146).
 *
 * The owner's clarification: when a run times out with criteria unmet, "it's
 * ok to create a draft PR and then automatically continue. Do not raise
 * another issue." The draft says `Part of #N` (never `Closes`), auto-merge is
 * never armed on it, and the fleet's own draft for an issue never stops that
 * issue being claimed again — the next run resumes the branch and finishes.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  convertToDraftContinuation,
  DRAFT_CONTINUATION_MARKER,
  ensureDraftContinuationPr,
} from "../lib/draft_continuation_pr.ts";
import { getBlockingPRForIssue, type OpenPR } from "../lib/issue_query.ts";

const REPO = "stSoftwareAU/VibeCoder";
const FLEET = ["VibeCoderST"];

function pr(over: Partial<OpenPR>): OpenPR {
  return {
    number: 4150,
    title: "WIP",
    baseRefName: "main",
    headRefName: "issue-4146-route",
    author: "VibeCoderST",
    ...over,
  } as OpenPR;
}

Deno.test("#4146 - the fleet's own draft PR for an issue does not block re-claiming it", () => {
  assertEquals(
    getBlockingPRForIssue([pr({ isDraft: true })], "", FLEET, 2, 4146),
    null,
  );
});

Deno.test("#4146 - the fleet's own ready PR for an issue still blocks it", () => {
  const blocking = getBlockingPRForIssue(
    [pr({ isDraft: false })],
    "",
    FLEET,
    2,
    4146,
  );
  assertEquals(blocking?.number, 4150);
});

Deno.test("#4146 - a timed-out run with no PR opens a draft that says Part of, never Closes", async () => {
  const calls: string[][] = [];
  const result = await ensureDraftContinuationPr({
    repo: REPO,
    issueNumber: 4146,
    issueTitle: "Route planning to opus",
    branchName: "issue-4146-route",
    baseBranch: "main",
    gh: (args) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "list") return Promise.resolve("[]");
      return Promise.resolve(`https://github.com/${REPO}/pull/4150\n`);
    },
  });

  assertEquals(result, { kind: "created", prNumber: 4150 });
  const create = calls.find((a) => a[0] === "pr" && a[1] === "create");
  assert(create, "a PR is created");
  assert(create.includes("--draft"), "as a draft");
  const body = create[create.indexOf("--body") + 1]!;
  assert(body.includes("Part of #4146"));
  assert(body.includes(DRAFT_CONTINUATION_MARKER));
  assertFalse(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#4146/i.test(body));
  assertFalse(
    calls.some((a) => a.includes("--auto")),
    "auto-merge never armed",
  );
  assertFalse(calls.some((a) => a[0] === "issue"), "no issue is filed");
});

Deno.test("#4146 - a branch that already has an open PR gets no second one", async () => {
  const calls: string[][] = [];
  const result = await ensureDraftContinuationPr({
    repo: REPO,
    issueNumber: 4146,
    issueTitle: "Route planning to opus",
    branchName: "issue-4146-route",
    baseBranch: "main",
    gh: (args) => {
      calls.push(args);
      return Promise.resolve(JSON.stringify([{ number: 4150, isDraft: true }]));
    },
  });

  assertEquals(result, { kind: "existing", prNumber: 4150 });
  assertFalse(calls.some((a) => a[0] === "pr" && a[1] === "create"));
});

Deno.test("#4146 - an incomplete armed PR is disarmed, made a draft, and stops closing the issue", async () => {
  const calls: string[][] = [];
  await convertToDraftContinuation({
    repo: REPO,
    issueNumber: 4146,
    prNumber: 4150,
    body: "## Summary\n\nHalf done. Closes #4146.\n",
    gh: (args) => {
      calls.push(args);
      if (args[1] === "view") {
        return Promise.resolve(
          JSON.stringify({ isDraft: false, autoMergeRequest: { at: "x" } }),
        );
      }
      return Promise.resolve("");
    },
    log: () => {},
  });

  assert(calls.some((a) => a[1] === "merge" && a.includes("--disable-auto")));
  assert(calls.some((a) => a[1] === "ready" && a.includes("--undo")));
  const edit = calls.find((a) => a[1] === "edit")!;
  const body = edit[edit.indexOf("--body") + 1]!;
  assert(body.includes("Part of #4146"));
  assertFalse(/\bcloses\s+#4146\b/i.test(body));
  assertFalse(calls.some((a) => a[1] === "close"), "never closed");
});

Deno.test("#4146 - an unarmed draft is left a draft and only its body is refreshed", async () => {
  const calls: string[][] = [];
  await convertToDraftContinuation({
    repo: REPO,
    issueNumber: 4146,
    prNumber: 4150,
    body: "Closes #4146",
    gh: (args) => {
      calls.push(args);
      return Promise.resolve(
        args[1] === "view"
          ? JSON.stringify({ isDraft: true, autoMergeRequest: null })
          : "",
      );
    },
    log: () => {},
  });
  assertEquals(calls.map((a) => a[1]), ["view", "edit"]);
});

Deno.test("#4146 - a failed draft creation is reported, never thrown", async () => {
  const result = await ensureDraftContinuationPr({
    repo: REPO,
    issueNumber: 4146,
    issueTitle: "Route planning to opus",
    branchName: "issue-4146-route",
    baseBranch: "main",
    gh: (args) =>
      args[1] === "list"
        ? Promise.resolve("[]")
        : Promise.reject(new Error("HTTP 502")),
  });
  assertEquals(result.kind, "failed");
});
