/**
 * Claim-freshness re-check (Issue #344).
 *
 * A claim that was legitimate when it was taken can be worthless by the time
 * the PR goes up. On VibeCoder#333 it was: the issue closed at 07:57:54Z when
 * PR #339 merged, and the worker opened PR #341 against it at 08:15:06Z —
 * seventeen minutes later, a `CONFLICTING`/`DIRTY` duplicate of work already
 * on `main` that a human had to salvage by hand.
 *
 * These tests pin the decision rules, the fail-safe behaviour of the lookups,
 * and the fact that a stale claim is a *clean* outcome — not a failure.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkAlreadyLanded,
  checkClaimFreshness,
  decideClaimFreshness,
  formatStaleClaimComment,
  formatStaleClaimReason,
  type StaleClaim,
} from "../lib/claim_freshness.ts";
import {
  claimStaleOutcome,
  describeRunOutcome,
  type RunOutcome,
} from "../lib/run_outcome.ts";
import {
  describeAttemptOutcome,
  renderRunOutcomeClause,
} from "../lib/heartbeat_storage.ts";
import type { Result } from "../types.ts";

const REPO = "stSoftwareAU/VibeCoder";
const BRANCH = "issue-333-parse-the-weekly-usage-limit-reset";
const OTHER_BRANCH = "issue-333-human-side-fix";
const PR_URL = "https://github.com/stSoftwareAU/VibeCoder/pull/339";

// ---------------------------------------------------------------------------
// decideClaimFreshness — the pure rules
// ---------------------------------------------------------------------------

Deno.test("claim freshness #344 - an issue closed mid-cycle makes the claim stale", () => {
  const verdict = decideClaimFreshness({
    issueState: "CLOSED",
    existingPr: { kind: "none" },
    runBranch: BRANCH,
  });

  assertEquals(verdict.kind, "stale");
  assert(verdict.kind === "stale");
  assertEquals(verdict.reason, "issue_closed");
  assertStringIncludes(verdict.detail, "closed");
});

Deno.test("claim freshness #344 - a closed issue names the PR that referenced it", () => {
  const verdict = decideClaimFreshness({
    issueState: "CLOSED",
    existingPr: {
      kind: "superseded",
      prState: "MERGED",
      prUrl: PR_URL,
      prNumber: 339,
      headRefName: OTHER_BRANCH,
    },
    runBranch: BRANCH,
  });

  assert(verdict.kind === "stale");
  assertEquals(verdict.reason, "issue_closed");
  assertEquals(verdict.prNumber, 339);
  assertEquals(verdict.prUrl, PR_URL);
});

Deno.test("claim freshness #344 - an open issue with no PR is fresh", () => {
  const verdict = decideClaimFreshness({
    issueState: "OPEN",
    existingPr: { kind: "none" },
    runBranch: BRANCH,
  });

  assertEquals(verdict.kind, "fresh");
});

Deno.test("claim freshness #344 - a merged PR carrying this run's branch is stale", () => {
  const verdict = decideClaimFreshness({
    issueState: "OPEN",
    existingPr: {
      kind: "superseded",
      prState: "MERGED",
      prUrl: PR_URL,
      prNumber: 339,
      headRefName: BRANCH,
    },
    runBranch: BRANCH,
  });

  assert(verdict.kind === "stale");
  assertEquals(verdict.reason, "work_already_merged");
  assertEquals(verdict.prNumber, 339);
});

Deno.test("claim freshness #344 - someone else's merged PR does NOT discard this run's commits (#174)", () => {
  const verdict = decideClaimFreshness({
    issueState: "OPEN",
    existingPr: {
      kind: "superseded",
      prState: "MERGED",
      prUrl: PR_URL,
      prNumber: 339,
      headRefName: OTHER_BRANCH,
    },
    runBranch: BRANCH,
  });

  // #174's rule: a merged PR on a different branch does not complete this
  // run, and the unpublished commits on this branch still want their PR.
  assertEquals(verdict.kind, "fresh");
});

Deno.test("claim freshness #344 - a merged PR with an unknown head is not treated as ours", () => {
  const verdict = decideClaimFreshness({
    issueState: "OPEN",
    existingPr: {
      kind: "superseded",
      prState: "MERGED",
      prUrl: PR_URL,
      prNumber: 339,
    },
    runBranch: BRANCH,
  });

  assertEquals(verdict.kind, "fresh");
});

Deno.test("claim freshness #344 - an open PR for the issue is left to decideCompletionPr", () => {
  for (const headRefName of [BRANCH, OTHER_BRANCH, undefined]) {
    const verdict = decideClaimFreshness({
      issueState: "OPEN",
      existingPr: { kind: "open", prUrl: PR_URL, prNumber: 341, headRefName },
      runBranch: BRANCH,
    });

    // Not a stale-claim rule: `decideCompletionPr` already recovers an open
    // PR that references the issue rather than creating a competing one, and
    // `superseding_pr.ts` reports an *unreadable* PR state as "open" — so
    // aborting here would abandon a finished run on a `gh` hiccup.
    assertEquals(verdict.kind, "fresh", `head '${headRefName}' must be fresh`);
  }
});

Deno.test("claim freshness #344 - an unreadable issue state fails safe to fresh", () => {
  const verdict = decideClaimFreshness({
    issueState: null,
    existingPr: { kind: "none" },
    runBranch: BRANCH,
  });

  // Withholding a finished, pushed, quality-gated PR because `gh` hiccupped
  // is the worse error of the two.
  assertEquals(verdict.kind, "fresh");
});

Deno.test("claim freshness #344 - a closed state is recognised whatever its case", () => {
  for (const state of ["CLOSED", "closed", " Closed "]) {
    const verdict = decideClaimFreshness({
      // checkClaimFreshness normalises; the rule itself sees the normalised
      // value, so assert on what normalisation produces.
      issueState: state.trim().toUpperCase(),
      existingPr: { kind: "none" },
      runBranch: BRANCH,
    });
    assertEquals(verdict.kind, "stale", `state '${state}' should be stale`);
  }
});

// ---------------------------------------------------------------------------
// checkClaimFreshness — the lookups
// ---------------------------------------------------------------------------

interface GhCall {
  args: string[];
}

function ghStub(
  handlers: {
    issueState?: string | (() => never);
    prState?: string;
    prHead?: string;
  },
  calls: GhCall[],
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    calls.push({ args });
    if (args[0] === "issue" && args[1] === "view") {
      if (typeof handlers.issueState === "function") handlers.issueState();
      return Promise.resolve(
        JSON.stringify({ state: handlers.issueState ?? "OPEN" }),
      );
    }
    if (args[0] === "pr" && args[1] === "view") {
      return Promise.resolve(
        JSON.stringify({
          state: handlers.prState ?? "OPEN",
          headRefName: handlers.prHead ?? BRANCH,
        }),
      );
    }
    return Promise.resolve("");
  };
}

function prLookup(url: string | null): () => Promise<Result<string, Error>> {
  return () =>
    Promise.resolve(
      url === null
        ? { ok: false, error: new Error("No PR found") }
        : { ok: true, value: url },
    );
}

Deno.test("claim freshness #344 - pre-write mode reads only the issue state", async () => {
  const calls: GhCall[] = [];
  const verdict = await checkClaimFreshness({
    repo: REPO,
    issueNumber: 333,
    runBranch: BRANCH,
    mode: "pre-write",
    deps: {
      findExistingPrForIssue: prLookup(PR_URL),
      runGhCommand: ghStub({ issueState: "CLOSED" }, calls),
    },
  });

  assert(verdict.kind === "stale");
  assertEquals(verdict.reason, "issue_closed");
  // One `gh` call — the cheap half of the guard, before an agent run is spent.
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.args.slice(0, 2), ["issue", "view"]);
});

Deno.test("claim freshness #344 - pre-write mode does not stop a run for an in-flight PR", async () => {
  const calls: GhCall[] = [];
  const verdict = await checkClaimFreshness({
    repo: REPO,
    issueNumber: 333,
    runBranch: BRANCH,
    mode: "pre-write",
    deps: {
      findExistingPrForIssue: prLookup(PR_URL),
      runGhCommand: ghStub({ issueState: "OPEN", prState: "MERGED" }, calls),
    },
  });

  // Only the decisive signal is consulted before the agent runs, so the
  // #174/#218 paths still get to make their own call later.
  assertEquals(verdict.kind, "fresh");
  assertEquals(calls.length, 1);
});

Deno.test("claim freshness #344 - pre-pr mode reproduces the VibeCoder#333 abort", async () => {
  const calls: GhCall[] = [];
  const verdict = await checkClaimFreshness({
    repo: REPO,
    issueNumber: 333,
    runBranch: BRANCH,
    mode: "pre-pr",
    deps: {
      findExistingPrForIssue: prLookup(PR_URL),
      runGhCommand: ghStub(
        { issueState: "CLOSED", prState: "MERGED", prHead: OTHER_BRANCH },
        calls,
      ),
    },
  });

  assert(verdict.kind === "stale");
  assertEquals(verdict.reason, "issue_closed");
  assertEquals(verdict.prNumber, 339);
  assert(
    calls.some((c) => c.args.slice(0, 2).join(" ") === "pr view"),
    "pre-pr mode also classifies the existing PR",
  );
});

Deno.test("claim freshness #344 - a `gh issue view` failure fails safe to fresh and is warned about", async () => {
  const warnings: string[] = [];
  const verdict = await checkClaimFreshness({
    repo: REPO,
    issueNumber: 333,
    runBranch: BRANCH,
    mode: "pre-pr",
    deps: {
      findExistingPrForIssue: prLookup(null),
      runGhCommand: (args: string[]) => {
        if (args[0] === "issue") {
          return Promise.reject(new Error("gh: API rate limit exceeded"));
        }
        return Promise.resolve("");
      },
      warn: (m) => warnings.push(m),
    },
  });

  assertEquals(verdict.kind, "fresh");
  // Never swallowed: the reason is on the record even though the guard
  // deliberately let the run continue.
  assert(
    warnings.some((w) => w.includes("rate limit")),
    `expected the failure to be logged, got ${JSON.stringify(warnings)}`,
  );
});

Deno.test("claim freshness #344 - an unparseable issue payload fails safe to fresh and is warned about", async () => {
  const warnings: string[] = [];
  const verdict = await checkClaimFreshness({
    repo: REPO,
    issueNumber: 333,
    runBranch: BRANCH,
    mode: "pre-write",
    deps: {
      findExistingPrForIssue: prLookup(null),
      runGhCommand: () => Promise.resolve("not json at all"),
      warn: (m) => warnings.push(m),
    },
  });

  assertEquals(verdict.kind, "fresh");
  assert(
    warnings.some((w) => w.includes("Unreadable")),
    `expected an unreadable-payload warning, got ${JSON.stringify(warnings)}`,
  );
});

Deno.test("claim freshness #344 - a lower-case gh state is still recognised as closed", async () => {
  const verdict = await checkClaimFreshness({
    repo: REPO,
    issueNumber: 333,
    runBranch: BRANCH,
    mode: "pre-write",
    deps: {
      findExistingPrForIssue: prLookup(null),
      runGhCommand: () => Promise.resolve(JSON.stringify({ state: "closed" })),
    },
  });

  assert(verdict.kind === "stale");
  assertEquals(verdict.reason, "issue_closed");
});

// ---------------------------------------------------------------------------
// The hand-off text and the outcome
// ---------------------------------------------------------------------------

const STALE: StaleClaim = {
  reason: "issue_closed",
  detail: "the issue closed while this run was working",
  prUrl: PR_URL,
  prNumber: 339,
};

Deno.test("claim freshness #344 - the reason starts with a greppable claim_stale token", () => {
  const reason = formatStaleClaimReason(STALE);
  assert(
    reason.startsWith("claim_stale:issue_closed"),
    `unexpected reason: ${reason}`,
  );
  assertStringIncludes(reason, STALE.detail);
});

Deno.test("claim freshness #344 - the hand-off comment links the branch so the work is not lost", () => {
  const body = formatStaleClaimComment({
    repo: REPO,
    branch: BRANCH,
    stale: STALE,
  });

  assertStringIncludes(body, BRANCH);
  assertStringIncludes(body, `https://github.com/${REPO}/tree/`);
  assertStringIncludes(body, PR_URL);
  assertStringIncludes(body, "did **not** open a PR");
});

Deno.test("claim freshness #344 - the hand-off comment still works when no PR overtook the run", () => {
  const body = formatStaleClaimComment({
    repo: REPO,
    branch: BRANCH,
    stale: { reason: "issue_closed", detail: "the issue closed" },
  });

  assertStringIncludes(body, BRANCH);
  assert(!body.includes("undefined"), `unexpected placeholder: ${body}`);
});

Deno.test("claim freshness #344 - the outcome is a distinct kind, never a failure", () => {
  const outcome: RunOutcome = claimStaleOutcome({
    phase: "completion",
    stale: STALE,
    branch: BRANCH,
  });

  assertEquals(outcome.kind, "claim_stale");
  assertEquals(describeRunOutcome(outcome), "claim_stale:issue_closed");
  // Not `no_pr`: `no_pr` is the kind that carries a failure category, files a
  // run-failure issue and labels the issue failed (Issue #342's lesson).
  assert(outcome.kind !== "no_pr");
});

Deno.test("claim freshness #344 - the release comment names the branch the work is on", () => {
  const clause = renderRunOutcomeClause(
    claimStaleOutcome({ phase: "completion", stale: STALE, branch: BRANCH }),
  );

  assertStringIncludes(clause, "claim went stale");
  assertStringIncludes(clause, BRANCH);
  assertStringIncludes(clause, PR_URL);
});

Deno.test("claim freshness #344 - the attempt tally reads as a stale claim, not a crash", () => {
  const text = describeAttemptOutcome(
    claimStaleOutcome({ phase: "execute", stale: STALE }),
  );

  assertStringIncludes(text, "claim went stale");
  assertStringIncludes(text, "issue_closed");
});

const LANDED_HEAD = "a".repeat(40);
const LANDED_MERGE = "b".repeat(40);

function landedIssue(overrides: Record<string, unknown> = {}) {
  return {
    number: 339,
    url: PR_URL,
    state: "MERGED",
    title: "Fix the requested behaviour (#333)",
    mergedAt: "2026-10-18T01:44:24Z",
    headRefName: BRANCH,
    headRefOid: LANDED_HEAD,
    headRepository: { name: "VibeCoder" },
    headRepositoryOwner: { login: "stSoftwareAU" },
    baseRefName: "main",
    mergeCommit: { oid: LANDED_MERGE },
    body:
      "Closes #333.\n\n## Acceptance Criteria\n- **met** — Fix the requested behaviour — evidence: test passes",
    ...overrides,
  };
}

function landedOptions(overrides: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  const warnings: string[] = [];
  const options = {
    repo: REPO,
    issueNumber: 333,
    issueBody: "## Acceptance Criteria\n- [ ] Fix the requested behaviour",
    runBranch: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    cwd: "/tmp/test-repo",
    warn: (message: string) => warnings.push(message),
    runGh: (args: string[]) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "list") {
        return Promise.resolve(
          JSON.stringify([landedIssue()]),
        );
      }
      return Promise.resolve("behind");
    },
    runGit: (args: string[]) => {
      calls.push(args);
      return Promise.resolve({
        ok: true as const,
        value: {
          code: 0,
          stdout: args[0] === "rev-parse" ? LANDED_HEAD : "",
          stderr: "",
        },
      });
    },
    ...overrides,
  };
  return { options, calls, warnings };
}

Deno.test("already-landed proof binds the closing issue, exact run branch and merged work (Issue #3977)", async () => {
  const { options, calls } = landedOptions();
  const result = await checkAlreadyLanded(options);
  assertEquals(result.kind, "stale");
  assert(result.kind === "stale");
  assertEquals(result.reason, "work_already_merged");
  assertEquals(result.prNumber, 339);
  assertEquals(result.prUrl, PR_URL);
  assert(
    calls.every((args) =>
      !["rebase", "merge", "push", "reset", "checkout", "issue"].includes(
        args[0]!,
      )
    ),
    "proof must not recover, rewrite branches or mutate issues",
  );
});

function landedResponse(pr: Record<string, unknown> = {}) {
  return JSON.stringify([landedIssue(pr)]);
}

Deno.test("already-landed proof rejects partial, unrelated and unreadable merge evidence (Issue #3977)", async () => {
  for (
    const pr of [
      { state: "OPEN" },
      { number: 0, url: `https://github.com/${REPO}/pull/0` },
      { number: 339.5, url: `https://github.com/${REPO}/pull/339.5` },
      { number: undefined },
      { url: "https://github.com/Other/Repo/pull/339" },
      { headRefName: OTHER_BRANCH },
      { headRepositoryOwner: { login: "Other" } },
      { baseRefName: "milestone/other" },
      { headRefOid: undefined },
      { headRefOid: [LANDED_HEAD] },
      { mergeCommit: null },
      { mergeCommit: { oid: "not-a-sha" } },
      { mergedAt: null },
      { mergedAt: 0 },
      { mergedAt: "not-a-date" },
      { mergeCommit: { oid: [LANDED_MERGE] } },
      {
        body:
          "Closes #333.\n\n## Acceptance Criteria\n- **partial** — Fix the requested behaviour — evidence: only one path — reason: more scope remains",
      },
    ]
  ) {
    const { options, calls } = landedOptions({
      runGh: (args: string[]) =>
        Promise.resolve(args[1] === "list" ? landedResponse(pr) : "behind"),
    });
    assertEquals(
      (await checkAlreadyLanded(options)).kind,
      "fresh",
      JSON.stringify(pr),
    );
    assertEquals(
      calls.some((args) => args[0] === "fetch"),
      false,
      "invalid evidence must not fetch a PR head",
    );
  }
  for (
    const pr of [
      { title: "Unrelated (#334)" },
      { body: "Mentions #333" },
      { body: "`Closes #333`" },
      { body: "    Closes #333" },
      { body: "\tCloses #333" },
      { body: " \tCloses #333" },
      { body: "  \tCloses #333" },
      { body: "   \tCloses #333" },
      { body: "Closes `an example` #333" },
      {
        body:
          "Closes #333\n\n## Acceptance Criteria\n- **met** — Fix the requested behaviour",
      },
      {
        body:
          "Closes #333\n\n## Acceptance Criteria\n- **missing** — Fix the requested behaviour — reason: requested behaviour is not implemented",
      },
      {
        body:
          "## Acceptance Criteria\n- [x] Completed portion\n- [ ] Remaining work\n\nCloses #333",
      },
      { body: "> Closes #333" },
      { body: "<!-- Closes #333 -->" },
      { body: "```\nCloses #333\n```" },
    ]
  ) {
    const { options } = landedOptions({
      runGh: (args: string[]) =>
        Promise.resolve(args[1] === "list" ? landedResponse(pr) : "behind"),
    });
    assertEquals(
      (await checkAlreadyLanded(options)).kind,
      "fresh",
      JSON.stringify(pr),
    );
  }
});

Deno.test("already-landed proof preserves local work and refuses unavailable comparisons (Issue #3977)", async () => {
  for (
    const mode of [
      "dirty",
      "extra-commit",
      "lookup-failed",
      "changed-during-proof",
      "late-dirty",
      "changed-head",
      "changed-branch",
      "changed-pr-head",
      "status-unreadable",
      "ancestry-unreadable",
      "ancestry-error",
      "head-unreadable",
      "branch-unreadable",
      "head-extra-commit",
      "branch-extra-commit",
    ] as const
  ) {
    let proved = false;
    const { options, warnings, calls } = landedOptions({
      runGit: (args: string[]) => {
        calls.push(args);
        if (mode === "lookup-failed") {
          return Promise.resolve({
            ok: false as const,
            error: new Error("network unavailable"),
          });
        }
        if (args[0] === "merge-base" && mode === "ancestry-error") {
          return Promise.resolve({
            ok: false as const,
            error: new Error("ancestry observation unavailable"),
          });
        }
        if (args[0] === "merge-base") proved = true;
        const code = args[0] === "merge-base" &&
            (mode === "extra-commit" ||
              (mode === "head-extra-commit" ||
                  mode === "branch-extra-commit") && args[2] === "c".repeat(40))
          ? 1
          : args[0] === "status" && mode === "status-unreadable"
          ? 128
          : args[0] === "merge-base" && mode === "ancestry-unreadable"
          ? 128
          : 0;
        let stdout = "";
        if (
          args[0] === "status" &&
          (mode === "dirty" || mode === "late-dirty" && proved)
        ) stdout = "?? unshipped.ts";
        if (args[0] === "rev-parse") {
          const ref = args.at(-1);
          const changed = (mode === "changed-during-proof" && proved) ||
            (mode === "changed-head" && proved && ref === "HEAD^{commit}") ||
            (mode === "changed-branch" && proved &&
              ref === `${BRANCH}^{commit}`) ||
            (mode === "changed-pr-head" && ref === "FETCH_HEAD^{commit}");
          stdout = changed ? "c".repeat(40) : LANDED_HEAD;
          if (
            mode === "head-unreadable" && ref === "HEAD^{commit}" ||
            mode === "branch-unreadable" && ref === `${BRANCH}^{commit}`
          ) stdout = "not-a-commit";
          if (
            mode === "head-extra-commit" && ref === "HEAD^{commit}" ||
            mode === "branch-extra-commit" && ref === `${BRANCH}^{commit}`
          ) stdout = "c".repeat(40);
        }
        return Promise.resolve({
          ok: true as const,
          value: {
            code,
            stdout,
            stderr: code === 128 ? "git observation unavailable" : "",
          },
        });
      },
    });
    assertEquals((await checkAlreadyLanded(options)).kind, "fresh", mode);
    if (mode === "ancestry-error") {
      assert(
        warnings.some((message) =>
          message.includes("ancestry observation unavailable")
        ),
        "the original ancestry failure remains diagnosable",
      );
    }
    if (
      mode === "extra-commit" || mode === "head-extra-commit" ||
      mode === "branch-extra-commit"
    ) {
      assertEquals(
        warnings,
        [],
        "ordinary distinct work is not an unreadable ancestry check",
      );
    }

    if (
      mode === "dirty" || mode === "head-unreadable" ||
      mode === "branch-unreadable"
    ) {
      assertEquals(
        calls.some((args) => args[0] === "fetch"),
        false,
        "already invalid local work does not trigger a pull-ref fetch",
      );
    }
    if (
      mode === "late-dirty" || mode === "changed-head" ||
      mode === "changed-branch"
    ) {
      assert(
        calls.some((args) => args[0] === "fetch"),
        "the final observation is tested after initially valid local work",
      );
    }
    if (mode === "lookup-failed") {
      assert(
        warnings.some((message) => message.includes("network unavailable")),
        "the original Git failure remains diagnosable",
      );
    }
    if (mode === "status-unreadable" || mode === "ancestry-unreadable") {
      assert(
        warnings.some((message) =>
          message.includes(
            mode === "status-unreadable"
              ? "git status failed"
              : "Cannot compare local work",
          )
        ),
        "the specific unreadable observation remains diagnosable",
      );
    }
  }
  for (const status of ["ahead", "diverged", "unknown"]) {
    const { options } = landedOptions({
      runGh: (args: string[]) =>
        Promise.resolve(args[1] === "list" ? landedResponse() : status),
    });
    assertEquals((await checkAlreadyLanded(options)).kind, "fresh", status);
  }
  const { options, warnings } = landedOptions({
    runGh: () => Promise.reject(new Error("GitHub unavailable")),
  });
  assertEquals((await checkAlreadyLanded(options)).kind, "fresh");
  assert(warnings.some((text) => text.includes("unavailable")));
});

Deno.test("already-landed proof keeps reapproved scope and distinguishes milestone integration (Issue #3977)", async () => {
  const reapproved = landedOptions({ reapproved: true });
  assertEquals((await checkAlreadyLanded(reapproved.options)).kind, "fresh");
  assertEquals(reapproved.calls, []);
  const branch = "milestone/requested-scope";
  const { options } = landedOptions({
    baseBranch: branch,
    runGh: (args: string[]) =>
      Promise.resolve(
        args[1] === "list" ? landedResponse({ baseRefName: branch }) : "behind",
      ),
  });
  const result = await checkAlreadyLanded(options);
  assert(result.kind === "stale");
  assertEquals(result.baseBranch, branch);
  assertEquals(result.defaultBranch, "main");
  assertEquals(result.mergeCommit, LANDED_MERGE);
});

Deno.test("already-landed proof accepts canonical repo casing, historical summaries and unrequested extras (Issue #3977)", async () => {
  for (
    const body of [
      "Closes #333\n\nThe exact implementation is delivered.",
      "   Closes #333\n\nThe exact implementation is delivered.",
      landedIssue().body +
      "\n- **unrequested** — Optional documentation cleanup — reason: incidental extra work",
    ]
  ) {
    const { options } = landedOptions({
      repo: REPO.toLowerCase(),
      runGh: (args: string[]) =>
        Promise.resolve(
          args[1] === "list" ? landedResponse({ body }) : "behind",
        ),
    });
    assertEquals((await checkAlreadyLanded(options)).kind, "stale", body);
  }
});

Deno.test("already-landed proof replays public #3740 squash and preserves #3534 partial scope (Issue #3977)", async () => {
  const rows = JSON.parse(
    await Deno.readTextFile(
      new URL("./fixtures/already_landed_3977.json", import.meta.url),
    ),
  ) as Array<
    {
      issueNumber: number;
      firstReplayedCommit: string;
      pr: {
        headRefName: string;
        headRefOid: string;
        baseRefName: string;
        number: number;
        body: string;
      };
    }
  >;
  for (const row of rows) {
    const { options, calls } = landedOptions({
      issueNumber: row.issueNumber,
      issueBody: "Historical issue scope",
      runBranch: row.pr.headRefName,
      baseBranch: row.pr.baseRefName,
      runGh: (args: string[]) =>
        Promise.resolve(
          args[1] === "list" ? JSON.stringify([row.pr]) : "behind",
        ),
      runGit: (args: string[]) => {
        calls.push(args);
        return Promise.resolve({
          ok: true as const,
          value: {
            code: 0,
            stdout: args[0] === "rev-parse"
              ? args.at(-1) === "FETCH_HEAD^{commit}"
                ? row.pr.headRefOid
                : row.firstReplayedCommit
              : "",
            stderr: "",
          },
        });
      },
    });
    const result = await checkAlreadyLanded(options);
    assertEquals(result.kind, row.issueNumber === 3740 ? "stale" : "fresh");
    if (result.kind === "stale") {
      assertEquals(result.prNumber, 3959);
      assertEquals(
        result.baseBranch,
        "milestone/review-fix-and-foreign-push-drift",
      );
      assert(
        calls.some((args) =>
          args[0] === "merge-base" && args.includes(row.firstReplayedCommit)
        ),
      );
    } else {
      assert(
        row.pr.body.includes("**partial**"),
        "the historical partial verdict must remain visible",
      );
      assertEquals(calls.some((args) => args[0] === "fetch"), false);
    }
  }
});

Deno.test("already-landed proof skips malformed candidate fields without poisoning a later exact PR (Issue #3977)", async () => {
  for (
    const malformed of [
      null,
      23,
      "not a PR",
      landedIssue({ url: undefined }),
      landedIssue({ body: undefined }),
      landedIssue({ body: 23 }),
      landedIssue({ title: undefined }),
    ]
  ) {
    const { options } = landedOptions({
      runGh: (args: string[]) =>
        Promise.resolve(
          args[1] === "list"
            ? JSON.stringify([malformed, landedIssue()])
            : "behind",
        ),
    });
    assertEquals(
      (await checkAlreadyLanded(options)).kind,
      "stale",
      JSON.stringify(malformed),
    );
  }
});

Deno.test("already-landed proof validates the requested identity and avoids local work when no merged PR exists (Issue #3977)", async () => {
  for (
    const extra of [{ repo: "--invalid" }, { issueNumber: 0 }, {
      issueNumber: 333.5,
    }]
  ) {
    const { options, calls, warnings } = landedOptions(extra);
    assertEquals((await checkAlreadyLanded(options)).kind, "fresh");
    assertEquals(calls, []);
    assert(
      warnings.some((message) =>
        message.includes("Invalid repository or issue")
      ),
    );
  }
  const { options, calls } = landedOptions({
    runGh: () => Promise.resolve("[]"),
  });
  assertEquals((await checkAlreadyLanded(options)).kind, "fresh");
  assertEquals(
    calls,
    [],
    "no merged candidates means no local or fetch operations",
  );
});

Deno.test("already-landed proof reports malformed merged-PR collections without observing local work (Issue #3977)", async () => {
  for (const raw of ["{}", "null", "[", "23"]) {
    const { options, calls, warnings } = landedOptions({
      runGh: () => Promise.resolve(raw),
    });
    assertEquals((await checkAlreadyLanded(options)).kind, "fresh");
    assertEquals(
      calls,
      [],
      "unreadable merge collections do not trigger local/fetch commands",
    );
    assert(
      warnings.some((message) => message.includes("merged-PR lookup")),
      "the collection reader names the failed evidence read",
    );
  }
});
