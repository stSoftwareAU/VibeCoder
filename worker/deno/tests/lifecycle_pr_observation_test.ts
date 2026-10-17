import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type LifecyclePrSnapshot,
  recordClosedLifecyclePrs,
  recordLifecyclePrFromGithub,
  recordLifecyclePrSnapshot,
} from "../lib/lifecycle_pr_observation.ts";
import {
  lifecycleLedgerPath,
  readLifecycleLedger,
} from "../lib/lifecycle_ledger.ts";
import { classifyLifecycleOutcome } from "../lib/lifecycle_outcomes.ts";
import { buildAssignmentIdMarker } from "../lib/pr_body.ts";
import type { PrRollup } from "../lib/check_runs_batch.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { cleanupMergedPrBranches } from "../lib/branch_cleanup.ts";
import {
  buildFailedCheckRunsLookup,
  findFailedCiChecks,
} from "../lib/pr_maintenance.ts";
import { ASSIGNMENT, invocation } from "./fixtures/lifecycle/scenarios.ts";
import { reconcileLifecycleEvents } from "../lib/lifecycle_reconcile.ts";

const snapshot: LifecyclePrSnapshot = {
  body: `Closes #1\n${buildAssignmentIdMarker(ASSIGNMENT)}`,
  headRefName: "issue-1",
  headRefOid: "abc123",
  state: "OPEN",
  createdAt: "2026-10-01T00:00:01.000Z",
  closedAt: null,
  mergedAt: null,
  reviewDecision: "APPROVED",
};
const rollup: PrRollup = {
  headSha: "abc123",
  rollupState: "SUCCESS",
  checkRuns: [{
    databaseId: 1,
    name: "quality",
    status: "completed",
    conclusion: "success",
  }],
  statusContexts: [],
};
async function withLedger(body: (path: string, dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await body(`${dir}/ledger.jsonl`, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
function record(
  path: string,
  patch: Partial<LifecyclePrSnapshot> = {},
  observedAt = "2026-10-01T00:00:02.000Z",
  checks: PrRollup | undefined = rollup,
) {
  return recordLifecyclePrSnapshot({
    ledgerPath: path,
    host: "host-1",
    repo: "org/repo",
    prNumber: 10,
    observedAt,
    snapshot: { ...snapshot, ...patch },
    rollup: checks,
  });
}
const terminal = { state: "MERGED", mergedAt: "2026-10-01T00:00:03.000Z" };

Deno.test("PR observations record gates before merge and replay without double counting", () =>
  withLedger(async (path) => {
    await record(path);
    await record(path, terminal, "2026-10-01T00:00:04.000Z");
    await record(path, terminal, "2026-10-01T00:00:05.000Z");
    const events = await readLifecycleLedger(path);
    assertEquals(events.length, 5);
    assertEquals(classifyLifecycleOutcome(events).success, true);
  }));
Deno.test("PR observations never infer pre-merge gates from a post-merge snapshot", () =>
  withLedger(async (path) => {
    await record(path, terminal, "2026-10-01T00:00:04.000Z");
    const result = classifyLifecycleOutcome(await readLifecycleLedger(path));
    assertEquals(result.state, "merged");
    assertEquals(result.success, false);
  }));
Deno.test("PR observations bind CI and approvals to the merged head", () =>
  withLedger(async (path) => {
    await record(path);
    await record(path, { headRefOid: "new-head" }, "2026-10-01T00:00:02.500Z");
    await record(
      path,
      { ...terminal, headRefOid: "new-head" },
      "2026-10-01T00:00:04.000Z",
    );
    const events = await readLifecycleLedger(path);
    assertEquals(
      events.filter((e) => e.kind === "gate" && e.gate === "quality").length,
      1,
    );
    assertEquals(classifyLifecycleOutcome(events).success, false);
  }));
Deno.test("PR observations record failed, pending, absent CI and unapproved review gates", async () => {
  for (
    const [checks, reviewDecision, expected] of [
      [{ ...rollup, rollupState: "FAILURE" }, "CHANGES_REQUESTED", [
        "fail",
        "fail",
      ]],
      [{ ...rollup, rollupState: "PENDING" }, "REVIEW_REQUIRED", [
        "skipped",
        "skipped",
      ]],
      [{ ...rollup, checkRuns: [], rollupState: null }, "", [
        "skipped",
        "skipped",
      ]],
    ] as const
  ) {
    await withLedger(async (path) => {
      await record(path, { reviewDecision }, undefined, checks as PrRollup);
      const events = await readLifecycleLedger(path);
      assertEquals(
        events.filter((e) => e.kind === "gate").filter((e) =>
          e.gate !== "pr_open"
        ).map((
          e,
        ) => e.result),
        [...expected],
      );
    });
  }
});
Deno.test("PR observations skip markerless PRs and retain closed-unmerged outcomes", () =>
  withLedger(async (path) => {
    await record(path, { body: "Closes #1" });
    assertEquals(await readLifecycleLedger(path), []);
    await record(path, {
      state: "CLOSED",
      closedAt: "2026-10-01T00:00:03.000Z",
      headRefName: "feature",
    });
    assertEquals(
      classifyLifecycleOutcome(await readLifecycleLedger(path)).state,
      "closed_unmerged",
    );
  }));
Deno.test("PR observations reject missing identity and terminal timestamps", async () => {
  for (
    const patch of [
      { headRefName: "feature", body: buildAssignmentIdMarker(ASSIGNMENT) },
      { state: "MERGED" },
      { state: "CLOSED" },
      { state: "NEW_STATE" },
    ]
  ) {
    await withLedger(async (path) => {
      await assertRejects(() => record(path, patch), Error, "Lifecycle PR");
    });
  }
});
Deno.test("PR observation adapter logs read and append faults at error level", () =>
  withLedger(async (_path, dir) => {
    const errors: string[] = [];
    const logger = {
      error: (message: string) => {
        errors.push(message);
      },
    };
    const input = { workDir: `${dir}/missing`, repo: "org/repo", prNumber: 10 };
    await recordLifecyclePrFromGithub(
      input,
      () => Promise.reject(new Error("snapshot unavailable")),
      logger,
    );
    await recordLifecyclePrFromGithub(
      input,
      () => Promise.resolve(JSON.stringify(snapshot)),
      logger,
    );
    assertEquals(errors.length, 2);
    assertStringIncludes(errors[0]!, "snapshot unavailable");
    assertStringIncludes(errors[1]!, "Could not append");
  }));
Deno.test("maintenance check lookup exposes the same rollup it uses for CI decisions", async () => {
  const observations: PrRollup[] = [];
  const gh = () =>
    Promise.resolve(JSON.stringify({
      data: {
        repository: {
          n0: {
            commits: {
              nodes: [{
                commit: {
                  oid: "abc123",
                  statusCheckRollup: {
                    state: "SUCCESS",
                    contexts: {
                      nodes: [{
                        __typename: "CheckRun",
                        databaseId: 1,
                        name: "quality",
                        status: "COMPLETED",
                        conclusion: "SUCCESS",
                      }],
                    },
                  },
                },
              }],
            },
          },
        },
      },
    }));
  const lookup = await buildFailedCheckRunsLookup(
    "org/repo",
    [{ number: 10, headRefName: "issue-1" }],
    gh,
    ["failure"],
    async (_pr, value) => {
      observations.push(value);
    },
  );
  assertEquals(await lookup({ number: 10, headRefName: "issue-1" }), []);
  assertEquals(observations, [rollup]);
});
Deno.test("terminal maintenance records PR events once before missing-branch skips", () =>
  withLedger(async (_path, dir) => {
    let views = 0;
    const gh = (args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") {
        return Promise.resolve(
          JSON.stringify(
            args.includes("merged")
              ? [{
                number: 10,
                body: snapshot.body,
                headRefName: "",
                mergedAt: terminal.mergedAt,
              }, {
                number: 12,
                body: "human PR",
                headRefName: "",
                mergedAt: terminal.mergedAt,
              }]
              : [{
                number: 11,
                body: snapshot.body,
                closedAt: terminal.mergedAt,
                mergedAt: null,
              }],
          ),
        );
      }
      if (args[0] === "pr" && args[1] === "view") {
        views++;
        return Promise.resolve(
          JSON.stringify({
            ...snapshot,
            ...(args[2] === "10"
              ? terminal
              : { state: "CLOSED", closedAt: terminal.mergedAt }),
          }),
        );
      }
      throw new Error(`Unexpected test call: ${args[0]} ${args[1]}`);
    };
    const result = await cleanupMergedPrBranches(["org/repo"], "bot", {
      ghCommandFn: gh,
      workDir: dir,
    });
    assertEquals(result.ok, true);
    await recordClosedLifecyclePrs({
      workDir: dir,
      repos: ["org/repo"],
      githubUser: "bot",
    }, gh);
    await recordClosedLifecyclePrs({
      workDir: dir,
      repos: ["org/repo"],
      githubUser: "bot",
    }, gh);
    await cleanupMergedPrBranches(["org/repo"], "bot", {
      ghCommandFn: gh,
      workDir: dir,
    });
    assertEquals(views, 2);
    const entries = Array.from(Deno.readDirSync(dir));
    const events = await readLifecycleLedger(`${dir}/${entries[0]!.name}`);
    assertEquals(
      events.filter((e) => e.kind === "outcome" && e.outcome !== "pr_opened")
        .map((e) => e.kind === "outcome" ? e.outcome : "").sort(),
      ["closed_unmerged", "merged"],
    );
  }));

Deno.test("PR observation adapter reuses a maintenance listing snapshot", () =>
  withLedger(async (_path, dir) => {
    let calls = 0;
    await recordLifecyclePrFromGithub({
      workDir: dir,
      repo: "org/repo",
      prNumber: 10,
      snapshot,
      rollup,
    }, () => {
      calls++;
      throw new Error("unexpected read");
    });
    assertEquals(calls, 0);
    const entries = Array.from(Deno.readDirSync(dir));
    assertEquals(
      (await readLifecycleLedger(`${dir}/${entries[0]!.name}`)).length,
      4,
    );
  }));

Deno.test("terminal maintenance reads the old cache shape without marker metadata", () =>
  withLedger(async (_path, dir) => {
    const cache = new IssueCache(`${dir}/cache`);
    await cache.write("org/repo", "prs_merged_bot", [{
      number: 10,
      title: "old",
      headRefName: "",
      mergedAt: terminal.mergedAt,
      closingRefs: [1],
    }]);
    let reads = 0;
    const gh = (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view") {
        reads++;
        return Promise.resolve(JSON.stringify({ ...snapshot, ...terminal }));
      }
      return Promise.resolve("[]");
    };
    await cleanupMergedPrBranches(["org/repo"], "bot", {
      workDir: dir,
      cache,
      ghCommandFn: gh,
    });
    assertEquals(reads, 1);
  }));

Deno.test("merge cleanup records a later merge even if the PR was previously closed", () =>
  withLedger(async (_path, dir) => {
    const gh = (args: string[]) =>
      Promise.resolve(
        args[1] === "list"
          ? JSON.stringify([{
            number: 10,
            headRefName: "",
            body: snapshot.body,
            mergedAt: terminal.mergedAt,
          }])
          : JSON.stringify({ ...snapshot, ...terminal }),
      );
    await recordLifecyclePrFromGithub({
      workDir: dir,
      repo: "org/repo",
      prNumber: 10,
      snapshot: {
        ...snapshot,
        state: "CLOSED",
        closedAt: "2026-10-01T00:00:02.000Z",
      },
    }, gh);
    await cleanupMergedPrBranches(["org/repo"], "bot", {
      workDir: dir,
      ghCommandFn: gh,
    });
    const entries = Array.from(Deno.readDirSync(dir));
    assertEquals(
      classifyLifecycleOutcome(
        await readLifecycleLedger(`${dir}/${entries[0]!.name}`),
      ).state,
      "merged",
    );
  }));

Deno.test("CI maintenance writes head-bound quality and review observations from its listing", () =>
  withLedger(async (_path, dir) => {
    const errors: string[] = [];
    const noop = () => {};
    const gh = (args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") {
        return Promise.resolve(JSON.stringify([{ number: 10, ...snapshot }]));
      }
      if (args[1] === "graphql") {
        return Promise.resolve(JSON.stringify({
          data: {
            repository: {
              n0: {
                commits: {
                  nodes: [{
                    commit: {
                      oid: "abc123",
                      statusCheckRollup: {
                        state: "SUCCESS",
                        contexts: {
                          nodes: [{
                            __typename: "CheckRun",
                            databaseId: 1,
                            name: "quality",
                            status: "COMPLETED",
                            conclusion: "SUCCESS",
                          }],
                        },
                      },
                    },
                  }],
                },
              },
            },
          },
        }));
      }
      return Promise.resolve("[]");
    };
    const result = await findFailedCiChecks({
      githubUser: "bot",
      repos: ["org/repo"],
      workDir: dir,
      ghCommandFn: gh,
      isRepoAllowed: () => true,
      isAuthorisedCommenter: () => true,
      logger: {
        info: noop,
        warn: noop,
        error: (message) => {
          errors.push(message);
        },
        debug: noop,
        security: noop,
        skipReason: noop,
        timing: noop,
        scanSummary: noop,
        workerSummary: noop,
      },
    });
    assertEquals(result, { ok: true, value: null });
    assertEquals(errors, []);
    const entries = Array.from(Deno.readDirSync(dir)).filter((entry) =>
      entry.name.startsWith("lifecycle_ledger_")
    );
    assertEquals(entries.length, 1);
    const events = await readLifecycleLedger(`${dir}/${entries[0]!.name}`);
    assertEquals(
      events.filter((event) => event.kind === "gate").map((
        event,
      ) => [event.gate, event.result]),
      [["pr_open", "pass"], ["quality", "pass"], ["review", "pass"]],
    );
  }));

