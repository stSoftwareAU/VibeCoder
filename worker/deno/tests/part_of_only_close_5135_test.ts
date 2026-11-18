/**
 * A merged PR that names an issue only as `Part of #N` does not close it
 * (Issue #5135).
 *
 * NEAT-AI#4165 and VibeCoder#5119 merged with a title ending `(Issue #N)` and
 * a body saying `Part of #N`, which stays open. Both merged-PR closers took
 * the title as proof and closed the issue anyway. They now leave it open,
 * labels untouched, exactly like an unmet acceptance criterion. A closing
 * keyword naming the issue still wins, and a PR whose body does not name the
 * issue at all still closes it from its title.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  closeIssuesForMergedPrs,
  findExistingPrForIssue,
} from "../lib/pr_issue_linking.ts";
import { workOnIssueMergedPrPrecheck } from "../lib/phases/merged_pr_precheck_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { ensureIssueClosedIfPrMerged } from "../lib/issue_lifecycle.ts";
import { fetchMergedPRsAnyAuthor } from "../lib/issue_query.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { resetDecisionWarnings } from "../lib/decision_warn_dedup.ts";
import type { MergeLanding } from "../lib/merge_landing.ts";
import type { Logger } from "../types.ts";

const ISSUE = 4165;
const OTHER = 4170;

/** NEAT-AI#4165 shape: summary prose, no criteria block. */
const SUMMARY_BODY = [
  "## Summary",
  "",
  "Adds the first slice of the scoring refactor and its tests.",
  "",
  `Part of #${ISSUE}, which stays open.`,
].join("\n");

/** VibeCoder#5119 shape: names the rule and carries a plain line. */
const RULE_BODY = [
  "## Summary",
  "",
  `This PR is \`Part of #${ISSUE}\`, not \`Closes\`.`,
  "",
  `Part of #${ISSUE}`,
].join("\n");

function makeLogger(lines: string[] = []): Logger {
  return {
    info: (m) => lines.push(`info:${m}`),
    warn: (m) => lines.push(`warn:${m}`),
    error: (m) => lines.push(`error:${m}`),
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

const milestoneLanded = () =>
  Promise.resolve<MergeLanding>({
    landed: true,
    via: "milestone-route-open",
    mergeCommit: "abc123",
    baseRefName: "milestone/4100-scoring",
  });

interface World {
  closed: string[];
  edits: string[][];
  logs: string[];
  fn: (args: string[]) => Promise<string>;
}

function world(prBody: string, labels: string[] = ["work-on"]): World {
  const w: World = {
    closed: [],
    edits: [],
    logs: [],
    fn: (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") {
        return Promise.resolve(JSON.stringify([{
          number: 4200,
          title: `Scoring refactor (Issue #${ISSUE})`,
          headRefName: `issue-${ISSUE}-scoring`,
          mergedAt: "2026-10-03T21:00:00Z",
          body: prBody,
        }]));
      }
      if (args[0] === "pr" && args[1] === "view") {
        return Promise.resolve(JSON.stringify({
          state: "MERGED",
          headRefName: `issue-${ISSUE}-scoring`,
          body: prBody,
        }));
      }
      if (args[0] === "issue" && args[1] === "view") {
        return Promise.resolve(JSON.stringify({
          state: "OPEN",
          labels: labels.map((name) => ({ name })),
          createdAt: "2026-10-01T00:00:00Z",
          milestone: null,
        }));
      }
      if (args[0] === "api" && (args[1] ?? "").includes("/comments")) {
        return Promise.resolve("[]");
      }
      if (args[0] === "issue" && args[1] === "close") w.closed.push(args[2]!);
      if (args[0] === "issue" && args[1] === "edit") w.edits.push(args);
      return Promise.resolve("");
    },
  };
  return w;
}

function runCloser(w: World, cache?: IssueCache): Promise<number> {
  return closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    w.fn,
    "planning",
    cache,
    {
      verifyMergeLandedFn: milestoneLanded,
      logger: makeLogger(w.logs),
      logFn: (line) => w.logs.push(line),
    },
  );
}

function runEnsure(w: World) {
  resetDecisionWarnings();
  return ensureIssueClosedIfPrMerged(
    "owner/repo",
    ISSUE,
    4200,
    "bot-user",
    {
      ghCommandFn: w.fn,
      logger: makeLogger(),
      verifyMergeLandedFn: milestoneLanded,
    },
  );
}

const PART_OF_ONLY: [string, string][] = [
  ["summary ending in Part of", SUMMARY_BODY],
  ["Part of beside a Closes-denying sentence", RULE_BODY],
];

for (const [label, body] of PART_OF_ONLY) {
  Deno.test(`closeIssuesForMergedPrs - ${label} leaves the issue open, labels untouched (Issue #5135)`, async () => {
    const w = world(body);
    assertEquals(await runCloser(w), 0);
    assertEquals(w.closed, []);
    assertEquals(w.edits, []);
  });

  Deno.test(`ensureIssueClosedIfPrMerged - ${label} leaves the issue open, labels untouched (Issue #5135)`, async () => {
    const w = world(body);
    const result = await runEnsure(w);
    assert(result.ok);
    assertEquals(result.value.closed, false);
    assertStringIncludes(result.value.reason, `Part of #${ISSUE}`);
    assertEquals(w.closed, []);
    assertEquals(w.edits, []);
  });
}

Deno.test("closeIssuesForMergedPrs - a closing keyword beside Part of still closes (Issue #5135)", async () => {
  const w = world(`${SUMMARY_BODY}\n\nCloses #${ISSUE}`);
  assertEquals(await runCloser(w), 1);
  assertEquals(w.closed, [String(ISSUE)]);
});

