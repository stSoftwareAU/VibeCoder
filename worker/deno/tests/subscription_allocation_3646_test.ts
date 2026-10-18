import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  initialAllocationState,
  parseAllocationPolicy,
  recommendAllocation as recommend,
  selectAllocationArm,
} from "../lib/subscription_allocation.ts";
import type {
  AssignmentRecord,
  ExperimentReport,
} from "../lib/fleet_experiment_report.ts";
import {
  evaluateSubscriptionAllocation,
  refreshSubscriptionAllocation,
} from "../lib/subscription_allocation_runtime.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  type AssignmentMarkerComment,
  recordIssueAssignment,
} from "../lib/issue_assignment.ts";
import { workerBuildFacts } from "../lib/worker_build_info.ts";

function recommendAllocation(
  config: ReturnType<typeof policy>,
  state: ReturnType<typeof initialAllocationState>,
  report: ExperimentReport,
) {
  return recommend(config, state, report, {
    observedAt: report.generatedAt,
    correlatedOutage: false,
    arms: Object.fromEntries(
      config.arms.map(
        (arm) => [arm.id, {
          hostDays: 100,
          availableSlotSeconds: 8640000,
          idleSlotSeconds: 0,
          quotaBlockedSlotSeconds: 0,
        }],
      ),
    ),
  });
}
function policy(overrides: Record<string, unknown> = {}) {
  return parseAllocationPolicy({
    seed: "allocation-trial",
    ledger_paths: ["/tmp/ledger.jsonl"],
    providers: { claude: { estimated_budget_usd: 100000, max_parallelism: 2 } },
    hosts: { test: { providers: ["claude"], capacity: 1 } },
    arms: [
      {
        id: "sonnet-haiku",
        label: "Incumbent",
        control: true,
        status: "active",
        weight: 1,
        manager: { provider: "claude", model: "sonnet" },
        executor: { provider: "claude", model: "haiku" },
      },
      {
        id: "candidate",
        label: "Candidate",
        control: false,
        status: "active",
        weight: 1,
        manager: { provider: "claude", model: "sonnet" },
        executor: { provider: "claude", model: "sonnet" },
      },
    ],
    max_cluster_issues: 1,
    max_issue_cost_usd: 5,
    ...overrides,
  })!;
}

function record(
  arm: string,
  index: number,
  cost: number,
  extra: Partial<AssignmentRecord> = {},
): AssignmentRecord {
  return {
    assignmentId: `${arm}-${index}`,
    cohort: arm,
    repo: "org/repo",
    issueNumber: index,
    hosts: [`host-${index}`],
    managerProvider: "claude",
    roleCombination: arm,
    assignedAt: "2026-10-10T00:00:00Z",
    costUsd: cost,
    costUnknownCount: 0,
    invocations: 3,
    failedInvocations: 0,
    quotaLimitedInvocations: 0,
    followOns: 0,
    reviewRejections: 0,
    gateFailures: 0,
    firstPassCi: true,
    status: "merged",
    timeToMergeHours: 1,
    mature: true,
    censored: false,
    usesExcludedModel: false,
    covariates: { repo: "org/repo", type: "bug" },
    ...extra,
  };
}

function evidence(count = 2000): ExperimentReport {
  return {
    generatedAt: "2026-10-18T00:00:00Z",
    windowDays: 30,
    horizonDays: 1,
    arms: [],
    weekly: [],
    breakdowns: [],
    warnings: [],
    verdict: {
      kind: "no-decision",
      reason: "allocator computes sequential uncertainty",
    },
    records: Array.from(
      { length: count },
      (
        _,
        index,
      ) => [record("sonnet-haiku", index, 4), record("candidate", index, 0.1)],
    ).flat(),
  };
}

Deno.test("allocation defaults to dry-run and refuses financial commitments, Fable and a changed control", () => {
  assertEquals(policy().autoRouting, false);
  assertEquals(parseAllocationPolicy(undefined), undefined);
  for (
    const override of [
      { subscription_fee_usd: 50 },
      { auto_routing: "true" },
      { max_shift: 1 },
      { exploration_floor: 0 },
      { control_floor: 0 },
    ]
  ) {
    assertThrows(() => policy(override));
  }
  const raw = policy();
  assertThrows(() =>
    policy({
      arms: raw.arms.map((arm) => ({
        ...arm,
        executor: { provider: "claude", model: "Fable" },
      })),
    })
  );
});