Deno.test("PR observations classify reopen and reclose at each cutoff", () =>
  withLedger(async (path) => {
    await record(path, {
      state: "CLOSED",
      closedAt: "2026-10-01T00:00:03.000Z",
    });
    await record(path, { reviewDecision: "" }, "2026-10-01T00:00:04.000Z");
    let events = await readLifecycleLedger(path);
    assertEquals(classifyLifecycleOutcome(events).state, "quality_green");
    assertEquals(
      reconcileLifecycleEvents([...events, invocation(3)]).assignments[0]!
        .totals.wastedEstimatedApiEquivalentUsd,
      0,
    );
    assertEquals(
      reconcileLifecycleEvents(
        [...events, invocation(3)],
        "2026-10-01T00:00:03.500Z",
      ).assignments[0]!.totals.wastedEstimatedApiEquivalentUsd,
      3,
    );
    assertEquals(
      classifyLifecycleOutcome(events, "2026-10-01T00:00:03.500Z").state,
      "closed_unmerged",
    );
    assertEquals(
      classifyLifecycleOutcome(events, "2026-10-01T00:00:04.500Z").state,
      "censored_at_cutoff",
    );
    await record(path, {
      state: "CLOSED",
      closedAt: "2026-10-01T00:00:05.000Z",
    });
    events = await readLifecycleLedger(path);
    assertEquals(classifyLifecycleOutcome(events).state, "closed_unmerged");
    assertEquals(
      classifyLifecycleOutcome(events, "2026-10-01T00:00:04.500Z").state,
      "censored_at_cutoff",
    );
  }));

