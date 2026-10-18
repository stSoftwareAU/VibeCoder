import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildLifecycleEvent,
  type LifecycleEvent,
} from "../lib/lifecycle_ledger.ts";
import {
  assignment,
  followOn,
  gate,
  invocation,
  outcome,
} from "./fixtures/lifecycle/scenarios.ts";
import {
  buildStabilisationReport,
  type StabilisationEvidence,
} from "../lib/stabilisation_report.ts";

async function successfulCli(args: string[], prefix = "{"): Promise<string> {
  const { stabilisationReportCli } = await import(
    "../lib/stabilisation_report_cli.ts"
  );
  const result = (await Promise.allSettled([stabilisationReportCli(args)]))[0]!;
  assertEquals(
    result.status,
    "fulfilled",
    "valid evidence must produce a report without throwing",
  );
  assert(result.status === "fulfilled");
  assert(
    result.value.trim().startsWith(prefix),
    "CLI emits the requested format",
  );
  return result.value;
}

function evidence(): StabilisationEvidence {
  return {
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-10-02T00:00:00.000Z",
    source: "synthetic fixture, not deployed fleet evidence",
    historyComplete: true,
    missing: [],
    deliveries: [{
      repo: "org/repo",
      issueNumber: 1,
      prNumber: 10,
      accepted: true,
      baseBranch: "main",
      defaultBranch: "main",
      mergedAt: "2026-10-01T00:00:04.000Z",
    }],
    rootCauses: [],
    safeguards: [],
  };
}
const delivered = [
  assignment,
  invocation(2),
  gate(10, "quality"),
  gate(10, "review"),
  outcome(10, "merged"),
];
function forIssue(
  events: LifecycleEvent[],
  issueNumber: number,
): LifecycleEvent[] {
  return events.map((event) =>
    buildLifecycleEvent({
      ...event,
      issueNumber,
      assignmentId: `11111111-1111-4111-8111-${
        String(issueNumber).padStart(12, "0")
      }`,
    })
  );
}

Deno.test("stabilisation counts unique accepted default deliveries and full rework once (Issue #3980)", () => {
  const retry = invocation(3, "retry", "failure");
  const fix = followOn(4, 10);
  const rows = [...delivered, retry, fix, ...delivered, fix];
  const observations = evidence();
  observations.deliveries.push({
    ...observations.deliveries[0]!,
    prNumber: 11,
  });
  rows.push(gate(11, "quality"), gate(11, "review"), outcome(11, "merged"));
  let failure: unknown;
  const report = (() => {
    try {
      return buildStabilisationReport(rows, observations);
    } catch (error) {
      failure = error;
      return undefined;
    }
  })();
  assertEquals(failure, undefined, "valid ledger observations do not throw");
  assert(report);
  assertEquals(report.deployments.length, 1);
  assertEquals(report.deployments[0]!.host, "host-1");
  assertEquals(report.deliveredIssues, 1);
  assertEquals(report.issues.length, 1);
  assertEquals(report.spend.estimatedApiEquivalentUsd, 9);
  assertEquals(report.estimatedApiEquivalentUsdPerDeliveredIssue, 9);
  assertEquals(report.issues[0]!.deliverySeconds, 4);
  assertEquals(report.calls, 2);
  assertEquals(report.followOns.ci_fix, 1);
  assertEquals(report.failedInvocations, 1);
  assertEquals(report.firstPass.quality, { passed: 1, failed: 0, unknown: 0 });
  assertEquals(report.firstPass.review, { passed: 1, failed: 0, unknown: 0 });
  assertEquals(report.blockingReviewHeads, 0);
  assertEquals(report.blockingReviewRounds, null);
  assertEquals(report.failureRate, null);
  assertEquals(report.comparativeWinner, null);
});

Deno.test("stabilisation retains failed, pending, milestone and missing delivery evidence (Issue #3980)", () => {
  const observations = evidence();
  observations.deliveries[0]!.baseBranch = "milestone/stabilisation";
  const pending = forIssue([assignment, invocation(5)], 2);
  const failed = forIssue([
    assignment,
    invocation(7, "failed", "failure"),
    outcome(20, "closed_unmerged"),
  ], 3);
  const unknown = forIssue(delivered, 4);
  const report = buildStabilisationReport([
    ...delivered,
    ...pending,
    ...failed,
    ...unknown,
  ], observations);
  assertEquals(report.deliveredIssues, 0);
  assertEquals(report.issues.map((row) => row.state), [
    "milestone_only",
    "pending",
    "failed",
    "missing_evidence",
  ]);
  assertEquals(report.spend.estimatedApiEquivalentUsd, 16);
  assertEquals(report.estimatedApiEquivalentUsdPerDeliveredIssue, null);
  assert(report.missing.some((note) => note.includes("target")));
  observations.deliveries.push({
    ...observations.deliveries[0]!,
    prNumber: 12,
    baseBranch: "main",
  });
  const followup = buildStabilisationReport([
    ...delivered,
    gate(12, "quality"),
    gate(12, "review"),
    outcome(12, "merged"),
  ], observations);
  assertEquals(followup.deliveredIssues, 1);
  assertEquals(followup.issues[0]!.state, "delivered");
  assertEquals(followup.spend.estimatedApiEquivalentUsd, 2);
});

