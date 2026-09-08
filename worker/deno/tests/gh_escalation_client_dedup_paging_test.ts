/**
 * End-to-end regression test for the escalation dedup blind spot
 * (Issue #1619).
 *
 * `createGhEscalationClient().getIssueComments` fetched the REST default —
 * the **oldest 30** comments — so `escalateToHuman`'s dedup scan never saw
 * the marker it had written on a busy issue. NEAT-AI-core#593 had 46
 * comments when the gate escalated: the marker sat in comment 47, the shim
 * read comments 1–30, and a duplicate "Issue Modified After Approval"
 * comment was posted 90 seconds after the first.
 *
 * The fake `ghFn` below reproduces that exactly — it serves 30 comments to
 * an un-paged request and all 47 to a `per_page=100` one — so the paged shim
 * dedups while the un-paged shape (kept here as the pre-fix control) posts
 * the duplicate.
 *
 * Australian English used throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { createGhEscalationClient } from "../lib/gh_escalation_client.ts";
import {
  buildDedupMarker,
  escalateToHuman,
} from "../lib/needs_human_escalation.ts";
import type { GitHubClient, GitHubComment, Logger, Result } from "../types.ts";

const REPO = "owner/repo";
const ISSUE = 593;
const WORKER = "vibe-coder[bot]";
const DEDUP_KEY = "content-modified-after-approval:owner/repo#593";
const NOW = Date.parse("2026-09-08T02:00:00Z");
const TOTAL_COMMENTS = 47;

/**
 * A `ghFn` standing in for an issue with 47 comments, the newest carrying
 * the dedup marker. An un-paged request gets the API default (oldest 30);
 * a `per_page=100` request gets the lot.
 */
function makeBusyIssueGh(): {
  ghFn: (args: string[]) => Promise<string>;
  postedBodies: string[];
} {
  const postedBodies: string[] = [];
  const all = Array.from({ length: TOTAL_COMMENTS }, (_, i) => ({
    id: i + 1,
    body: i + 1 === TOTAL_COMMENTS
      ? `Issue Modified After Approval\n\n${buildDedupMarker(DEDUP_KEY)}`
      : `routine comment ${i + 1}`,
    created_at: "2026-09-08T01:53:35Z",
    user: { login: WORKER },
  }));

  const ghFn = (args: string[]): Promise<string> => {
    const [verb, path] = args;
    if (verb === "api" && args.includes("-X")) {
      // Only comment posts are evidence of a duplicate; the label add is
      // idempotent and fires on every escalation.
      if (args.some((arg) => arg.includes("/comments"))) {
        const bodyArg = args[args.length - 1] ?? "";
        postedBodies.push(bodyArg.replace(/^body=/, ""));
      }
      return Promise.resolve("");
    }
    if (verb === "api" && path?.includes("/comments")) {
      const perPage = /[?&]per_page=(\d+)/.exec(path);
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "1");
      const size = perPage ? Number(perPage[1]) : 30;
      return Promise.resolve(
        JSON.stringify(all.slice((page - 1) * size, page * size)),
      );
    }
    return Promise.resolve("");
  };
  return { ghFn, postedBodies };
}

/**
 * A `GitHubClient` whose comment read is the pre-fix, un-paged request.
 *
 * Deliberately a hand-written control rather than shipped code: the fix
 * replaced the un-paged read, so the only way to show the two shapes
 * disagreeing on the same thread is to keep the old one here. It guards the
 * *test*, proving the fake issue really does hide comment 47 from a 30-comment
 * read — without it, a dedup pass would be indistinguishable from a fake that
 * never had the problem.
 */
function makeUnpagedClient(
  ghFn: (args: string[]) => Promise<string>,
): GitHubClient {
  const paged = createGhEscalationClient(ghFn);
  return {
    ...paged,
    async getIssueComments(
      repo: string,
      issueNumber: number,
    ): Promise<GitHubComment[]> {
      const raw = await ghFn([
        "api",
        `repos/${repo}/issues/${issueNumber}/comments`,
      ]);
      const parsed = JSON.parse(raw) as Array<
        {
          id: number;
          body: string;
          created_at: string;
          user: { login: string };
        }
      >;
      return parsed.map((entry) => ({
        id: entry.id,
        body: entry.body,
        author: entry.user.login,
        createdAt: entry.created_at,
        reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
      }));
    },
  };
}

function makeSilentLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

function escalate(client: GitHubClient) {
  return escalateToHuman({
    ghClient: client,
    repo: REPO,
    target: { kind: "issue", number: ISSUE },
    needsHumanLabel: "needs-human",
    reason: "the issue was edited after approval",
    nextStep: "review the edit and re-add work-on",
    dedupKey: DEDUP_KEY,
    githubUser: WORKER,
    deps: {
      now: () => NOW,
      github: {
        ensureLabelExists: (): Promise<Result<void>> =>
          Promise.resolve({ ok: true, value: undefined }),
      },
    },
    logger: makeSilentLogger(),
  });
}

Deno.test("escalateToHuman - the paged shim finds a dedup marker in comment 47", async () => {
  const { ghFn, postedBodies } = makeBusyIssueGh();

  const result = await escalate(createGhEscalationClient(ghFn));

  assertEquals(result.ok, true);
  assertEquals(result.ok && result.value.dedupSkipped, true);
  assertEquals(result.ok && result.value.commentPosted, false);
  assertEquals(postedBodies, []);
});

Deno.test("escalateToHuman - the un-paged read misses comment 47 and posts a duplicate", async () => {
  const { ghFn, postedBodies } = makeBusyIssueGh();

  const result = await escalate(makeUnpagedClient(ghFn));

  assertEquals(result.ok, true);
  assertEquals(result.ok && result.value.dedupSkipped, false);
  assertEquals(result.ok && result.value.commentPosted, true);
  assertEquals(postedBodies.length, 1);
});