Deno.test("PR observations invalidate live gates when the current head changes", () =>
  withLedger(async (path) => {
    await record(path);
    await record(
      path,
      { headRefOid: "new-head", reviewDecision: "" },
      "2026-10-01T00:00:02.500Z",
    );
    assertEquals(
      classifyLifecycleOutcome(await readLifecycleLedger(path)).state,
      "pr_opened",
    );
  }));

Deno.test("closed maintenance observes a new close timestamp after reopening", () =>
  withLedger(async (_path, dir) => {
    let closedAt = "2026-10-01T00:00:03.000Z";
    let views = 0;
    const gh = (args: string[]) => {
      if (args[1] === "list") {
        return Promise.resolve(
          JSON.stringify([{
            number: 10,
            body: snapshot.body,
            closedAt,
            mergedAt: null,
          }]),
        );
      }
      views++;
      return Promise.resolve(
        JSON.stringify({ ...snapshot, state: "CLOSED", closedAt }),
      );
    };
    const input = { workDir: dir, repos: ["org/repo"], githubUser: "bot" };
    await recordClosedLifecyclePrs(input, gh);
    await recordClosedLifecyclePrs(input, gh);
    assertEquals(views, 1);
    closedAt = "2026-10-01T00:00:05.000Z";
    await recordClosedLifecyclePrs(input, gh);
    assertEquals(views, 2);
  }));

