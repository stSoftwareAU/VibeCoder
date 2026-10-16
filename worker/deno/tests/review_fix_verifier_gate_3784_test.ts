/**
 * Tests for the review-fix verifier gate (Issue #3784).
 *
 * Calls the real `runReviewFixVerifierGate` against a temporary checkout. The
 * change-request body is rendered by the fleet's own `reviewBody`, and the
 * fake `gh` answers the same `--json` shape `gh pr view` and `gh issue view`
 * return. The verifier and recovery turn are injected fakes that record their
 * inputs.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ReviewFixVerifierGateDeps,
  type ReviewFixVerifierGateOutcome,
  runReviewFixVerifierGate,
} from "../lib/review_fix_verifier_gate.ts";
import type {
  PrePrVerifierInput,
  PrePrVerifierResult,
  ReviewFinding,
  ReviewReply,
} from "../lib/pre_pr_verifier.ts";
import { prResponseMessagePath } from "../lib/pr_branch_preparation.ts";
import { makeRecordingLogger } from "./support/fake_claim_hub.ts";
import {
  type FableReview,
  reviewBody,
} from "../../../.claude/skills/review-fleet-prs/scripts/review_log.ts";

const REPO = "org/repo";
const PR_NUMBER = 42;
const PR_SUMMARY = "docs/archive/pr-summaries/pr-summary-42.md";
const SUMMARY_TEXT = "## Summary\n\nThe retry counter resets on success.\n";

/** The `gh pr view --json baseRefName,title,body,files` file-list shape. */
const PR_FILES = [
  {
    path: "lib/a.ts",
    additions: 3,
    deletions: 1,
    changeType: "MODIFIED",
  },
  {
    path: PR_SUMMARY,
    additions: 9,
    deletions: 0,
    changeType: "ADDED",
  },
];

const FINDING: ReviewFinding = {
  file: "lib/a.ts",
  line: 12,
  problem: "The retry never resets the counter.",
  fix: "Reset the counter on success.",
};

/** A change-requesting review, rendered by the fleet's own `reviewBody`. */
const CHANGE_REQUEST = reviewBody(
  "changes_requested",
  {
    summary: "Please fix the retry.",
    findings: [FINDING],
    testChanges: "none",
    testChangeNotes: [],
    unrelatedIssues: [],
    checklist: [],
  } as FableReview,
  [],
);

function reviewWith(
  findings: ReviewFinding[],
  earlierFindings: ReviewReply["earlierFindings"],
): ReviewReply {
  return {
    summary: findings.length > 0 ? "Still open." : "Looks fixed.",
    findings,
    testChanges: "none",
    testChangeNotes: [],
    unrelatedIssues: [],
    checklist: [],
    earlierFindings,
  };
}

const CLEAN: PrePrVerifierResult = {
  status: "checked",
  review: reviewWith([], [{ index: 1, verdict: "fixed" }]),
};

const BLOCKED: PrePrVerifierResult = {
  status: "checked",
  review: reviewWith(
    [{
      file: "lib/a.ts",
      line: 12,
      problem: "Still not reset on the success path.",
      fix: "Reset it in the success branch.",
    }],
    [{ index: 1, verdict: "not fixed" }],
  ),
};

const NOT_CHECKED: PrePrVerifierResult = {
  status: "not_checked",
  reason: "verifier timed out",
};

/** A `gh` stub answering the PR and linked-issue reads. */
function defaultGh(args: string[]): Promise<string> {
  if (args[0] === "pr" && args[1] === "view") {
    return Promise.resolve(JSON.stringify({
      baseRefName: "main",
      title: "PR title",
      body: "PR body",
      files: PR_FILES,
    }));
  }
  if (args[0] === "issue" && args[1] === "view") {
    return Promise.resolve(JSON.stringify({
      title: "Linked issue title",
      body: "Linked issue body",
    }));
  }
  return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
}

