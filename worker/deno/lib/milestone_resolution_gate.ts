/**
 * The gate an automatic conflict resolution must pass (Issue #1559).
 *
 * A conflict the worker resolves itself gets the same verification a human's
 * resolution gets, and for the same reason: a resolution nobody checked is a
 * guess. The type-check gate of Issue #974 answers "does the merged tree still
 * compile?", which is the right question for a merge git resolved on its own.
 * It is not enough for a merge where the worker *chose a side*: dropping one
 * side's implementation compiles perfectly and fails the moment the other
 * side's tests run.
 *
 * So a resolved tree runs more of the repository's own tasks — its `check`,
 * its `check:manifests` and its unit suite — and only a tree that passes all
 * of them is pushed. A tree that defines none of them is reported `skipped`,
 * and the sync treats that as a refusal: a resolution that cannot be verified
 * is not a resolution.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  checkMergedTree,
  findProjectManifests,
  type MergeGateFn,
  type MergeGateOutcome,
  readManifestTasks,
} from "./milestone_merge_gate.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";

/**
 * How long the whole verification may run before it is given up on.
 *
 * A single budget across every task, not one per task: this runs inside the
 * sync cycle, and three fifteen-minute tasks per project would block the loop
 * the milestone sync is supposed to stay out of the way of. A verification
 * that does not finish inside it is a failure, never a pass.
 */
export const RESOLUTION_GATE_BUDGET_MS = 900_000;

/**
 * The tasks a resolved tree is verified with, beyond the Issue #974 type
 * check, in the order they run.
 *
 * `test:unit` and `test` are alternatives — the first one the repository
 * defines is the unit suite, so a repo with both does not run its integration
 * tests inside a sync cycle.
 */
export const RESOLUTION_GATE_TASKS = [
  "check:manifests",
  "test:unit",
  "test",
] as const;

/** The unit-suite task names, most specific first. */
const UNIT_SUITE_TASKS = ["test:unit", "test"] as const;

/** One task to run in one project. */
export interface ResolutionTask {
  /** Directory the task runs in. */
  dir: string;
  /** The manifest task name, e.g. `check:manifests`. */
  task: string;
  /** What is left of {@link RESOLUTION_GATE_BUDGET_MS} when it starts. */
  timeoutMs: number;
}

/** Runs one task. Injected in tests; spawns `deno task <name>` in production. */
export type ResolutionTaskRunner = (
  task: ResolutionTask,
) => Promise<{ code: number; output: string }>;

/** Longest task output carried into a log line or an escalation comment. */
const MAX_OUTPUT_LINES = 40;
const MAX_OUTPUT_CHARS = 4000;

/** Keep the tail — a task's failure sits at the end of its output. */
function tail(output: string): string {
  const lines = output.trim().split("\n");
  const kept = lines.slice(-MAX_OUTPUT_LINES).join("\n");
  return kept.length > MAX_OUTPUT_CHARS ? kept.slice(-MAX_OUTPUT_CHARS) : kept;
}

/**
 * Which of a project's tasks verify a resolution.
 *
 * @param defined - Every task the project's manifest declares
 * @returns The tasks to run, in order; empty when it declares none of them
 */
export function resolutionTasksFor(defined: string[]): string[] {
  const tasks: string[] = [];
  if (defined.includes("check:manifests")) tasks.push("check:manifests");
  const unitSuite = UNIT_SUITE_TASKS.find((name) => defined.includes(name));
  if (unitSuite) tasks.push(unitSuite);
  return tasks;
}

/** Whether a task name is the unit suite (the one the issue requires). */
function isUnitSuite(task: string): boolean {
  return (UNIT_SUITE_TASKS as readonly string[]).includes(task);
}

