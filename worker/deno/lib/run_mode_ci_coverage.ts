/**
 * What the CI gate must prove about both run modes (Issue #4150).
 *
 * Milestone #4060 settled that native is first-class forever (#4145) — equal
 * support, documented, and CI-tested. A mode nothing exercises rots: #4065 was
 * able to delete the native path outright precisely because no job would have
 * gone red. This module reads a workflow file and reports which run modes its
 * jobs actually exercise, so the `Validate Scripts` gate cannot quietly lose a
 * mode leg.
 *
 * The rules are the acceptance criteria of #4150, one function:
 *
 * - **Every mode is covered.** A job exercises a mode when its matrix (or its
 *   `VIBE_RUN_MODE` job environment) names it.
 * - **The failing check names the mode.** Two legs that report the same check
 *   name leave a reviewer guessing which mode broke.
 * - **Each leg runs the tests**, so a regression in either path fails the gate.
 * - **The native leg owes two extra proofs**: that no container runtime is
 *   reachable on that runner, and the pair of end-to-end behaviours #4145
 *   asked for — the opt-in launches the worker driver on the host, and without
 *   the opt-in the same runner fails loudly with the runtime message. No
 *   silent fallback in either direction (Issue #3234).
 * - **The budget is deliberate.** A mode job with no `timeout-minutes` can run
 *   until the runner's own ceiling.
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
 * The part of the "no runtime" failure every supported platform prints.
 *
 * Derived from the real error on each platform, so it is exactly the text a
 * host without a runtime emits — whatever the wording becomes.
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
  /** True when the job proves no container runtime is reachable. */
  provesNoContainerRuntime: boolean;
  /** True when the job launches the worker through the native opt-in. */
  runsNativeOptInSmoke: boolean;
  /** True when the job asserts the loud failure without the opt-in. */
  runsLoudFailureSmoke: boolean;
  /** The job's declared `timeout-minutes`, or null when it declares none. */
  timeoutMinutes: number | null;
}

/** What a workflow proves about the two run modes. */
export interface RunModeCiCoverage {
  /** One entry per (job, mode) pair the workflow exercises. */
  jobs: RunModeCiJob[];
  /** Everything #4150 requires and this workflow does not do. */
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

/** True when the step selects native mode, by step environment or inline. */
function optsIntoNative(step: WorkflowStep): boolean {
  if (isRunMode(step.env?.[RUN_MODE_ENV])) {
    return step.env?.[RUN_MODE_ENV] === "native";
  }
  return new RegExp(`${RUN_MODE_ENV}=(["']?)native\\1`).test(step.run ?? "");
}

/**
 * Audit one workflow's run-mode coverage.
 *
 * @param workflowYaml - Raw workflow YAML.
 * @returns The mode legs found, and every #4150 requirement they miss. A
 *   workflow with no mode job at all (a container-only workflow such as
 *   `container-build.yml`) reports no jobs and no problems — this audit says
 *   what a *mode* gate owes, not that every workflow must be one.
 */
export function auditRunModeCiCoverage(
  workflowYaml: string,
): RunModeCiCoverage {
  const parsed = parseYaml(workflowYaml) as
    | { jobs?: Record<string, WorkflowJob> }
    | null;
  const jobs: RunModeCiJob[] = [];

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
        provesNoContainerRuntime: steps.some((step) =>
          /command\s+-v/.test(step.run ?? "") &&
          CONTAINER_RUNTIME_EXECUTABLES.every((executable) =>
            mentionsWord(step.run ?? "", executable)
          )
        ),
        runsNativeOptInSmoke: steps.some((step) =>
          invokesLauncher(step) && optsIntoNative(step)
        ),
        runsLoudFailureSmoke: steps.some((step) =>
          invokesLauncher(step) && !optsIntoNative(step) &&
          (step.run ?? "").includes(CONTAINER_RUNTIME_UNAVAILABLE_MARKER)
        ),
        timeoutMinutes: typeof timeout === "number" ? timeout : null,
      });
    }
  }

  return { jobs, problems: problemsWith(jobs) };
}

/** Everything #4150 requires of the legs found, and they do not do. */
function problemsWith(jobs: RunModeCiJob[]): string[] {
  if (jobs.length === 0) return [];
  const problems: string[] = [];

  for (const mode of RUN_MODES) {
    if (!jobs.some((job) => job.mode === mode)) {
      problems.push(
        `no job exercises ${mode} mode — a mode nothing runs cannot fail CI`,
      );
    }
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
    if (job.mode !== "native") continue;
    if (!job.provesNoContainerRuntime) {
      problems.push(
        `${where} does not prove the runner has no container runtime`,
      );
    }
    if (!job.runsNativeOptInSmoke) {
      problems.push(
        `${where} never launches the worker through the native opt-in`,
      );
    }
    if (!job.runsLoudFailureSmoke) {
      problems.push(
        `${where} never asserts the loud "${CONTAINER_RUNTIME_UNAVAILABLE_MARKER}" ` +
          `failure without the opt-in`,
      );
    }
  }

  return problems;
}