Deno.test("allocation moves gradually toward proven efficiency while preserving control and exploration", () => {
  const config = policy();
  let state = initialAllocationState(config);
  for (let step = 0; step < 12; step++) {
    const report = evidence(2000 + step);
    report.generatedAt = new Date(
      Date.parse(report.generatedAt) + step * 3_600_000,
    ).toISOString();
    const plan = recommendAllocation(config, state, report);
    assertEquals(plan.action, "shift");
    assert(
      plan.weights.candidate! - state.weights.candidate! <=
        config.maxShift + 1e-12,
    );
    assert(plan.weights["sonnet-haiku"]! >= config.controlFloor);
    assert(plan.effectiveSamples.candidate! >= 2000);
    assert(
      plan.intervals.candidate!.low > plan.intervals["sonnet-haiku"]!.high,
    );
    state = plan.nextState;
    if (state.weights["sonnet-haiku"]! <= config.controlFloor + 1e-12) break;
  }
  assert(state.weights.candidate! > 0.5);
  assert(state.weights["sonnet-haiku"]! >= config.controlFloor);
});

Deno.test("immature, uncertain, biased and unknown-cost evidence cannot move allocation", () => {
  const config = policy();
  for (
    const report of [evidence(5), {
      ...evidence(),
      records: evidence().records.map((item) => ({ ...item, mature: false })),
    }, {
      ...evidence(),
      warnings: [{
        code: "biased-assignment" as const,
        message: "repository mix differs",
      }],
    }, {
      ...evidence(),
      records: evidence().records.map((item) => ({
        ...item,
        costUnknownCount: 1,
      })),
    }, {
      ...evidence(),
      records: evidence().records.map((item) => ({ ...item, costUsd: 1 })),
    }]
  ) {
    const state = initialAllocationState(config);
    const plan = recommendAllocation(config, state, report);
    assertEquals(plan.weights, state.weights);
    assert(plan.action !== "shift");
  }
});

Deno.test("quality regression rolls back immediately and the pause survives restart", () => {
  const config = policy();
  const shifted =
    recommendAllocation(config, initialAllocationState(config), evidence())
      .nextState;
  const report = evidence();
  report.records = report.records.map((item) =>
    item.cohort === "candidate"
      ? { ...item, reviewRejections: 2, gateFailures: 1 }
      : item
  );
  const rollback = recommendAllocation(config, shifted, report);
  assertEquals(rollback.action, "rollback");
  assertEquals(rollback.nextState.paused, true);
  assertEquals(rollback.weights, initialAllocationState(config).weights);
  const restarted = recommendAllocation(
    config,
    JSON.parse(JSON.stringify(rollback.nextState)),
    evidence(),
  );
  assertEquals(restarted.action, "paused");
});

Deno.test("repeated observations and the decision cadence cannot compound a shift", () => {
  const config = policy();
  const report = evidence();
  const first = recommendAllocation(
    config,
    initialAllocationState(config),
    report,
  );
  assertEquals(
    recommendAllocation(config, first.nextState, report).weights,
    first.weights,
  );
  const tooSoon = evidence(2001);
  assertEquals(
    recommendAllocation(config, first.nextState, tooSoon).weights,
    first.weights,
  );
});

Deno.test("automatic routing needs opt-in, a recorded dry-run and live quota/capacity", async () => {
  const config = policy({ auto_routing: true });
  const state = initialAllocationState(config);
  const status = {
    claude: {
      subscription: true,
      available: true,
      inFlight: 0,
      spentUsd: 0,
      costKnown: true,
    },
  };
  await assertRejects(
    () => selectAllocationArm(config, state, "org/repo", 1, "test", status),
    Error,
    "dry-run",
  );
  state.dryRunAt = "2026-10-17T00:00:00Z";
  const selected = await selectAllocationArm(
    config,
    state,
    "org/repo",
    1,
    "test",
    status,
  );
  assert(selected !== null);
  assertEquals(
    await selectAllocationArm(config, state, "org/repo", 1, "test", status),
    selected,
  );
  assertEquals(
    await selectAllocationArm(config, state, "org/repo", 1, "test", {
      claude: { ...status.claude, available: false },
    }),
    null,
  );
  assertEquals(
    await selectAllocationArm(config, state, "org/repo", 1, "test", {
      claude: { ...status.claude, spentUsd: 100000 },
    }),
    null,
  );
  assertEquals(
    await selectAllocationArm(policy(), state, "org/repo", 1, "test", status),
    null,
  );
});

