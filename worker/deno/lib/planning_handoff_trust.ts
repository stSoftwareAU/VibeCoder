/**
 * Worker planning hand-off trust exception (Issue #2688).
 *
 * The label-security backstop strips every operational label a worker login
 * applied (Issue #3225), so an oversized `work-on` epic used to dead-end at
 * `needs-human`. This module is the single, narrow exception both trust paths
 * share: a worker-applied `planning` label is honoured only when it is the
 * worker handing off an issue a trusted human already queued with `work-on`.
 *
 * ```mermaid
 * flowchart LR
 *   H["Trusted human adds work-on"] --> W["Worker runs issue"]
 *   W -->|"too large for one PR"| P["Worker adds planning"]
 *   P --> C{"isWorkerPlanningHandoff"}
 *   C -->|"work-on still trusted,<br/>added before planning"| T["planning trusted"]
 *   C -->|"anything else"| S["planning stripped"]
 * ```
 *
 * An outsider gains nothing: the anchor is a `work-on` label applied by an
 * allowed author, so anyone able to set it could already set `planning`.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/** Minimal timeline shape shared by the REST timeline readers. */
export interface HandoffTimelineEvent {
  event: string;
  label?: { name: string } | null;
  actor?: { login: string } | null;
}

/** The only label the hand-off exception covers. */
export const PLANNING_HANDOFF_LABEL = "planning";

/** The trusted pickup label that anchors the hand-off. */
export const PLANNING_HANDOFF_ANCHOR = "work-on";

function lastIndexOf(
  timeline: readonly HandoffTimelineEvent[],
  event: string,
  label: string,
): number {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e?.event === event && e.label?.name?.toLowerCase() === label) return i;
  }
  return -1;
}

function inList(login: string | undefined, list: readonly string[]): boolean {
  if (!login) return false;
  const lower = login.toLowerCase();
  return list.some((a) => a.toLowerCase() === lower);
}

/**
 * True when `labelName` is `planning` applied by a worker login as a
 * hand-off of a `work-on` issue a trusted, non-worker author queued.
 *
 * Every condition must hold, against an oldest-first timeline:
 * - the latest `planning` add was made by a login in `workerLogins`;
 * - the latest `work-on` add was made by an allowed author who is not a
 *   worker login;
 * - that `work-on` add precedes the latest `planning` add;
 * - `work-on` was not removed after that add.
 */
export function isWorkerPlanningHandoff(
  timeline: readonly HandoffTimelineEvent[],
  labelName: string,
  allowedAuthors: readonly string[],
  workerLogins: readonly string[],
): boolean {
  if (labelName.toLowerCase() !== PLANNING_HANDOFF_LABEL) return false;

  const planningAt = lastIndexOf(timeline, "labeled", PLANNING_HANDOFF_LABEL);
  if (planningAt < 0) return false;
  const planningAdder = timeline[planningAt]?.actor?.login;
  if (!inList(planningAdder, workerLogins)) return false;

  const workOnAt = lastIndexOf(timeline, "labeled", PLANNING_HANDOFF_ANCHOR);
  if (workOnAt < 0 || workOnAt > planningAt) return false;
  const workOnAdder = timeline[workOnAt]?.actor?.login;
  if (inList(workOnAdder, workerLogins)) return false;
  if (!inList(workOnAdder, allowedAuthors)) return false;

  const workOnRemovedAt = lastIndexOf(
    timeline,
    "unlabeled",
    PLANNING_HANDOFF_ANCHOR,
  );
  return workOnRemovedAt < workOnAt;
}
