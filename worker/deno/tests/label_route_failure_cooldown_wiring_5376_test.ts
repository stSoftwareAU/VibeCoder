/**
 * Production wiring for the planning and question routes' failure cooldown
 * (Issue #5376).
 *
 * The bug lived in `createProductionRunCoreDeps`: `findAndProcessByLabel` ran
 * planning and question without holding or recording a cooldown, so a failing
 * issue kept its label and was re-run every cycle. These tests drive the real
 * `deps.findAndProcessPlanning()` / `deps.findAndProcessQuestion()` twice over
 * a stub `gh` (`labelRouteGhCommandFn`) and a stub client
 * (`labelRouteGitHubClient`): the first call must post the failure record that
 * promises the cooldown, and the second must not run the agent again.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { loadState } from "../lib/cooldown_state.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { handleIssueFailure } from "../lib/label_failure.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient } from "../types.ts";

const REPO = "org/label-route-cooldown-fixture";
const WORKER_USER = "worker-bot";
const ALICE = "alice";
const ISSUE = 5376;
const PROMISE =
  "once its cooldown ends (2 h, rising to 24 h after repeated failures)";

/**
 * Mirrors `gh issue list --json <fields>` (only requested fields), `gh issue
 * view`, the batched GraphQL timeline and the REST timeline, with the route's
 * label added by a trusted author. Every `issue comment` body is recorded.
 */
function stubGh(
  label: string,
  comments: string[],
): (args: string[]) => Promise<string> {
  const fields: Record<string, unknown> = {
    number: ISSUE,
    title: "An issue whose route keeps failing",
    labels: [{ name: label }],
    assignees: [],
    author: { login: ALICE },
    body: "Body",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    url: `https://github.com/${REPO}/issues/${ISSUE}`,
    milestone: null,
    subIssuesSummary: { total: 0, completed: 0 },
  };
  const labeled = {
    __typename: "LabeledEvent",
    createdAt: "2026-01-01T00:00:00Z",
    label: { name: label },
    actor: { login: ALICE },
  };
  return (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "list") {
      const requested = new Set(
        (args[args.indexOf("--json") + 1] ?? "").split(","),
      );
      const row: Record<string, unknown> = {};
      for (const field of Object.keys(fields)) {
        if (requested.has(field)) row[field] = fields[field];
      }
      return Promise.resolve(JSON.stringify([row]));
    }
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(JSON.stringify({
        author: { login: ALICE },
        title: fields.title,
        body: "Body",
        labels: [{ name: label }],
        comments: [],
        state: "OPEN",
        milestone: null,
        updatedAt: "2026-01-01T00:00:00Z",
      }));
    }
    if (args[0] === "issue" && args[1] === "comment") {
      const bodyAt = args.indexOf("--body");
      if (bodyAt >= 0) comments.push(args[bodyAt + 1]!);
      return Promise.resolve("");
    }
    if (args[0] === "api" && args[1] === "graphql") {
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      const entries = [...query.matchAll(/(n\d+): issue\(number: (\d+)\)/g)];
      return Promise.resolve(JSON.stringify({
        data: {
          repository: Object.fromEntries(
            entries.map((match) => [match[1], {
              timelineItems: { nodes: [labeled] },
            }]),
          ),
        },
      }));
    }
    if (args[0] === "api" && (args[1] ?? "").includes("/timeline")) {
      return Promise.resolve(JSON.stringify([{
        id: 1,
        event: "labeled",
        label: { name: label },
        actor: { login: ALICE },
        created_at: "2026-01-01T00:00:00Z",
      }]));
    }
    return Promise.resolve("[]");
  };
}

/** A client that answers every processor call without a real `gh`. */
function stubClient(label: string): GitHubClient {
  return {
    getIssue: () =>
      Promise.resolve({
        number: ISSUE,
        title: "An issue whose route keeps failing",
        body: "Body",
        labels: [label],
        author: ALICE,
        assignees: [],
        createdAt: "",
        updatedAt: "",
      }),
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  } as unknown as GitHubClient;
}

/**
 * Build the production deps for one route with a Claude dep that always
 * fails, run the route twice, and report what each call did.
 */
