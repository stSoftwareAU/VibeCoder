/**
 * Tests for `pr_body_sync.ts` — refreshing a PR's body from a rewritten
 * summary on a review-fix run (Issue #3089).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  assemblePrBody,
  buildSummaryDigestMarker,
  PR_SUMMARY_DIGEST_PREFIX,
  prSummaryDigest,
  runPrBodySync,
  summaryDigestFromBody,
  type SyncPrBodyDeps,
  syncPrBodyFromSummary,
} from "../lib/pr_body_sync.ts";
import {
  buildSubAgentTierMarker,
  WORKER_PR_MARKER_PREFIX,
} from "../lib/pr_body.ts";
import { MILESTONE_CHILD_BUMP_NOTE } from "../lib/bump_deps.ts";
import type {
  GitCommandOptions,
  GitCommandOutput,
} from "../lib/git_timeout.ts";
import type { Logger, Result } from "../types.ts";

const noop = () => {};
const logger: Logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  security: noop,
  skipReason: noop,
  timing: noop,
  scanSummary: noop,
  workerSummary: noop,
};

const REPO = "owner/repo";
const PR_NUMBER = 7;
const ISSUE_NUMBER = 42;
const BEFORE_SHA = "beforesha0000000000000000000000000000000";
const HEAD_SHA = "headsha00000000000000000000000000000000";

function marker(issueNumber: number): string {
  return `${WORKER_PR_MARKER_PREFIX}${issueNumber} -->`;
}

async function makeRepo(opts: { withSummary?: boolean } = {}): Promise<string> {
  const root = await Deno.makeTempDir();
  if (opts.withSummary ?? true) {
    await Deno.mkdir(`${root}/docs/archive/pr-summaries`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/archive/pr-summaries/pr-summary-${ISSUE_NUMBER}.md`,
      `## Summary\n\nRewritten summary text. Closes #${ISSUE_NUMBER}.\n`,
    );
  }
  return root;
}

interface GhCall {
  args: string[];
  bodyFileContent?: string;
}

/** Records every `gh` call; captures `--body-file` content before cleanup. */
function stubGh(ghCalls: GhCall[], opts: { throwOnEdit?: boolean } = {}) {
  return async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "edit") {
      const idx = args.indexOf("--body-file");
      let bodyFileContent: string | undefined;
      const bodyFilePath = idx !== -1 ? args[idx + 1] : undefined;
      if (bodyFilePath) {
        bodyFileContent = await Deno.readTextFile(bodyFilePath);
      }
      ghCalls.push({ args, bodyFileContent });
      if (opts.throwOnEdit) {
        throw new Error("gh pr edit failed");
      }
      return "";
    }
    ghCalls.push({ args });
    return "";
  };
}

interface GitStubOptions {
  diffChanged?: boolean;
  diffFails?: boolean;
  headSha?: string;
  /**
   * [ancestor, descendant] pairs for which `merge-base --is-ancestor
   * <ancestor> <descendant>` should report success (exit 0). Models real
   * git ancestry instead of a fixed answer, so a caller that swaps the two
   * SHAs gets the opposite result (PR #3353 review, round 3). Any argv not
   * in this list reports "not an ancestor" (exit 1) — fails closed, since
   * most tests never reach this branch.
   */
  ancestorPairs?: Array<[string, string]>;
  /** When true, `merge-base` itself fails (ok: false) — models exit 128 when the compared SHA is not in the local checkout. */
  mergeBaseFails?: boolean;
}

