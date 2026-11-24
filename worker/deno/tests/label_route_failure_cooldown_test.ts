/**
 * Tests for label_route_failure_cooldown.ts — the escalating failure cooldown
 * on the planning and question label routes (Issue #5376).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { prepareLabelRouteFailureCooldown } from "../lib/label_route_failure_cooldown.ts";
import {
  type CooldownConfig,
  countRecentEscalatingFailures,
  loadState,
  recordIssueCooldown,
} from "../lib/cooldown_state.ts";
import { handleIssueFailure } from "../lib/label_failure.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubDeps, WorkerDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext } from "../lib/issue_worker.ts";
import { processIssuePlanning } from "../lib/planning_processor.ts";
import { processIssueQuestion } from "../lib/question_processor.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { GitHubClient, Logger } from "../types.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const REPO = "org/repo";
const PROMISE =
  "once its cooldown ends (2 h, rising to 24 h after repeated failures)";

async function withWorkDir(
  fn: (cfg: CooldownConfig) => Promise<void>,
): Promise<void> {
  const workDir = await Deno.makeTempDir({ prefix: "lrfc-test-" });
  try {
    await fn({ workDir, issueRetryCooldown: 600 });
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

/** A fake gh that reports no labels and records every comment body. */
function makeFakeGh(comments: string[]) {
  return (args: string[]): Promise<string> => {
    const bodyAt = args.indexOf("--body");
    if (args[0] === "issue" && args[1] === "comment" && bodyAt >= 0) {
      comments.push(args[bodyAt + 1]!);
    }
    return Promise.resolve("");
  };
}

