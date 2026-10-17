/** Pure assignment/PR outcome classification, including cohort censoring. */
import type { GateEvent, LifecycleEvent } from "./lifecycle_ledger.ts";

export type LifecycleOutcomeState =
  | "pr_opened"
  | "quality_green"
  | "review_approved"
  | "merged"
  | "closed_unmerged"
  | "pending"
  | "censored_at_cutoff";

export interface PrLifecycleOutcome {
  repo: string;
  prNumber: number;
  state: LifecycleOutcomeState;
  success: boolean;
}

export interface AssignmentLifecycleOutcome {
  state: LifecycleOutcomeState;
  success: boolean;
  prs: PrLifecycleOutcome[];
}

/** A cutoff is optional for a live view; a supplied cutoff censors open work. */
export function lifecycleEventsAtCutoff(
  events: readonly LifecycleEvent[],
  cutoff?: string,
): LifecycleEvent[] {
  const before = cutoff === undefined ? Infinity : Date.parse(cutoff);
  if (Number.isNaN(before)) throw new Error("Invalid lifecycle cohort cutoff");
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.eventKey)) return false;
    seen.add(event.eventKey);
    return Date.parse(event.recordedAt) <= before;
  });
}

function latestGatePassed(
  events: readonly LifecycleEvent[],
  gate: string,
  before: number,
): boolean {
  const gates = events.filter((e): e is GateEvent =>
    e.kind === "gate" && e.gate === gate && Date.parse(e.recordedAt) < before
  ).sort((a, b) =>
    Date.parse(b.recordedAt) - Date.parse(a.recordedAt) ||
    Number(a.result === "pass") - Number(b.result === "pass")
  );
  return gates[0]?.result === "pass";
}

function classifyPr(
  events: readonly LifecycleEvent[],
  censored: boolean,
): Pick<PrLifecycleOutcome, "state" | "success"> {
  const merged = events.find((e) =>
    e.kind === "outcome" && e.outcome === "merged"
  );
  // Quality/review observations were emitted only while OPEN, including older
  // ledgers without the explicit pr_open observation. Bind live gates to that
  // latest observed head, just as a merge binds them to its merged head.
  const explicitState = events.some((event) =>
    event.kind === "gate" && event.gate === "pr_open"
  );
  const opened = events.filter((event) =>
    event.kind === "gate" &&
    (explicitState
      ? event.gate === "pr_open" && event.result === "pass"
      : event.gate === "quality" || event.gate === "review")
  ).sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))[0];
  const before = merged ? Date.parse(merged.recordedAt) : Infinity;
  const head = merged?.runId ?? opened?.runId;
  const gateEvents = head
    ? events.filter((event) => event.runId === head)
    : events;
  const quality = latestGatePassed(gateEvents, "quality", before);
  const review = latestGatePassed(gateEvents, "review", before);
  if (merged) return { state: "merged", success: quality && review };
  const lastClosed = Math.max(
    -Infinity,
    ...events.filter((event) =>
      (event.kind === "outcome" && event.outcome === "closed_unmerged") ||
      (event.kind === "gate" && event.gate === "pr_open" &&
        event.result === "fail")
    ).map((event) => Date.parse(event.recordedAt)),
  );
  if (
    lastClosed > -Infinity &&
    lastClosed >= (opened ? Date.parse(opened.recordedAt) : -Infinity)
  ) {
    return { state: "closed_unmerged", success: false };
  }
  if (censored) return { state: "censored_at_cutoff", success: false };
  return {
    state: review ? "review_approved" : quality ? "quality_green" : "pr_opened",
    success: false,
  };
}

/**
 * Keep each PR's outcome; a gated merge wins over an abandoned sibling PR.
 * Only gate events on that PR strictly before its merge can make it successful.
 */
export function classifyLifecycleOutcome(
  input: readonly LifecycleEvent[],
  cutoff?: string,
): AssignmentLifecycleOutcome {
  const events = lifecycleEventsAtCutoff(input, cutoff);
  const groups = new Map<string, LifecycleEvent[]>();
  for (const event of events) {
    if (!("prNumber" in event) || event.prNumber === undefined) continue;
    const key = `${event.repo}#${event.prNumber}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const prs = [...groups.values()].map((group) => {
    const first = group[0]!;
    return {
      repo: first.repo,
      prNumber: (first as GateEvent).prNumber!,
      ...classifyPr(group, cutoff !== undefined),
    };
  }).sort((a, b) => a.repo.localeCompare(b.repo) || a.prNumber - b.prNumber);
  const rank: Record<LifecycleOutcomeState, number> = {
    pending: 0,
    closed_unmerged: 1,
    pr_opened: 2,
    quality_green: 3,
    review_approved: 4,
    censored_at_cutoff: 5,
    merged: 6,
  };
  const best =
    [...prs].sort((a, b) =>
      Number(b.success) - Number(a.success) || rank[b.state] - rank[a.state]
    )[0];
  return {
    state: best?.state ??
      (cutoff === undefined ? "pending" : "censored_at_cutoff"),
    success: best?.success ?? false,
    prs,
  };
}
