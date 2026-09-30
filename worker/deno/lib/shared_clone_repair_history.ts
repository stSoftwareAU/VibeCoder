/** Repair-history tracking and churn escalation for shared-clone ref sweeps (Issue #2889). */

import type { SelfHealEvent } from "./self_heal_events.ts";
import type {
  SharedCloneRefSweepDeps,
  SharedCloneSweepOutcome,
} from "./shared_clone_ref_sweep.ts";
import {
  REPAIR_ESCALATION_THRESHOLD,
  REPAIR_HISTORY_FILENAME,
  REPAIR_WINDOW_MS,
  SHARED_CLONE_REF_SWEEP_MODULE,
} from "./shared_clone_ref_sweep.ts";

/** Repair-history file shape (Issue #2889). */
interface RepairHistory {
  repairs: Record<string, number[]>;
}

/** Append this sweep's repair to the history file and escalate if it churns. */
export async function recordRepairAndMaybeEscalate(
  repo: string,
  workDir: string,
  now: () => Date,
  deps: SharedCloneRefSweepDeps,
  emit: (event: SelfHealEvent) => Promise<void>,
  outcome: SharedCloneSweepOutcome,
): Promise<void> {
  const historyPath = `${workDir}/${REPAIR_HISTORY_FILENAME}`;
  const nowMs = now().getTime();

  let history: RepairHistory = { repairs: {} };
  try {
    const text = await Deno.readTextFile(historyPath);
    const parsed = JSON.parse(text);
    if (
      parsed && typeof parsed === "object" &&
      parsed.repairs && typeof parsed.repairs === "object"
    ) {
      history = parsed as RepairHistory;
    } else {
      throw new Error("unexpected shape");
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      deps.logError(
        `Shared-clone sweep: repair history file is corrupt, starting fresh: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    history = { repairs: {} };
  }

  const windowStart = nowMs - REPAIR_WINDOW_MS;
  const existing = (history.repairs[repo] ?? []).filter((t) =>
    t >= windowStart
  );
  existing.push(nowMs);
  history.repairs[repo] = existing;

  const tempPath = `${historyPath}.tmp-${crypto.randomUUID()}`;
  try {
    await Deno.writeTextFile(tempPath, JSON.stringify(history));
    await Deno.rename(tempPath, historyPath);
  } catch (error) {
    deps.logError(
      `Shared-clone sweep: could not write repair history for ${repo}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    try {
      await Deno.remove(tempPath);
    } catch (removeError) {
      if (!(removeError instanceof Deno.errors.NotFound)) {
        deps.logError(
          `Shared-clone sweep: could not clean up temp history file for ${repo}: ${
            removeError instanceof Error
              ? removeError.message
              : String(removeError)
          }`,
        );
      }
    }
  }

  const repairsInWindow = existing.length;
  if (repairsInWindow > REPAIR_ESCALATION_THRESHOLD) {
    outcome.escalated = true;
    const message =
      `[SHARED_CLONE_REF_CHURN] ${repo}: shared clone repaired ${repairsInWindow} ` +
      "times in the last 24h — broken refs keep reappearing; last-writer " +
      "provenance is in self-heal.jsonl (Issue #2889)";
    deps.logError(message);
    await emit({
      timestamp: now().toISOString(),
      module: SHARED_CLONE_REF_SWEEP_MODULE,
      action: "escalate",
      result: "failed",
      reason: message,
      details: { repo, repairsInWindow },
    });
  }
}