Deno.test("CI maintenance skips markerless bots and refreshes missing review metadata", async () => {
  for (const mode of ["markerless", "missing-review", "changed-head"]) {
    const markerless = mode === "markerless";
    await withLedger(async (_path, dir) => {
      let views = 0;
      const errors: string[] = [];
      const noop = () => {};
      const gh = (args: string[]) => {
        if (args[0] === "pr" && args[1] === "view") {
          views++;
          return Promise.resolve(JSON.stringify(snapshot));
        }
        if (args[0] === "pr" && args[1] === "list") {
          if (markerless && args.includes("--author")) {
            return Promise.resolve("[]");
          }
          const { reviewDecision: _review, ...withoutReview } = snapshot;
          return Promise.resolve(
            JSON.stringify([{
              ...(mode === "changed-head"
                ? { ...snapshot, headRefOid: "old-head" }
                : withoutReview),
              number: 10,
              ...(markerless
                ? {
                  body: "dependency update",
                  author: { login: "dependabot[bot]" },
                  isCrossRepository: false,
                }
                : {}),
            }]),
          );
        }
        if (args[1] === "graphql") {
          return Promise.resolve(
            JSON.stringify({
              data: {
                repository: {
                  n0: {
                    commits: {
                      nodes: [{
                        commit: {
                          oid: "abc123",
                          statusCheckRollup: {
                            state: "SUCCESS",
                            contexts: { nodes: [] },
                          },
                        },
                      }],
                    },
                  },
                },
              },
            }),
          );
        }
        return Promise.resolve("[]");
      };
      await findFailedCiChecks({
        githubUser: "bot",
        repos: ["org/repo"],
        workDir: dir,
        ghCommandFn: gh,
        isRepoAllowed: () => true,
        isAuthorisedCommenter: () => true,
        logger: {
          info: noop,
          warn: noop,
          error: (message) => {
            errors.push(message);
          },
          debug: noop,
          security: noop,
          skipReason: noop,
          timing: noop,
          scanSummary: noop,
          workerSummary: noop,
        },
      });
      assertEquals(errors, []);
      assertEquals(views, markerless ? 0 : 1);
      const entries = Array.from(Deno.readDirSync(dir)).filter((entry) =>
        entry.name.startsWith("lifecycle_ledger_")
      );
      assertEquals(entries.length, markerless ? 0 : 1);
      if (!markerless) {
        const events = await readLifecycleLedger(`${dir}/${entries[0]!.name}`);
        assertEquals(classifyLifecycleOutcome(events).state, "review_approved");
      }
    });
  }
});