Deno.test("dry-run state survives restart, requires explicit opt-in, and refuses old or corrupt state", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ledger = `${dir}/ledger.jsonl`;
    await Deno.writeTextFile(ledger, "");
    const config = buildDefaultWorkerConfig({
      workDir: `${dir}/work`,
      subscriptionAllocation: policy({ ledger_paths: [ledger] }),
    });
    await assertRejects(
      () => evaluateSubscriptionAllocation(config, { apply: true }),
      Error,
      "explicitly enabled",
    );
    const preview = await evaluateSubscriptionAllocation(config);
    const written = JSON.parse(await Deno.readTextFile(preview.stateFile));
    assertEquals(
      written.weights,
      initialAllocationState(config.subscriptionAllocation!).weights,
    );
    assert(written.dryRunAt !== null);
    config.subscriptionAllocation = policy({
      ledger_paths: [ledger],
      auto_routing: true,
    });
    const applied = await evaluateSubscriptionAllocation(config, {
      apply: true,
    });
    assertEquals(applied.plan.weights, written.weights);
    const messages: string[] = [];
    assertEquals(
      (await refreshSubscriptionAllocation(
        config,
        (message) => messages.push(message),
      ))?.action,
      "hold",
    );
    assert(messages[0]!.includes("subscription-allocation"));
    const old = JSON.stringify({ version: 0, weights: {} });
    await Deno.writeTextFile(preview.stateFile, old);
    await assertRejects(
      () => evaluateSubscriptionAllocation(config, { apply: true }),
      Error,
      "schema or policy",
    );
    assertEquals(await Deno.readTextFile(preview.stateFile), old);
    assertEquals(
      await refreshSubscriptionAllocation(
        config,
        (message) => messages.push(message),
      ),
      undefined,
    );
    assert(messages.at(-1)!.includes("refresh held"));
    assertEquals(await Deno.readTextFile(preview.stateFile), old);
    await evaluateSubscriptionAllocation(config, { reset: true });
    assertEquals(
      JSON.parse(await Deno.readTextFile(preview.stateFile)).version,
      1,
    );
    await Deno.remove(ledger);
    await assertRejects(() => evaluateSubscriptionAllocation(config), Error);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("outcome refresh leaves unconfigured workers and preview-only policy untouched", async () => {
  const config = buildDefaultWorkerConfig();
  const messages: string[] = [];
  assertEquals(
    await refreshSubscriptionAllocation(
      config,
      (message) => messages.push(message),
    ),
    undefined,
  );
  config.subscriptionAllocation = policy();
  assertEquals(
    await refreshSubscriptionAllocation(
      config,
      (message) => messages.push(message),
    ),
    undefined,
  );
  assertEquals(messages, []);
});

Deno.test("a cohort is assigned once and survives retries under another treatment", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const comments: AssignmentMarkerComment[] = [];
    const seams = {
      ledgerPath: `${dir}/ledger.jsonl`,
      host: "test",
      runId: "allocation-test",
      now: () => Date.parse("2026-10-18T00:00:00Z"),
      mintId: () => "00000000-0000-4000-8000-000000000001",
      buildFacts: workerBuildFacts,
      store: {
        listMarkerComments: async () => comments,
        postMarkerComment: async (
          _repo: string,
          _issue: number,
          body: string,
        ) => {
          comments.push({
            author: "worker",
            createdAt: "2026-10-18T00:00:00Z",
            body,
          });
        },
      },
    };
    const input = {
      repo: "org/repo",
      issueNumber: 1,
      trustedAuthors: ["worker"],
      roles: [{
        role: "manager" as const,
        provider: "claude",
        model: "sonnet",
      }],
    };
    const first = await recordIssueAssignment(
      { ...input, cohort: "candidate" },
      seams,
    );
    const retry = await recordIssueAssignment({
      ...input,
      cohort: "sonnet-haiku",
    }, { ...seams, runId: "retry" });
    assertEquals(first.cohort, "candidate");
    assertEquals(retry.cohort, "candidate");
    assertEquals(retry.assignmentId, first.assignmentId);
    assertEquals(comments.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("missing capacity telemetry, correlated outages and worse throughput suppress shifts", () => {
  const config = policy();
  const state = initialAllocationState(config);
  const report = evidence();
  assertEquals(recommend(config, state, report).action, "hold");
  const bad = {
    observedAt: report.generatedAt,
    correlatedOutage: true,
    arms: {},
  };
  assertEquals(recommend(config, state, report, bad).action, "hold");
  const slower = {
    observedAt: report.generatedAt,
    correlatedOutage: false,
    arms: {
      "sonnet-haiku": {
        hostDays: 10,
        availableSlotSeconds: 100,
        idleSlotSeconds: 0,
        quotaBlockedSlotSeconds: 0,
      },
      candidate: {
        hostDays: 100,
        availableSlotSeconds: 100,
        idleSlotSeconds: 0,
        quotaBlockedSlotSeconds: 0,
      },
    },
  };
  assertEquals(recommend(config, state, report, slower).action, "hold");
});