interface RunOptions {
  changeRequest?: string;
  branchName?: string;
  prNumber?: number;
  gh?: (args: string[]) => Promise<string>;
  /** Verifier answers in call order; a call past the end is an error. */
  results?: PrePrVerifierResult[];
  recovery?: { ok: true } | { ok: false; error: Error };
  existingReply?: string;
  /** Skip writing the PR summary into the checkout. */
  omitSummaryFile?: boolean;
  /** Summary text the recovery turn writes into the checkout. */
  recoveryWritesSummary?: string;
}

interface RunResult {
  outcome: ReviewFixVerifierGateOutcome;
  repoPath: string;
  verifierInputs: PrePrVerifierInput[];
  recoveryPrompts: string[];
  ghCalls: string[][];
  records: Array<[string, unknown]>;
  /** `.pr_response_message` after the gate, or undefined when none was written. */
  reply: string | undefined;
}

async function runGate(options: RunOptions): Promise<RunResult> {
  const dir = await Deno.makeTempDir({ prefix: "review_fix_verifier_3784_" });
  try {
    if (!options.omitSummaryFile) {
      await Deno.mkdir(`${dir}/docs/archive/pr-summaries`, {
        recursive: true,
      });
      await Deno.writeTextFile(`${dir}/${PR_SUMMARY}`, SUMMARY_TEXT);
    }
    if (options.existingReply !== undefined) {
      await Deno.writeTextFile(
        prResponseMessagePath(dir),
        options.existingReply,
      );
    }

    const { logger, records } = makeRecordingLogger();
    const ghCalls: string[][] = [];
    const verifierInputs: PrePrVerifierInput[] = [];
    const recoveryPrompts: string[] = [];
    const queue = [...(options.results ?? [])];

    const deps: ReviewFixVerifierGateDeps = {
      runGh: (args: string[]) => {
        ghCalls.push(args);
        return (options.gh ?? defaultGh)(args);
      },
      runVerifier: (input: PrePrVerifierInput) => {
        verifierInputs.push(input);
        const next = queue.shift();
        if (next === undefined) {
          return Promise.reject(new Error("unexpected verifier call"));
        }
        return Promise.resolve(next);
      },
      runRecovery: async (prompt: string) => {
        recoveryPrompts.push(prompt);
        if (options.recoveryWritesSummary !== undefined) {
          await Deno.writeTextFile(
            `${dir}/${PR_SUMMARY}`,
            options.recoveryWritesSummary,
          );
        }
        return options.recovery ?? { ok: true };
      },
      logger,
    };

    const outcome = await runReviewFixVerifierGate(
      {
        repo: REPO,
        prNumber: options.prNumber ?? PR_NUMBER,
        branchName: options.branchName ?? "issue-42-foo",
        repoPath: dir,
        changeRequest: options.changeRequest ?? CHANGE_REQUEST,
        timeoutSeconds: 600,
      },
      deps,
    );

    let reply: string | undefined;
    try {
      reply = await Deno.readTextFile(prResponseMessagePath(dir));
    } catch {
      reply = undefined;
    }
    return {
      outcome,
      repoPath: dir,
      verifierInputs,
      recoveryPrompts,
      ghCalls,
      records,
      reply,
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const EXISTING_REPLY = "Existing reply text: I fixed the retry.";

// (a) ---------------------------------------------------------------------

Deno.test("review-fix verifier gate (#3784): a body with no fleet findings is skipped", async () => {
  const run = await runGate({ changeRequest: "Looks good, thanks." });

  assertEquals(run.outcome.status, "skipped");
  assertEquals(run.verifierInputs.length, 0);
  assertEquals(run.reply, undefined);
});

// (b) ---------------------------------------------------------------------

Deno.test("review-fix verifier gate (#3784): a clean round calls the verifier on the review-fix round and writes no reply", async () => {
  const run = await runGate({ results: [CLEAN] });

  assertEquals(run.outcome, { status: "clean", recoveryRan: false });
  assertEquals(run.verifierInputs.length, 1);
  const input = run.verifierInputs[0]!;
  assertEquals(input.round, {
    kind: "review-fix",
    prNumber: PR_NUMBER,
    previousFindings: [{
      file: "lib/a.ts",
      line: 12,
      problem: "The retry never resets the counter.",
      fix: "Reset the counter on success.",
    }],
  });
  assertEquals(input.baseRef, "origin/main");
  assertEquals(input.changedFiles, ["lib/a.ts", PR_SUMMARY]);
  assertEquals(input.summaryPath, PR_SUMMARY);
  assertEquals(input.summaryContent, SUMMARY_TEXT);
  assertEquals(input.repoPath, run.repoPath);
  assertEquals(input.issueNumber, 42);
  assertEquals(input.issueTitle, "Linked issue title");
  assertEquals(input.issueBody, "Linked issue body");
  assertEquals(run.reply, undefined);
});

Deno.test("review-fix verifier gate (#3784): the per-finding verdicts are logged at info", async () => {
  const run = await runGate({ results: [CLEAN] });

  const verdictLines = run.records.filter(([message]) =>
    message === "Review-fix verifier verdicts (Issue #3784)"
  );
  assertEquals(verdictLines.length, 1);
  assertEquals(verdictLines[0]![1], {
    repo: REPO,
    prNumber: PR_NUMBER,
    verdicts: { "1": "fixed" },
  });
});

// (c) ---------------------------------------------------------------------

Deno.test("review-fix verifier gate (#3784): blocked then recovered runs one recovery turn, re-checks, and writes no reply", async () => {
  const run = await runGate({ results: [BLOCKED, CLEAN] });

  assertEquals(run.outcome, { status: "recovered", recoveryRan: true });
  assertEquals(run.recoveryPrompts.length, 1);
  assertStringIncludes(
    run.recoveryPrompts[0]!,
    "Still not reset on the success path.",
  );
  assertEquals(run.verifierInputs.length, 2);
  assertEquals(run.reply, undefined);
});

// (d) ---------------------------------------------------------------------

Deno.test("review-fix verifier gate (#3784): blocked twice is reported in the reply, keeping existing text first", async () => {
  const run = await runGate({
    results: [BLOCKED, BLOCKED],
    existingReply: EXISTING_REPLY,
  });

  assertEquals(run.outcome.status, "reported");
  if (run.outcome.status !== "reported") throw new Error("unreachable");
  assertEquals(run.outcome.recoveryRan, true);
  assertEquals(
    run.outcome.review.findings[0]!.problem,
    "Still not reset on the success path.",
  );
  assertEquals(run.recoveryPrompts.length, 1);
  assertEquals(run.verifierInputs.length, 2);

  const reply = run.reply!;
  assert(reply.startsWith(EXISTING_REPLY), "existing reply text stays first");
  assertStringIncludes(reply, "### Review-fix verifier (Issue #3784)");
  assertStringIncludes(reply, "Still not reset on the success path.");
  assertStringIncludes(
    reply,
    "still unresolved after its one recovery attempt",
  );
  assert(!reply.includes("<!--"), "no HTML comment is written");
});

// (e) ---------------------------------------------------------------------

Deno.test("review-fix verifier gate (#3784): blocked then the re-check cannot run is reported, never recovered", async () => {
  const run = await runGate({ results: [BLOCKED, NOT_CHECKED] });

  assertEquals(run.outcome.status, "reported");
  if (run.outcome.status !== "reported") throw new Error("unreachable");
  assertEquals(run.outcome.recoveryRan, true);
  // The reported review is the first check's, the one the round still owes.
  assertEquals(
    run.outcome.review.findings[0]!.problem,
    "Still not reset on the success path.",
  );

  const reply = run.reply!;
  assertStringIncludes(reply, "Still not reset on the success path.");
  assertStringIncludes(
    reply,
    "The re-check after that recovery attempt could not run",
  );
  assertStringIncludes(reply, "(verifier timed out)");
});

Deno.test("review-fix verifier gate (#3784): the re-check reads the PR summary and files the recovery turn left", async () => {
  const fixedSummary =
    "## Summary\n\nThe retry counter resets on success and on retry.\n";
  let prViews = 0;
  const run = await runGate({
    results: [BLOCKED, CLEAN],
    recoveryWritesSummary: fixedSummary,
    gh: (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && ++prViews === 2) {
        return Promise.resolve(JSON.stringify({
          baseRefName: "main",
          title: "PR title",
          body: "PR body",
          files: [...PR_FILES, { path: "lib/a_test.ts" }],
        }));
      }
      return defaultGh(args);
    },
  });

  assertEquals(run.outcome, { status: "recovered", recoveryRan: true });
  assertEquals(run.verifierInputs.length, 2);
  assertEquals(run.verifierInputs[0]!.summaryContent, SUMMARY_TEXT);
  assertEquals(run.verifierInputs[1]!.summaryContent, fixedSummary);
  assertEquals(run.verifierInputs[1]!.changedFiles, [
    "lib/a.ts",
    PR_SUMMARY,
    "lib/a_test.ts",
  ]);
  assertEquals(run.verifierInputs[1]!.round, run.verifierInputs[0]!.round);
});

Deno.test("review-fix verifier gate (#3784): a PR read that fails before the re-check is reported as a re-check that could not run", async () => {
  let prViews = 0;
  const run = await runGate({
    results: [BLOCKED],
    gh: (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && ++prViews === 2) {
        return Promise.reject(new Error("gh: HTTP 502"));
      }
      return defaultGh(args);
    },
  });

  assertEquals(run.outcome.status, "reported");
  if (run.outcome.status !== "reported") throw new Error("unreachable");
  assertEquals(run.outcome.recoveryRan, true);
  assertEquals(run.verifierInputs.length, 1);
  const reply = run.reply!;
  assertStringIncludes(
    reply,
    "The re-check after that recovery attempt could not run",
  );
  assertStringIncludes(reply, "gh: HTTP 502");
});

// (f) ---------------------------------------------------------------------

Deno.test("review-fix verifier gate (#3784): a round the verifier did not check says so in the reply", async () => {
  const run = await runGate({ results: [NOT_CHECKED] });

  assertEquals(run.outcome, {
    status: "not_checked",
    reason: "verifier not checked: verifier timed out",
    recoveryRan: false,
  });
  assertEquals(run.recoveryPrompts.length, 0);
  const reply = run.reply!;
  assertStringIncludes(reply, "### Review-fix verifier (Issue #3784)");
  assertStringIncludes(reply, "could not check this round");
  assertStringIncludes(reply, "no earlier finding is confirmed fixed by it");
});

// (g) ---------------------------------------------------------------------

Deno.test("review-fix verifier gate (#3784): a failed gh read is not checked, with the reason in the reply", async () => {
  const run = await runGate({
    results: [CLEAN],
    gh: () => Promise.reject(new Error("gh: HTTP 502")),
  });

  assertEquals(run.outcome.status, "not_checked");
  if (run.outcome.status !== "not_checked") throw new Error("unreachable");
  assertStringIncludes(run.outcome.reason, "could not read PR #42");
  assertStringIncludes(run.outcome.reason, "gh: HTTP 502");
  assertEquals(run.verifierInputs.length, 0);
  assertStringIncludes(run.reply!, "could not check this round");
  assertStringIncludes(run.reply!, "gh: HTTP 502");
});

// (h) ---------------------------------------------------------------------

Deno.test("review-fix verifier gate (#3784): a PR with no summary file is not checked", async () => {
  const run = await runGate({
    results: [CLEAN],
    gh: (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view") {
        return Promise.resolve(JSON.stringify({
          baseRefName: "main",
          title: "PR title",
          body: "PR body",
          files: [PR_FILES[0]],
        }));
      }
      return defaultGh(args);
    },
  });

  assertEquals(run.outcome, {
    status: "not_checked",
    reason:
      "the PR carries no PR summary file, so the verifier has no PR body to read",
    recoveryRan: false,
  });
  assertEquals(run.verifierInputs.length, 0);
  assertStringIncludes(run.reply!, "the PR carries no PR summary file");
});

