/**
 * The listing-seeded issue fetcher and the batched state read (Issue #2662).
 *
 * The claim scan's dependency gate reads bodies and states through an
 * `IssueFetcher`. These tests pin that a listed issue costs no `gh` call, that
 * the states the listing does not cover arrive in one aliased GraphQL query
 * per repository, and that a failed batch falls back to exactly the per-issue
 * read the scan made before — so the batch changes the cost, never the
 * verdict.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";

import {
  fetchIssueStatesBatch,
  ISSUE_STATE_BATCH_SIZE,
  seedIssueFetcherFromListing,
} from "../lib/issue_finder_common.ts";
import type { IssueFetcher, IssueState } from "../lib/issue_dependencies.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";

const REPO = "fleet/app";

function listed(
  number: number,
  body: string | undefined,
  milestone = "",
): FilterableIssue {
  const issue: FilterableIssue = {
    number,
    title: `Issue ${number}`,
    url: "",
    author: "alice",
    assignees: [],
    labels: ["work-on"],
    createdAt: "",
    updatedAt: "",
    milestone,
  };
  if (body !== undefined) issue.body = body;
  return issue;
}

/** A fallback fetcher that records every per-issue read it is asked for. */
function recordingFetcher(): IssueFetcher & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    getIssueState(repo, n) {
      reads.push(`state ${repo}#${n}`);
      return Promise.resolve({ number: n, state: "CLOSED", milestone: null });
    },
    getSubIssues(repo, n) {
      reads.push(`sub ${repo}#${n}`);
      return Promise.resolve([]);
    },
    getIssueBody(repo, n) {
      reads.push(`body ${repo}#${n}`);
      return Promise.resolve("");
    },
  };
}

/** A `gh` stub answering the batched state query. */
function batchGh(
  answer: (numbers: number[]) => string,
): ((args: string[]) => Promise<string>) & { calls: string[][] } {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    const query = args.find((a) => a.startsWith("query=")) ?? "";
    const numbers = [
      ...query.matchAll(/issueOrPullRequest\(number: (\d+)\)/g),
    ].map((m) => Number(m[1]));
    return Promise.resolve(answer(numbers));
  };
  return Object.assign(gh, { calls });
}

function closedAnswer(numbers: number[]): string {
  const repository: Record<string, unknown> = {};
  numbers.forEach((n, i) => {
    repository[`i${i}`] = {
      number: n,
      state: n === 31 ? "MERGED" : "CLOSED",
      title: `Closed ${n}`,
      milestone: n === 30 ? { title: "Sprint 2" } : null,
    };
  });
  return JSON.stringify({ data: { repository } });
}

Deno.test("a listed issue's body and state cost no gh call (Issue #2662)", async () => {
  const base = recordingFetcher();
  const gh = batchGh(closedAnswer);
  const fetcher = seedIssueFetcherFromListing(
    base,
    (repo) => repo === REPO ? [listed(7, "Depends on #8"), listed(8, "")] : [],
    gh,
  );

  assertEquals(await fetcher.getIssueBody(REPO, 7), "Depends on #8");
  const state: IssueState = await fetcher.getIssueState(REPO, 8);
  assertEquals(state.state, "OPEN");
  assertEquals(base.reads, []);
  assertEquals(gh.calls, []);
});

Deno.test("a listing row without a body is still read per issue (Issue #2662)", async () => {
  const base = recordingFetcher();
  const fetcher = seedIssueFetcherFromListing(
    base,
    () => [listed(7, undefined)],
    batchGh(closedAnswer),
  );
  await fetcher.getIssueBody(REPO, 7);
  assertEquals(base.reads, [`body ${REPO}#7`]);
});

Deno.test("every uncovered dependency is read in one batch per repo (Issue #2662)", async () => {
  const base = recordingFetcher();
  const gh = batchGh(closedAnswer);
  const fetcher = seedIssueFetcherFromListing(
    base,
    () => [
      listed(1, "Depends on #30"),
      listed(2, "Blocked by #31 and depends on #1"),
      listed(3, "Depends on other/repo#32"),
    ],
    gh,
  );

  const s30 = await fetcher.getIssueState(REPO, 30);
  const s31 = await fetcher.getIssueState(REPO, 31);

  assertEquals(gh.calls.length, 1, "one query for both dependencies");
  assertEquals(s30, {
    number: 30,
    state: "CLOSED",
    title: "Closed 30",
    milestone: "Sprint 2",
  });
  // A merged pull request reads as closed, exactly as the per-issue view.
  assertEquals(s31.state, "CLOSED");
  assertEquals(base.reads, []);
});

Deno.test("a failed batch falls back to the per-issue read (Issue #2662)", async () => {
  for (
    const answer of [
      () => "not json",
      () => JSON.stringify({ errors: [{ message: "boom" }] }),
      () => JSON.stringify({ data: { repository: null } }),
    ]
  ) {
    const base = recordingFetcher();
    const fetcher = seedIssueFetcherFromListing(
      base,
      () => [listed(1, "Depends on #30")],
      batchGh(answer),
    );
    const state = await fetcher.getIssueState(REPO, 30);
    assertEquals(state.state, "CLOSED");
    assertEquals(base.reads, [`state ${REPO}#30`]);
  }
});

Deno.test("a repo the scan holds no listing for keeps the per-issue read (Issue #2662)", async () => {
  const base = recordingFetcher();
  const gh = batchGh(closedAnswer);
  const fetcher = seedIssueFetcherFromListing(base, () => undefined, gh);
  await fetcher.getIssueState("other/repo", 32);
  assertEquals(base.reads, ["state other/repo#32"]);
  assertEquals(gh.calls, []);
});

Deno.test("the batch splits at the alias ceiling and refuses a bad slug (Issue #2662)", async () => {
  const numbers = Array.from(
    { length: ISSUE_STATE_BATCH_SIZE + 1 },
    (_, i) => i + 1,
  );
  const gh = batchGh(closedAnswer);
  const states = await fetchIssueStatesBatch(REPO, numbers, gh);
  assertEquals(gh.calls.length, 2);
  assertEquals(states.size, numbers.length);

  const refused = batchGh(closedAnswer);
  assertEquals(
    (await fetchIssueStatesBatch('x/y") { evil', [1], refused)).size,
    0,
  );
  assertEquals(refused.calls, []);
});