function stubGit(gitCalls: string[][], opts: GitStubOptions = {}) {
  return (
    args: string[],
    _options?: GitCommandOptions,
  ): Promise<Result<GitCommandOutput>> => {
    gitCalls.push(args);
    if (args[0] === "diff") {
      if (opts.diffFails) {
        return Promise.resolve({
          ok: false,
          error: new Error("git diff boom"),
        });
      }
      const summaryPath = args[args.length - 1] ?? "";
      return Promise.resolve({
        ok: true,
        value: {
          code: 0,
          stdout: (opts.diffChanged ?? true) ? summaryPath : "",
          stderr: "",
        },
      });
    }
    if (args[0] === "rev-parse") {
      return Promise.resolve({
        ok: true,
        value: { code: 0, stdout: `${opts.headSha ?? HEAD_SHA}\n`, stderr: "" },
      });
    }
    if (args[0] === "merge-base") {
      if (opts.mergeBaseFails) {
        return Promise.resolve({
          ok: false,
          error: new Error("fatal: Not a valid commit name"),
        });
      }
      const [ancestor, descendant] = args.slice(2);
      const isAncestor = (opts.ancestorPairs ?? []).some(
        ([a, d]) => a === ancestor && d === descendant,
      );
      return Promise.resolve({
        ok: true,
        value: { code: isAncestor ? 0 : 1, stdout: "", stderr: "" },
      });
    }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
}

function baseBody(issueNumber: number): string {
  return `## Summary\n\nOriginal summary. Closes #${issueNumber}.\n\n---\n\n` +
    `🤖 Processed by: old-worker\n${marker(issueNumber)}`;
}

function viewJson(
  body: string,
  files: string[] = [],
  headRefOid: string = HEAD_SHA,
): string {
  return JSON.stringify({
    body,
    files: files.map((path) => ({ path })),
    headRefOid,
  });
}

// --- assemblePrBody -------------------------------------------------------

Deno.test("assemblePrBody - uses the summary content when present", () => {
  const body = assemblePrBody({
    summaryContent: "## Summary\n\nDid the thing. Closes #42.",
    issueNumber: 42,
    extraSections: "",
    footer: "\n---\n\nfooter",
    summaryDigest: "deadbeef",
    subAgentTier: undefined,
  });
  assertStringIncludes(body, "Did the thing.");
  assertStringIncludes(body, "footer");
  assertStringIncludes(body, marker(42));
});

Deno.test("assemblePrBody - falls back to a minimal body when the summary is empty", () => {
  const body = assemblePrBody({
    summaryContent: "",
    issueNumber: 42,
    extraSections: "",
    footer: "",
    summaryDigest: "deadbeef",
    subAgentTier: undefined,
  });
  assertStringIncludes(body, "## Summary");
  assertStringIncludes(body, "Closes #42.");
});

Deno.test("assemblePrBody - appends a closing keyword when the summary lacks one", () => {
  const body = assemblePrBody({
    summaryContent: "## Summary\n\nDid the thing, no closing keyword here.",
    issueNumber: 42,
    extraSections: "",
    footer: "",
    summaryDigest: "deadbeef",
    subAgentTier: undefined,
  });
  assertStringIncludes(body, "Closes #42");
});

Deno.test("assemblePrBody - records the summary digest marker right after the worker marker", () => {
  const digest = "a".repeat(64);
  const body = assemblePrBody({
    summaryContent: "## Summary\n\nDid the thing. Closes #42.",
    issueNumber: 42,
    extraSections: "",
    footer: "\n---\n\nfooter",
    summaryDigest: digest,
    subAgentTier: undefined,
  });
  const markerIdx = body.indexOf(marker(42));
  const digestMarker = buildSummaryDigestMarker(digest);
  const digestIdx = body.indexOf(digestMarker);
  assert(markerIdx !== -1, "expected worker marker to be present");
  assert(digestIdx !== -1, "expected digest marker to be present");
  assert(
    digestIdx > markerIdx,
    "expected digest marker to follow the worker marker",
  );
  assertEquals(
    body.slice(markerIdx + marker(42).length, digestIdx + digestMarker.length)
      .trim(),
    digestMarker,
  );
  assertEquals(summaryDigestFromBody(body), digest);
});

// --- subAgentTier (Issue #3403) --------------------------------------------

/** Every occurrence of the sub-agent tier marker in `body`. */
function tierMarkerOccurrences(body: string): string[] {
  return body.match(/<!-- vibe-sub-agent-tier tier="[a-z]+" -->/g) ?? [];
}

Deno.test("assemblePrBody - carries exactly one tier marker, even when the summary quotes a different one", () => {
  const body = assemblePrBody({
    summaryContent: `## Summary\n\nQuoting the marker: ${
      buildSubAgentTierMarker("sonnet")
    }\n\nDid the thing. Closes #42.`,
    issueNumber: 42,
    extraSections: "",
    footer: "\n---\n\nfooter",
    summaryDigest: "deadbeef",
    subAgentTier: "haiku",
  });
  assertEquals(tierMarkerOccurrences(body), [buildSubAgentTierMarker("haiku")]);
});

Deno.test("assemblePrBody - carries no tier marker when subAgentTier is undefined", () => {
  const body = assemblePrBody({
    summaryContent: "## Summary\n\nDid the thing. Closes #42.",
    issueNumber: 42,
    extraSections: "",
    footer: "\n---\n\nfooter",
    summaryDigest: "deadbeef",
    subAgentTier: undefined,
  });
  assertEquals(tierMarkerOccurrences(body), []);
});

// --- prSummaryDigest / summaryDigestFromBody -------------------------------

Deno.test("prSummaryDigest - produces 64 lowercase hex characters", async () => {
  const digest = await prSummaryDigest("## Summary\n\nSome content.\n");
  assertEquals(digest.length, 64);
  assert(
    /^[0-9a-f]{64}$/.test(digest),
    `expected lowercase hex, got ${digest}`,
  );
});

Deno.test("prSummaryDigest - same content yields the same digest", async () => {
  const a = await prSummaryDigest("## Summary\n\nSame content.\n");
  const b = await prSummaryDigest("## Summary\n\nSame content.\n");
  assertEquals(a, b);
});

Deno.test("prSummaryDigest - different content yields a different digest", async () => {
  const a = await prSummaryDigest("## Summary\n\nContent A.\n");
  const b = await prSummaryDigest("## Summary\n\nContent B.\n");
  assert(a !== b);
});

Deno.test("summaryDigestFromBody - returns undefined when no marker is present", () => {
  assertEquals(summaryDigestFromBody(baseBody(ISSUE_NUMBER)), undefined);
});

Deno.test("summaryDigestFromBody - ignores a malformed marker (not 64 hex characters)", () => {
  const body = `${
    baseBody(ISSUE_NUMBER)
  }\n${PR_SUMMARY_DIGEST_PREFIX}abc123" -->`;
  assertEquals(summaryDigestFromBody(body), undefined);
});

Deno.test("summaryDigestFromBody - the last occurrence wins when the summary quotes an earlier marker", () => {
  const earlier = "b".repeat(64);
  const real = "c".repeat(64);
  const body =
    `## Summary\n\nQuoting an old marker: ${
      buildSummaryDigestMarker(earlier)
    }\n\n` +
    `${baseBody(ISSUE_NUMBER)}\n${buildSummaryDigestMarker(real)}`;
  assertEquals(summaryDigestFromBody(body), real);
});

// --- syncPrBodyFromSummary -------------------------------------------------

Deno.test("sync - summary changed: edits the PR once with the refreshed body", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(
            viewJson(baseBody(ISSUE_NUMBER), ["src/a.ts"]),
          );
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls, { diffChanged: true }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok, `expected ok, got ${JSON.stringify(result)}`);
    if (result.ok) {
      assertEquals(result.value, {
        status: "updated",
        issueNumber: ISSUE_NUMBER,
      });
    }
    assertEquals(ghCalls.length, 1);
    const editCall = ghCalls[0];
    assert(editCall, "expected one gh call to have been recorded");
    assertEquals(editCall.args[0], "pr");
    assertEquals(editCall.args[1], "edit");
    const newBody = editCall.bodyFileContent ?? "";
    assertStringIncludes(newBody, "Rewritten summary text.");
    assertStringIncludes(newBody, marker(ISSUE_NUMBER));
    assertStringIncludes(newBody, "Processed by:");
    assertStringIncludes(newBody, `Closes #${ISSUE_NUMBER}`);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - a legacy body with no tier marker gets none added (Issue #3403)", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          // `baseBody` carries no summary-digest marker and no tier marker —
          // the legacy shape from before either existed.
          return Promise.resolve(
            viewJson(baseBody(ISSUE_NUMBER), ["src/a.ts"]),
          );
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls, { diffChanged: true }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok, `expected ok, got ${JSON.stringify(result)}`);
    assertEquals(ghCalls.length, 1);
    const newBody = ghCalls[0]?.bodyFileContent ?? "";
    assertEquals(tierMarkerOccurrences(newBody), []);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - a live body carrying the haiku tier marker rebuilds with exactly one haiku marker (Issue #3403)", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    // An OLD digest, so the recorded digest differs from the current
    // summary file's content and the sync proceeds via the digest path
    // (not the legacy before-push-SHA path).
    const oldDigest = "0".repeat(64);
    const liveBody = `${baseBody(ISSUE_NUMBER)}\n${
      buildSummaryDigestMarker(oldDigest)
    }\n${buildSubAgentTierMarker("haiku")}`;
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(liveBody, ["src/a.ts"]));
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls, { diffChanged: true }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok, `expected ok, got ${JSON.stringify(result)}`);
    assertEquals(ghCalls.length, 1);
    const newBody = ghCalls[0]?.bodyFileContent ?? "";
    assertEquals(tierMarkerOccurrences(newBody), [
      buildSubAgentTierMarker("haiku"),
    ]);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - summary unchanged: skips without editing", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(baseBody(ISSUE_NUMBER)));
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls, { diffChanged: false }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value, {
        status: "skipped",
        reason: "summary unchanged",
      });
    }
    assertEquals(ghCalls.length, 0);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - no worker marker: skips without editing or diffing", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(
            viewJson("## Summary\n\nA PR nobody authored with the worker."),
          );
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value, {
        status: "skipped",
        reason: "no worker marker",
      });
    }
    assertEquals(ghCalls.length, 0);
    assertEquals(gitCalls.length, 0);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

