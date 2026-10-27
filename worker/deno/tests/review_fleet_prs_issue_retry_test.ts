/**
 * review-fleet-prs files the reviewer's out-of-scope findings as issues. A
 * transient GitHub failure on one call must not lose the finding: the
 * find-or-create is retried, searching again first, so a create that did land
 * is linked rather than filed twice.
 */
import { assertEquals } from "@std/assert";
import { isRetryableError } from "../lib/retry.ts";
import type {
  FableReview,
  UnrelatedIssue,
} from "../../../.claude/skills/review-fleet-prs/scripts/review_log.ts";
import { fileUnrelatedIssues } from "../../../.claude/skills/review-fleet-prs/scripts/post.ts";

const PR = {
  repo: "owner/repo",
  number: 7,
  url: "https://github.com/owner/repo/pull/7",
};

const ISSUE: UnrelatedIssue = {
  title: "Guard misses a percent-encoded number segment",
  file: "lib/guard.ts",
  line: 12,
  body: "The guard reads the raw path.",
};

const review: FableReview = {
  summary: "ok",
  findings: [],
  testChanges: "none",
  testChangeNotes: [],
  unrelatedIssues: [ISSUE],
  checklist: [],
};

// The exact error GitHub returned on GRQ-25 when it lost a finding.
const GRAPHQL_HICCUP =
  "gh issue create: GraphQL: Something went wrong while executing your query " +
  "on 2026-10-27T21:33:25Z. Please include `9332:1B55CE:407D0C:64AF7C:6AE118A3` " +
  "when reporting this issue.";

Deno.test("retry - GitHub's 'Something went wrong while executing your query' is transient", () => {
  assertEquals(isRetryableError(GRAPHQL_HICCUP), true);
});

Deno.test("fileUnrelatedIssues retries a create that hit a transient GitHub failure", async () => {
  const calls: string[] = [];
  let creates = 0;
  const gh = (args: string[]): Promise<string> => {
    calls.push(args[1] ?? "");
    if (args[1] === "list") return Promise.resolve("[]");
    if (args[1] === "create") {
      creates++;
      return creates === 1
        ? Promise.reject(new Error(GRAPHQL_HICCUP))
        : Promise.resolve("https://github.com/owner/repo/issues/900");
    }
    return Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));
  };
  const filed = await fileUnrelatedIssues(PR, review, gh);
  assertEquals(filed.map((f) => f.number), [900]);
  // Searched again before the second create.
  assertEquals(calls, ["list", "create", "list", "create"]);
});

Deno.test("fileUnrelatedIssues links, not refiles, a create that landed despite its error", async () => {
  let lists = 0;
  let creates = 0;
  const gh = (args: string[]): Promise<string> => {
    if (args[1] === "list") {
      lists++;
      return Promise.resolve(
        lists === 1 ? "[]" : JSON.stringify([{
          number: 901,
          url: "https://github.com/owner/repo/issues/901",
          title: ISSUE.title,
        }]),
      );
    }
    if (args[1] === "create") {
      creates++;
      return Promise.reject(new Error(GRAPHQL_HICCUP));
    }
    return Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));
  };
  const filed = await fileUnrelatedIssues(PR, review, gh);
  assertEquals(filed.map((f) => f.number), [901]);
  assertEquals(creates, 1);
});

Deno.test("fileUnrelatedIssues does not retry a permanent failure", async () => {
  let creates = 0;
  const gh = (args: string[]): Promise<string> => {
    if (args[1] === "list") return Promise.resolve("[]");
    creates++;
    return Promise.reject(
      new Error(
        "gh issue create: HTTP 403: Resource not accessible by integration",
      ),
    );
  };
  assertEquals(await fileUnrelatedIssues(PR, review, gh), []);
  assertEquals(creates, 1);
});
