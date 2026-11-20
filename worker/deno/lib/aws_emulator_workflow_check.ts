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
 *   and the step's effective shell (its `shell:`, else the job's or the
 *   workflow's `defaults.run.shell`) is unset or on an allowlist: `bash` or
 *   `sh`, then only `--noprofile`, `--norc` and `-e`/`-u`/`-x`/`-o <name>`
 *   options, then optionally `{0}`; `-c`, `-s`, `-n`, `-o noexec`, extra
 *   words, `true {0}` and the like could pass without running the body
 *   (PR #5276 review);
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
 * `checkContainerBuildRunsAwsEmulator` checks the parsed container-build.yml:
 * job `container` has a step that runs the reference command as `agent` in a
 * fresh container of the image just built (`[container-agent-run]`): one
 * `docker run` with `--user agent`, an `--entrypoint` ending in
 * `/test-aws-emulator.sh` and a `--volume` of
 * `${GITHUB_WORKSPACE}/infra/cloudformation:`, with its exit status intact (no
 * `|`, `;` or `&`, no `!`), no `continue-on-error`, an `if:` of only
 * `env.IMAGE_CHANGED == 'true'`, and an effective shell that runs the body. Job
 * `container` itself has no `continue-on-error` and no `if:`, since a skipped
 * or soft-failing job hides the run.
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
import { defaultShell } from "./aws_emulator_in_ci_check.ts";

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

const SHELL_OPTION_NAMES = ["pipefail", "errexit", "nounset", "xtrace"];
const SHELL_COMMANDS = ["bash", "sh"].flatMap((name) => [
  name,
  `/bin/${name}`,
  `/usr/bin/${name}`,
]);

/**
 * Whether a `shell:` value runs the `run:` body, by allowlist: `bash` or `sh`,
 * bare or as `/bin/` or `/usr/bin/` (any other path could be a planted
 * look-alike), then zero or more of `--noprofile`, `--norc`, a cluster of
 * `e`/`u`/`x` flags, or `-o`/`-eo` followed by pipefail, errexit, nounset or
 * xtrace; then, if anything follows, exactly `{0}`. Everything else (`-c`,
 * `-s`, `-n`, `-o noexec`, extra words, other commands) is refused.
 */
function shellRunsBody(value: string): boolean {
  const words = value.trim().split(/\s+/);
  if (!SHELL_COMMANDS.includes(words[0] ?? "")) return false;
  let i = 1;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (w === "--noprofile" || w === "--norc" || /^-[eux]+$/.test(w)) {
      i += 1;
    } else if (
      /^-[eux]*o$/.test(w) && SHELL_OPTION_NAMES.includes(words[i + 1] ?? "")
    ) {
      i += 2;
    } else break;
  }
  const rest = words.slice(i);
  return rest.length === 0 || (rest.length === 1 && rest[0] === "{0}");
}

/**
 * Whether a step's effective shell (`step.shell`, else the job's, else the
 * workflow's `defaults.run.shell`) runs the `run:` body: unset, or allowed by
 * `shellRunsBody`. Returns the shell value in `value`, for the finding message.
 */
