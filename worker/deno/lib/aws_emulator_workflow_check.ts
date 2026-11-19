/**
 * Quality gate check: the AWS Emulator CloudFormation CI workflow (Issue #5110).
 *
 * `.github/workflows/aws-emulator.yml` deploys VibeCoder's own CloudFormation
 * templates into the official AWS Emulator. Its safety rests on a few
 * statically decidable properties, which these pure helpers verify so a
 * regression fails the unit test
 * `worker/deno/tests/issue_5110_aws_emulator_workflow_test.ts`, which runs in
 * the quality gate:
 *
 * - (a) a step invokes `infra/cloudformation/test-aws-emulator.sh` in command
 *   position (an `echo` or a comment does not count), and a failure of the
 *   script fails the job: the step's code (comment lines dropped) has no `|`,
 *   `;` or `&`, so nothing follows, pipes or backgrounds the call; the step
 *   consists only of `set -euo pipefail` (optional) and that one call, so no
 *   `if`, `exit` or second command can skip or replace it; no `!` or
 *   `if`/`while`/`until` word precedes the call, because `! ./script` turns
 *   a failure into success (PR #5276 review); and neither the
 *   job nor that step sets `continue-on-error` or an `if:` (PR #3478 review);
 * - (b) a step runs `container/toolchains/aws-emulator.sh` (the pinned,
 *   checksum-verified install), a step runs `container/toolchains/aws-cli.sh`
 *   (the pinned aws-cli, not the runner's own), and a step installs
 *   `container/aws-emulator-run.sh`, all before the test step;
 * - (c) the job has no `services`, no step or volume mentions
 *   `/var/run/docker.sock`, and nothing references Floci;
 * - (d) `on.workflow_call` is present (quality.yml calls this workflow), and
 *   `on.pull_request` is absent: a standalone pull_request run is not part of
 *   quality.yml's gate; and top-level `concurrency` is absent, because a
 *   called workflow inherits its caller's group and its own would cancel
 *   siblings;
 * - (e) top-level `permissions.contents` is `read`;
 * - (f) every `actions/checkout` step sets `persist-credentials: false`.
 *
 * `checkQualityCallsAwsEmulator` checks the parsed quality.yml: a job calls
 * this workflow (`[gate-call]`) and the `gate` job needs it (`[gate-needs]`).
 *
 * Each finding names its invariant in square brackets, e.g. `[test-step]`.
 *
 * No I/O: callers parse the YAML and pass the parsed value in.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import {
  shellSegments,
  statusPreservingCommandIndex,
} from "./shell_command_words.ts";

/** The test script the workflow must run in command position. */
export const SCRIPT_PATH = "infra/cloudformation/test-aws-emulator.sh";
/** The pinned, checksum-verified install fragment. */
const TOOLCHAIN_PATH = "container/toolchains/aws-emulator.sh";
/** The pinned, checksum-verified aws-cli fragment (CI must not use the runner's). */
const CLI_TOOLCHAIN_PATH = "container/toolchains/aws-cli.sh";
/** The runner script the workflow must install onto the PATH. */
const RUNNER_PATH = "container/aws-emulator-run.sh";
const DOCKER_SOCK = "/var/run/docker.sock";
const CHECKOUT_PREFIX = "actions/checkout@";
/** The `uses` value of the quality.yml job that calls this workflow. */
export const AWS_EMULATOR_USES = "./.github/workflows/aws-emulator.yml";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return the `run` text of a step, or "" when absent. */
function runOf(step: unknown): string {
  return isObject(step) && typeof step.run === "string" ? step.run : "";
}

/** The steps of a job, or [] when absent. */
function stepsOf(job: Record<string, unknown>): unknown[] {
  return Array.isArray(job.steps) ? job.steps : [];
}

/**
 * The `run:` text of a step with comment lines (trimmed line starting with
 * `#`) dropped.
 */