// --- issueNumberFromMarker: quoted markers in the summary (PR #3353 review) ---

Deno.test("sync - a summary quoting an earlier numeric worker marker is not mistaken for this PR's issue", async () => {
  const repoPath = await makeRepo(); // writes pr-summary-42.md only
  try {
    const quotedMarker = marker(7);
    const liveBody =
      `## Summary\n\nThe marker \`${quotedMarker}\` records the issue.\n\n` +
      `---\n\n🤖 Processed by: old-worker\n${marker(ISSUE_NUMBER)}`;
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(liveBody));
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls, { diffChanged: true }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    // Pre-fix: issueNumberFromMarker took the FIRST occurrence (7), which
    // has no pr-summary-7.md file, so the broken code would report
    // {status: "skipped", reason: "summary file deleted"} instead.
    assert(result.ok, `expected ok, got ${JSON.stringify(result)}`);
    if (result.ok) {
      assertEquals(result.value, {
        status: "updated",
        issueNumber: ISSUE_NUMBER,
      });
    }
    const newBody = ghCalls[0]?.bodyFileContent ?? "";
    assertStringIncludes(newBody, "Rewritten summary text.");
    assertStringIncludes(newBody, `Closes #${ISSUE_NUMBER}`);
    assertEquals(newBody.includes("Closes #7"), false);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - a non-numeric placeholder marker in the summary does not block the real marker", async () => {
  const repoPath = await makeRepo();
  try {
    const placeholder = "<!-- vibe-worker-issue-N -->";
    const liveBody =
      `## Summary\n\nThe marker \`${placeholder}\` records the issue.\n\n` +
      `---\n\n🤖 Processed by: old-worker\n${marker(ISSUE_NUMBER)}`;
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(liveBody));
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls, { diffChanged: true }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    // Pre-fix: issueNumberFromMarker stopped at the FIRST occurrence of the
    // prefix (the placeholder), whose digits regex failed to match "N", so
    // the broken code would report {status: "skipped", reason: "no worker
    // marker"} instead of reaching the real marker that follows it.
    assert(result.ok, `expected ok, got ${JSON.stringify(result)}`);
    if (result.ok) {
      assertEquals(result.value, {
        status: "updated",
        issueNumber: ISSUE_NUMBER,
      });
    }
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

// --- checkout freshness vs the PR's remote head (PR #3353 review) ------------

Deno.test("sync - checkout HEAD differs from the PR's remote head: skips without editing", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          // A concurrent run pushed a newer head after this checkout was
          // made — the remote's headRefOid no longer matches this
          // checkout's local HEAD (which the git stub reports as
          // HEAD_SHA below).
          return Promise.resolve(
            viewJson(baseBody(ISSUE_NUMBER), [], "newer-remote-head-sha"),
          );
        }
        return stubGh(ghCalls)(args);
      },
      // Trap for a swapped argument order (PR #3353 review, round 3): the
      // real ancestry here is "local HEAD_SHA is behind newer-remote-head-
      // sha", so the pair below only matches if the production code were to
      // call merge-base with the two SHAs swapped — which would wrongly
      // report "is an ancestor" and make this test edit instead of skip.
      runGitCommand: stubGit(gitCalls, {
        diffChanged: true,
        ancestorPairs: [[HEAD_SHA, "newer-remote-head-sha"]],
      }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok, `expected ok, got ${JSON.stringify(result)}`);
    if (result.ok) {
      assertEquals(result.value, {
        status: "skipped",
        reason: "checkout is not the PR head",
      });
    }
    assertEquals(ghCalls.length, 0);
    assertEquals(
      gitCalls.find((call) => call[0] === "merge-base"),
      ["merge-base", "--is-ancestor", "newer-remote-head-sha", HEAD_SHA],
      "expected the remote (older) head to be checked as the ancestor argument",
    );
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - PR's reported head lags behind this checkout's own verified push: still edits (PR #3353 review, round 2)", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          // GitHub's API has not yet caught up with the push this run just
          // made and verified against the remote: it still reports the
          // PRE-push SHA as headRefOid, while local HEAD is already at the
          // pushed HEAD_SHA (an ancestor relationship, not a divergence).
          return Promise.resolve(
            viewJson(baseBody(ISSUE_NUMBER), [], BEFORE_SHA),
          );
        }
        return stubGh(ghCalls)(args);
      },
      // Only [BEFORE_SHA, HEAD_SHA] (the remote's stale head is an ancestor
      // of our own verified push) answers "is an ancestor" — a swapped argv
      // would miss this pair, fall through to the default "not an ancestor",
      // and skip instead of editing (PR #3353 review, round 3).
      runGitCommand: stubGit(gitCalls, {
        diffChanged: true,
        ancestorPairs: [[BEFORE_SHA, HEAD_SHA]],
      }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok, `expected ok, got ${JSON.stringify(result)}`);
    if (result.ok) {
      assertEquals(result.value, {
        status: "updated",
        issueNumber: ISSUE_NUMBER,
      });
    }
    assertEquals(
      gitCalls.find((call) => call[0] === "merge-base"),
      ["merge-base", "--is-ancestor", BEFORE_SHA, HEAD_SHA],
      "expected the PR's reported (stale) head checked as the ancestor argument",
    );
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - merge-base itself fails: skips without editing (PR #3353 review, round 3)", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          // Remote reports a head that is not reachable from this shallow
          // or stale local checkout at all — merge-base can't even compare
          // them (git exits 128, "fatal: Not a valid commit name").
          return Promise.resolve(
            viewJson(baseBody(ISSUE_NUMBER), [], "newer-remote-head-sha"),
          );
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls, {
        diffChanged: true,
        mergeBaseFails: true,
      }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok, `expected ok, got ${JSON.stringify(result)}`);
    if (result.ok) {
      assertEquals(result.value, {
        status: "skipped",
        reason: "checkout is not the PR head",
      });
    }
    assertEquals(ghCalls.length, 0);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - no before-push SHA: skips without editing", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(baseBody(ISSUE_NUMBER)));
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: undefined,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value, {
        status: "skipped",
        reason: "no before-push sha",
      });
    }
    assertEquals(ghCalls.length, 0);
    assertEquals(gitCalls.length, 0);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - gh pr edit throws: returns an error Result", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(
            viewJson(baseBody(ISSUE_NUMBER), ["src/a.ts"]),
          );
        }
        return stubGh(ghCalls, { throwOnEdit: true })(args);
      },
      runGitCommand: stubGit(gitCalls, { diffChanged: true }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "Failed to update PR");
    }
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - git diff fails: returns an error Result", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(baseBody(ISSUE_NUMBER)));
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls, { diffFails: true }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "Failed to diff");
    }
    assertEquals(ghCalls.length, 0);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - carries over the milestone section and bump-skip note from the existing body", async () => {
  const repoPath = await makeRepo();
  try {
    const existingBody =
      `## Summary\n\nOriginal summary. Closes #${ISSUE_NUMBER}.\n\n` +
      `\n## Milestone\nPart of milestone "Great Milestone" (branch \`milestone/great\`).\n\n` +
      `\n${MILESTONE_CHILD_BUMP_NOTE}\n\n---\n\n🤖 Processed by: old-worker\n${
        marker(ISSUE_NUMBER)
      }`;

    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(existingBody));
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls, { diffChanged: true }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value, {
        status: "updated",
        issueNumber: ISSUE_NUMBER,
      });
    }
    const editCall = ghCalls[0];
    assert(editCall, "expected one gh call to have been recorded");
    const newBody = editCall.bodyFileContent ?? "";
    assertStringIncludes(newBody, "Great Milestone");
    assertStringIncludes(newBody, MILESTONE_CHILD_BUMP_NOTE);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - empty repoPath: returns an error without calling gh", async () => {
  const ghCalls: GhCall[] = [];
  const gitCalls: string[][] = [];
  const deps: SyncPrBodyDeps = {
    runGhCommand: stubGh(ghCalls),
    runGitCommand: stubGit(gitCalls),
    logger,
  };

  const result = await syncPrBodyFromSummary(
    {
      repo: REPO,
      prNumber: PR_NUMBER,
      repoPath: "",
      beforeSha: BEFORE_SHA,
      workerName: "worker-a",
      githubUser: "ghuser",
    },
    deps,
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, `PR #${PR_NUMBER}`);
    assertStringIncludes(result.error.message, "No checkout path");
  }
  assertEquals(ghCalls.length, 0);
});

