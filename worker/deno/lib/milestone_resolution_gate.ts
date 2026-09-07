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
  findProjectManifests,
  type MergeGateOutcome,
  readManifestTasks,
} from "./milestone_merge_gate.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";

/**
 * How long one verification task may run before it is killed.
 *
 * Longer than the type-check gate's budget because a unit suite is the slowest
 * thing here; a suite that cannot finish inside it is reported as a failure,
 * not waved through.
 */
export const RESOLUTION_GATE_TIMEOUT_MS = 900_000;

/**
 * The tasks a resolved tree is verified with, in the order they run.
 *
 * `test:unit` and `test` are alternatives — the first one the repository
 * defines is the unit suite, so a repo with both does not run its integration
 * tests inside a sync cycle.
 */
export const RESOLUTION_GATE_TASKS = [
  "check",
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
  for (const name of ["check", "check:manifests"]) {
    if (defined.includes(name)) tasks.push(name);
  }
  const unitSuite = UNIT_SUITE_TASKS.find((name) => defined.includes(name));
  if (unitSuite) tasks.push(unitSuite);
  return tasks;
}

/** Spawn one of the repository's own tasks with a bounded timeout. */
const spawnTask: ResolutionTaskRunner = async (task) => {
  const result = await runWithTimeout(
    Deno.execPath(),
    ["task", task.task],
    { cwd: task.dir, timeoutMs: RESOLUTION_GATE_TIMEOUT_MS },
  );
  if (!result.ok) return { code: 1, output: result.error.message };
  const { code, stdout, stderr, timedOut } = result.value;
  const output = [stdout, stderr].map((s) => s.trim()).filter(Boolean)
    .join("\n");
  if (timedOut) {
    return {
      code: 124,
      output:
        `${output}\n'deno task ${task.task}' timed out after ${RESOLUTION_GATE_TIMEOUT_MS}ms`
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

  const ran: string[] = [];
  for (const project of await findProjectManifests(repoDir)) {
    const defined = await readManifestTasks(project.manifest);
    for (const task of resolutionTasksFor(defined)) {
      const where = `deno task ${task} in ${project.dir}`;
      let result: { code: number; output: string };
      try {
        result = await runner({ dir: project.dir, task });
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
    }
  }

  if (ran.length === 0) {
    return {
      status: "skipped",
      detail: `no ${RESOLUTION_GATE_TASKS.join("/")} task under '${repoDir}' ` +
        `— nothing could verify the resolution`,
      output: "",
    };
  }

  return { status: "passed", detail: `${ran.join("; ")} passed`, output: "" };
}
