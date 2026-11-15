/**
 * Tests for the orphaned fleet draft self-heal (Issue #4952).
 *
 * A fleet draft whose issue has no live claim and whose body does not open
 * with a draft-continuation marker is marked ready, and its CI is awaited, so
 * the auto-merge sweep can arm it. Every other draft stays a draft.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  buildDraftContinuationBody,
  DRAFT_CONTINUATION_MARKER,
} from "../lib/draft_continuation_pr.ts";
import { syncPrBodyFromSummary } from "../lib/pr_body_sync.ts";
import type { Logger } from "../types.ts";
import { readyOrphanedDraftPr } from "../lib/draft_pr_self_heal.ts";

/**
 * A hold body as the worker wrote it for unmet criteria before Issue #5095
 * retired that conversion. Drafts held then still carry it, so the self-heal
 * must keep leaving them alone.
 */
function legacyUnmetHoldBody(issueNumber: number, body: string): string {
  return [
    DRAFT_CONTINUATION_MARKER,
    "",
    `> **Draft — not every acceptance criterion is met yet.** Part of #${issueNumber}. ` +
    "The next run continues this branch; when it completes, the PR is " +
    "marked ready and auto-merge armed, even with a criterion still unmet, " +
    "and it says `Closes #N` unless an entry is `missing`.",
    "",
    body,
  ].join("\n");
}

const REPO = "stSoftwareAU/VibeCoder";
const SHA = "abc123";
const FLEET = ["VibeCoderST", "stservice"];
const PR = 7;

interface PrFixture {
  body: string;
  isDraft: boolean;
  /** Omitted from the live view when undefined. */
  headRefName?: string;
}

interface Fixture {
  /** `"unreadable"` makes `gh pr view` fail. */
  pr: PrFixture | "unreadable";
  /** `"unreadable"` makes `gh issue view` fail. */
  issue:
    | { state: string; assignees?: { login: string }[] }
    | "unreadable";
  /** Makes `gh pr ready` fail. */
  readyFails?: boolean;
  /** Whether a new check run appears once the PR is ready. Default true. */
  ciStarts?: boolean;
}

function healthyDraft(over: Partial<PrFixture> = {}): PrFixture {
  return {
    body: "Work in progress, no marker.",
    isDraft: true,
    headRefName: "issue-7-fix-thing",
    ...over,
  };
}

const OPEN_UNCLAIMED = { state: "OPEN", assignees: [] };

/** A gh stub that routes on the subcommand and records every call. */
function ghStub(f: Fixture) {
  const calls: string[][] = [];
  let ready = false;
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      // The check-run wait's head read: `--json headRefOid,isDraft`.
      if (args.some((arg) => arg === "headRefOid,isDraft")) {
        return Promise.resolve(
          JSON.stringify({ headRefOid: SHA, isDraft: !ready }),
        );
      }
      if (f.pr === "unreadable") {
        return Promise.reject(new Error("HTTP 502"));
      }
      return Promise.resolve(JSON.stringify(f.pr));
    }
    if (args[0] === "pr" && args[1] === "ready") {
      if (f.readyFails) return Promise.reject(new Error("HTTP 502"));
      ready = true;
      return Promise.resolve("");
    }
    if (args[0] === "issue" && args[1] === "view") {
      if (f.issue === "unreadable") {
        return Promise.reject(new Error("HTTP 503"));
      }
      return Promise.resolve(JSON.stringify(f.issue));
    }
    if (args[0] === "api") {
      const runs = ready && f.ciStarts !== false
        ? [{ id: 2, conclusion: null }]
        : [];
      return Promise.resolve(JSON.stringify(runs));
    }
    return Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));
  };
  return { gh, calls };
}

const noSleep = () => Promise.resolve();

/**
 * Run the self-heal against a stub and capture its logs. `listingHeadRefName`
 * is the head branch the sweep's listing supplied, if any.
 */
async function heal(f: Fixture, listingHeadRefName?: string) {
  const { gh, calls } = ghStub(f);
  const warnings: string[] = [];
  const infos: string[] = [];
  const healed = await readyOrphanedDraftPr({
    repo: REPO,
    prNumber: PR,
    gh,
    fleetAuthors: FLEET,
    log: (m) => warnings.push(m),
    info: (m) => infos.push(m),
    sleep: noSleep,
    ...(listingHeadRefName !== undefined
      ? { headRefName: listingHeadRefName }
      : {}),
  });
  const readyCalls = calls.filter((c) => c[0] === "pr" && c[1] === "ready");
  return { healed, calls, readyCalls, warnings, infos };
}