Deno.test("sync - summary file deleted: skips without editing", async () => {
  const repoPath = await makeRepo({ withSummary: false });
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(baseBody(ISSUE_NUMBER)));
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls, { diffChanged: true }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value, {
        status: "skipped",
        reason: "summary file deleted",
      });
    }
    assertEquals(ghCalls.length, 0);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - keeps a leading degraded-run section (Issue #2562)", async () => {
  const repoPath = await makeRepo();
  try {
    await Deno.writeTextFile(
      `${repoPath}/docs/archive/pr-summaries/pr-summary-${ISSUE_NUMBER}.md`,
      `# PR Summary — Issue #${ISSUE_NUMBER}: new title\n\n` +
        `## Summary\n\nRewritten summary text. Closes #${ISSUE_NUMBER}.\n`,
    );
    const degraded = [
      "## ⚠️ Degraded run — partial delivery",
      "",
      "This run was degraded (served by a fallback model) and did not show " +
      "every accepted scope item as met. The outstanding items continue in #77:",
      "",
      "- the export",
      "",
    ].join("\n");
    const oldSummary = [
      `# PR Summary — Issue #${ISSUE_NUMBER}: old title`,
      "",
      "Old preamble that must not survive.",
      "",
      "## Summary",
      "",
      `Original summary. Closes #${ISSUE_NUMBER}.`,
      "",
      "---",
      "",
      `🤖 Processed by: old-worker\n${marker(ISSUE_NUMBER)}`,
    ].join("\n");
    let live = `${degraded}\n${oldSummary}`;
    const ghCalls: GhCall[] = [];
    const record = stubGh(ghCalls);
    const deps: SyncPrBodyDeps = {
      runGhCommand: async (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return viewJson(live);
        }
        // Issue #3350: the banner is re-derived from the current issue.
        if (args[0] === "issue" && args[1] === "view") {
          return JSON.stringify({
            body: "## Acceptance Criteria\n\n- the export\n",
          });
        }
        const out = await record(args);
        const edited = ghCalls.at(-1)?.bodyFileContent;
        if (args[0] === "pr" && args[1] === "edit" && edited) live = edited;
        return out;
      },
      runGitCommand: stubGit([], { diffChanged: true }),
      logger,
    };
    const input = {
      repo: REPO,
      prNumber: PR_NUMBER,
      repoPath,
      beforeSha: BEFORE_SHA,
      workerName: "worker-a",
      githubUser: "ghuser",
    };

    const first = await syncPrBodyFromSummary(input, deps);
    assert(first.ok);
    if (first.ok) assertEquals(first.value.status, "updated");
    const synced = ghCalls[0]?.bodyFileContent ?? "";
    assert(synced.startsWith("## ⚠️ Degraded run — partial delivery"));
    assertStringIncludes(synced, "continue in #77");
    assertStringIncludes(synced, "new title");
    assertStringIncludes(synced, "Rewritten summary text.");
    assertEquals(synced.includes("old title"), false);
    assertEquals(synced.includes("Old preamble that must not survive."), false);
    assertEquals(synced.includes("Original summary."), false);

    // Issue #3315: the first sync recorded the summary digest inside the
    // body, so the second call now short-circuits on that recorded digest
    // (reason "summary unchanged") rather than reaching the "body already
    // current" comparison — same observable outcome (skipped, no edit).
    const second = await syncPrBodyFromSummary(input, deps);
    assert(second.ok);
    if (second.ok) {
      assertEquals(second.value, {
        status: "skipped",
        reason: "summary unchanged",
      });
    }
    assertEquals(ghCalls.length, 1);
    assertEquals(live, synced);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

// --- recorded-digest staleness (Issue #3315 / GRQ#5175) -------------------

Deno.test("sync - recorded digest of an OLDER summary, no before-push SHA, git stub reports unchanged: still updates", async () => {
  const repoPath = await makeRepo();
  try {
    const oldDigest = await prSummaryDigest(
      "## Summary\n\nOlder summary text.\n",
    );
    const liveBody =
      `## Summary\n\nOlder summary text.\n\n---\n\n🤖 Processed by: old-worker\n${
        marker(ISSUE_NUMBER)
      }\n${buildSummaryDigestMarker(oldDigest)}`;

    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(liveBody, ["src/a.ts"]));
        }
        return stubGh(ghCalls)(args);
      },
      // A missed-sync GRQ#5175 shape: the pre-push SHA diff would report
      // "unchanged" (it only catches a change made by *this* run), but the
      // recorded digest is stale regardless.
      runGitCommand: stubGit(gitCalls, { diffChanged: false }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: undefined,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok, `expected ok, got ${JSON.stringify(result)}`);
    if (result.ok) {
      assertEquals(result.value, {
        status: "updated",
        issueNumber: ISSUE_NUMBER,
      });
    }
    assertEquals(ghCalls.length, 1);
    assertEquals(
      gitCalls.filter((c) => c[0] === "diff").length,
      0,
      "expected no git diff call when a recorded digest decides staleness",
    );
    const newBody = ghCalls[0]?.bodyFileContent ?? "";
    assertStringIncludes(newBody, "Rewritten summary text.");
    const currentDigest = await prSummaryDigest(
      `## Summary\n\nRewritten summary text. Closes #${ISSUE_NUMBER}.\n`,
    );
    assertEquals(summaryDigestFromBody(newBody), currentDigest);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - recorded digest equals the current summary's digest: skips even though the git stub reports changed", async () => {
  const repoPath = await makeRepo();
  try {
    const currentDigest = await prSummaryDigest(
      `## Summary\n\nRewritten summary text. Closes #${ISSUE_NUMBER}.\n`,
    );
    const liveBody =
      `## Summary\n\nRewritten summary text. Closes #${ISSUE_NUMBER}.\n\n---\n\n🤖 Processed by: old-worker\n${
        marker(ISSUE_NUMBER)
      }\n${buildSummaryDigestMarker(currentDigest)}`;

    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(liveBody));
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls, { diffChanged: true }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value, {
        status: "skipped",
        reason: "summary unchanged",
      });
    }
    assertEquals(ghCalls.length, 0);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - round trip: a body produced by one sync is skipped as unchanged by the next", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    let live = baseBody(ISSUE_NUMBER);
    const deps: SyncPrBodyDeps = {
      runGhCommand: async (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return viewJson(live);
        }
        const out = await stubGh(ghCalls)(args);
        const edited = ghCalls.at(-1)?.bodyFileContent;
        if (args[0] === "pr" && args[1] === "edit" && edited) live = edited;
        return out;
      },
      runGitCommand: stubGit(gitCalls, { diffChanged: true }),
      logger,
    };
    const input = {
      repo: REPO,
      prNumber: PR_NUMBER,
      repoPath,
      beforeSha: BEFORE_SHA,
      workerName: "worker-a",
      githubUser: "ghuser",
    };

    const first = await syncPrBodyFromSummary(input, deps);
    assert(first.ok);
    if (first.ok) assertEquals(first.value.status, "updated");
    assertEquals(ghCalls.length, 1);

    const second = await syncPrBodyFromSummary(input, deps);
    assert(second.ok);
    if (second.ok) {
      assertEquals(second.value, {
        status: "skipped",
        reason: "summary unchanged",
      });
    }
    assertEquals(ghCalls.length, 1);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - recorded digest present and summary file deleted: skips without editing", async () => {
  const repoPath = await makeRepo({ withSummary: false });
  try {
    const digest = "d".repeat(64);
    const liveBody = `${baseBody(ISSUE_NUMBER)}\n${
      buildSummaryDigestMarker(digest)
    }`;
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(liveBody));
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls, { diffChanged: true }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: undefined,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value, {
        status: "skipped",
        reason: "summary file deleted",
      });
    }
    assertEquals(ghCalls.length, 0);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("runPrBodySync - a failed sync warns once and does not fail the caller", async () => {
  const warnings: string[] = [];
  const errors: string[] = [];
  const counting: Logger = {
    ...logger,
    warn: (message) => warnings.push(message),
    error: (message) => errors.push(message),
  };
  await runPrBodySync(
    {
      repo: REPO,
      prNumber: PR_NUMBER,
      repoPath: "/tmp/unused",
      beforeSha: BEFORE_SHA,
      workerName: "worker-a",
      githubUser: "ghuser",
    },
    {
      runGhCommand: () => Promise.resolve(""),
      runGitCommand: stubGit([]),
      logger: counting,
    },
    () =>
      Promise.resolve({
        ok: false,
        error: new Error("gh pr edit failed"),
      }),
  );
  assertEquals(warnings, ["PR body sync failed (Issue #3089)"]);
  assertEquals(errors, []);
});

