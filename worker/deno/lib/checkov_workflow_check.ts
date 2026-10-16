/**
 * Lock-step check between the Checkov CI job and the local quality stage
 * (Issue #3653).
 *
 * The CloudFormation scan runs twice: locally by the Checkov stage
 * (`lib/checkov_check.ts`), and in CI by `.github/workflows/checkov.yml`,
 * whose result the required `gate` job in `quality.yml` aggregates. Both must
 * scan the same pinned image with the same arguments, and the CI judge must
 * be the same `judgeCheckovRun`. {@link validateCheckovWorkflows} reads the two
 * workflow files as text and returns one problem per broken invariant:
 *
 *   a. checkov.yml is triggered by `workflow_call` and nothing else.
 *   b. Exactly one step runs the pinned scan: `docker run`, `--entrypoint
 *      checkov`, {@link CHECKOV_IMAGE} and {@link checkovScanArgs} in order.
 *   c. The scan step passes none of the flags that weaken a Checkov run.
 *   d. A step hands the report and Checkov's exit code to `checkov_report.ts`,
 *      and the scan step captures its exit with `|| status=$?`, so a non-zero
 *      Checkov exit reaches the judge rather than ending the step first.
 *   e. quality.yml has a job that calls checkov.yml, and `jobs.gate.needs`
 *      names that job.
 *   f. checkov.yml sets no `concurrency`, at top level or on any job. As a
 *      called workflow it inherits the caller's `github.workflow`, so a group
 *      of its own would cancel its siblings; quality.yml holds the one group.
 *
 * Commands are read as a shell would split them, approximately: `\`+newline
 * continuations are joined, quote characters are dropped, and the rest is
 * split on whitespace. This is a guard against drift, not a shell parser.
 *
 * Unparseable YAML is reported as a problem, never thrown.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { parse as parseYaml } from "@std/yaml/parse";
import { CHECKOV_WORKFLOW_PATH, checkovScanArgs } from "./checkov_check.ts";
import { CHECKOV_IMAGE } from "./pinned_actions.ts";
import { joinContinuations } from "./ci_install_pin_scanner.ts";

/** The quality workflow whose `gate` job must need the Checkov job. */
export const QUALITY_WORKFLOW_PATH = ".github/workflows/quality.yml";

/** The `uses:` reference quality.yml holds for the Checkov workflow. */
const CHECKOV_USES = `./${CHECKOV_WORKFLOW_PATH}`;

/** Checkov flags that weaken a run; a scan passing any of them is not the gate. */
export const WEAKENING_CHECKOV_FLAGS: readonly string[] = [
  "--soft-fail",
  "--soft-fail-on",
  "--hard-fail-on",
  "--skip-check",
  "--check",
  "--skip-path",
  "--skip-framework",
  "--baseline",
  "--external-checks-dir",
  "--config-file",
];

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A YAML sequence of strings, or a lone string as one entry; else empty. */
function stringList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Parses one workflow file, or returns the problem when it cannot be read. */
function parseWorkflow(
  text: string,
  path: string,
): { doc: Mapping } | { problem: string } {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = message.split("\n")[0];
    return { problem: `${path}: not valid YAML (${detail})` };
  }
  if (!isMapping(parsed)) return { problem: `${path}: not a YAML mapping` };
  return { doc: parsed };
}

/** The words of a shell command: continuations joined, quotes dropped. */
function shellWords(command: string): string[] {
  return joinContinuations(command)
    .map((line) => line.command)
    .flatMap((logical) => logical.split(/\s+/))
    .map((word) => word.replaceAll('"', "").replaceAll("'", ""))
    .filter((word) => word !== "");
}

/** Whether `run` occurs as a contiguous run of `words`. */
function containsRun(
  words: readonly string[],
  run: readonly string[],
): boolean {
  for (let at = 0; at + run.length <= words.length; at++) {
    if (run.every((word, offset) => words[at + offset] === word)) return true;
  }
  return false;
}

/** The shell words of every step in the workflow that has a `run:`. */
function runWords(doc: Mapping): string[][] {
  const jobs: Mapping = isMapping(doc.jobs) ? doc.jobs : {};
  const commands: string[][] = [];
  for (const body of Object.values(jobs)) {
    if (!isMapping(body) || !Array.isArray(body.steps)) continue;
    for (const step of body.steps) {
      if (isMapping(step) && typeof step.run === "string") {
        commands.push(shellWords(step.run));
      }
    }
  }
  return commands;
}

/** Whether the words are the pinned scan: image, entrypoint and arguments. */
function isScanCommand(words: readonly string[]): boolean {
  return containsRun(words, ["docker", "run"]) &&
    containsRun(words, ["--entrypoint", "checkov"]) &&
    containsRun(words, [CHECKOV_IMAGE]) &&
    containsRun(words, checkovScanArgs());
}