/** Spawn one of the repository's own tasks within the remaining budget. */
const spawnTask: ResolutionTaskRunner = async (task) => {
  const result = await runWithTimeout(
    Deno.execPath(),
    ["task", task.task],
    { cwd: task.dir, timeoutMs: task.timeoutMs },
  );
  if (!result.ok) return { code: 1, output: result.error.message };
  const { code, stdout, stderr, timedOut } = result.value;
  const output = [stdout, stderr].map((s) => s.trim()).filter(Boolean)
    .join("\n");
  if (timedOut) {
    return {
      code: 124,
      output:
        `${output}\n'deno task ${task.task}' timed out after ${task.timeoutMs}ms`
          .trim(),
    };
  }
  return { code, output };
};

/**
 * Verify a tree whose conflicts the worker resolved itself.
 *
 * @param repoDir - Root of the merged working tree (the clone's cwd)
 * @param runner - Override the spawned task (tests)
 * @returns `passed` only when every task that ran passed; `skipped` when the
 *   tree defines nothing to run, which the caller must treat as a refusal
 */
export async function verifyResolvedTree(
  repoDir: string,
  runner: ResolutionTaskRunner = spawnTask,
  /** The Issue #974 type check. Injected in tests; the real gate otherwise. */
  typeCheck: MergeGateFn = checkMergedTree,
  /** Reads the clock. Injected in tests so the budget is deterministic. */
  now: () => number = () => Date.now(),
): Promise<MergeGateOutcome> {
  // A tree that cannot be read is a verification that could not be run.
  try {
    if (!(await Deno.stat(repoDir)).isDirectory) {
      return {
        status: "failed",
        detail: `merged tree '${repoDir}' is not a directory — nothing ` +
          `verified the resolution`,
        output: "",
      };
    }
  } catch (err) {
    return {
      status: "failed",
      detail: `merged tree '${repoDir}' could not be read — nothing verified ` +
        `the resolution`,
      output: tail(err instanceof Error ? err.message : String(err)),
    };
  }

  const deadline = now() + RESOLUTION_GATE_BUDGET_MS;

  // The Issue #974 gate first, exactly as it stands — including its fallback
  // to a whole-tree `deno check` where the manifest names no `check` task.
  // Re-implementing it here would quietly drop that fallback, and a
  // resolution pushed without any type check is the state #974 exists to end.
  const typed = await typeCheck(repoDir);
  if (typed.status !== "passed") {
    return typed.status === "failed" ? typed : {
      status: "skipped",
      detail: `${typed.detail} — the Issue #974 type check did not run`,
      output: typed.output,
    };
  }

  const ran: string[] = [typed.detail];
  let unitSuiteRan = false;
  for (const project of await findProjectManifests(repoDir)) {
    const defined = await readManifestTasks(project.manifest);
    for (const task of resolutionTasksFor(defined)) {
      const where = `deno task ${task} in ${project.dir}`;
      const timeoutMs = deadline - now();
      if (timeoutMs <= 0) {
        return {
          status: "failed",
          detail: `${where} was not reached within the ` +
            `${RESOLUTION_GATE_BUDGET_MS}ms verification budget — the ` +
            `resolution is unverified, so it is not pushed`,
          output: "",
        };
      }
      let result: { code: number; output: string };
      try {
        result = await runner({ dir: project.dir, task, timeoutMs });
      } catch (err) {
        // Unrunnable is not clean — the resolution stays unverified.
        return {
          status: "failed",
          detail: `${where} could not be run`,
          output: tail(err instanceof Error ? err.message : String(err)),
        };
      }
      if (result.code !== 0) {
        return {
          status: "failed",
          detail: `${where} failed (exit ${result.code})`,
          output: tail(result.output),
        };
      }
      ran.push(where);
      if (isUnitSuite(task)) unitSuiteRan = true;
    }
  }

  if (!unitSuiteRan) {
    // Choosing a side compiles perfectly while dropping the other side's
    // behaviour, so the type check alone does not verify a resolution.
    return {
      status: "skipped",
      detail: `no ${UNIT_SUITE_TASKS.join("/")} task under '${repoDir}' — ` +
        `nothing ran the cases that would show a dropped implementation`,
      output: "",
    };
  }

  return { status: "passed", detail: `${ran.join("; ")} passed`, output: "" };
}