// --- degraded-run section re-derivation (Issue #3350) ---------------------

const STALE_NO_FOLLOW_UP = [
  "## ⚠️ Degraded run — no follow-up filed",
  "",
  "This run was degraded (served model `claude-haiku-4-5` does not match " +
  "expected `opus`). No follow-up was filed because the issue states no " +
  "acceptance criteria.",
  "",
  "",
].join("\n");

const OLD_SUMMARY_WITH_FOOTER = [
  `# PR Summary — Issue #${ISSUE_NUMBER}: old title`,
  "",
  "## Summary",
  "",
  `Original summary. Closes #${ISSUE_NUMBER}.`,
  "",
  "---",
  "",
  `🤖 Processed by: old-worker\n${marker(ISSUE_NUMBER)}`,
].join("\n");

async function writeSummary(repoPath: string, text: string): Promise<void> {
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-${ISSUE_NUMBER}.md`,
    text,
  );
}

function criterionSummary(status: string, reviewer: string): string {
  return `## Summary\n\nDid it. Closes #${ISSUE_NUMBER}.\n\n` +
    `## Acceptance Criteria\n\n- **${status}** — the export works — ` +
    `evidence: \`worker/deno/tests/x_test.ts\` — reviewer: ${reviewer}\n`;
}

Deno.test("sync - re-derives a stale degraded-run section from the current issue and summary (Issue #3350)", async () => {
  const repoPath = await makeRepo();
  try {
    await writeSummary(repoPath, criterionSummary("met", "met"));
    const live = `${STALE_NO_FOLLOW_UP}\n${OLD_SUMMARY_WITH_FOOTER}`;
    const ghCalls: GhCall[] = [];
    const record = stubGh(ghCalls);
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(live));
        }
        if (args[0] === "issue" && args[1] === "view") {
          return Promise.resolve(JSON.stringify({
            body: "## Acceptance Criteria\n\n- the export works\n",
          }));
        }
        return record(args);
      },
      runGitCommand: stubGit([], { diffChanged: true }),
      logger,
    };
    const result = await syncPrBodyFromSummary({
      repo: REPO,
      prNumber: PR_NUMBER,
      repoPath,
      beforeSha: BEFORE_SHA,
      workerName: "worker-a",
      githubUser: "ghuser",
    }, deps);
    assert(result.ok);
    if (result.ok) assertEquals(result.value.status, "updated");
    const edit = ghCalls.find((c) => c.args[1] === "edit");
    const synced = edit?.bodyFileContent ?? "";
    assert(synced.length > 0, "expected a pr edit");
    assertEquals(synced.startsWith("## ⚠️ Degraded run"), false);
    assertEquals(synced.includes("states no acceptance criteria"), false);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