/** The trigger names of an `on:` value, whatever YAML form it takes. */
function triggerNames(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return stringList(on);
  if (isMapping(on)) return Object.keys(on);
  return [];
}

/** Invariants a through d and f, over the parsed checkov.yml. */
function checkovProblems(doc: Mapping): string[] {
  const path = CHECKOV_WORKFLOW_PATH;
  const problems: string[] = [];

  const triggers = triggerNames(doc.on);
  if (triggers.length !== 1 || triggers[0] !== "workflow_call") {
    problems.push(
      `${path}: \`on\` must be exactly \`workflow_call\` ` +
        `(found: ${triggers.join(", ") || "nothing"})`,
    );
  }

  const commands = runWords(doc);
  const scans = commands.filter(isScanCommand);
  if (scans.length === 0) {
    problems.push(
      `${path}: no step's run invokes the pinned Checkov scan ` +
        `(docker run --entrypoint checkov ${CHECKOV_IMAGE} ` +
        `${checkovScanArgs().join(" ")})`,
    );
  } else if (scans.length > 1) {
    problems.push(
      `${path}: ${scans.length} steps invoke the pinned Checkov scan; ` +
        "exactly one must",
    );
  }

  const weakening = WEAKENING_CHECKOV_FLAGS.filter((flag) =>
    scans.some((words) =>
      words.some((word) => word === flag || word.startsWith(`${flag}=`))
    )
  );
  if (weakening.length > 0) {
    problems.push(
      `${path}: the Checkov scan step passes weakening Checkov flag(s): ` +
        weakening.join(", "),
    );
  }

  const judged = commands.some((words) =>
    words.some((word) =>
      word === "checkov_report.ts" || word.endsWith("/checkov_report.ts")
    ) &&
    words.includes("--report") &&
    words.includes("--checkov-exit")
  );
  if (!judged) {
    problems.push(
      `${path}: no step runs checkov_report.ts with --report and ` +
        "--checkov-exit, so the report is never judged",
    );
  }

  if (
    scans.length > 0 &&
    !scans.every((words) => containsRun(words, ["||", "status=$?"]))
  ) {
    problems.push(
      `${path}: the Checkov scan step does not capture its exit with ` +
        "`|| status=$?`, so a failed scan ends the step before " +
        "checkov_report.ts judges it",
    );
  }

  const why =
    "as a called workflow it inherits the caller's github.workflow, " +
    "so its own group would cancel its siblings (quality.yml holds the one group)";
  if (Object.hasOwn(doc, "concurrency")) {
    problems.push(
      `${path}: top-level \`concurrency\` is not allowed; ${why}`,
    );
  }
  const jobs: Mapping = isMapping(doc.jobs) ? doc.jobs : {};
  for (const [key, body] of Object.entries(jobs)) {
    if (isMapping(body) && Object.hasOwn(body, "concurrency")) {
      problems.push(
        `${path}: job \`${key}\` sets \`concurrency\`, which is not allowed; ${why}`,
      );
    }
  }

  return problems;
}

/** Invariant e, over the parsed quality.yml. */
function qualityProblems(doc: Mapping): string[] {
  const jobs: Mapping = isMapping(doc.jobs) ? doc.jobs : {};
  const callers = Object.entries(jobs)
    .filter(([, body]) => isMapping(body) && body.uses === CHECKOV_USES)
    .map(([key]) => key);
  if (callers.length === 0) {
    return [`${QUALITY_WORKFLOW_PATH}: no job calls ${CHECKOV_USES}`];
  }

  const gate: Mapping = isMapping(jobs.gate) ? jobs.gate : {};
  const needs = stringList(gate.needs);
  if (!callers.some((key) => needs.includes(key))) {
    return [
      `${QUALITY_WORKFLOW_PATH}: jobs.gate.needs does not include ${
        callers[0]
      }`,
    ];
  }
  return [];
}

/**
 * Checks that the Checkov CI workflow and the quality workflow that calls it
 * hold the invariants the local Checkov stage relies on (Issue #3653).
 *
 * @param checkovYaml - The text of `.github/workflows/checkov.yml`.
 * @param qualityYaml - The text of `.github/workflows/quality.yml`.
 * @returns One problem per broken invariant; empty when both files hold.
 */
export function validateCheckovWorkflows(
  checkovYaml: string,
  qualityYaml: string,
): string[] {
  const problems: string[] = [];

  const checkov = parseWorkflow(checkovYaml, CHECKOV_WORKFLOW_PATH);
  if ("problem" in checkov) {
    problems.push(checkov.problem);
  } else {
    problems.push(...checkovProblems(checkov.doc));
  }

  const quality = parseWorkflow(qualityYaml, QUALITY_WORKFLOW_PATH);
  if ("problem" in quality) {
    problems.push(quality.problem);
  } else {
    problems.push(...qualityProblems(quality.doc));
  }

  return problems;
}
