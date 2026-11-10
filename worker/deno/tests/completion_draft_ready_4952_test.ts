/**
 * Completion marks an existing draft PR ready and arms it, and never releases
 * a run as having raised a PR that is still a draft (Issue #4952).
 *
 * `recoverAndFinaliseExistingPr` marks a draft ready when its state is known
 * to be draft, and also when the state cannot be read, after one retry. A
 * failed `gh pr ready` leaves the PR a draft, so the run fails as interrupted
 * and auto-merge is not armed when the draft is known, or when the ready
 * step's own head read says `isDraft` is true. Otherwise a failed ready only
 * warns and the run arms as before. A PR already ready is left alone. The REST
 * fallback's PR (Issue #4952) gets the same ready step on the creation path.
 *
 * Arming is observed through the `finalisePr` seam (armAutoMergeAtCreation),
 * and `gh` calls through the `runGhCommand` fake.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  recoverAndFinaliseExistingPr,
  workOnIssueCompletion,
} from "../lib/phases/completion_phase.ts";
import { markDraftReadyAndAwaitCi } from "../lib/draft_continuation_pr.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import type { WorkerConfig } from "../types.ts";

const REPO = "org/repo";
const PR = 27;
const PR_URL = `https://github.com/${REPO}/pull/${PR}`;
const BRANCH = "issue-11-draft-continuation";
const BODY = "## Summary\n\nCloses #11.\n";
const SHA = "abc123";
/** The `--json` fields of the state lookup (lookupPrState). */
const LOOKUP_FIELDS = "state,headRefName,isDraft";
/** The `--json` fields of the ready step's head read (markDraftReadyAndAwaitCi). */
const READY_FIELDS = "headRefOid,isDraft";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): WorkerConfig {
  return buildDefaultWorkerConfig();
}

function makeContext(): IssueContext {
  return {
    repo: REPO,
    issueNumber: 11,
    issueTitle: "Draft continuation",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testworker",
    config: makeConfig(),
  };
}