/** Runs one sync against `live` with the given issue-view behaviour. */
async function syncWithDegradedLive(opts: {
  summary: string;
  live: string;
  issueView: () => string;
}) {
  const repoPath = await makeRepo();
  try {
    await writeSummary(repoPath, opts.summary);
    const ghCalls: GhCall[] = [];
    const record = stubGh(ghCalls);
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(opts.live));
        }
        if (args[0] === "issue" && args[1] === "view") {
          ghCalls.push({ args });
          return Promise.resolve(opts.issueView());
        }
        return record(args);
      },
      runGitCommand: stubGit([], { diffChanged: true }),
      logger,
    };
    const result = await syncPrBodyFromSummary({
      repo: REPO,
      prNumber: PR_NUMBER,
      repoPath,
      beforeSha: BEFORE_SHA,
      workerName: "worker-a",
      githubUser: "ghuser",
    }, deps);
    return { result, ghCalls };
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
}

Deno.test("sync - fails loudly when the issue cannot be read to re-derive the degraded-run section (Issue #3350)", async () => {
  const { result, ghCalls } = await syncWithDegradedLive({
    summary: criterionSummary("met", "met"),
    live: `${STALE_NO_FOLLOW_UP}\n${OLD_SUMMARY_WITH_FOOTER}`,
    issueView: () => {
      throw new Error("gh issue view boom");
    },
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, `#${ISSUE_NUMBER}`);
  }
  assertEquals(ghCalls.some((c) => c.args[1] === "edit"), false);
});