async function runRouteTwice(
  route: "planning" | "question",
): Promise<void> {
  const workDir = await Deno.makeTempDir({ prefix: "lrfc-wiring-" });
  const comments: string[] = [];
  const label = route === "planning" ? "planning" : "question";
  const gh = stubGh(label, comments);
  const workerDeps = createMockDeps({
    claude: {
      runClaudeWithRetry: () => {
        return Promise.resolve({
          ok: false,
          error: new Error("Claude failed"),
        });
      },
    },
    github: {
      handleIssueFailure: ((opts: Parameters<typeof handleIssueFailure>[0]) =>
        handleIssueFailure(opts, {
          ghCommandFn: gh,
        })) as GitHubDeps["handleIssueFailure"],
    },
  });
  const mockCrashHandling = { ...workerDeps.crashHandling };
  const byRepo = new Map([[
    REPO,
    { allowedAuthors: [ALICE], authorisedCommenters: [ALICE] },
  ]]);
  const { deps, cleanup } = await createProductionRunCoreDeps({
    repoDir: workDir,
    workDir,
    githubUser: WORKER_USER,
    logger: createLogger({
      write: (l: string) => {
        if (Deno.env.get("LRFC_DEBUG")) console.error(l);
      },
    }),
    config: {
      ...buildDefaultWorkerConfig(),
      repos: [REPO],
      workDir,
      planningLabel: "planning",
      questionLabel: "question",
    },
    resolveTrustedAuthors: () => Promise.resolve({ ok: true, byRepo }),
    workerDeps,
    labelRouteGhCommandFn: gh,
    labelRouteGitHubClient: stubClient(label),
  });
  // The factory binds the heartbeat to the real GitHub marker comment; put
  // the mock's local-only heartbeat back so no real `gh` is spawned.
  Object.assign(workerDeps.crashHandling, mockCrashHandling);
  try {
    assertEquals((await deps.refreshTrustedAuthors!()).ok, true);
    const run = route === "planning"
      ? () => deps.findAndProcessPlanning({ deadlineEpochMs: Date.now() + 6e5 })
      : () => deps.findAndProcessQuestion();
    const first = await run();
    assert(first.ok);
    assertEquals(first.value.processed, false);
    const state = await loadState(workDir);
    assertEquals(
      state.entries.map(({ repo, issueNumber, kind }) => ({
        repo,
        issueNumber,
        kind,
      })),
      [{ repo: REPO, issueNumber: ISSUE, kind: "non_transient" }],
    );
    const published = [...comments];
    if (route === "planning") {
      assert(
        published.some((comment) => comment.includes(PROMISE)),
        published.join("\n"),
      );
    }
    const second = await run();
    assert(second.ok);
    assertEquals(second.value.processed, false);
    assertEquals(await loadState(workDir), state);
    assertEquals(comments, published);
  } finally {
    await cleanup?.();
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test(
  "production deps - a failed planning run posts the 2 h promise and is not re-run on the next scan (Issue #5376)",
  () => runRouteTwice("planning"),
);

Deno.test(
  "production deps - a failed question run is not re-run on the next scan (Issue #5376)",
  () => runRouteTwice("question"),
);

/**
 * The claim scan's run-local hold, read through the production census: one
 * `low-priority` issue whose recorded failure is `ageSeconds` old.
 */
async function claimScanCensusLine(ageSeconds: number): Promise<string> {
  const workDir = await Deno.makeTempDir({ prefix: "lrfc-hold-wiring-" });
  try {
    const now = Math.floor(Date.now() / 1000);
    // A planning failure entry, as the label route records it.
    await Deno.writeTextFile(
      `${workDir}/.cooldown_state.json`,
      JSON.stringify({
        entries: [{
          repo: REPO,
          issueNumber: ISSUE,
          timestamp: now - ageSeconds,
          kind: "non_transient",
        }],
      }),
    );
    const fields: Record<string, unknown> = {
      number: ISSUE,
      title: "A relabelled issue",
      labels: [{ name: "low-priority" }],
      assignees: [],
      body: "",
      author: { login: ALICE },
      subIssuesSummary: { total: 0, completed: 0 },
    };
    const gh = (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        const requested = new Set(
          (args[args.indexOf("--json") + 1] ?? "").split(","),
        );
        const row: Record<string, unknown> = {};
        for (const field of Object.keys(fields)) {
          if (requested.has(field)) row[field] = fields[field];
        }
        return Promise.resolve(JSON.stringify([row]));
      }
      if (args[0] === "api" && (args[1] ?? "").includes("/timeline")) {
        return Promise.resolve(JSON.stringify([{
          id: 1,
          event: "labeled",
          label: { name: "low-priority" },
          actor: { login: ALICE },
          created_at: "2026-01-01T00:00:00Z",
        }]));
      }
      return Promise.resolve("[]");
    };
    const lines: string[] = [];
    const byRepo = new Map([[
      REPO,
      { allowedAuthors: [ALICE], authorisedCommenters: [ALICE] },
    ]]);
    const { deps } = await createProductionRunCoreDeps({
      repoDir: workDir,
      workDir,
      githubUser: WORKER_USER,
      logger: createLogger({ write: (line: string) => lines.push(line) }),
      config: { ...buildDefaultWorkerConfig(), repos: [REPO], workDir },
      resolveTrustedAuthors: () => Promise.resolve({ ok: true, byRepo }),
      idleDetectGhCommandFn: gh,
    });
    assertEquals((await deps.refreshTrustedAuthors!()).ok, true);
    await deps.runIdleDetectAudit!({
      tick: 1,
      scanFoundClaimable: false,
      scanExcludedRepos: [],
    });
    await deps.runIdleDecisionCensus!({
      decisionPoint: "filing",
      claimScanCompleted: true,
      claimedRepos: [],
      scanExcludedRepos: [],
    });
    const line = lines.find((l) =>
      l.includes("[idle-census]") && l.includes(`repo=${REPO}`)
    );
    assert(line !== undefined, "the census logged no line for the repo");
    return line;
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test(
  "production deps - a planning failure past its 2 h window no longer holds the claim scan (Issue #5376)",
  async () => {
    // Kept in the state file for the 48 h escalation history.
    const line = await claimScanCensusLine(3 * 3600);
    assert(line.includes("run_local_hold=0"), line);
    assert(line.includes("low_priority=1"), line);
  },
);

Deno.test(
  "production deps - a planning failure inside its 2 h window holds the claim scan (Issue #5376 control)",
  async () => {
    const line = await claimScanCensusLine(3600);
    assert(line.includes("run_local_hold=1"), line);
    assert(line.includes("low_priority=0"), line);
  },
);
