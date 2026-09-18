/**
 * Wall-clock timings per stage of a merge-conflict attempt (Issue #2308).
 *
 * A conflict attempt routinely runs for twenty to thirty minutes, and until
 * now the only record of where that went was the wall-clock gap between two
 * log lines. This timer is the missing breakdown: each attempt records the
 * seconds it spent deepening the clone, in the deterministic rules, gathering
 * issue context, in the resolution agent, in the verification gate and in the
 * push — on the PR conclusion comment or the milestone sync report, and in the
 * worker log, on both paths.
 *
 * The clock is injected, so the timer is a pure function of the ticks it is
 * given and a test needs no wall clock at all.
 *
 * **A stage that never stopped is reported, never dropped.** It renders as
 * `unfinished` rather than as a plausible-looking duration: an attempt that
 * died inside the agent is exactly the case these timings exist to show, and a
 * stage that quietly vanished from the line would hide it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { getHostname } from "./worker_identity.ts";

/** The stages a merge-conflict attempt is broken into. */
export type ConflictStage =
  | "deepen"
  | "rules"
  | "issue-context"
  | "agent"
  | "gate"
  | "push";

/** One stage's wall-clock cost. */
export interface StageTiming {
  /** The stage this line is about. */
  stage: ConflictStage;
  /**
   * Whole seconds the stage took, or `null` when it was started and never
   * stopped — rendered as `unfinished`, never as a duration.
   */
  seconds: number | null;
}

/** Records how long each stage of one conflict attempt took. */
export interface ConflictStageTimer {
  /**
   * Begin timing `stage`.
   *
   * A stage still running when the next one starts was never stopped, so it
   * is recorded as unfinished rather than given an invented duration.
   */
  start(stage: ConflictStage): void;
  /** Stop the running stage, adding its elapsed time to that stage's total. */
  stop(): void;
  /** What each stage cost, in the order the stages first started. */
  report(): StageTiming[];
}

/**
 * Create a stage timer over an injected clock.
 *
 * A stage started more than once accumulates: the milestone path runs its
 * gate again after a repair round, and two `gate` entries on one line would
 * say less than one total. Once a stage has gone unfinished it stays
 * unfinished, however much time a later run of it adds.
 *
 * @param nowMs - Monotonic-enough millisecond clock; defaults to `Date.now`
 * @returns A timer whose report is a pure function of the ticks it was given
 */
export function createConflictStageTimer(
  nowMs: () => number = () => Date.now(),
): ConflictStageTimer {
  /** Accumulated milliseconds per stage. */
  const totals = new Map<ConflictStage, number>();
  /** Stages that were started and never stopped. */
  const unfinished = new Set<ConflictStage>();
  /** First-start order, so the line reads in the order the attempt ran. */
  const order: ConflictStage[] = [];
  let running: { stage: ConflictStage; startedMs: number } | null = null;

  const close = (finished: boolean): void => {
    if (running === null) return;
    if (finished) {
      // A clock that went backwards contributes nothing rather than a
      // negative duration.
      const elapsed = Math.max(0, nowMs() - running.startedMs);
      totals.set(running.stage, (totals.get(running.stage) ?? 0) + elapsed);
    } else {
      unfinished.add(running.stage);
    }
    running = null;
  };

  return {
    start(stage: ConflictStage): void {
      close(false);
      if (!order.includes(stage)) order.push(stage);
      running = { stage, startedMs: nowMs() };
    },
    stop(): void {
      close(true);
    },
    report(): StageTiming[] {
      const stillRunning = running?.stage;
      return order.map((stage) => ({
        stage,
        seconds: unfinished.has(stage) || stage === stillRunning
          ? null
          : Math.round((totals.get(stage) ?? 0) / 1000),
      }));
    },
  };
}

/**
 * Render a stage report as the one Markdown line the comments carry.
 *
 * @param report - What {@link ConflictStageTimer.report} produced
 * @param host - The host the attempt ran on, from {@link currentHost}
 * @returns e.g. ``Timings (host `mel-01`): deepen 3s · rules 1s · agent 212s``
 */
export function formatStageTimings(
  report: readonly StageTiming[],
  host: string,
): string {
  const stages = report.map((timing) =>
    `${timing.stage} ${
      timing.seconds === null ? "unfinished" : `${timing.seconds}s`
    }`
  );
  // An empty report says so rather than trailing off into nothing: "no stage
  // was timed" is a fact a reader can act on, a blank line is not.
  return `Timings (host \`${host}\`): ${
    stages.length > 0 ? stages.join(" · ") : "no stage was timed"
  }`;
}

/** A parsed timings line: the host it names, and each stage it reports. */
export interface ParsedStageTimings {
  /** The host the line names, when it named one. */
  host?: string;
  /** One entry per stage, `null` seconds for an unfinished stage. */
  stages: { stage: string; seconds: number | null }[];
}

/**
 * Read a rendered timings line back (Issue #2311).
 *
 * The inverse of {@link formatStageTimings}, and deliberately beside it so
 * the two cannot drift: the line is what a conclusion records, and the
 * `merge-fallback` flag reports each spent run's stages from it. Anything the
 * grammar does not fit is dropped rather than guessed — a stage nobody can
 * read is not a stage that took zero seconds.
 *
 * @param line - A line as {@link formatStageTimings} rendered it
 */
export function parseStageTimings(line: string): ParsedStageTimings {
  const match = line.match(/^Timings \(host `([^`]*)`\): (.*)$/);
  if (!match) return { stages: [] };
  const host = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  const stages = body === "no stage was timed" ? [] : body.split(" · ").flatMap(
    (part) => {
      const stage = part.match(/^(\S+) (unfinished|\d+)s?$/);
      if (!stage) return [];
      return [{
        stage: stage[1]!,
        seconds: stage[2] === "unfinished" ? null : Number(stage[2]),
      }];
    },
  );
  return { ...(host ? { host } : {}), stages };
}

/**
 * The host this attempt is running on — the one seam the callers use.
 *
 * Spelled here rather than at each call site so a test injects one function
 * and the two paths cannot report the host differently.
 *
 * @returns The worker's hostname, or `unknown-host` when it cannot be read
 */
export function currentHost(): string {
  return getHostname();
}
