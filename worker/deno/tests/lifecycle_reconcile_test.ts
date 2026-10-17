import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  reconcileLifecycleEvents,
  reconcileLifecycleFiles,
} from "../lib/lifecycle_reconcile.ts";
import {
  buildLifecycleEvent,
  serialiseLifecycleEvent,
} from "../lib/lifecycle_ledger.ts";
import {
  assignment,
  followOn,
  invocation,
  ledgerEvent,
  outcome,
  scenarios,
} from "./fixtures/lifecycle/scenarios.ts";

for (const fixture of scenarios) {
  Deno.test(`lifecycle reconciliation fixture: ${fixture.name}`, () => {
    const result = reconcileLifecycleEvents(fixture.events, fixture.cutoff);
    const row = result.assignments[0]!;
    const cohort = result.cohorts[0]!;
    assertEquals(row.totals.estimatedApiEquivalentUsd, fixture.total);
    assertEquals(row.totals.wastedEstimatedApiEquivalentUsd, fixture.wasted);
    assertEquals(row.totals.partial, false);
    assertEquals(row.totals.unknownUsageCount, 0);
    assertEquals(row.totals.unknownPricingCount, 0);
    assertEquals(
      Object.fromEntries(
        Object.entries(row.byRole).map((
          [role, value],
        ) => [role, value.estimatedApiEquivalentUsd]),
      ),
      fixture.roles,
    );
    assertEquals(row.outcome.state, fixture.state);
    assertEquals(row.outcome.success, fixture.success);
    assertEquals(cohort.totals, row.totals);
    assertEquals(cohort.byRole, row.byRole);
    assertEquals(cohort.assignmentCount, 1);
    assertEquals(cohort.successCount, Number(fixture.success));
  });
}

Deno.test("lifecycle reconciliation retains unknown usage and pricing as a partial estimate", () => {
  const unknown = ledgerEvent({
    result: "timeout",
    usage: "unknown",
    pricing: "unknown",
    telemetryAbsentReason: "usage_not_reported",
  });
  const row = reconcileLifecycleEvents([assignment, unknown]).assignments[0]!;
  assertEquals(row.totals, {
    estimatedApiEquivalentUsd: null,
    wastedEstimatedApiEquivalentUsd: null,
    partial: true,
    wastedPartial: true,
    unknownUsageCount: 1,
    unknownPricingCount: 1,
  });
  const mixed = reconcileLifecycleEvents([
    assignment,
    unknown,
    invocation(3, "known"),
  ]).assignments[0]!;
  assertEquals(mixed.totals.estimatedApiEquivalentUsd, 3);
  assertEquals(mixed.totals.partial, true);
});