// (i) ---------------------------------------------------------------------

Deno.test("review-fix verifier gate (#3784): a malformed base ref is not checked", async () => {
  for (const baseRefName of ["-x", "a..b", "/etc/passwd"]) {
    const run = await runGate({
      results: [CLEAN],
      gh: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(JSON.stringify({
            baseRefName,
            title: "PR title",
            body: "PR body",
            files: PR_FILES,
          }));
        }
        return defaultGh(args);
      },
    });

    assertEquals(run.outcome.status, "not_checked", baseRefName);
    assertEquals(run.verifierInputs.length, 0, baseRefName);
    assertStringIncludes(run.reply!, "is not well-formed");
  }
});

// (j) ---------------------------------------------------------------------

Deno.test("review-fix verifier gate (#3784): a branch naming no issue uses the PR's title and body", async () => {
  const issueReads: string[][] = [];
  const run = await runGate({
    prNumber: 77,
    branchName: "feature-without-issue",
    results: [CLEAN],
    gh: (args: string[]) => {
      if (args[0] === "issue") issueReads.push(args);
      return defaultGh(args);
    },
  });

  assertEquals(run.outcome, { status: "clean", recoveryRan: false });
  assertEquals(issueReads.length, 0);
  const input = run.verifierInputs[0]!;
  assertEquals(input.issueNumber, 77);
  assertEquals(input.issueTitle, "PR title");
  assertEquals(input.issueBody, "PR body");
});

