/**
 * Integration test for the fail-loud untrusted `work-on` strip in
 * `collectWorkOnCandidates` (Issue #3575).
 *
 * When the `work-on` label's most-recent adder is untrusted, the collector must
 * no longer skip the issue silently: it strips the label and posts one
 * explanatory comment so the issue can never sit in a false "queued" state.
 * This test drives a single untrusted-work-on issue through the real collector
 * and asserts the label removal + comment fire and the issue is not selected.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { collectWorkOnCandidates } from "../lib/collect_work_on_candidates.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  createIssueFetcher,
  type FindIssuesOptions,
} from "../lib/issue_finder_common.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";
import type { ClosedPR, OpenPR } from "../lib/issue_query.ts";
import type { WorkerConfig } from "../types.ts";

function makeConfig(): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: ["owner/repo"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    workDir: Deno.makeTempDirSync({ prefix: "work-on-fail-loud-workdir-" }),
  };
}

interface StripRecorder {
  removed: Array<{ issue: number; label: string }>;
  comments: Array<{ issue: number; body: string }>;
}

/**
 * Mock gh for a single open work-on issue #50 whose `work-on` label was added
 * by the untrusted actor `mallory`. Records the strip's `--remove-label` and
 * `issue comment` calls.
 */
function createMockGh(recorder: StripRecorder): (
  args: string[],
) => Promise<string> {
  const listEntry = {
    number: 50,
    title: "Untrusted work-on issue",
    url: "https://github.com/owner/repo/issues/50",
    assignees: [],
    labels: [{ name: "work-on" }],
    createdAt: "2026-07-26T00:00:00Z",
    author: { login: "alice" },
    milestone: null,
    body: "Some body",
  };
  const timeline = [{
    event: "labeled",
    label: { name: "work-on" },
    actor: { login: "mallory" },
    created_at: "2026-07-26T00:00:00Z",
  }];

  return (args: string[]): Promise<string> => {
    const command = args.join(" ");

    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify([listEntry]));
    }
    if (command.includes("timeline") || command.includes("timelineItems")) {
      return Promise.resolve(JSON.stringify(timeline));
    }
    // Comment thread read for dedup — no prior marker.
    if (command.includes("/comments")) {
      return Promise.resolve("[]");
    }
    if (args[0] === "issue" && args[1] === "comment") {
      recorder.comments.push({ issue: Number(args[2]), body: args[6] ?? "" });
      return Promise.resolve("");
    }
    if (
      args[0] === "issue" && args[1] === "edit" &&
      args.includes("--remove-label")
    ) {
      const idx = args.indexOf("--remove-label");
      recorder.removed.push({ issue: Number(args[2]), label: args[idx + 1]! });
      return Promise.resolve("");
    }
    return Promise.resolve("[]");
  };
}

Deno.test("collectWorkOnCandidates - untrusted work-on is stripped and explained, not silently skipped (Issue #3575)", async () => {
  const recorder: StripRecorder = { removed: [], comments: [] };
  const mockGh = createMockGh(recorder);
  const config = makeConfig();

  const cache = new IssueCache(
    Deno.makeTempDirSync({ prefix: "work-on-fail-loud-cache-" }),
    600,
  );
  const options: FindIssuesOptions = {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache,
  };
  const fetcher = createIssueFetcher(mockGh);
  const repoPRs: OpenPR[] = [];
  const repoClosedPRs: ClosedPR[] = [];
  const repoAllIssues: FilterableIssue[] = [];

  const result = await collectWorkOnCandidates(
    "owner/repo",
    config,
    options,
    repoPRs,
    repoAllIssues,
    fetcher,
    repoClosedPRs,
  );

  // Not selected — the untrusted label does not queue work.
  assertEquals(result.candidates.length, 0);

  // Fail loud: the label was stripped and one explanatory comment posted.
  assertEquals(recorder.removed, [{ issue: 50, label: "work-on" }]);
  assertEquals(recorder.comments.length, 1);
  assert(recorder.comments[0]!.issue === 50);
  assertStringIncludes(recorder.comments[0]!.body, "mallory");
  assertStringIncludes(recorder.comments[0]!.body, "trusted-author allowlist");
});