function codeOf(step: unknown): string {
  return runOf(step).split("\n").filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

/**
 * The command segments of a step's `run:`, or [] when the step's code has any
 * `|`, `;` or `&`: those could swallow an exit status (`|| true`, a pipe, a
 * trailing command or a background job) or skip a command (`if x; then`), so
 * such a step counts as neither running nor installing anything.
 */
function segmentsOf(step: unknown): string[][] {
  const code = codeOf(step);
  if (/[|;&]/.test(code)) return [];
  return shellSegments(code);
}

/**
 * Whether a segment runs `path` in command position: the command word ends
 * with `path`, or is `bash`/`sh` and the next word does. A `!`, or an
 * `if`/`while`/`until` condition, in front of the command does not count: the
 * script's exit status would no longer decide the step (`! ./test.sh` turns a
 * failure into success and is exempt from `set -e`).
 */
function segmentInvokes(words: string[], path: string): boolean {
  const i = statusPreservingCommandIndex(words);
  if (i === -1) return false;
  const head = words[i] ?? "";
  if (head.endsWith(path)) return true;
  return (head === "bash" || head === "sh") &&
    (words[i + 1] ?? "").endsWith(path);
}

/**
 * Whether a segment installs `RUNNER_PATH` by `install` or `cp` with the
 * runner script as a later word. An `echo` naming it does not count.
 */
function segmentInstallsRunner(words: string[]): boolean {
  const i = statusPreservingCommandIndex(words);
  if (i === -1) return false;
  const head = words[i] ?? "";
  return (head === "install" || head === "cp") &&
    words.slice(i + 1).some((w) => w.endsWith(RUNNER_PATH));
}

/** Whether a step runs `path` in command position with its exit status intact. */
function stepInvokes(step: unknown, path: string): boolean {
  return segmentsOf(step).some((w) => segmentInvokes(w, path));
}

/** Whether a step installs the runner script with its exit status intact. */
function stepInstallsRunner(step: unknown): boolean {
  return segmentsOf(step).some(segmentInstallsRunner);
}

/**
 * Whether the step's code is only `set -euo pipefail` (optional) and exactly
 * one segment invoking `path`.
 */
function stepIsOnlyScript(step: unknown, path: string): boolean {
  const rest = segmentsOf(step).filter((w) =>
    w.join(" ") !== "set -euo pipefail"
  );
  return rest.length === 1 && segmentInvokes(rest[0] ?? [], path);
}

/** The job entries of a parsed workflow as `[name, job]` pairs. */
function jobEntries(
  workflow: Record<string, unknown>,
): [string, Record<string, unknown>][] {
  if (!isObject(workflow.jobs)) return [];
  return Object.entries(workflow.jobs).filter((
    entry,
  ): entry is [string, Record<string, unknown>] => isObject(entry[1]));
}

/**
 * Check a parsed aws-emulator.yml. Returns human-readable findings, each
 * prefixed with its invariant in square brackets; an empty list means the
 * workflow is sound.
 */
export function checkAwsEmulatorWorkflow(workflow: unknown): string[] {
  if (!isObject(workflow)) {
    return ["workflow is not an object"];
  }
  const problems: string[] = [];
  const jobs = jobEntries(workflow);

  // (a) the test step, in the job that runs it.
  const testJob = jobs.find(([, job]) =>
    stepsOf(job).some((s) => stepInvokes(s, SCRIPT_PATH))
  );
  if (!testJob) {
    problems.push(
      `[test-step] no step runs ${SCRIPT_PATH} in command position with its exit status intact`,
    );
  } else {
    const [jobId, job] = testJob;
    const steps = stepsOf(job);
    const testIndex = steps.findIndex((s) => stepInvokes(s, SCRIPT_PATH));
    const testStep = steps[testIndex];
    if (!stepIsOnlyScript(testStep, SCRIPT_PATH)) {
      problems.push(
        `[test-step] the ${SCRIPT_PATH} step must run only \`set -euo pipefail\` and the script, so nothing can skip or replace the deploy`,
      );
    }
    const softFails = [job, testStep].some((o) =>
      isObject(o) && o["continue-on-error"] !== undefined &&
      o["continue-on-error"] !== false
    );
    if (softFails) {
      problems.push(
        `[test-step] continue-on-error must not be set on job ${jobId} or its ${SCRIPT_PATH} step: a failed deploy must fail the job`,
      );
    }
    if (
      [job, testStep].some((o) => isObject(o) && o.if !== undefined)
    ) {
      problems.push(
        `[test-step] an if: on job ${jobId} or its ${SCRIPT_PATH} step could skip the deploy, and a skipped job reports success`,
      );
    }

    // (b) the pinned install and the runner install come before the test.
    const toolchainIndex = steps.findIndex((s) =>
      stepInvokes(s, TOOLCHAIN_PATH)
    );
    if (toolchainIndex === -1) {
      problems.push(
        `[pinned-install] no step runs ${TOOLCHAIN_PATH} (the pinned, checksum-verified install) in command position with its exit status intact`,
      );
    } else if (toolchainIndex > testIndex) {
      problems.push(
        `[pinned-install] ${TOOLCHAIN_PATH} must run before the test step`,
      );
    }
    const cliIndex = steps.findIndex((s) => stepInvokes(s, CLI_TOOLCHAIN_PATH));
    if (cliIndex === -1) {
      problems.push(
        `[pinned-cli] no step runs ${CLI_TOOLCHAIN_PATH} (the pinned aws-cli the worker container uses) in command position with its exit status intact`,
      );
    } else if (cliIndex > testIndex) {
      problems.push(
        `[pinned-cli] ${CLI_TOOLCHAIN_PATH} must run before the test step`,
      );
    }
    const runnerIndex = steps.findIndex((s) => stepInstallsRunner(s));
    if (runnerIndex === -1) {
      problems.push(
        `[runner-install] no step installs ${RUNNER_PATH} with its exit status intact`,
      );
    } else if (runnerIndex > testIndex) {
      problems.push(
        `[runner-install] ${RUNNER_PATH} must be installed before the test step`,
      );
    }
  }

  // (c) no service container, no docker socket, no Floci.
  for (const [jobId, job] of jobs) {
    if (job.services !== undefined) {
      problems.push(
        `[no-services] job ${jobId} must not declare services: the emulator runs as a local process`,
      );
    }
  }
  const text = JSON.stringify(workflow);
  if (text.includes(DOCKER_SOCK)) {
    problems.push(
      `[no-docker-socket] no step or volume may mention ${DOCKER_SOCK}`,
    );
  }
  if (/floci/i.test(text)) {
    problems.push("[no-floci] nothing may reference Floci");
  }

  // (d) triggers. YAML 1.1 parsers may read `on` as boolean true.
  const triggers = isObject(workflow.on)
    ? workflow.on
    : isObject(workflow["true"])
    ? workflow["true"]
    : undefined;
  if (!isObject(triggers) || !("workflow_call" in triggers)) {
    problems.push(
      "[triggers] on.workflow_call must be present: quality.yml calls this workflow",
    );
  }
  if (isObject(triggers) && "pull_request" in triggers) {
    problems.push(
      "[triggers] on.pull_request must be absent: a standalone pull_request run is not part of quality.yml's gate",
    );
  }
  if ("concurrency" in workflow) {
    problems.push(
      "[no-concurrency] top-level concurrency must be absent: a called workflow inherits its caller's group and its own would cancel siblings",
    );
  }

  // (e) least-privilege token.
  const permissions = workflow.permissions;
  if (!isObject(permissions) || permissions.contents !== "read") {
    problems.push("[permissions] top-level permissions.contents must be read");
  }

  // (f) every checkout must not persist credentials.
  const checkouts = jobs.flatMap(([, job]) => stepsOf(job)).filter((s) =>
    isObject(s) && typeof s.uses === "string" &&
    s.uses.startsWith(CHECKOUT_PREFIX)
  );
  if (checkouts.length === 0) {
    problems.push("[checkout-credentials] no actions/checkout step found");
  }
  for (const checkout of checkouts) {
    const withBlock = isObject(checkout) && isObject(checkout.with)
      ? checkout.with
      : {};
    if (withBlock["persist-credentials"] !== false) {
      problems.push(
        "[checkout-credentials] actions/checkout step must set with.persist-credentials: false",
      );
    }
  }

  return problems;
}

/**
 * Check a parsed quality.yml: some job calls the AWS Emulator workflow and the
 * `gate` job needs that job. Never throws on malformed input.
 */
export function checkQualityCallsAwsEmulator(quality: unknown): string[] {
  if (!isObject(quality)) return ["quality workflow is not an object"];
  const problems: string[] = [];
  const jobs = jobEntries(quality);
  const caller = jobs.find(([, job]) => job.uses === AWS_EMULATOR_USES);
  if (!caller) {
    problems.push(
      `[gate-call] no quality.yml job has uses: ${AWS_EMULATOR_USES}`,
    );
    return problems;
  }
  const gate = jobs.find(([id]) => id === "gate")?.[1];
  const needs = gate?.needs;
  const list = Array.isArray(needs)
    ? needs
    : needs === undefined
    ? []
    : [needs];
  if (!list.includes(caller[0])) {
    problems.push(
      `[gate-needs] the gate job must need ${
        caller[0]
      }, so a failed or skipped AWS Emulator run turns gate red`,
    );
  }
  return problems;
}