// (k) ---------------------------------------------------------------------

Deno.test("review-fix verifier gate (#3784): a recovery turn that cannot launch still re-runs the verifier, and is never reported as recovered", async () => {
  const failedLaunch = {
    ok: false as const,
    error: new Error("claude could not launch"),
  };

  const blockedTwice = await runGate({
    results: [BLOCKED, BLOCKED],
    recovery: failedLaunch,
  });
  assertEquals(blockedTwice.recoveryPrompts.length, 1);
  assertEquals(blockedTwice.verifierInputs.length, 2);
  assertEquals(blockedTwice.outcome.status, "reported");
  if (blockedTwice.outcome.status !== "reported") {
    throw new Error("unreachable");
  }
  assertEquals(blockedTwice.outcome.recoveryRan, false);
  assertStringIncludes(blockedTwice.reply!, "still unresolved");

  // Re-check passes on the same head, but no recovery turn ran, so the
  // verdict is clean, not recovered.
  const reCheckPasses = await runGate({
    results: [BLOCKED, CLEAN],
    recovery: failedLaunch,
  });
  assertEquals(reCheckPasses.verifierInputs.length, 2);
  assertEquals(reCheckPasses.outcome, { status: "clean", recoveryRan: false });
});

// (l) ---------------------------------------------------------------------

Deno.test("review-fix verifier gate (#3784): a linked-issue read that throws falls back to the PR's title and body", async () => {
  const run = await runGate({
    prNumber: 77,
    branchName: "issue-42-foo",
    results: [CLEAN],
    gh: (args: string[]) => {
      if (args[0] === "issue") {
        return Promise.reject(new Error("gh: issue not found"));
      }
      return defaultGh(args);
    },
  });

  assertEquals(run.outcome, { status: "clean", recoveryRan: false });
  // The issue was looked up from the branch, and the read failed.
  assert(
    run.ghCalls.some((args) =>
      args[0] === "issue" && args[1] === "view" && args[2] === "42"
    ),
  );
  const input = run.verifierInputs[0]!;
  assertEquals(input.issueNumber, 77);
  assertEquals(input.issueTitle, "PR title");
  assertEquals(input.issueBody, "PR body");
});