Deno.test("stabilisation preserves unknown spend, missing build roles and unattributed calls (Issue #3980)", () => {
  const known = invocation(2);
  assert(known.kind === "invocation");
  const unknown = buildLifecycleEvent({
    ...known,
    runId: "missing",
    usage: "unknown",
    pricing: "unknown",
    estimatedApiEquivalentUsd: undefined,
  });
  const unattributed = buildLifecycleEvent({
    ...unknown,
    assignmentId: "unknown",
    issueNumber: undefined,
    runId: "unattributed",
  });
  const report = buildStabilisationReport(
    [...delivered, unknown, unattributed],
    evidence(),
  );
  assertEquals(report.spend.partial, true);
  assertEquals(report.spend.estimatedApiEquivalentUsd, 2);
  assertEquals(report.estimatedApiEquivalentUsdPerDeliveredIssue, null);
  assertEquals(report.unattributedCalls, 1);
  assertEquals(report.deployments[0]!.workerCommit, null);
  assertEquals(report.deployments[0]!.roles[0]!.model, null);
  assert(report.missing.some((note) => note.includes("build")));
  const none = buildStabilisationReport([assignment, unknown], evidence());
  assertEquals(none.spend.estimatedApiEquivalentUsd, null);
  assertEquals(
    none.deliveredIssues,
    0,
    "a snapshot cannot fabricate an unobserved merge",
  );
});

Deno.test("stabilisation bounds the window, retains earlier rework and censors later delivery (Issue #3980)", () => {
  const observations = evidence();
  observations.start = "2026-10-01T00:00:02.000Z";
  observations.end = "2026-10-01T00:00:03.000Z";
  const report = buildStabilisationReport(delivered, observations);
  assertEquals(report.deliveredIssues, 0);
  assertEquals(
    report.spend.estimatedApiEquivalentUsd,
    2,
    "active issue retains observed pre-window attempt costs",
  );
  assertEquals(report.issues[0]!.state, "pending");
  assertEquals(
    buildStabilisationReport(delivered, {
      ...observations,
      start: "2026-10-02T00:00:00.000Z",
      end: "2026-10-03T00:00:00.000Z",
    }).issues,
    [],
  );
  for (
    const bounds of [{ start: "invalid" }, { end: "invalid" }, {
      end: "2026-09-01T00:00:00.000Z",
    }]
  ) {
    assertThrows(
      () => buildStabilisationReport(delivered, { ...evidence(), ...bounds }),
      Error,
      "window",
    );
  }
});

Deno.test("stabilisation requires accepted scope, matching merge and gated delivery (Issue #3980)", () => {
  for (
    const changed of [{ accepted: false }, { prNumber: 99 }, {
      mergedAt: "2026-10-01T00:00:05.000Z",
    }, { defaultBranch: "develop" }]
  ) {
    const observations = evidence();
    Object.assign(observations.deliveries[0]!, changed);
    assertEquals(
      buildStabilisationReport(delivered, observations).deliveredIssues,
      0,
      JSON.stringify(changed),
    );
  }
  assertEquals(
    buildStabilisationReport(
      delivered.filter((event) =>
        !(event.kind === "gate" && event.gate === "review")
      ),
      evidence(),
    ).deliveredIssues,
    0,
  );
  const observations = evidence();
  observations.historyComplete = false;
  const report = buildStabilisationReport(delivered, observations);
  assertEquals(report.deliveredIssues, 1);
  assertEquals(report.estimatedApiEquivalentUsdPerDeliveredIssue, null);
  assertEquals(report.issues[0]!.deliverySeconds, null);
});