Deno.test("lifecycle reconciliation preserves the priced part of split-model usage", () => {
  const tokens = {
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  const row = reconcileLifecycleEvents([
    assignment,
    ledgerEvent({
      result: "failure",
      usage: "known",
      pricing: "unknown",
      models: [{
        model: "known",
        role: "manager",
        tokens,
        pricing: "known",
        estimatedApiEquivalentUsd: 2,
      }, {
        model: "new-model",
        role: "sub-agent (unattributed)",
        tokens,
        pricing: "unknown",
      }],
    }),
  ]).assignments[0]!;
  assertEquals(row.totals.estimatedApiEquivalentUsd, 2);
  assertEquals(row.totals.wastedEstimatedApiEquivalentUsd, 2);
  assertEquals(row.totals.unknownUsageCount, 0);
  assertEquals(row.totals.unknownPricingCount, 1);
  assertEquals(
    row.byRole["sub-agent (unattributed)"]!.estimatedApiEquivalentUsd,
    null,
  );
  assertEquals(row.totals.partial, true);
});

Deno.test("lifecycle reconciliation keeps distinct follow-on cycles sharing a process run ID", () => {
  const first = followOn(5, 10);
  const second = buildLifecycleEvent({
    ...first,
    kind: "follow_on",
    followOn: "pr_feedback",
    cycle: "review-2",
    attempt: 2,
    estimatedApiEquivalentUsd: 3,
  });
  const row = reconcileLifecycleEvents([assignment, first, second, first])
    .assignments[0]!;
  assertEquals(row.totals.estimatedApiEquivalentUsd, 8);
  assertEquals(row.byFollowOn.ci_fix!.estimatedApiEquivalentUsd, 5);
  assertEquals(row.byFollowOn.pr_feedback!.estimatedApiEquivalentUsd, 3);
  assertEquals(
    Object.values(row.byAttempt).map((value) => value.estimatedApiEquivalentUsd)
      .sort(),
    [3, 5],
  );
});

Deno.test("lifecycle reconciliation reads multiple files and dedupes across hosts", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const events = scenarios[0]!.events;
    const text = events.map(serialiseLifecycleEvent).join("\n") + "\n";
    await Deno.writeTextFile(`${dir}/a.jsonl`, text);
    await Deno.writeTextFile(`${dir}/b.jsonl`, text);
    assertEquals(
      await reconcileLifecycleFiles([`${dir}/a.jsonl`, `${dir}/b.jsonl`]),
      reconcileLifecycleEvents(events),
    );
    await Deno.writeTextFile(`${dir}/bad.jsonl`, "bad json\n");
    await assertRejects(
      () => reconcileLifecycleFiles([`${dir}/bad.jsonl`]),
      Error,
      "line 1",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("lifecycle reconciliation distinguishes known zero, missing telemetry and missing cohort", () => {
  assertEquals(reconcileLifecycleEvents([]), { assignments: [], cohorts: [] });
  const empty = reconcileLifecycleEvents([assignment]).assignments[0]!;
  assertEquals(empty.totals.estimatedApiEquivalentUsd, 0);
  assertEquals(empty.byRole, {});
  const known = reconcileLifecycleEvents([invocation(0)]).assignments[0]!;
  assertEquals(known.cohort, "unknown");
  assertEquals(known.totals.estimatedApiEquivalentUsd, 0);
  assertEquals(known.totals.partial, false);
  const legacy = reconcileLifecycleEvents([
    ledgerEvent({ result: "success", estimatedApiCostUsd: 8 }),
  ]).assignments[0]!;
  assertEquals(legacy.totals.estimatedApiEquivalentUsd, null);
  assertEquals(legacy.totals.unknownUsageCount, 1);
  assertEquals(legacy.totals.unknownPricingCount, 1);
  const missing = reconcileLifecycleEvents([
    ledgerEvent({ result: "success", usage: "known", pricing: "known" }),
  ]).assignments[0]!;
  assertEquals(missing.totals.unknownUsageCount, 0);
  assertEquals(missing.totals.unknownPricingCount, 1);
});

Deno.test("lifecycle reconciliation groups original cohorts across assignments and rejects conflicts", () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const extra = [assignment, invocation(7)].map((event) =>
    buildLifecycleEvent({ ...event, assignmentId: id })
  );
  const result = reconcileLifecycleEvents([...scenarios[0]!.events, ...extra]);
  assertEquals(result.assignments.length, 2);
  assertEquals(result.cohorts[0]!.assignmentCount, 2);
  assertEquals(result.cohorts[0]!.successCount, 1);
  assertEquals(result.cohorts[0]!.totals.estimatedApiEquivalentUsd, 12);
  const conflicting = buildLifecycleEvent({
    ...assignment,
    kind: "assignment",
    assignedAt: "2026-10-01T00:00:00.000Z",
    cohort: "other",
    reused: true,
    treatment: { roles: [{ role: "manager", provider: "claude" }] },
    host: "host-2",
  });
  assertThrows(
    () => reconcileLifecycleEvents([assignment, conflicting]),
    Error,
    "Conflicting lifecycle cohorts",
  );
});

Deno.test("lifecycle reconciliation accounts for closed work and excludes costs beyond cutoff", () => {
  const events = [assignment, invocation(3), outcome(10, "closed_unmerged")];
  assertEquals(
    reconcileLifecycleEvents(events).assignments[0]!.totals
      .wastedEstimatedApiEquivalentUsd,
    3,
  );
  const late = buildLifecycleEvent({
    ...invocation(7, "late"),
    recordedAt: "2026-10-01T00:00:05.000Z",
  });
  assertEquals(
    reconcileLifecycleEvents([...events, late], "2026-10-01T00:00:04.000Z")
      .assignments[0]!.totals.estimatedApiEquivalentUsd,
    3,
  );
  const unknown = buildLifecycleEvent({
    kind: "follow_on",
    assignmentId: "unknown",
    runId: "worker-1",
    host: "host-1",
    repo: "org/repo",
    recordedAt: "2026-10-01T00:00:01.000Z",
    followOn: "ci_fix",
    attempt: 1,
  });
  const row = reconcileLifecycleEvents([unknown]).assignments[0]!;
  assertEquals(row.assignmentId, "unknown");
  assertEquals(
    row.byAttempt["unknown:ci_fix:worker-1:1"]!.estimatedApiEquivalentUsd,
    null,
  );
});

Deno.test("lifecycle reconciliation counts unknown records once when models share a role", () => {
  const tokens = {
    inputTokens: 1,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  const event = ledgerEvent({
    result: "success",
    usage: "known",
    pricing: "unknown",
    models: [
      {
        model: "a",
        role: "manager",
        tokens,
        pricing: "known",
        estimatedApiEquivalentUsd: 2,
      },
      {
        model: "b",
        role: "manager",
        tokens,
        pricing: "known",
        estimatedApiEquivalentUsd: 3,
      },
      { model: "c", role: "manager", tokens, pricing: "unknown" },
      { model: "d", role: "manager", tokens, pricing: "known" },
    ],
  });
  const row = reconcileLifecycleEvents([event]).assignments[0]!;
  assertEquals(row.totals.estimatedApiEquivalentUsd, 5);
  assertEquals(row.byRole.manager!.estimatedApiEquivalentUsd, 5);
  assertEquals(row.byRole.manager!.unknownPricingCount, 1);
  assertEquals(row.totals.unknownPricingCount, 1);
});

Deno.test("lifecycle reconciliation retains missing aggregate pricing with priced role detail", () => {
  const row = reconcileLifecycleEvents([ledgerEvent({
    result: "success",
    usage: "known",
    models: [{
      model: "known",
      role: "manager",
      tokens: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      pricing: "known",
      estimatedApiEquivalentUsd: 2,
    }],
  })]).assignments[0]!;
  assertEquals(row.totals.estimatedApiEquivalentUsd, 2);
  assertEquals(row.totals.unknownPricingCount, 1);
  assertEquals(row.totals.partial, true);
  assertEquals(row.byRole.manager!.partial, false);
});

Deno.test("lifecycle reconciliation assigns only abandoned sibling follow-on costs as wasted", () => {
  const row = reconcileLifecycleEvents(scenarios[1]!.events).assignments[0]!;
  assertEquals(row.totals.estimatedApiEquivalentUsd, 9);
  assertEquals(row.totals.wastedEstimatedApiEquivalentUsd, 4);
  assertEquals(row.byRole.manager!.wastedEstimatedApiEquivalentUsd, 0);
  assertEquals(row.byFollowOn.ci_fix!.wastedEstimatedApiEquivalentUsd, 4);
});