Deno.test("#4952 - an unclaimed draft with no marker is marked ready and reports CI started", async () => {
  const run = await heal({
    pr: healthyDraft(),
    issue: OPEN_UNCLAIMED,
  });
  assert(run.healed, "CI started, so the sweep may arm it");
  assertEquals(run.readyCalls.length, 1);
  assertEquals(run.readyCalls[0], ["pr", "ready", "7", "--repo", REPO]);
  assertEquals(run.infos, [
    "Marked orphaned fleet draft PR #7 ready (Issue #4952)",
  ]);
  assertEquals(run.warnings, []);
  assert(
    run.calls.some((c) =>
      c[0] === "api" &&
      c[1] === `repos/${REPO}/commits/${SHA}/check-runs?per_page=100`
    ),
    `the CI wait must read the check runs of the head commit ${SHA}: ${
      JSON.stringify(run.calls)
    }`,
  );
});

Deno.test("#4952 - a draft carrying the draft-continuation marker is held and never readied", async () => {
  const run = await heal({
    pr: healthyDraft({
      body: buildDraftContinuationBody(PR),
    }),
    issue: OPEN_UNCLAIMED,
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls, []);
});

Deno.test("#4952 - a legacy unmet-criteria hold draft carrying the marker is held and never readied", async () => {
  const run = await heal({
    pr: healthyDraft({
      body: legacyUnmetHoldBody(7, "Part of #7"),
    }),
    issue: OPEN_UNCLAIMED,
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls, []);
});

Deno.test("#4952 - control: the same draft without the marker is healed, so the marker is the refusing rule", async () => {
  const withMarker = await heal({
    pr: healthyDraft({
      body: `${DRAFT_CONTINUATION_MARKER}\n\nPart of #7`,
    }),
    issue: OPEN_UNCLAIMED,
  });
  const withoutMarker = await heal({
    pr: healthyDraft({ body: "Part of #7" }),
    issue: OPEN_UNCLAIMED,
  });
  assertFalse(withMarker.healed);
  assert(withoutMarker.healed);
  assertEquals(withoutMarker.readyCalls.length, 1);
});

Deno.test("#4952 - a body that quotes the marker in a code span, mid-body, is not a hold and is healed", async () => {
  const run = await heal({
    pr: healthyDraft({
      body: "Adds a check.\n\nThe template used to emit " +
        `\`${DRAFT_CONTINUATION_MARKER}\` on its first line, so this is the ` +
        "fix for the stale comment.",
    }),
    issue: OPEN_UNCLAIMED,
  });
  assert(run.healed, "a mid-body quotation does not open a hold");
  assertEquals(run.readyCalls.length, 1);
});

Deno.test("#4952 - a body that quotes the marker in prose, mid-body, is not a hold and is healed", async () => {
  const run = await heal({
    pr: healthyDraft({
      body: "Work in progress.\n\nWe discussed whether " +
        `${DRAFT_CONTINUATION_MARKER} should be written by hand. It should not.`,
    }),
    issue: OPEN_UNCLAIMED,
  });
  assert(run.healed, "a mid-body mention in prose does not open a hold");
  assertEquals(run.readyCalls.length, 1);
});

Deno.test("#4952 - a body that opens with the marker after leading whitespace is held", async () => {
  for (
    const body of [
      `\n${DRAFT_CONTINUATION_MARKER}\n\nPart of #7`,
      `   \n\t${DRAFT_CONTINUATION_MARKER}\n\nPart of #7`,
    ]
  ) {
    const run = await heal({
      pr: healthyDraft({ body }),
      issue: OPEN_UNCLAIMED,
    });
    assertFalse(run.healed, `held for body ${JSON.stringify(body)}`);
    assertEquals(run.readyCalls, []);
  }
});

Deno.test("#4952 - an issue assigned to a fleet author is a live claim and never readied", async () => {
  const run = await heal({
    pr: healthyDraft(),
    issue: { state: "OPEN", assignees: [{ login: "vibecoderst" }] },
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls, []);
});

Deno.test("#4952 - control: an issue assigned to a non-fleet login is not a claim, so it is healed", async () => {
  const run = await heal({
    pr: healthyDraft(),
    issue: { state: "OPEN", assignees: [{ login: "some-human" }] },
  });
  assert(run.healed);
  assertEquals(run.readyCalls.length, 1);
});

Deno.test("#4952 - control: an open issue with an empty assignees list is unclaimed and healed", async () => {
  const run = await heal({
    pr: healthyDraft(),
    issue: { state: "OPEN", assignees: [] },
  });
  assert(run.healed);
  assertEquals(run.readyCalls.length, 1);
  assertEquals(run.warnings, []);
});

Deno.test("#4952 - an issue read with no assignees key is malformed: not readied, warns naming the PR and issue", async () => {
  const run = await heal({
    pr: healthyDraft(),
    issue: { state: "OPEN" },
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls, []);
  assertEquals(run.warnings.length, 1);
  assert(
    run.warnings[0]!.includes("PR #7") && run.warnings[0]!.includes("issue #7"),
    `expected a warning naming PR #7 and issue #7, got ${
      JSON.stringify(run.warnings)
    }`,
  );
});

Deno.test("#4952 - a closed issue is never readied", async () => {
  const run = await heal({
    pr: healthyDraft(),
    issue: { state: "CLOSED", assignees: [] },
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls, []);
});

Deno.test("#4952 - a branch that does not name an issue is never readied, and no issue is read", async () => {
  const run = await heal({
    pr: healthyDraft({ headRefName: "sync/1786-milestone-1653" }),
    issue: OPEN_UNCLAIMED,
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls, []);
  assertEquals(run.calls.filter((c) => c[0] === "issue"), []);
});

Deno.test("#4952 - an unreadable PR view stays a draft and warns naming the PR number", async () => {
  const run = await heal({ pr: "unreadable", issue: OPEN_UNCLAIMED });
  assertFalse(run.healed);
  assertEquals(run.readyCalls, []);
  assert(
    run.warnings.some((m) => m.includes("PR #7")),
    `expected a warning naming PR #7, got ${JSON.stringify(run.warnings)}`,
  );
});

Deno.test("#4952 - an unreadable issue view stays a draft, is not readied, and warns naming the PR number", async () => {
  const run = await heal({ pr: healthyDraft(), issue: "unreadable" });
  assertFalse(run.healed);
  assertEquals(run.readyCalls, []);
  assertEquals(run.infos, []);
  assert(
    run.warnings.some((m) => m.includes("PR #7")),
    `expected a warning naming PR #7, got ${JSON.stringify(run.warnings)}`,
  );
});

Deno.test("#4952 - a non-string PR body stays a draft and warns naming the PR number", async () => {
  const run = await heal({
    pr: healthyDraft({ body: 42 as unknown as string }),
    issue: OPEN_UNCLAIMED,
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls, []);
  assertEquals(run.calls.filter((c) => c[0] === "issue"), []);
  assert(
    run.warnings.some((m) => m.includes("PR #7") && m.includes("body")),
    `expected a body warning naming PR #7, got ${JSON.stringify(run.warnings)}`,
  );
});

Deno.test("#4952 - the listing's head branch is used when the live view omits headRefName", async () => {
  const run = await heal(
    {
      pr: healthyDraft({ headRefName: undefined }),
      issue: OPEN_UNCLAIMED,
    },
    "issue-7-x",
  );
  assert(run.healed);
  const issueCalls = run.calls.filter((c) => c[0] === "issue");
  assertEquals(issueCalls.length, 1);
  assertEquals(issueCalls[0]![2], "7");
});

Deno.test("#4952 - the live head branch is preferred over the listing's when both exist", async () => {
  const run = await heal(
    {
      pr: healthyDraft({ headRefName: "issue-2-y" }),
      issue: OPEN_UNCLAIMED,
    },
    "issue-1-x",
  );
  assert(run.healed);
  const issueCalls = run.calls.filter((c) => c[0] === "issue");
  assertEquals(issueCalls.length, 1);
  assertEquals(issueCalls[0]![2], "2");
});

Deno.test("#4952 - a PR that is not a draft is not touched", async () => {
  const run = await heal({
    pr: healthyDraft({ isDraft: false }),
    issue: OPEN_UNCLAIMED,
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls, []);
});

Deno.test("#4952 - a failed gh pr ready reports false and warns naming the PR number", async () => {
  const run = await heal({
    pr: healthyDraft(),
    issue: OPEN_UNCLAIMED,
    readyFails: true,
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls.length, 1);
  assert(
    run.warnings.some((m) => m.includes("PR #7")),
    `expected a warning naming PR #7, got ${JSON.stringify(run.warnings)}`,
  );
  assertEquals(run.infos, []);
});

Deno.test("#4952 - ready but no ready-for-review CI reports false, so the sweep does not arm it", async () => {
  const run = await heal({
    pr: healthyDraft(),
    issue: OPEN_UNCLAIMED,
    ciStarts: false,
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls.length, 1);
  assert(
    run.warnings.some((m) => m.includes("PR #7")),
    "the CI-not-started outcome is named with the PR number",
  );
});

// --- A body sync keeps the hold (PR #5033 review) ---------------------------

const SYNC_BRANCH = "issue-7-fix-thing";
const SYNC_LOGGER: Logger = {
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

/**
 * Run the real PR-body sync against a draft whose live body is `liveBody` and
 * return the body it published, as a merge-conflict repair or a completion
 * exit would leave it.
 */
async function syncedBody(liveBody: string): Promise<string> {
  const repoPath = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${repoPath}/docs/archive/pr-summaries/pr-summary-7.md`,
      "## Summary\n\nRewritten summary. Closes #7.\n",
    );
    let published = "";
    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR,
        repoPath,
        beforeSha: "before",
        workerName: "worker-a",
        githubUser: "ghuser",
        branchName: SYNC_BRANCH,
      },
      {
        logger: SYNC_LOGGER,
        runGhCommand: async (args) => {
          if (args[0] === "pr" && args[1] === "view") {
            return JSON.stringify({
              body: liveBody,
              files: [],
              headRefOid: SHA,
              headRefName: SYNC_BRANCH,
            });
          }
          if (args[0] === "pr" && args[1] === "edit") {
            published = await Deno.readTextFile(
              args[args.indexOf("--body-file") + 1]!,
            );
            return "";
          }
          throw new Error(`unexpected gh ${args.join(" ")}`);
        },
        runGitCommand: (args) =>
          Promise.resolve({
            ok: true as const,
            value: {
              code: 0,
              // `git diff --name-only` names the summary, so it changed.
              stdout: args[0] === "rev-parse" ? `${SHA}\n` : "summary\n",
              stderr: "",
            },
          }),
      },
    );
    assert(result.ok, `sync failed: ${JSON.stringify(result)}`);
    assertEquals(
      result.value.status,
      "updated",
      "the sync must rebuild the body for this test to reach the marker",
    );
    return published;
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
}

Deno.test("#4952 - a continuation draft stays held after the body sync adopts its marker-less body", async () => {
  const body = await syncedBody(buildDraftContinuationBody(7));
  assertEquals(
    body.startsWith(`${DRAFT_CONTINUATION_MARKER}\n\n`),
    true,
    "the rebuilt body must still open with the marker",
  );
  assertEquals(
    body.split(DRAFT_CONTINUATION_MARKER).length - 1,
    1,
    "the marker is kept once, not duplicated",
  );
  const run = await heal({
    pr: healthyDraft({ body }),
    issue: OPEN_UNCLAIMED,
  });
  assertFalse(run.healed, "a synced hold is still a hold");
  assertEquals(run.readyCalls, []);
});

Deno.test("#4952 - a worker-marked hold draft stays held after the body sync refreshes it", async () => {
  const workerBody = "## Summary\n\nOld.\n\n<!-- vibe-worker-issue-7 -->";
  const body = await syncedBody(legacyUnmetHoldBody(7, workerBody));
  assertEquals(body.startsWith(`${DRAFT_CONTINUATION_MARKER}\n\n`), true);
  const run = await heal({
    pr: healthyDraft({ body }),
    issue: OPEN_UNCLAIMED,
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls, []);
});

Deno.test("#4952 - control: the body sync adds no marker to a draft that never had one, so it is still healed", async () => {
  const body = await syncedBody("Work in progress, no marker.");
  assertFalse(body.includes(DRAFT_CONTINUATION_MARKER));
  const run = await heal({
    pr: healthyDraft({ body }),
    issue: OPEN_UNCLAIMED,
  });
  assert(run.healed);
});