function effectiveShell(
  workflow: Record<string, unknown>,
  job: Record<string, unknown>,
  step: unknown,
): { runsBody: boolean; value: unknown } {
  const value = (isObject(step) ? step.shell : undefined) ??
    defaultShell(job) ?? defaultShell(workflow);
  if (value === undefined) return { runsBody: true, value };
  if (typeof value !== "string") return { runsBody: false, value };
  return { runsBody: shellRunsBody(value), value };
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

    const shell = effectiveShell(workflow, job, testStep);
    if (!shell.runsBody) {
      problems.push(
        `[test-step] the ${SCRIPT_PATH} step's shell (step, job or workflow defaults.run.shell) must be bash or sh that runs the body; got ${
          JSON.stringify(shell.value)
        }`,
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
 * The only `docker run` flags the agent run may carry. Anything else fails
 * closed: `--env` could set `BASH_ENV` for the bash script, and `--mount` or
 * `--volumes-from` could shadow the mounted reference script.
 */
const DOCKER_VALUE_FLAGS = ["--user", "-u", "--volume", "-v", "--entrypoint"];
const DOCKER_BOOLEAN_FLAGS = ["--rm"];
/** The one volume source: the checkout's CloudFormation directory. */
const AGENT_VOLUME_SOURCE = "${GITHUB_WORKSPACE}/infra/cloudformation";
const AGENT_SCRIPT_NAME = "test-aws-emulator.sh";

/** Strip one surrounding pair of matching quotes. */
function unquote(word: string): string {
  const m = /^(["'])(.*)\1$/.exec(word);
  return m ? (m[2] ?? "") : word;
}

/**
 * Whether `volume` is `AGENT_VOLUME_SOURCE:D:ro` with `entrypoint` exactly
 * `D/test-aws-emulator.sh`, D an absolute path with no `.`, `..` or empty
 * segment. The entrypoint then names the script from the read-only mount.
 */
function volumeHoldsEntrypoint(volume: string, entrypoint: string): boolean {
  const parts = volume.split(":");
  if (parts.length !== 3) return false;
  const [source, dest, mode] = parts as [string, string, string];
  if (source !== AGENT_VOLUME_SOURCE || mode !== "ro") return false;
  const segments = dest.split("/");
  if (
    segments[0] !== "" || segments.length < 2 ||
    segments.slice(1).some((x) => x === "" || x === "." || x === "..")
  ) return false;
  return entrypoint === `${dest}/${AGENT_SCRIPT_NAME}`;
}

/**
 * Whether one segment is exactly the `docker run` of the agent reference
 * command. The arguments are parsed positionally and fail closed: an unknown
 * flag, a different image or any trailing word other than `< /dev/null` means
 * the segment does not count. The last `--user` must be `agent`; there must be
 * exactly one `--volume`, mounting `${GITHUB_WORKSPACE}/infra/cloudformation`
 * read-only at some D; and the last `--entrypoint` must be
 * `D/test-aws-emulator.sh`, so no second mount can shadow the script.
 */
function segmentRunsAwsEmulatorAsAgent(words: string[]): boolean {
  const i = statusPreservingCommandIndex(words);
  if (i === -1 || words[i] !== "docker" || words[i + 1] !== "run") return false;
  const users: string[] = [];
  const entrypoints: string[] = [];
  const volumes: string[] = [];
  let j = i + 2;
  while (j < words.length) {
    const w = words[j] ?? "";
    if (!w.startsWith("-")) break;
    if (DOCKER_BOOLEAN_FLAGS.includes(w)) {
      j += 1;
      continue;
    }
    const eq = w.indexOf("=");
    const flag = eq === -1 ? w : w.slice(0, eq);
    if (!DOCKER_VALUE_FLAGS.includes(flag)) return false;
    let value: string;
    if (eq !== -1) {
      value = w.slice(eq + 1);
      j += 1;
    } else {
      if (j + 1 >= words.length) return false;
      value = words[j + 1] ?? "";
      j += 2;
    }
    value = unquote(value);
    if (flag === "--user" || flag === "-u") users.push(value);
    else if (flag === "--entrypoint") entrypoints.push(value);
    else volumes.push(value);
  }
  if (unquote(words[j] ?? "") !== "${IMAGE}") return false;
  const tail = words.slice(j + 1).join(" ");
  if (tail !== "< /dev/null" && tail !== "</dev/null") return false;
  return users[users.length - 1] === "agent" && volumes.length === 1 &&
    volumeHoldsEntrypoint(
      volumes[0] ?? "",
      entrypoints[entrypoints.length - 1] ?? "",
    );
}

/**
 * Whether a step sets its own `IMAGE` (or an `env:` that is not a plain map,
 * such as an expression, which could resolve to one). The agent-run step
 * itself may set no `env:` at all: `BASH_ENV` or `DOCKER_HOST` there would
 * replace the docker command or its daemon.
 */
function stepOverridesImage(step: unknown): boolean {
  if (!isObject(step) || step.env === undefined) return false;
  return !isObject(step.env) || "IMAGE" in step.env;
}

/**
 * Whether a segment is `docker build` tagging `${IMAGE}` (`-t`, `--tag`, or
 * either with `=`).
 */
function segmentBuildsImage(words: string[]): boolean {
  const i = statusPreservingCommandIndex(words);
  if (i === -1 || words[i] !== "docker" || words[i + 1] !== "build") {
    return false;
  }
  return words.slice(i + 2).some((w, k, rest) => {
    if (w === "-t" || w === "--tag") {
      return unquote(rest[k + 1] ?? "") === "${IMAGE}";
    }
    const m = /^(?:-t|--tag)=(.*)$/.exec(w);
    return m !== null && unquote(m[1] ?? "") === "${IMAGE}";
  });
}

/**
 * A step that could change what `${IMAGE}` names between the build and the
 * agent run: it runs a docker/podman command that
 * builds, tags, pulls, loads, imports or commits an image and mentions
 * `IMAGE` or the job's literal tag. A build of some other tag (the job's
 * bad-provider-set probe) does not count. Matched over the step's text, so a
 * mention fails closed.
 */
function stepMayRetagImage(step: unknown, jobTag: string): boolean {
  const text = codeOf(step);
  const retags =
    /\b(?:docker|podman)\s+(?:image\s+)?(?:build|buildx|tag|pull|load|import|commit)\b/
      .test(text);
  return retags &&
    (text.includes("IMAGE") || (jobTag !== "" && text.includes(jobTag)));
}

/**
 * Whether the step's code is only `set -euo pipefail` (optional) and exactly
 * one segment that is the agent `docker run`.
 */
function stepIsAgentRun(step: unknown): boolean {
  const rest = segmentsOf(step).filter((w) =>
    w.join(" ") !== "set -euo pipefail"
  );
  return rest.length === 1 && segmentRunsAwsEmulatorAsAgent(rest[0] ?? []);
}

/**
 * Check a parsed container-build.yml: job `container` has a step that runs the
 * AWS Emulator reference command as `agent` in a fresh container, with its
 * exit status intact (`[container-agent-run]`). Never throws on malformed
 * input.
 */
export function checkContainerBuildRunsAwsEmulator(
  workflow: unknown,
): string[] {
  const tag = "[container-agent-run]";
  if (!isObject(workflow)) return [`${tag} workflow is not an object`];
  const job = jobEntries(workflow).find(([id]) => id === "container")?.[1];
  const step = job === undefined
    ? undefined
    : stepsOf(job).find(stepIsAgentRun);
  if (job === undefined || step === undefined || !isObject(step)) {
    return [
      `${tag} no step in job container runs the AWS Emulator reference command as agent (docker run --rm --user agent, exactly one read-only infra/cloudformation volume at D, --entrypoint D/test-aws-emulator.sh, image \${IMAGE}) with its exit status intact`,
    ];
  }
  const problems: string[] = [];
  if (
    job["continue-on-error"] !== undefined &&
    job["continue-on-error"] !== false
  ) {
    problems.push(
      `${tag} job container must not set continue-on-error: a soft-failing job hides the agent run`,
    );
  }
  if (job.if !== undefined) {
    problems.push(
      `${tag} job container must not have an if:: a skipped job hides the agent run`,
    );
  }
  const coe = step["continue-on-error"];
  if (coe !== undefined && coe !== false) {
    problems.push(
      `${tag} the agent-run step must not set continue-on-error: a failed run must fail the check`,
    );
  }
  if (step.if !== undefined && step.if !== "env.IMAGE_CHANGED == 'true'") {
    problems.push(
      `${tag} the agent-run step's if: must be absent or exactly env.IMAGE_CHANGED == 'true', the job's image gate; got ${
        JSON.stringify(step.if)
      }`,
    );
  }
  const steps = stepsOf(job);
  const stepIndex = steps.indexOf(step);
  if (step.env !== undefined) {
    problems.push(
      `${tag} the agent-run step must not set env: IMAGE, BASH_ENV or DOCKER_HOST there would change what runs`,
    );
  }
  const envWriter = steps.find((s) => /GITHUB_(?:ENV|PATH)/.test(codeOf(s)));
  if (envWriter !== undefined) {
    problems.push(
      `${tag} no step in job container may write GITHUB_ENV or GITHUB_PATH: either could change IMAGE, IMAGE_CHANGED or the docker on the PATH for the agent run`,
    );
  }
  const jobEnv = job.env;
  const jobTag = isObject(jobEnv) && typeof jobEnv.IMAGE === "string"
    ? jobEnv.IMAGE
    : "";
  if (jobTag === "") {
    problems.push(
      `${tag} job container must set env.IMAGE to the tag its docker build step builds`,
    );
  }
  if (
    !isObject(jobEnv) ||
    jobEnv.IMAGE_CHANGED !== "${{ needs.changes.outputs.image }}"
  ) {
    problems.push(
      `${tag} job container must set env.IMAGE_CHANGED to exactly \${{ needs.changes.outputs.image }}: a constant would skip the build and the agent run`,
    );
  }
  const buildIndex = steps.findIndex((s, k) =>
    k < stepIndex && !stepOverridesImage(s) &&
    segmentsOf(s).some(segmentBuildsImage)
  );
  if (buildIndex === -1) {
    problems.push(
      `${tag} no earlier step in job container runs docker build -t "\${IMAGE}" without its own env.IMAGE: the agent run must use the image just built`,
    );
  } else if (
    steps.slice(buildIndex + 1, stepIndex).some((s) =>
      stepMayRetagImage(s, jobTag)
    )
  ) {
    problems.push(
      `${tag} a step between the docker build and the agent run builds, tags, pulls, loads, imports or commits an image, so \${IMAGE} may no longer be the image just built`,
    );
  }
  const shell = effectiveShell(workflow, job, step);
  if (!shell.runsBody) {
    problems.push(
      `${tag} the agent-run step's shell (step, job or workflow defaults.run.shell) must be bash or sh that runs the body; got ${
        JSON.stringify(shell.value)
      }`,
    );
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
