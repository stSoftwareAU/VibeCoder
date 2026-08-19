/**
 * What the CI gate must prove about the run mode (Issues #4150, #4).
 *
 * Containment is mandatory (Issue #4): container is the only run mode, and a
 * mode nothing exercises rots — #4065 was able to delete a whole launcher path
 * precisely because no job would have gone red. This module reads a workflow
 * file and reports what its jobs actually prove, so the `Validate Scripts`
 * gate cannot quietly lose the leg that guards containment.
 *
 * The rules, one function:
 *
 * - **The mode is covered.** A job exercises container mode when its matrix
 *   (or its `VIBE_RUN_MODE` job environment) names it.
 * - **The failing check names the mode.** A leg that reports a bare name
 *   leaves a reviewer guessing what broke.
 * - **The leg runs the tests**, so a regression in the launcher path fails
 *   the gate.
 * - **The budget is deliberate.** A mode job with no `timeout-minutes` can run
 *   until the runner's own ceiling.
 * - **No host fallback is proven.** Somewhere in the workflow a job takes
 *   every container runtime off its runner (and proves none answers), then
 *   launches `run.sh` and asserts the loud "no supported container runtime"
 *   failure — the one end-to-end proof that a runtime-less host never runs
 *   the worker on the host (Issue #3234). The former native opt-in smoke went
 *   with native mode.
 *
 * The loud-failure marker is derived from the real
 * {@link ContainerRuntimeUnavailableError} message rather than restated, so a
 * reworded error cannot leave CI grepping for a string nothing prints any more.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { parse as parseYaml } from "@std/yaml/parse";
import {
  isRunMode,
  RUN_MODE_ENV,
  RUN_MODES,
  type RunMode,
} from "./run_mode.ts";
import {
  CONTAINER_RUNTIMES,
  ContainerRuntimeUnavailableError,
  SUPPORTED_HOST_PLATFORMS,
} from "./container_runtime.ts";

/** Executable names a host is probed for — `container`, `docker`, `podman`. */
export const CONTAINER_RUNTIME_EXECUTABLES: readonly string[] = Object
  .values(CONTAINER_RUNTIMES)
  .map((candidate) => candidate.executable);

/** The longest prefix two strings share. */
function commonPrefix(left: string, right: string): string {
  let end = 0;
  while (end < left.length && end < right.length && left[end] === right[end]) {
    end++;
  }
  return left.slice(0, end);
}

/**
 * The text a runtime-less launch prints, whatever the platform: the common
 * prefix of the real {@link ContainerRuntimeUnavailableError} messages.
 */
export const CONTAINER_RUNTIME_UNAVAILABLE_MARKER: string =
  SUPPORTED_HOST_PLATFORMS
    .map((platform) =>
      new ContainerRuntimeUnavailableError(platform, []).message
    )
    .reduce(commonPrefix)
    .trim();

/** What one job proves about the mode it runs. */
export interface RunModeCiJob {
  /** Workflow job id (the key under `jobs:`). */
  jobId: string;
  /** The run mode this job exercises. */
  mode: RunMode;
  /** The check name GitHub reports for this job, matrix value expanded. */
  checkName: string;
  /** True when the job runs the Deno test suite (whole or targeted). */
  runsModeTests: boolean;
  /** The job's declared `timeout-minutes`, or null when it declares none. */
  timeoutMinutes: number | null;
}

/** What a workflow proves about the run mode. */
export interface RunModeCiCoverage {
  /** One entry per (job, mode) pair the workflow exercises. */
  jobs: RunModeCiJob[];
  /**
   * Job ids that take every container runtime off the runner and assert the
   * loud failure of a launch without one — the no-host-fallback proof.
   */
  noHostFallbackProofs: string[];
  /** Everything #4150 / #4 requires and this workflow does not do. */
  problems: string[];
}

/** A workflow step, reduced to the fields the audit reads. */
interface WorkflowStep {
  name?: string;
  run?: string;
  env?: Record<string, unknown>;
}

/** A workflow job, reduced to the fields the audit reads. */
interface WorkflowJob {
  name?: string;
  env?: Record<string, unknown>;
  steps?: WorkflowStep[];
  strategy?: { matrix?: Record<string, unknown> };
  "timeout-minutes"?: unknown;
}

/** True when `char` continues a shell word — a word character or a hyphen. */
function continuesWord(char: string | undefined): boolean {
  return char !== undefined && /[\w-]/.test(char);
}

/**
 * Report whether `text` contains `word` as a whole shell word.
 *
 * Scanned literally rather than through a built regex: `word` comes from data
 * (runtime executable names), and compiling data into a pattern is both a ReDoS
 * surface and needless escaping.
 */
function mentionsWord(text: string, word: string): boolean {
  if (word.length === 0) return false;
  for (
    let at = text.indexOf(word);
    at !== -1;
    at = text.indexOf(word, at + 1)
  ) {
    if (
      !continuesWord(text[at - 1]) && !continuesWord(text[at + word.length])
    ) {
      return true;
    }
  }
  return false;
}

