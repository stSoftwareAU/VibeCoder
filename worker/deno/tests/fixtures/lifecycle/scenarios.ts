import {
  buildLifecycleEvent,
  type LifecycleEvent,
  type LifecycleEventInput,
} from "../../../lib/lifecycle_ledger.ts";

export const ASSIGNMENT = "11111111-1111-4111-8111-111111111111";
export function ledgerEvent(
  fields: Partial<LifecycleEventInput>,
): LifecycleEvent {
  return buildLifecycleEvent({
    kind: "invocation",
    assignmentId: ASSIGNMENT,
    runId: "run-1",
    host: "host-1",
    repo: "org/repo",
    issueNumber: 1,
    recordedAt: "2026-10-01T00:00:01.000Z",
    role: "manager",
    provider: "claude",
    attempt: 1,
    ...fields,
  } as LifecycleEventInput);
}
export const assignment = buildLifecycleEvent({
  kind: "assignment",
  assignmentId: ASSIGNMENT,
  runId: "run-1",
  host: "host-1",
  repo: "org/repo",
  issueNumber: 1,
  recordedAt: "2026-10-01T00:00:00.000Z",
  assignedAt: "2026-10-01T00:00:00.000Z",
  cohort: "control",
  reused: false,
  treatment: { roles: [{ role: "manager", provider: "claude" }] },
});
export function invocation(
  cost: number,
  runId = "run-1",
  result: "success" | "failure" | "timeout" = "success",
  role: "manager" | "executor" = "manager",
): LifecycleEvent {
  return ledgerEvent({
    runId,
    role,
    result,
    usage: "known",
    pricing: "known",
    estimatedApiEquivalentUsd: cost,
  });
}
export function outcome(
  prNumber: number,
  outcome: "pr_opened" | "merged" | "closed_unmerged",
): LifecycleEvent {
  return buildLifecycleEvent({
    kind: "outcome",
    assignmentId: ASSIGNMENT,
    runId: "run-1",
    host: "host-1",
    repo: "org/repo",
    issueNumber: 1,
    prNumber,
    outcome,
    recordedAt: outcome === "pr_opened"
      ? "2026-10-01T00:00:01.000Z"
      : "2026-10-01T00:00:04.000Z",
  });
}
export function gate(
  prNumber: number,
  gate: "quality" | "review",
): LifecycleEvent {
  return buildLifecycleEvent({
    kind: "gate",
    assignmentId: ASSIGNMENT,
    runId: "run-1",
    host: "host-1",
    repo: "org/repo",
    issueNumber: 1,
    prNumber,
    gate,
    result: "pass",
    attempt: prNumber,
    recordedAt: "2026-10-01T00:00:02.000Z",
  });
}
export function followOn(
  cost: number,
  prNumber: number,
  runId = "follow-1",
): LifecycleEvent {
  return buildLifecycleEvent({
    kind: "follow_on",
    assignmentId: ASSIGNMENT,
    runId,
    host: "host-1",
    repo: "org/repo",
    prNumber,
    followOn: "ci_fix",
    cycle: "cycle-1",
    attempt: 1,
    usage: "known",
    pricing: "known",
    estimatedApiEquivalentUsd: cost,
    recordedAt: "2026-10-01T00:00:02.000Z",
  });
}
const success = [
  assignment,
  invocation(2),
  invocation(3, "exec-1", "success", "executor"),
  outcome(10, "pr_opened"),
  gate(10, "quality"),
  gate(10, "review"),
  outcome(10, "merged"),
];
export const scenarios: {
  name: string;
  events: LifecycleEvent[];
  total: number;
  wasted: number;
  roles: Record<string, number>;
  state: string;
  success: boolean;
  cutoff?: string;
}[] = [
  {
    name: "success",
    events: success,
    total: 5,
    wasted: 0,
    roles: { manager: 2, executor: 3 },
    state: "merged",
    success: true,
  },
  {
    name: "multi-PR issue",
    events: [
      ...success,
      outcome(11, "pr_opened"),
      outcome(11, "closed_unmerged"),
      followOn(4, 11),
    ],
    total: 9,
    wasted: 4,
    roles: { manager: 2, executor: 3, "follow-on (unattributed)": 4 },
    state: "merged",
    success: true,
  },
  {
    name: "failure",
    events: [
      assignment,
      invocation(2, "failed", "failure"),
      invocation(3, "timed-out", "timeout", "executor"),
    ],
    total: 5,
    wasted: 5,
    roles: { manager: 2, executor: 3 },
    state: "pending",
    success: false,
  },
  {
    name: "retry",
    events: [
      ...success,
      invocation(7, "failed", "failure"),
      invocation(11, "timed-out", "timeout"),
    ],
    total: 23,
    wasted: 18,
    roles: { manager: 20, executor: 3 },
    state: "merged",
    success: true,
  },
  {
    name: "open PR at cutoff",
    events: [assignment, invocation(2), outcome(10, "pr_opened")],
    total: 2,
    wasted: 0,
    roles: { manager: 2 },
    state: "censored_at_cutoff",
    success: false,
    cutoff: "2026-10-01T00:00:03.000Z",
  },
  {
    name: "restart",
    events: [...success, ...success],
    total: 5,
    wasted: 0,
    roles: { manager: 2, executor: 3 },
    state: "merged",
    success: true,
  },
];