function makeState(): PhaseState {
  return {
    branchName: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/mock-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

/** One reply to the state lookup: the PR's draft flag, or a gh error. */
type LookupReply = { isDraft?: boolean } | Error;

/**
 * A `gh` fake for an existing draft or ready PR.
 *
 * `lookups` answers the state lookups in order, the last repeating.
 * `viewIsDraft` is the `isDraft` in the ready step's head read (undefined
 * leaves it out). `readyReadFails` makes that head read throw, so the check
 * runs cannot be snapshotted. `readyFails` makes `gh pr ready` throw. Once
 * ready, the head commit gains one new check run, so CI counts as started at
 * once, unless `checkRunsFailAfterReady` makes the check-run reads throw then
 * (the CI wait ends at once rather than sleeping out its bound).
 */
function ghFake(opts: {
  lookups: LookupReply[];
  viewIsDraft?: boolean;
  readyFails?: boolean;
  readyReadFails?: boolean;
  checkRunsFailAfterReady?: boolean;
}) {
  const calls: string[][] = [];
  let lookupReads = 0;
  let ready = false;
  const runGhCommand = (args: string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "pr" && args[1] === "view") {
      if (args.includes(LOOKUP_FIELDS)) {
        const reply = opts.lookups[
          Math.min(lookupReads++, opts.lookups.length - 1)
        ]!;
        if (reply instanceof Error) return Promise.reject(reply);
        return Promise.resolve(
          JSON.stringify({ state: "OPEN", headRefName: BRANCH, ...reply }),
        );
      }
      if (args.includes(READY_FIELDS)) {
        if (opts.readyReadFails) {
          return Promise.reject(new Error("HTTP 502"));
        }
        return Promise.resolve(JSON.stringify({
          headRefOid: SHA,
          ...(opts.viewIsDraft !== undefined
            ? { isDraft: opts.viewIsDraft }
            : {}),
        }));
      }
      return Promise.resolve("{}");
    }
    if (args[0] === "pr" && args[1] === "ready") {
      if (opts.readyFails) return Promise.reject(new Error("HTTP 502"));
      ready = true;
      return Promise.resolve("");
    }
    if (args[0] === "api") {
      if (opts.checkRunsFailAfterReady && ready) {
        return Promise.reject(new Error("HTTP 502"));
      }
      return Promise.resolve(
        JSON.stringify(ready ? [{ id: 2, conclusion: null }] : []),
      );
    }
    return Promise.resolve("");
  };
  return { runGhCommand, calls };
}

/**
 * Deps recording auto-merge arming (`finalisePr`), warnings, info logs and
 * the PR comments posted through `createClient`.
 */
function makeDeps(gh: ReturnType<typeof ghFake>, comments: string[] = []) {
  const armed: number[] = [];
  const warns: { message: string; context?: Record<string, unknown> }[] = [];
  const infos: string[] = [];
  const deps = createMockDeps({
    logger: {
      info: (message: string) => {
        infos.push(message);
      },
      warn: (message: string, context?: Record<string, unknown>) => {
        warns.push({ message, context });
      },
    },
    github: {
      runGhCommand: gh.runGhCommand,
      createClient: () =>
        ({
          postComment: (_repo: string, _pr: number, body: string) => {
            comments.push(body);
            return Promise.resolve(undefined);
          },
        }) as never,
    },
    pr: {
      finalisePr: (options: { prNumber: number }) => {
        armed.push(options.prNumber);
        return Promise.resolve({
          ok: true,
          value: { result: AutoMergeResult.Enabled, message: "armed" },
        });
      },
    },
  });
  return { deps, armed, warns, infos };
}

function readyCalls(calls: string[][]): string[][] {
  return calls.filter((c) => c[0] === "pr" && c[1] === "ready");
}

const recover = (deps: ReturnType<typeof createMockDeps>) =>
  recoverAndFinaliseExistingPr(
    PR_URL,
    makeContext(),
    makeState(),
    BODY,
    deps,
    {},
  );

// ---------------------------------------------------------------------------
// Completion through recoverAndFinaliseExistingPr
// ---------------------------------------------------------------------------

Deno.test(
  "Issue #4952 - an existing draft PR is marked ready and auto-merge is armed",
  async () => {
    const gh = ghFake({ lookups: [{ isDraft: true }], viewIsDraft: true });
    const { deps, armed } = makeDeps(gh);

    const result = await recover(deps);

    assertEquals(result, { status: "continue" });
    const ready = readyCalls(gh.calls);
    assertEquals(ready.length, 1, "gh pr ready is called once");
    assertEquals(ready[0]![2], String(PR));
    assertEquals(armed, [PR]);
  },
);

Deno.test(
  "Issue #4952 - an unreadable state is retried once, then the draft is marked ready and armed",
  async () => {
    const gh = ghFake({
      lookups: [new Error("HTTP 502"), { isDraft: true }],
      viewIsDraft: true,
    });
    const { deps, armed } = makeDeps(gh);

    const result = await recover(deps);

    assertEquals(result, { status: "continue" });
    assertEquals(
      gh.calls.filter((c) => c.includes(LOOKUP_FIELDS)).length,
      2,
      "one retry after the first state read fails",
    );
    assertEquals(readyCalls(gh.calls).length, 1);
    assertEquals(armed, [PR]);
  },
);

Deno.test(
  "Issue #4952 - when both state reads fail, gh pr ready is still attempted and warned with the PR number",
  async () => {
    const gh = ghFake({
      lookups: [new Error("HTTP 502"), new Error("HTTP 502")],
      viewIsDraft: true,
    });
    const { deps, armed, warns } = makeDeps(gh);

    const result = await recover(deps);

    assertEquals(result, { status: "continue" });
    assertEquals(
      readyCalls(gh.calls).length,
      1,
      "draft state unknown, so ready",
    );
    assertEquals(armed, [PR]);
    const warning = warns.find((w) =>
      w.message.includes("PR draft state could not be read")
    );
    assert(warning !== undefined, "the unreadable draft state is warned");
    assertEquals(warning.context?.prNumber, PR);
  },
);

Deno.test(
  "Issue #4952 - unknown state + unreadable head read + gh pr ready fails → continue, still armed, and a WARN names the PR",
  async () => {
    const gh = ghFake({
      lookups: [new Error("HTTP 502"), new Error("HTTP 502")],
      readyReadFails: true,
      readyFails: true,
    });
    const { deps, armed, warns } = makeDeps(gh);

    const result = await recover(deps);

    assertEquals(
      result,
      { status: "continue" },
      "an unknown state never fails",
    );
    assertEquals(readyCalls(gh.calls).length, 1, "ready was attempted");
    assertEquals(armed, [PR], "arming happens exactly as before");
    const warning = warns.find((w) =>
      w.message.includes(
        "Could not mark the PR ready with its draft state unknown",
      )
    );
    assert(warning !== undefined, "the failed ready is warned");
    assertEquals(warning.context?.prNumber, PR);
  },
);

Deno.test(
  "Issue #4952 - unknown state + unreadable head read → ready is marked and the PR is still armed",
  async () => {
    const gh = ghFake({
      lookups: [new Error("HTTP 502"), new Error("HTTP 502")],
      readyReadFails: true,
    });
    const { deps, armed } = makeDeps(gh);

    const result = await recover(deps);

    assertEquals(result, { status: "continue" });
    assertEquals(readyCalls(gh.calls).length, 1);
    assertEquals(
      armed,
      [PR],
      "the CI wait cannot be read, but an unknown state keeps ciStarted true",
    );
  },
);

Deno.test(
  "Issue #4952 - a failed gh pr ready fails the run as interrupted, names the PR and does not arm",
  async () => {
    const gh = ghFake({
      lookups: [{ isDraft: true }],
      viewIsDraft: true,
      readyFails: true,
    });
    const { deps, armed, warns } = makeDeps(gh);

    const result = await recover(deps);

    assert(result.status === "failure", "the run fails, not continues");
    assertEquals(result.category, "interrupted");
    assertStringIncludes(result.reason, `PR #${PR}`);
    assertStringIncludes(result.reason, "still a draft");
    assertEquals(readyCalls(gh.calls).length, 1);
    assertEquals(armed, [], "auto-merge is not armed on a draft");
    const warning = warns.find((w) =>
      w.message.includes("Could not mark the draft PR ready")
    );
    assert(warning !== undefined, "the failed ready is warned");
    assertEquals(warning.context?.prNumber, PR);
  },
);

Deno.test(
  "Issue #4952 - a PR that is not a draft is not marked ready, and is still armed",
  async () => {
    const gh = ghFake({ lookups: [{ isDraft: false }] });
    const { deps, armed } = makeDeps(gh);

    const result = await recover(deps);

    assertEquals(result, { status: "continue" });
    assertEquals(readyCalls(gh.calls).length, 0, "gh pr ready is not called");
    assertEquals(
      gh.calls.some((c) => c.includes(READY_FIELDS)),
      false,
      "no ready-step head read either",
    );
    assertEquals(armed, [PR]);
  },
);

Deno.test(
  "Issue #4952 - unknown state + head read says draft + gh pr ready fails → the run fails as interrupted and is not armed",
  async () => {
    const gh = ghFake({
      lookups: [new Error("HTTP 502"), new Error("HTTP 502")],
      viewIsDraft: true,
      readyFails: true,
    });
    const { deps, armed, warns } = makeDeps(gh);

    const result = await recover(deps);

    assert(result.status === "failure", "the run fails, not continues");
    assertEquals(result.category, "interrupted");
    assertStringIncludes(result.reason, `PR #${PR}`);
    assertEquals(readyCalls(gh.calls).length, 1, "ready was attempted");
    assertEquals(armed, [], "auto-merge is not armed on a draft");
    assert(
      warns.some((w) =>
        w.message.includes("Could not mark the draft PR ready")
      ),
      "the failed ready is warned as a known draft",
    );
  },
);

Deno.test(
  "Issue #4952 - unknown state + head read says draft + CI cannot be confirmed → marked ready but not armed",
  async () => {
    const gh = ghFake({
      lookups: [new Error("HTTP 502"), new Error("HTTP 502")],
      viewIsDraft: true,
      checkRunsFailAfterReady: true,
    });
    const { deps, armed } = makeDeps(gh);

    const result = await recover(deps);

    assertEquals(
      result,
      { status: "continue" },
      "a CI wait that cannot be confirmed is not a failed ready",
    );
    assertEquals(readyCalls(gh.calls).length, 1, "ready succeeded");
    assertEquals(
      armed,
      [],
      "the draft's ready-for-review CI has not started, so it is left for the sweep",
    );
  },
);

Deno.test(
  "Issue #4952 - a known draft already ready on the live view is not marked ready again, is armed, and is not logged as marked",
  async () => {
    const gh = ghFake({ lookups: [{ isDraft: true }], viewIsDraft: false });
    const { deps, armed, infos } = makeDeps(gh);

    const result = await recover(deps);

    assertEquals(result, { status: "continue" });
    assertEquals(readyCalls(gh.calls).length, 0, "gh pr ready is not called");
    assertEquals(armed, [PR]);
    assert(
      !infos.some((m) => m.includes("Marked the draft continuation PR ready")),
      "nothing was marked ready by this run",
    );
  },
);

Deno.test(
  "Issue #4952 - the advisory says the PR is still a draft when gh pr ready fails, and says armed when it is ready",
  async () => {
    const comments: string[] = [];
    const failing = ghFake({
      lookups: [{ isDraft: true }],
      viewIsDraft: true,
      readyFails: true,
    });
    const failingState = makeState();
    failingState.completionAdvisoryComment = "- A finding to note";
    await recoverAndFinaliseExistingPr(
      PR_URL,
      makeContext(),
      failingState,
      BODY,
      makeDeps(failing, comments).deps,
      {},
    );

    const succeeding = ghFake({
      lookups: [{ isDraft: true }],
      viewIsDraft: true,
    });
    const readyState = makeState();
    readyState.completionAdvisoryComment = "- A finding to note";
    await recoverAndFinaliseExistingPr(
      PR_URL,
      makeContext(),
      readyState,
      BODY,
      makeDeps(succeeding, comments).deps,
      {},
    );

    assertEquals(comments.length, 2, "one advisory per run");
    assertStringIncludes(comments[0]!, "still a draft");
    assertStringIncludes(comments[0]!, "`gh pr ready` failed");
    assert(
      !comments[0]!.includes("auto-merge stays armed"),
      "a still-draft PR is not described as armed",
    );
    assertStringIncludes(comments[1]!, "auto-merge stays armed");
    assert(
      !comments[1]!.includes("still a draft"),
      "a ready PR is not described as a draft",
    );
  },
);

// ---------------------------------------------------------------------------
// markDraftReadyAndAwaitCi
// ---------------------------------------------------------------------------

const noSleep = () => Promise.resolve();

Deno.test(
  "Issue #4952 - markDraftReadyAndAwaitCi reports a failed gh pr ready as not ready",
  async () => {
    const calls: string[][] = [];
    const gh = (args: string[]): Promise<string> => {
      calls.push(args);
      if (args[1] === "view") {
        return Promise.resolve(JSON.stringify({ headRefOid: SHA }));
      }
      if (args[1] === "ready") return Promise.reject(new Error("HTTP 502"));
      return Promise.resolve("[]");
    };

    const result = await markDraftReadyAndAwaitCi({
      repo: REPO,
      prNumber: 7,
      gh,
      sleep: noSleep,
      log: () => {},
    });

    assertEquals(result, { ready: false, ciStarted: false, draft: null });
    assertEquals(calls.filter((c) => c[0] === "api").length, 1);
  },
);

Deno.test(
  "Issue #4952 - markDraftReadyAndAwaitCi skips ready and the CI wait when the PR is already ready",
  async () => {
    const calls: string[][] = [];
    const gh = (args: string[]): Promise<string> => {
      calls.push(args);
      if (args[1] === "view") {
        return Promise.resolve(
          JSON.stringify({ headRefOid: SHA, isDraft: false }),
        );
      }
      return Promise.resolve("[]");
    };

    const result = await markDraftReadyAndAwaitCi({
      repo: REPO,
      prNumber: 7,
      gh,
      sleep: noSleep,
      log: () => {},
    });

    assertEquals(result, { ready: true, ciStarted: true, draft: false });
    assertEquals(readyCalls(calls).length, 0, "gh pr ready is not called");
    assertEquals(calls.filter((c) => c[0] === "api").length, 0);
  },
);

// ---------------------------------------------------------------------------
// The REST fallback's PR on the creation path (Issue #4952)
// ---------------------------------------------------------------------------

const QUOTA_ERROR =
  "gh command failed (exit 1): GraphQL: API rate limit already exceeded for user ID 23146043.";

/**
 * Run the creation path with `gh pr create` past its primary quota, so the
 * REST fallback returns PR #27: an open draft continuation on this branch.
 * `readyFails` makes `gh pr ready` throw.
 */
async function runRestFallback(readyFails: boolean) {
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-11.md`,
    "## Summary\n\nPart of #11.\n",
  );
  const config = buildDefaultWorkerConfig();
  // Keep the bounded infra retry's backoff out of this test.
  config.infraRetryBackoffMs = 1;
  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: 11,
    issueTitle: "Draft continuation",
    issueBody: "",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "testworker",
    config,
  };
  const state: PhaseState = { ...makeState(), repoPath };

  const calls: string[][] = [];
  const armed: number[] = [];
  let ready = false;
  const runGhCommand = (args: string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "pr" && args[1] === "create") {
      return Promise.reject(new Error(QUOTA_ERROR));
    }
    if (
      args[0] === "api" && args.some((a) => a.includes(`repos/${REPO}/pulls`))
    ) {
      return Promise.resolve(`${PR_URL}\n`);
    }
    if (args[0] === "pr" && args[1] === "view") {
      return Promise.resolve(
        args.includes(READY_FIELDS)
          ? JSON.stringify({ headRefOid: SHA, isDraft: true })
          : "{}",
      );
    }
    if (args[0] === "pr" && args[1] === "ready") {
      if (readyFails) return Promise.reject(new Error("HTTP 502"));
      ready = true;
      return Promise.resolve("");
    }
    if (args[0] === "api") {
      return Promise.resolve(
        JSON.stringify(ready ? [{ id: 2, conclusion: null }] : []),
      );
    }
    return Promise.resolve("");
  };

  const deps = createMockDeps({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as never,
    github: {
      createClient: () =>
        ({ postComment: () => Promise.resolve(undefined) }) as never,
      runGhCommand,
    },
    git: {
      reconcileHeadToBranch: () =>
        Promise.resolve({
          ok: true as const,
          value: {
            action: "already-on-branch" as const,
            fromRef: BRANCH,
          },
        }),
      pushUnpushedCommits: () =>
        Promise.resolve({ ok: true as const, value: 2 }),
      runGitCommand: (args: string[]) =>
        Promise.resolve({
          ok: true as const,
          value: {
            code: 0,
            stdout: args[0] === "rev-list" ? "2\n" : "",
            stderr: "",
          },
        }),
    },
    pr: {
      // The pre-checks are GraphQL-backed, so they are dead at the quota.
      findExistingPrForIssue: () =>
        Promise.resolve({
          ok: false,
          error: new Error("GraphQL: API rate limit already exceeded"),
        }),
      findExistingPrForBranch: () =>
        Promise.resolve({
          ok: false,
          error: new Error("GraphQL: API rate limit already exceeded"),
        }),
      finalisePr: (options: { prNumber: number }) => {
        armed.push(options.prNumber);
        return Promise.resolve({
          ok: true,
          value: { result: AutoMergeResult.Enabled, message: "armed" },
        });
      },
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);
  await Deno.remove(repoPath, { recursive: true });
  return { result, calls, armed };
}

Deno.test(
  "Issue #4952 - the REST fallback's draft continuation is marked ready and armed",
  async () => {
    const run = await runRestFallback(false);

    assertEquals(run.result, { status: "continue" });
    assertEquals(readyCalls(run.calls).length, 1, "gh pr ready is called once");
    assertEquals(readyCalls(run.calls)[0]![2], String(PR));
    assertEquals(run.armed, [PR]);
  },
);

Deno.test(
  "Issue #4952 - the REST fallback's draft that cannot be marked ready fails the run and is not armed",
  async () => {
    const run = await runRestFallback(true);

    assert(run.result.status === "failure", "the run fails, not continues");
    assertEquals(run.result.category, "interrupted");
    assertStringIncludes(run.result.reason, `PR #${PR}`);
    // "interrupted" is an infrastructure category, so the body gets one
    // bounded in-process retry (Issue #1550) and ready is attempted again.
    assert(readyCalls(run.calls).length >= 1, "ready was attempted");
    assertEquals(run.armed, [], "auto-merge is not armed on a draft");
  },
);