Deno.test("CI maintenance never revives a closed PR from a cached OPEN listing", () =>
  withLedger(async (_path, dir) => {
    const now = Date.now();
    const snapshot = {
      body: buildAssignmentIdMarker("11111111-1111-4111-8111-111111111111"),
      headRefName: "issue-1",
      headRefOid: "abc123",
      state: "OPEN",
      createdAt: new Date(now - 86400000).toISOString(),
      mergedAt: null,
      closedAt: null,
      reviewDecision: "APPROVED",
    };
    const cache = new IssueCache(`${dir}/cache`);
    await cache.write("org/repo", "prs_maint_bot", [{
      number: 10,
      ...snapshot,
    }]);
    const path = lifecycleLedgerPath(dir);
    await recordLifecyclePrSnapshot({
      ledgerPath: path,
      host: "host-1",
      repo: "org/repo",
      prNumber: 10,
      snapshot: {
        ...snapshot,
        state: "CLOSED",
        closedAt: new Date(now - 30000).toISOString(),
      },
      observedAt: new Date(now - 20000).toISOString(),
    });
    assertEquals(
      classifyLifecycleOutcome(await readLifecycleLedger(path)).state,
      "closed_unmerged",
    );
    const noop = () => {};
    const gh = (args: string[]) =>
      Promise.resolve(
        args[1] === "graphql"
          ? JSON.stringify({
            data: {
              repository: {
                n0: {
                  commits: {
                    nodes: [{
                      commit: {
                        oid: "abc123",
                        statusCheckRollup: {
                          state: "SUCCESS",
                          contexts: {
                            nodes: [{
                              __typename: "CheckRun",
                              databaseId: 1,
                              name: "quality",
                              status: "COMPLETED",
                              conclusion: "SUCCESS",
                            }],
                          },
                        },
                      },
                    }],
                  },
                },
              },
            },
          })
          : "[]",
      );
    await findFailedCiChecks({
      githubUser: "bot",
      repos: ["org/repo"],
      workDir: dir,
      cache,
      ghCommandFn: gh,
      isRepoAllowed: () => true,
      isAuthorisedCommenter: () => true,
      logger: {
        info: noop,
        warn: noop,
        error: console.error,
        debug: noop,
        security: noop,
        skipReason: noop,
        timing: noop,
        scanSummary: noop,
        workerSummary: noop,
      },
    });
    assertEquals(
      classifyLifecycleOutcome(await readLifecycleLedger(path)).state,
      "closed_unmerged",
    );
  }));

Deno.test("quality uses its own observation time and cannot reopen an explicitly closed PR", () =>
  withLedger(async (path) => {
    await recordLifecyclePrSnapshot({
      ledgerPath: path,
      host: "host-1",
      repo: "org/repo",
      prNumber: 10,
      snapshot,
      observedAt: "2026-10-01T00:00:02.000Z",
      qualityObservedAt: "2026-10-01T00:00:04.000Z",
      rollup,
    });
    await record(path, {
      state: "CLOSED",
      closedAt: "2026-10-01T00:00:03.000Z",
    });
    assertEquals(
      classifyLifecycleOutcome(await readLifecycleLedger(path)).state,
      "closed_unmerged",
    );
    await record(path, terminal);
    assertEquals(
      classifyLifecycleOutcome(await readLifecycleLedger(path)).success,
      false,
    );
  }));