Deno.test("ensureIssueClosedIfPrMerged - a closing keyword beside Part of still closes (Issue #5135)", async () => {
  const w = world(`${SUMMARY_BODY}\n\nCloses #${ISSUE}`);
  const result = await runEnsure(w);
  assert(result.ok);
  assertEquals(result.value.closed, true);
  assertEquals(w.closed, [String(ISSUE)]);
});

Deno.test("closeIssuesForMergedPrs - a body that does not name the issue still closes from the title (Issue #5135)", async () => {
  const w = world("## Summary\n\nAdds the scoring refactor.");
  assertEquals(await runCloser(w), 1);
  assertEquals(w.closed, [String(ISSUE)]);
});

Deno.test("ensureIssueClosedIfPrMerged - a body that does not name the issue still closes from the title (Issue #5135)", async () => {
  const w = world("## Summary\n\nAdds the scoring refactor.");
  const result = await runEnsure(w);
  assert(result.ok);
  assertEquals(result.value.closed, true);
  assertEquals(w.closed, [String(ISSUE)]);
});

Deno.test("closeIssuesForMergedPrs - Part of a different issue does not hold this one (Issue #5135)", async () => {
  const w = world(`## Summary\n\nPart of #${OTHER}, which stays open.`);
  assertEquals(await runCloser(w), 1);
  assertEquals(w.closed, [String(ISSUE)]);
});

Deno.test("ensureIssueClosedIfPrMerged - Part of a different issue does not hold this one (Issue #5135)", async () => {
  const w = world(`## Summary\n\nPart of #${OTHER}, which stays open.`);
  const result = await runEnsure(w);
  assert(result.ok);
  assertEquals(result.value.closed, true);
  assertEquals(w.closed, [String(ISSUE)]);
});

Deno.test("closeIssuesForMergedPrs - a persisted old-shape entry cannot close a Part of issue (Issue #5135)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const cache = new IssueCache(dir);
    // The shape written before `partOfRefs` was collected.
    await cache.write("owner/repo", "prs_merged_any", [{
      number: 4200,
      title: `Scoring refactor (Issue #${ISSUE})`,
      headRefName: `issue-${ISSUE}-scoring`,
      mergedAt: "2026-10-03T21:00:00Z",
      closingRefs: [],
    }]);
    const w = world(SUMMARY_BODY);
    assertEquals(await runCloser(w, cache), 0);
    assertEquals(w.closed, []);
    assertEquals(w.edits, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fetchMergedPRsAnyAuthor - carries partOfRefs and ignores an old-shape cache entry (Issue #5135)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const cache = new IssueCache(dir);
    await cache.write("owner/repo", "prs_merged_any", [{
      number: 4200,
      title: `Scoring refactor (Issue #${ISSUE})`,
      headRefName: `issue-${ISSUE}-scoring`,
      mergedAt: "2026-10-03T21:00:00Z",
      closingRefs: [],
    }]);
    const w = world(SUMMARY_BODY);
    const prs = await fetchMergedPRsAnyAuthor("owner/repo", cache, 30, w.fn);
    assertEquals(prs.length, 1);
    assertEquals(prs[0]!.partOfRefs, [ISSUE]);
    assertEquals(prs[0]!.closingRefs, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

for (const cached of [false, true]) {
  Deno.test(`findExistingPrForIssue - a merged Part of-only PR does not suppress the remaining work (cache=${cached}) (Issue #5135)`, async () => {
    const dir = await Deno.makeTempDir({ prefix: "part-of-only-lookup-" });
    try {
      const cache = cached ? new IssueCache(dir) : undefined;
      let body = SUMMARY_BODY;
      const gh = (args: string[]): Promise<string> => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(JSON.stringify({ body, state: "MERGED" }));
        }
        const state = args[args.indexOf("--state") + 1];
        return Promise.resolve(JSON.stringify(
          state === "open" ? [] : [{
            number: 4200,
            title: `Scoring refactor (Issue #${ISSUE})`,
            url: "https://github.com/owner/repo/pull/4200",
            body,
            mergedAt: "2026-10-03T21:00:00Z",
            closedAt: new Date().toISOString(),
            isCrossRepository: false,
          }],
        ));
      };
      const partOf = await findExistingPrForIssue(
        "owner/repo",
        ISSUE,
        gh,
        undefined,
        cache,
      );
      assertEquals(
        partOf.ok,
        false,
        "a Part of-only merge leaves the original issue eligible",
      );
      const lookup = () =>
        findExistingPrForIssue("owner/repo", ISSUE, gh, undefined, cache);
      const precheck = await workOnIssueMergedPrPrecheck(
        {
          repo: "owner/repo",
          issueNumber: ISSUE,
          issueTitle: "Finish the scoring refactor",
          issueBody: "",
          issueLabels: ["work-on"],
          issueComments: "",
          githubUser: "bot",
          config: buildDefaultWorkerConfig(),
        },
        {
          branchName: "",
          baseBranch: "",
          defaultBranch: "",
          repoPath: dir,
          clarityStatus: "not_assessed",
          claudeOutput: "",
          executeStartTime: 0,
          baselineQualityPassed: true,
          baselineQualityOutput: "",
        },
        createMockDeps({
          pr: { findExistingPrForIssue: lookup },
          github: { runGhCommand: gh },
        }),
      );
      assertEquals(precheck, { status: "continue" });
      body = `${SUMMARY_BODY}\n\nCloses #${ISSUE}`;
      const closes = await findExistingPrForIssue(
        "owner/repo",
        ISSUE,
        gh,
        undefined,
        cache,
      );
      assert(closes.ok);
      assertEquals(closes.value, "https://github.com/owner/repo/pull/4200");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}