Deno.test("stabilisation preserves observed categories and labels synthetic safeguards without a benefit claim (Issue #3980)", () => {
  const failed = invocation(3, "failed", "failure");
  const observations = evidence();
  observations.rootCauses = [{
    eventKey: failed.eventKey,
    category: "summary_incomplete",
    processGenerated: true,
  }, {
    eventKey: failed.eventKey,
    category: "summary_incomplete",
    processGenerated: true,
  }];
  observations.safeguards = [{
    id: "identical-sync",
    source: "observed",
    failuresPrevented: 0,
    extraChecks: 8,
    extraModelCalls: 0,
    extraSeconds: 2,
    residualRecurrence: 0,
  }, {
    id: "already-landed",
    source: "synthetic",
    failuresPrevented: 1,
    extraChecks: 1,
    extraModelCalls: 0,
    extraSeconds: null,
    residualRecurrence: null,
  }];
  const report = buildStabilisationReport([...delivered, failed], observations);
  assertEquals(report.rootCauses, [{
    category: "summary_incomplete",
    count: 1,
    processGenerated: 1,
  }]);
  assertEquals(report.safeguards[0]!.observedBenefit, "none_observed");
  assertEquals(report.safeguards[0]!.netBenefit, "unknown");
  assertEquals(report.safeguards[1]!.source, "synthetic");
  assertEquals(report.safeguards[1]!.observedBenefit, "not_live_evidence");
  assertEquals(report.comparativeWinner, null);
});

Deno.test("stabilisation joins a CI follow-on's assignment before selecting its active issue (Issue #3980)", () => {
  const observations = evidence();
  observations.start = "2026-10-01T00:00:01.500Z";
  const report = buildStabilisationReport([
    assignment,
    invocation(2),
    followOn(4, 10),
  ], observations);
  assertEquals(report.issues.length, 1);
  assertEquals(report.issues[0]!.issueNumber, 1);
  assertEquals(report.spend.estimatedApiEquivalentUsd, 6);
  assertEquals(report.unattributedCalls, 0);
});

Deno.test("stabilisation links a tracking-issue default roll-up to accepted child work (Issue #3980)", () => {
  const observations = evidence();
  observations.deliveries[0]!.baseBranch = "milestone/stabilisation";
  observations.deliveries.push({
    ...observations.deliveries[0]!,
    prNumber: 12,
    baseBranch: "main",
  });
  const rollup = forIssue([
    gate(12, "quality"),
    gate(12, "review"),
    outcome(12, "merged"),
  ], 99);
  const report = buildStabilisationReport(
    [...delivered, ...rollup],
    observations,
  );
  assertEquals(report.deliveredIssues, 1);
  assertEquals(
    report.issues.find((row) => row.issueNumber === 1)!.state,
    "delivered",
  );
  assertEquals(report.spend.estimatedApiEquivalentUsd, 2);
});

Deno.test("stabilisation retains simultaneous declared causes and ignores pending gate polls (Issue #3980)", () => {
  const failed = invocation(3, "failed", "failure");
  const observations = evidence();
  observations.rootCauses = [{
    eventKey: failed.eventKey,
    category: "summary_incomplete",
    processGenerated: true,
  }, {
    eventKey: failed.eventKey,
    category: "quality_check",
    processGenerated: false,
  }];
  const quality = gate(10, "quality");
  assert(quality.kind === "gate");
  const pending = buildLifecycleEvent({
    ...quality,
    result: "skipped",
    attempt: 99,
    recordedAt: "2026-10-01T00:00:01.500Z",
  });
  const report = buildStabilisationReport(
    [...delivered, failed, pending],
    observations,
  );
  assertEquals(report.rootCauses, [{
    category: "quality_check",
    count: 1,
    processGenerated: 0,
  }, { category: "summary_incomplete", count: 1, processGenerated: 1 }]);
  assertEquals(report.firstPass.quality, { passed: 1, failed: 0, unknown: 0 });
});

Deno.test("stabilisation keeps retried work pending while retaining its earlier failed spend (Issue #3980)", () => {
  const closed = outcome(10, "closed_unmerged");
  const reopened = buildLifecycleEvent({
    ...outcome(11, "pr_opened"),
    recordedAt: "2026-10-01T00:00:05.000Z",
  });
  const report = buildStabilisationReport([
    assignment,
    invocation(3, "first", "failure"),
    closed,
    reopened,
  ], evidence());
  assertEquals(report.issues[0]!.state, "pending");
  assertEquals(report.spend.estimatedApiEquivalentUsd, 3);
});

