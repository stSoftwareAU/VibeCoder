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
 *   script fails the job: the call is not followed by `|`, `;`, `&`, `||` or
 *   `&&`, and neither the job nor that step sets `continue-on-error` or an
 *   `if:` (PR #3478 review);
 * - (b) a step runs `container/toolchains/aws-emulator.sh` (the pinned,
 *   checksum-verified install), a step runs `container/toolchains/aws-cli.sh`
 *   (the pinned aws-cli, not the runner's own), and a step installs
 *   `container/aws-emulator-run.sh`, all before the test step;
 * - (c) the job has no `services`, no step or volume mentions
 *   `/var/run/docker.sock`, and nothing references Floci;
 * - (d) `pull_request` watches `infra/cloudformation/**`, the workflow itself,
 *   `container/aws-emulator-run.sh`, `container/toolchains/aws-emulator.sh`,
 *   `container/toolchains/aws-cli.sh` and `container/tools.json`, and targets `milestone/*` branches;
 * - (e) top-level `permissions.contents` is `read`;
 * - (f) every `actions/checkout` step sets `persist-credentials: false`.
 *
 * Each finding names its invariant in square brackets, e.g. `[test-step]`.
 *
 * No I/O: callers parse the YAML and pass the parsed value in.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

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
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * A shell word: a run of bare characters and quoted sections, so that
 * `CURL_RETRY="--retry 8"` is one word even though its quoted part has spaces.
 */
const WORD_RE = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
const REQUIRED_PATHS = [
  "infra/cloudformation/**",
  ".github/workflows/aws-emulator.yml",
  RUNNER_PATH,
  TOOLCHAIN_PATH,
  CLI_TOOLCHAIN_PATH,
  "container/tools.json",
];

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
 * Logical shell lines of a `run:` block: trimmed, comments and blank lines
 * dropped, and backslash-continued lines joined onto the line they continue.
 */
function logicalLines(run: string): string[] {
  const lines: string[] = [];
  let pending = "";
  for (const raw of run.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.endsWith("\\")) {
      pending += line.slice(0, -1) + " ";
      continue;
    }
    lines.push((pending + line).trim());
    pending = "";
  }
  if (pending.trim() !== "") lines.push(pending.trim());
  return lines;
}

/**
 * The command words of a shell line after any leading `sudo`, `env` and
 * `VAR=value` assignments. A quoted value stays one word, so
 * `env CURL_RETRY="--retry 8" bash x.sh` yields `["bash", "x.sh"]`.
 */
function commandWords(line: string): string[] {
  const words = line.match(WORD_RE) ?? [];
  let i = 0;
  while (
    i < words.length &&
    (words[i] === "sudo" || words[i] === "env" ||
      ASSIGNMENT_RE.test(words[i] ?? ""))
  ) {
    i++;
  }
  return words.slice(i);
}

/**
 * Whether a line runs `path` in command position with its exit status intact.
 * Any `|`, `;` or `&` on the line could swallow the status (`|| true`, a
 * pipe, a trailing command or a background job), so such a line does not
 * count. Accepts the path as the command, or as the script given to `bash` or
 * `sh`.
 */
function invokes(line: string, path: string): boolean {
  if (/[|;&]/.test(line)) return false;
  const words = commandWords(line);
  const head = words[0] ?? "";
  if (head.endsWith(path)) return true;
  return (head === "bash" || head === "sh") &&
    (words[1] ?? "").endsWith(path);
}

/**
 * Whether a line installs `RUNNER_PATH` by `install` or `cp` with the runner
 * script as a source, with the exit status intact. An `echo` naming it does
 * not count.
 */
function installsRunner(line: string): boolean {
  if (/[|;&]/.test(line)) return false;
  const words = commandWords(line);
  return (words[0] === "install" || words[0] === "cp") &&
    words.slice(1).some((w) => w.endsWith(RUNNER_PATH));
}

/** Whether any logical line of a step's `run:` satisfies `predicate`. */
function stepMatches(step: unknown, predicate: (line: string) => boolean) {
  return logicalLines(runOf(step)).some(predicate);
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
    stepsOf(job).some((s) => stepMatches(s, (l) => invokes(l, SCRIPT_PATH)))
  );
  if (!testJob) {
    problems.push(
      `[test-step] no step runs ${SCRIPT_PATH} in command position with its exit status intact`,
    );
  } else {
    const [jobId, job] = testJob;
    const steps = stepsOf(job);
    const testIndex = steps.findIndex((s) =>
      stepMatches(s, (l) => invokes(l, SCRIPT_PATH))
    );
    const testStep = steps[testIndex];
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
      stepMatches(s, (l) => invokes(l, TOOLCHAIN_PATH))
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
    const cliIndex = steps.findIndex((s) =>
      stepMatches(s, (l) => invokes(l, CLI_TOOLCHAIN_PATH))
    );
    if (cliIndex === -1) {
      problems.push(
        `[pinned-cli] no step runs ${CLI_TOOLCHAIN_PATH} (the pinned aws-cli the worker container uses) in command position with its exit status intact`,
      );
    } else if (cliIndex > testIndex) {
      problems.push(
        `[pinned-cli] ${CLI_TOOLCHAIN_PATH} must run before the test step`,
      );
    }
    const runnerIndex = steps.findIndex((s) => stepMatches(s, installsRunner));
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

  // (d) trigger paths. YAML 1.1 parsers may read `on` as boolean true.
  const triggers = isObject(workflow.on)
    ? workflow.on
    : isObject(workflow["true"])
    ? workflow["true"]
    : undefined;
  const prTrigger = isObject(triggers) ? triggers.pull_request : undefined;
  const paths = isObject(prTrigger) && Array.isArray(prTrigger.paths)
    ? prTrigger.paths
    : [];
  for (const required of REQUIRED_PATHS) {
    if (!paths.includes(required)) {
      problems.push(
        `[triggers] on.pull_request.paths must include ${required}`,
      );
    }
  }
  const prBranches = isObject(prTrigger) && Array.isArray(prTrigger.branches)
    ? prTrigger.branches
    : [];
  if (!prBranches.includes("milestone/*")) {
    problems.push(
      "[triggers] on.pull_request.branches must include milestone/*",
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