Deno.test("sync - makes no issue call when the body carries no degraded-run section (Issue #3350)", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const record = stubGh(ghCalls);
    const live = `## Summary\n\nOld.\n\n---\n\n${marker(ISSUE_NUMBER)}`;
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(live));
        }
        return record(args);
      },
      runGitCommand: stubGit([], { diffChanged: true }),
      logger,
    };
    const result = await syncPrBodyFromSummary({
      repo: REPO,
      prNumber: PR_NUMBER,
      repoPath,
      beforeSha: BEFORE_SHA,
      workerName: "worker-a",
      githubUser: "ghuser",
    }, deps);
    assert(result.ok);
    assertEquals(ghCalls.length, 1);
    assertEquals(ghCalls.some((c) => c.args[0] === "issue"), false);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - a summary that now marks the criterion partial replaces the no-follow-up banner (Issue #3350)", async () => {
  const { result, ghCalls } = await syncWithDegradedLive({
    summary: criterionSummary("partial", "partial"),
    live: `${STALE_NO_FOLLOW_UP}\n${OLD_SUMMARY_WITH_FOOTER}`,
    issueView: () =>
      JSON.stringify({
        body: "## Acceptance Criteria\n\n- the export works\n",
      }),
  });
  assert(result.ok);
  const synced = ghCalls.find((c) => c.args[1] === "edit")?.bodyFileContent ??
    "";
  assertStringIncludes(synced, "The worker filed no follow-up for these items");
  assertStringIncludes(synced, "**partial** — the export works");
  assertEquals(synced.includes("No follow-up was filed because"), false);
});