Deno.test("stabilisation includes old child history when only its tracking roll-up delivers in-window (Issue #3980)", () => {
  const observations = evidence();
  observations.start = "2026-10-01T00:00:05.000Z";
  observations.deliveries[0]!.baseBranch = "milestone/stabilisation";
  observations.deliveries.push({
    ...observations.deliveries[0]!,
    prNumber: 12,
    baseBranch: "main",
    mergedAt: "2026-10-01T00:00:10.000Z",
  });
  const rollup = forIssue([
    gate(12, "quality"),
    gate(12, "review"),
    buildLifecycleEvent({
      ...outcome(12, "merged"),
      recordedAt: "2026-10-01T00:00:10.000Z",
    }),
  ], 99);
  const report = buildStabilisationReport(
    [...delivered, ...rollup],
    observations,
  );
  assertEquals(report.deliveredIssues, 1);
  assertEquals(
    report.issues.find((row) => row.issueNumber === 1)!.spend
      .estimatedApiEquivalentUsd,
    2,
  );
  assertEquals(
    report.issues.find((row) => row.issueNumber === 1)!.deliverySeconds,
    10,
  );
});

Deno.test("stabilisation CLI reads real ledger files and refuses corrupt or misleading evidence (Issue #3980)", async () => {
  const { stabilisationReportCli } = await import(
    "../lib/stabilisation_report_cli.ts"
  );
  const root = await Deno.makeTempDir();
  try {
    const snapshot = `${root}/evidence.json`, ledger = `${root}/ledger.jsonl`;
    await Deno.writeTextFile(snapshot, JSON.stringify(evidence()));
    await Deno.writeTextFile(
      ledger,
      delivered.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    const result = JSON.parse(
      await successfulCli(["--evidence", snapshot, ledger, ledger]),
    );
    assertEquals(result.deliveredIssues, 1);
    assertEquals(result.spend.estimatedApiEquivalentUsd, 2);
    const { assertRejects } = await import("@std/assert");
    await assertRejects(() => stabilisationReportCli([]), Error, "Supply");
    assert((await successfulCli(["--help"], "Usage:")).startsWith("Usage:"));
    for (
      const args of [
        ["--wrong", snapshot, ledger],
        ["--evidence", "", ledger],
        ["--evidence", snapshot],
      ]
    ) {
      await assertRejects(() => stabilisationReportCli(args), Error, "Supply");
    }
    await Deno.writeTextFile(
      snapshot,
      JSON.stringify({
        ...evidence(),
        safeguards: [{
          id: "unknown",
          source: "observed",
          failuresPrevented: null,
          extraChecks: null,
          extraModelCalls: null,
          extraSeconds: null,
          residualRecurrence: null,
        }],
      }),
    );
    assertEquals(
      JSON.parse(await successfulCli(["--evidence", snapshot, ledger]))
        .safeguards[0].observedBenefit,
      "unknown",
    );
    for (const field of ["historyComplete", "accepted", "processGenerated"]) {
      const invalid: Record<string, unknown> = { ...evidence() };
      if (field === "historyComplete") invalid.historyComplete = "false";
      if (field === "accepted") {
        invalid.deliveries = [{
          ...evidence().deliveries[0],
          accepted: "false",
        }];
      }
      if (field === "processGenerated") {
        invalid.rootCauses = [{
          eventKey: "x",
          category: "quality_check",
          processGenerated: "false",
        }];
      }
      await Deno.writeTextFile(snapshot, JSON.stringify(invalid));
      await assertRejects(
        () => stabilisationReportCli(["--evidence", snapshot, ledger]),
        Error,
        `field ${field}`,
      );
    }
    for (const value of [-1, "unknown"]) {
      await Deno.writeTextFile(
        snapshot,
        JSON.stringify({
          ...evidence(),
          safeguards: [{ id: "test", source: "observed", extraSeconds: value }],
        }),
      );
      await assertRejects(
        () => stabilisationReportCli(["--evidence", snapshot, ledger]),
        Error,
        "field extraSeconds",
      );
    }
    await Deno.writeTextFile(snapshot, JSON.stringify(evidence()));
    await Deno.writeTextFile(ledger, "bad json\n");
    await assertRejects(
      () => stabilisationReportCli(["--evidence", snapshot, ledger]),
      Error,
      "line 1",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("stabilisation CLI refuses unknown safeguard provenance and keeps absent observations unknown (Issue #3980)", async () => {
  const { stabilisationReportCli } = await import(
    "../lib/stabilisation_report_cli.ts"
  );
  const { assertRejects } = await import("@std/assert");
  const root = await Deno.makeTempDir();
  try {
    const snapshot = `${root}/evidence.json`, ledger = `${root}/ledger.jsonl`;
    await Deno.writeTextFile(ledger, "");
    for (
      const safeguard of [{ id: "incomplete" }, {
        id: "synthetic",
        source: "synthetic-fixture",
        failuresPrevented: 1,
      }]
    ) {
      await Deno.writeTextFile(
        snapshot,
        JSON.stringify({ ...evidence(), safeguards: [safeguard] }),
      );
      await assertRejects(
        () => stabilisationReportCli(["--evidence", snapshot, ledger]),
        Error,
        "safeguard source",
      );
    }
    await Deno.writeTextFile(
      snapshot,
      JSON.stringify({
        ...evidence(),
        safeguards: [{ id: "incomplete", source: "observed" }],
      }),
    );
    const report = JSON.parse(
      await successfulCli(["--evidence", snapshot, ledger]),
    );
    assertEquals(report.safeguards[0].observedBenefit, "unknown");
    assertEquals(report.safeguards[0].failuresPrevented, null);
    assertEquals(report.safeguards[0].extraSeconds, null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("stabilisation treats missing target names as unknown and compares merge instants (Issue #3980)", () => {
  for (
    const change of [
      { baseBranch: undefined, defaultBranch: undefined },
      { baseBranch: "", defaultBranch: "" },
      { baseBranch: "" },
      { defaultBranch: "" },
      { baseBranch: undefined },
      { defaultBranch: undefined },
    ]
  ) {
    const observations = evidence();
    Object.assign(observations.deliveries[0]!, change);
    let failure: unknown;
    const report = (() => {
      try {
        return buildStabilisationReport(delivered, observations);
      } catch (error) {
        failure = error;
        return undefined;
      }
    })();
    assertEquals(
      failure,
      undefined,
      "missing target evidence stays unknown without throwing",
    );
    assert(report);
    assertEquals(report.deliveredIssues, 0);
    assertEquals(report.issues[0]!.state, "missing_evidence");
  }
  const observations = evidence();
  observations.deliveries[0]!.mergedAt = "2026-10-01T00:00:04Z";
  assertEquals(
    buildStabilisationReport(delivered, observations).deliveredIssues,
    1,
  );
});

Deno.test("stabilisation retains old child cost when its tracking receipt has unknown targets (Issue #3980)", () => {
  const observations = evidence();
  observations.start = "2026-10-01T00:00:05.000Z";
  observations.deliveries = [
    {
      ...observations.deliveries[0]!,
      prNumber: 12,
      mergedAt: "2026-10-01T00:00:10Z",
      baseBranch: undefined,
      defaultBranch: undefined,
    } as unknown as StabilisationEvidence["deliveries"][number],
  ];
  const rollup = forIssue([
    gate(12, "quality"),
    gate(12, "review"),
    buildLifecycleEvent({
      ...outcome(12, "merged"),
      recordedAt: "2026-10-01T00:00:10.000Z",
    }),
  ], 99);
  const report = buildStabilisationReport(
    [...delivered, ...rollup],
    observations,
  );
  assertEquals(report.deliveredIssues, 0);
  assertEquals(
    report.issues.find((row) => row.issueNumber === 1)!.state,
    "missing_evidence",
  );
  assertEquals(report.spend.estimatedApiEquivalentUsd, 2);
});

Deno.test("stabilisation first-pass decisions retain chronology, failures and blocking-head dedup (Issue #3980)", () => {
  const quality = gate(10, "quality");
  assert(quality.kind === "gate");
  const failed = buildLifecycleEvent({
    ...quality,
    result: "fail",
    attempt: 2,
    recordedAt: "2026-10-01T00:00:03.000Z",
  });
  const rejected = gate(10, "review");
  assert(rejected.kind === "gate");
  const rejection = buildLifecycleEvent({
    ...rejected,
    result: "fail",
    attempt: 3,
  });
  assert(rejection.kind === "gate");
  const repeat = buildLifecycleEvent({
    ...rejection,
    attempt: 4,
    recordedAt: "2026-10-01T00:00:03.000Z",
  });
  const report = buildStabilisationReport([
    assignment,
    failed,
    quality,
    rejection,
    repeat,
  ], evidence());
  assertEquals(report.firstPass.quality, { passed: 1, failed: 0, unknown: 0 });
  assertEquals(report.firstPass.review, { passed: 0, failed: 1, unknown: 0 });
  assertEquals(report.blockingReviewHeads, 1);
  const tied = buildLifecycleEvent({ ...quality, result: "fail", attempt: 99 });
  assertEquals(
    buildStabilisationReport([assignment, quality, tied], evidence()).firstPass
      .quality,
    { passed: 0, failed: 1, unknown: 0 },
  );
});

Deno.test("stabilisation reports actual treatment, every role and known zero separately from unknown spend (Issue #3980)", () => {
  const roles = [{
    role: "manager" as const,
    provider: "claude",
    model: "sonnet",
    effort: "high",
  }, {
    role: "executor" as const,
    provider: "claude",
    model: "haiku",
    effort: "low",
  }, {
    role: "reviewer" as const,
    provider: "claude",
    model: "opus",
    effort: "xhigh",
  }];
  assert(assignment.kind === "assignment");
  const recorded = buildLifecycleEvent({
    ...assignment,
    treatment: { roles, workerCommit: "a".repeat(40), workerVersion: "1.0.0" },
  });
  const manager = invocation(2);
  assert(manager.kind === "invocation");
  const worker = buildLifecycleEvent({
    ...manager,
    role: "executor",
    estimatedApiEquivalentUsd: 3,
  });
  const reviewer = buildLifecycleEvent({
    ...manager,
    role: "reviewer",
    estimatedApiEquivalentUsd: 4,
  });
  const report = buildStabilisationReport(
    [recorded, manager, worker, reviewer],
    evidence(),
  );
  assertEquals(report.deployments, [{
    host: "host-1",
    workerCommit: "a".repeat(40),
    workerVersion: "1.0.0",
    roles,
  }]);
  assertEquals(report.attempts, 1);
  assertEquals(report.calls, 3);
  assertEquals(report.spend.estimatedApiEquivalentUsd, 9);
  assertEquals(
    Object.fromEntries(
      Object.entries(report.spendByRole).map((
        [role, row],
      ) => [role, row.estimatedApiEquivalentUsd]),
    ),
    { manager: 2, executor: 3, reviewer: 4 },
  );
  assertEquals(
    report.missing.some((note) => note.includes("Deployed worker build")),
    false,
  );
  const zero = buildStabilisationReport(
    [assignment, invocation(0)],
    evidence(),
  );
  assertEquals(zero.spend.estimatedApiEquivalentUsd, 0);
  assertEquals(zero.spend.partial, false);
  assertEquals(zero.spend.wastedEstimatedApiEquivalentUsd, 0);
  assertEquals(zero.deployments[0]!.workerVersion, null);
  assertEquals(zero.deployments[0]!.roles, [
    { role: "manager", provider: "claude", model: null, effort: null },
    { role: "executor", provider: null, model: null, effort: null },
    { role: "reviewer", provider: null, model: null, effort: null },
  ]);
});

Deno.test("stabilisation CLI entry point emits JSON and a nonzero malformed-input exit (Issue #3980)", async () => {
  const root = await Deno.makeTempDir();
  try {
    const snapshot = `${root}/evidence.json`, ledger = `${root}/ledger.jsonl`;
    await Deno.writeTextFile(snapshot, JSON.stringify(evidence()));
    await Deno.writeTextFile(
      ledger,
      delivered.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    const entry =
      new URL("../lib/stabilisation_report_cli.ts", import.meta.url).pathname;
    const run = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        "--allow-read",
        entry,
        "--evidence",
        snapshot,
        ledger,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(run.code, 0, new TextDecoder().decode(run.stderr));
    assert(
      new TextDecoder().decode(run.stdout).trim().startsWith("{"),
      "entry point emits a JSON report object",
    );
    assertEquals(
      JSON.parse(new TextDecoder().decode(run.stdout)).deliveredIssues,
      1,
    );
    const bad = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        "--allow-read",
        entry,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(bad.code, 1);
    assert(new TextDecoder().decode(bad.stderr).includes("Supply --evidence"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("stabilisation preserves unknown wasted spend and known lower bounds independently (Issue #3980)", () => {
  const failed = invocation(2, "unknown-failure", "failure");
  assert(failed.kind === "invocation");
  const unknown = buildLifecycleEvent({
    ...failed,
    usage: "unknown",
    pricing: "unknown",
    estimatedApiEquivalentUsd: undefined,
  });
  const partial = buildStabilisationReport(
    [assignment, invocation(3), unknown],
    evidence(),
  );
  assertEquals(partial.spend.wastedPartial, true);
  assertEquals(partial.spend.wastedEstimatedApiEquivalentUsd, null);
  const lowerBound = buildStabilisationReport([
    assignment,
    unknown,
    invocation(4, "known-failure", "failure"),
  ], evidence());
  assertEquals(lowerBound.spend.wastedPartial, true);
  assertEquals(lowerBound.spend.wastedEstimatedApiEquivalentUsd, 4);
  const incomplete = buildStabilisationReport([assignment, invocation(3)], {
    ...evidence(),
    historyComplete: false,
  });
  assertEquals(incomplete.spend.wastedPartial, true);
  assertEquals(incomplete.spend.wastedEstimatedApiEquivalentUsd, null);
  assert(
    incomplete.missing.some((note) => note.includes("history/host coverage")),
  );
});

Deno.test("stabilisation receipts require the same repository and PR before retaining old child cost (Issue #3980)", () => {
  for (const change of [{ repo: "other/repo" }, { prNumber: 99 }]) {
    const observations = evidence();
    observations.start = "2026-10-01T00:00:05Z";
    observations.deliveries = [{
      ...observations.deliveries[0]!,
      prNumber: 12,
      mergedAt: "2026-10-01T00:00:10Z",
    }];
    const unrelatedMerge = buildLifecycleEvent({
      ...outcome(12, "merged"),
      issueNumber: 99,
      recordedAt: "2026-10-01T00:00:10Z",
      ...change,
    });
    const report = buildStabilisationReport([
      assignment,
      invocation(2),
      unrelatedMerge,
    ], observations);
    assertEquals(
      report.issues.some((row) => row.issueNumber === 1),
      false,
      JSON.stringify(change),
    );
    assertEquals(report.spend.estimatedApiEquivalentUsd, 0);
  }
});

Deno.test("stabilisation keeps repository delivery identities separate and does not borrow another PR's proof (Issue #3980)", () => {
  const foreign = delivered.map((event) =>
    buildLifecycleEvent({
      ...event,
      repo: "other/repo",
      assignmentId: "33333333-3333-4333-8333-333333333333",
    })
  );
  const separate = buildStabilisationReport(
    [...delivered, ...foreign],
    evidence(),
  );
  assertEquals(separate.deliveredIssues, 1);
  assertEquals(
    separate.issues.find((row) => row.repo === "other/repo")!.state,
    "missing_evidence",
  );
  for (
    const other of [foreign, [
      gate(11, "quality"),
      gate(11, "review"),
      outcome(11, "merged"),
    ]]
  ) {
    const ownMergeWithoutGates = [
      assignment,
      invocation(2),
      outcome(10, "merged"),
    ];
    const report = buildStabilisationReport(
      [...ownMergeWithoutGates, ...other],
      evidence(),
    );
    assertEquals(
      report.deliveredIssues,
      0,
      "unrelated successful PR cannot supply missing pre-merge gates",
    );
    assertEquals(
      report.issues.find((row) => row.repo === "org/repo")!.state,
      "missing_evidence",
    );
  }
});

Deno.test("stabilisation keeps a pre-window delivery outside the delivery denominator (Issue #3980)", () => {
  const observations = evidence();
  observations.start = "2026-10-01T00:00:05Z";
  const later = buildLifecycleEvent({
    ...invocation(3, "later"),
    recordedAt: "2026-10-01T00:00:06Z",
  });
  const report = buildStabilisationReport([...delivered, later], observations);
  assertEquals(report.deliveredIssues, 0);
  assertEquals(report.issues[0]!.state, "missing_evidence");
  assertEquals(report.spend.estimatedApiEquivalentUsd, 5);
});

Deno.test("stabilisation distinguishes terminal failure from each observed way of resuming work (Issue #3980)", () => {
  assert(assignment.kind === "assignment");
  const terminalOutcome = outcome(10, "closed_unmerged");
  assert(terminalOutcome.kind === "outcome");
  const failed = buildLifecycleEvent({
    ...terminalOutcome,
    prNumber: undefined,
    outcome: "failed",
  });
  assertEquals(
    buildStabilisationReport([assignment, failed], evidence()).issues[0]!.state,
    "failed",
  );
  const resumed = [
    buildLifecycleEvent({
      ...assignment,
      assignmentId: "22222222-2222-4222-8222-222222222222",
      assignedAt: "2026-10-01T00:00:05Z",
      recordedAt: "2026-10-01T00:00:05Z",
    }),
    buildLifecycleEvent({
      ...invocation(3, "resumed"),
      recordedAt: "2026-10-01T00:00:05Z",
    }),
    buildLifecycleEvent({
      ...outcome(10, "pr_opened"),
      recordedAt: "2026-10-01T00:00:05Z",
    }),
  ];
  for (const observation of resumed) {
    // Reopening the same closed PR is a resume too; the old close must not win.
    const terminal = observation.kind === "outcome"
      ? outcome(10, "closed_unmerged")
      : failed;
    assertEquals(
      buildStabilisationReport([assignment, terminal, observation], evidence())
        .issues[0]!.state,
      "pending",
      observation.kind,
    );
  }
  const quality = gate(10, "quality");
  assert(quality.kind === "gate");
  const gateOnly = buildLifecycleEvent({
    ...quality,
    prNumber: undefined,
  });
  assertEquals(
    buildStabilisationReport([gateOnly], evidence()).issues[0]!.state,
    "pending",
    "no failure observation is not a terminal failure",
  );
});

Deno.test("stabilisation reports a child receipt without local merge or target evidence as missing (Issue #3980)", () => {
  const observations = evidence();
  observations.start = "2026-10-01T00:00:05Z";
  observations.deliveries = [{
    ...observations.deliveries[0]!,
    prNumber: 12,
    mergedAt: "2026-10-01T00:00:10Z",
    baseBranch: "",
    defaultBranch: "",
  }];
  const rollup = buildLifecycleEvent({
    ...outcome(12, "merged"),
    issueNumber: 99,
    recordedAt: "2026-10-01T00:00:10Z",
  });
  const report = buildStabilisationReport(
    [assignment, invocation(2), rollup],
    observations,
  );
  assertEquals(
    report.issues.find((row) => row.issueNumber === 1)!.state,
    "missing_evidence",
  );
  assertEquals(report.spend.estimatedApiEquivalentUsd, 2);
});

Deno.test("stabilisation cannot manufacture elapsed time from an assignment after the merge (Issue #3980)", () => {
  assert(assignment.kind === "assignment");
  const laterAssignment = buildLifecycleEvent({
    ...assignment,
    recordedAt: "2026-10-01T00:00:05Z",
    assignedAt: "2026-10-01T00:00:05Z",
  });
  assertEquals(
    buildStabilisationReport(
      [laterAssignment, ...delivered.slice(1)],
      evidence(),
    ).issues[0]!.deliverySeconds,
    null,
  );
  assertEquals(
    buildStabilisationReport(delivered.slice(1), evidence()).issues[0]!
      .deliverySeconds,
    null,
  );
});

Deno.test("stabilisation root-cause coverage follows exact observed failed-event identities (Issue #3980)", () => {
  const failed = invocation(3, "failed", "failure");
  const observations = evidence();
  const cause = {
    eventKey: failed.eventKey,
    category: "infrastructure",
    processGenerated: false,
  };
  observations.rootCauses = [{ ...cause, eventKey: "unobserved" }];
  const missing = buildStabilisationReport([assignment, failed], observations);
  assertEquals(missing.rootCauses, []);
  assert(missing.missing.some((note) => note.includes("root-cause")));
  observations.rootCauses = [cause];
  const covered = buildStabilisationReport([assignment, failed], observations);
  assertEquals(
    covered.missing.some((note) => note.includes("root-cause")),
    false,
  );
  const success = buildStabilisationReport(
    [assignment, invocation(2)],
    evidence(),
  );
  assertEquals(
    success.missing.some((note) => note.includes("root-cause")),
    false,
  );
});

Deno.test("stabilisation warns independently about absent builds and incomplete effective roles (Issue #3980)", () => {
  const missingBuild = (rows: LifecycleEvent[]) =>
    buildStabilisationReport(rows, evidence()).missing.some((note) =>
      note.includes("Deployed worker build")
    );
  assertEquals(missingBuild([invocation(2)]), true);
  assert(assignment.kind === "assignment");
  const roles = ["manager", "executor", "reviewer"].map((role) => ({
    role: role as "manager" | "executor" | "reviewer",
    provider: "claude",
    model: "recorded-model",
  }));
  const noCommit = buildLifecycleEvent({ ...assignment, treatment: { roles } });
  assertEquals(missingBuild([noCommit, invocation(2)]), true);
  const incompleteRoles = buildLifecycleEvent({
    ...assignment,
    treatment: { workerCommit: "b".repeat(40), roles: roles.slice(0, 2) },
  });
  assertEquals(missingBuild([incompleteRoles, invocation(2)]), true);
});

Deno.test("stabilisation separates a failed quality gate from a blocking review and observed prevention from net benefit (Issue #3980)", () => {
  const quality = gate(10, "quality");
  assert(quality.kind === "gate");
  const report = buildStabilisationReport([
    assignment,
    buildLifecycleEvent({ ...quality, result: "fail" }),
    gate(10, "review"),
  ], {
    ...evidence(),
    safeguards: [{
      id: "observed",
      source: "observed",
      failuresPrevented: 2,
      extraChecks: 2,
      extraModelCalls: 0,
      extraSeconds: 1,
      residualRecurrence: 0,
    }],
  });
  assertEquals(report.blockingReviewHeads, 0);
  assertEquals(report.safeguards[0]!.observedBenefit, "observed_preventions");
  assertEquals(report.safeguards[0]!.netBenefit, "unknown");
});