function makeClient(): GitHubClient {
  return {
    getIssue: () =>
      Promise.resolve({
        number: 100,
        title: "Test",
        body: "",
        labels: [],
        author: "user",
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

function makeFailingDeps(comments: string[]): WorkerDeps {
  const fakeGh = makeFakeGh(comments);
  return createMockDeps({
    claude: {
      runClaudeWithRetry: () =>
        Promise.resolve({ ok: false, error: new Error("Claude failed") }),
    },
    github: {
      handleIssueFailure: ((opts: Parameters<typeof handleIssueFailure>[0]) =>
        handleIssueFailure(opts, {
          ghCommandFn: fakeGh,
        })) as GitHubDeps["handleIssueFailure"],
    },
  });
}

function makeCtx(
  issueNumber: number,
  label: string,
): IssueContext {
  return {
    repo: REPO,
    issueNumber,
    issueTitle: "Title",
    issueBody: "Body",
    issueLabels: [label],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
  };
}

function captureLogger(warnings: string[]): Logger {
  const base = createMockDeps().logger;
  return { ...base, warn: (m: string) => void warnings.push(m) };
}

const okResult = (
  markedAsFailedOnce: boolean,
  failureCategory: string,
) =>
  Promise.resolve({
    ok: true as const,
    value: {
      markedAsFailedOnce,
      failureCategory,
      isInfrastructure: false,
    },
  });

function stubDeps(
  handle: (...a: unknown[]) => Promise<unknown>,
): WorkerDeps {
  return createMockDeps({
    github: { handleIssueFailure: handle as GitHubDeps["handleIssueFailure"] },
  });
}

const failOpts = {
  repo: REPO,
  issueNumber: 100,
  githubUser: "testbot",
  failureMessage: "boom",
} as unknown as Parameters<GitHubDeps["handleIssueFailure"]>[0];

Deno.test("a failed planning run posts the 2 h record and holds the issue off the next scan", async () => {
  await withWorkDir(async (cfg) => {
    const comments: string[] = [];
    const deps = makeFailingDeps(comments);
    const before = await prepareLabelRouteFailureCooldown({
      cooldownConfig: cfg,
      workerDeps: deps,
      logger: deps.logger,
    });
    assertEquals(before.isHeld(REPO, 100), false);

    const result = await processIssuePlanning(makeCtx(100, "planning"), {
      ghClient: makeClient(),
      logger: deps.logger,
      deps: before.workerDeps,
      promptsDir: PROMPTS_DIR,
    });
    assertEquals(result.ok, false);
    assert(comments.some((c) => c.includes(PROMISE)), comments.join("\n"));

    const next = await prepareLabelRouteFailureCooldown({
      cooldownConfig: cfg,
      workerDeps: deps,
      logger: deps.logger,
    });
    assertEquals(next.isHeld(REPO, 100), true);
    assertEquals(next.isHeld(REPO, 101), false);
  });
});

Deno.test("a failed question run holds the issue off the next scan", async () => {
  await withWorkDir(async (cfg) => {
    const comments: string[] = [];
    const deps = makeFailingDeps(comments);
    const before = await prepareLabelRouteFailureCooldown({
      cooldownConfig: cfg,
      workerDeps: deps,
      logger: deps.logger,
    });
    assertEquals(before.isHeld(REPO, 50), false);

    const result = await processIssueQuestion(makeCtx(50, "question"), {
      ghClient: makeClient(),
      logger: deps.logger,
      deps: before.workerDeps,
    });
    assertEquals(result.ok, false);

    const next = await prepareLabelRouteFailureCooldown({
      cooldownConfig: cfg,
      workerDeps: deps,
      logger: deps.logger,
    });
    assertEquals(next.isHeld(REPO, 50), true);
    assertEquals(next.isHeld(REPO, 51), false);
  });
});

Deno.test("a second failure steps the ladder", async () => {
  await withWorkDir(async (cfg) => {
    const deps = stubDeps(() => okResult(true, "claude_error"));
    const wrapped = await prepareLabelRouteFailureCooldown({
      cooldownConfig: cfg,
      workerDeps: deps,
      logger: deps.logger,
    });
    await wrapped.workerDeps.github.handleIssueFailure(failOpts);
    await wrapped.workerDeps.github.handleIssueFailure(failOpts);
    const state = await loadState(cfg.workDir, cfg.issueRetryCooldown);
    assertEquals(countRecentEscalatingFailures(state, REPO, 100), 2);
  });
});

Deno.test("a non-fault result records nothing", async () => {
  await withWorkDir(async (cfg) => {
    const deps = stubDeps(() => okResult(false, "scheduled_release"));
    const wrapped = await prepareLabelRouteFailureCooldown({
      cooldownConfig: cfg,
      workerDeps: deps,
      logger: deps.logger,
    });
    const result = await wrapped.workerDeps.github.handleIssueFailure(
      failOpts,
    );
    assertEquals(result.ok, true);
    const state = await loadState(cfg.workDir, cfg.issueRetryCooldown);
    assertEquals(state.entries.length, 0);
    const next = await prepareLabelRouteFailureCooldown({
      cooldownConfig: cfg,
      workerDeps: deps,
      logger: deps.logger,
    });
    assertEquals(next.isHeld(REPO, 100), false);
  });
});

Deno.test("a timeout records kind timeout; a throw records non_transient and rethrows", async () => {
  await withWorkDir(async (cfg) => {
    const timeoutDeps = stubDeps(() => okResult(true, "timeout"));
    const w1 = await prepareLabelRouteFailureCooldown({
      cooldownConfig: cfg,
      workerDeps: timeoutDeps,
      logger: timeoutDeps.logger,
    });
    await w1.workerDeps.github.handleIssueFailure(failOpts);
    let state = await loadState(cfg.workDir, cfg.issueRetryCooldown);
    assertEquals(state.entries.map((e) => e.kind), ["timeout"]);

    const throwDeps = stubDeps(() => Promise.reject(new Error("gh exploded")));
    const w2 = await prepareLabelRouteFailureCooldown({
      cooldownConfig: cfg,
      workerDeps: throwDeps,
      logger: throwDeps.logger,
    });
    await assertRejects(
      () => w2.workerDeps.github.handleIssueFailure(failOpts),
      Error,
      "gh exploded",
    );
    state = await loadState(cfg.workDir, cfg.issueRetryCooldown);
    assertEquals(state.entries.map((e) => e.kind), [
      "timeout",
      "non_transient",
    ]);
  });
});

Deno.test("a failed cooldown write is logged, not thrown", async () => {
  const file = await Deno.makeTempFile({ prefix: "lrfc-notadir-" });
  try {
    const warnings: string[] = [];
    const deps = stubDeps(() => okResult(true, "claude_error"));
    const wrapped = await prepareLabelRouteFailureCooldown({
      cooldownConfig: { workDir: file, issueRetryCooldown: 600 },
      workerDeps: deps,
      logger: captureLogger(warnings),
    });
    const result = await wrapped.workerDeps.github.handleIssueFailure(
      failOpts,
    );
    assertEquals(result.ok, true);
    assert(warnings.some((w) => w.includes("org/repo#100")), warnings.join());
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("a flat entry does not hold the issue on the label route", async () => {
  await withWorkDir(async (cfg) => {
    const flat = await recordIssueCooldown(cfg, REPO, 100);
    assert(flat.ok);
    const deps = createMockDeps();
    const prepared = await prepareLabelRouteFailureCooldown({
      cooldownConfig: cfg,
      workerDeps: deps,
      logger: deps.logger,
    });
    assertEquals(prepared.isHeld(REPO, 100), false);
  });
});