/** The run modes one job exercises, from its matrix or its environment. */
function modesOf(job: WorkflowJob): RunMode[] {
  const matrixModes = job.strategy?.matrix?.["mode"];
  if (Array.isArray(matrixModes)) {
    return matrixModes.filter((value): value is RunMode => isRunMode(value));
  }
  const configured = job.env?.[RUN_MODE_ENV];
  return isRunMode(configured) ? [configured] : [];
}

/**
 * The check name GitHub reports for one leg of a job.
 *
 * A `name:` wins, with the matrix expression expanded; without one, GitHub
 * names a matrix leg `<job-id> (<value>)`.
 */
function checkNameFor(
  jobId: string,
  job: WorkflowJob,
  mode: RunMode,
  fromMatrix: boolean,
): string {
  if (typeof job.name === "string") {
    return job.name.replace(/\$\{\{\s*matrix\.mode\s*\}\}/g, mode);
  }
  return fromMatrix ? `${jobId} (${mode})` : jobId;
}

/** True when the step invokes a launcher rather than talking about one. */
function invokesLauncher(step: WorkflowStep): boolean {
  return /(^|[^\w./])\.?\/?run\.sh(\s|$)/m.test(step.run ?? "");
}

/**
 * Audit one workflow's run-mode coverage.
 *
 * @param workflowYaml - Raw workflow YAML.
 * @returns The mode legs found, the no-host-fallback proofs, and every
 *   requirement they miss. A workflow with no mode job at all (a
 *   container-only workflow such as `container-build.yml`) reports no jobs
 *   and no problems — this audit says what a *mode* gate owes, not that every
 *   workflow must be one.
 */
export function auditRunModeCiCoverage(
  workflowYaml: string,
): RunModeCiCoverage {
  const parsed = parseYaml(workflowYaml) as
    | { jobs?: Record<string, WorkflowJob> }
    | null;
  const jobs: RunModeCiJob[] = [];
  const noHostFallbackProofs: string[] = [];

  for (const [jobId, job] of Object.entries(parsed?.jobs ?? {})) {
    const modes = modesOf(job);
    const fromMatrix = Array.isArray(job.strategy?.matrix?.["mode"]);
    const steps = job.steps ?? [];
    const runs = steps.map((step) => step.run ?? "").join("\n");
    const timeout = job["timeout-minutes"];

    for (const mode of modes) {
      jobs.push({
        jobId,
        mode,
        checkName: checkNameFor(jobId, job, mode, fromMatrix),
        runsModeTests: /\bdeno\s+(task\s+)?test\b/.test(runs),
        timeoutMinutes: typeof timeout === "number" ? timeout : null,
      });
    }

    // The no-host-fallback proof: every runtime taken off the runner and
    // proven absent, then a launch asserted to fail with the real
    // runtime-unavailable message.
    const provesNoRuntime = steps.some((step) =>
      /command\s+-v/.test(step.run ?? "") &&
      CONTAINER_RUNTIME_EXECUTABLES.every((executable) =>
        mentionsWord(step.run ?? "", executable)
      )
    );
    const runsLoudFailureSmoke = steps.some((step) =>
      invokesLauncher(step) &&
      (step.run ?? "").includes(CONTAINER_RUNTIME_UNAVAILABLE_MARKER)
    );
    if (provesNoRuntime && runsLoudFailureSmoke) {
      noHostFallbackProofs.push(jobId);
    }
  }

  return {
    jobs,
    noHostFallbackProofs,
    problems: problemsWith(jobs, noHostFallbackProofs),
  };
}

/** Everything #4150 / #4 requires of the legs found, and they do not do. */
function problemsWith(
  jobs: RunModeCiJob[],
  noHostFallbackProofs: string[],
): string[] {
  if (jobs.length === 0) return [];
  const problems: string[] = [];

  for (const mode of RUN_MODES) {
    if (!jobs.some((job) => job.mode === mode)) {
      problems.push(
        `no job exercises ${mode} mode — a mode nothing runs cannot fail CI`,
      );
    }
  }

  if (noHostFallbackProofs.length === 0) {
    problems.push(
      `no job proves the no-host-fallback contract: take every container ` +
        `runtime off a runner and assert the loud ` +
        `"${CONTAINER_RUNTIME_UNAVAILABLE_MARKER}" failure of run.sh`,
    );
  }

  for (const job of jobs) {
    const where = `${job.jobId} (${job.mode})`;
    const clash = jobs.find((other) =>
      other !== job && other.checkName === job.checkName
    );
    if (clash) {
      problems.push(
        `${where} reports the same check name as ${clash.jobId} ` +
          `(${clash.mode}): "${job.checkName}" — the failing check must name ` +
          `the broken mode`,
      );
    }
    if (!job.checkName.includes(job.mode)) {
      problems.push(
        `${where} reports as "${job.checkName}", which does not name the mode`,
      );
    }
    if (!job.runsModeTests) {
      problems.push(`${where} runs no tests, so it cannot catch a regression`);
    }
    if (job.timeoutMinutes === null) {
      problems.push(`${where} declares no timeout-minutes budget`);
    }
  }

  return problems;
}
