/**
 * Decides whether the repository's CI blocks on a mutation-testing job, so the
 * worker's own mutation check survivors can be treated as blocking (Issue #4617).
 *
 * This is a local approximation of "a required check, or the job that feeds
 * it". The worker has no access to branch protection from here, so any
 * PR-triggered job that runs the mutation tool and can fail the workflow is
 * treated as blocking. A job that is marked `continue-on-error`, or a step
 * that is, or a command line that ends in a no-op tail (`|| true`, `|| :`,
 * `|| exit 0` or `|| /bin/true`; see `isNonFailing`), cannot fail the workflow
 * and so does not count.
 *
 * Known limits:
 * - A job that only calls a reusable workflow (`uses:`) is not inspected, so a
 *   mutation run inside that called workflow is not detected.
 * - Only cargo-mutants (`cargo mutants` or `cargo-mutants`, optionally with a
 *   `+toolchain` word such as `cargo +nightly mutants`) and `deno task` with a
 *   task name containing `mutat` are recognised. Other tools are not.
 * - Any PR-triggered job counts. Job-level `if:` and path filters are not
 *   evaluated, and branch protection is not read.
 * - A no-op tail is taken to cover the whole logical line, so
 *   `cargo mutants; echo done || true` is treated as non-failing even though
 *   the `cargo mutants` failure would stop the step.
 *
 * Files that cannot be read or parsed are reported in `unreadable` rather than
 * being treated as non-blocking silently, so the caller can log them.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { parse as parseYaml } from "@std/yaml/parse";
import { WORKFLOWS_DIR } from "./workflow_scope.ts";

/** A PR-triggered workflow job that runs the mutation tool and can fail. */
export interface BlockingMutationJob {
  /** Workflow file name, e.g. "mutants.yml". */
  workflow: string;
  /** Job key under `jobs:`. */
  job: string;
}

/** Result of scanning a repository's workflows for a blocking mutation job. */
export interface CiMutationContract {
  /** The first qualifying job in sorted file order, or `null` if none. */
  blocking: BlockingMutationJob | null;
  /** Workflow file names that could not be read or parsed. */
  unreadable: string[];
}

type Mapping = Record<string, unknown>;

const CARGO_MUTANTS = /\bcargo(?:\s+\+\S+)?[ -]mutants\b/;
const DENO_MUTATION_TASK = /\bdeno\s+task\s+\S*mutat\S*/i;

/** Only `*.yml` / `*.yaml` names are workflows. */
function isWorkflowName(name: string): boolean {
  return name.endsWith(".yml") || name.endsWith(".yaml");
}

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `true` and `"true"` both mean the flag is set. */
function isTrueFlag(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * Sorted names of the workflow files directly under `.github/workflows/`, or
 * `null` when that directory does not exist. Any other read error propagates.
 */
async function listWorkflowFiles(repoPath: string): Promise<string[] | null> {
  const dir = `${repoPath}/${WORKFLOWS_DIR}`;
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isDirectory && isWorkflowName(entry.name)) {
        names.push(entry.name);
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  return names.sort();
}

/**
 * Whether the trigger includes `pull_request`. The `on` key may parse as the
 * string "on" or as "true" (YAML 1.1 boolean). `pull_request_target` does not
 * count.
 */
function triggersOnPullRequest(doc: Mapping): boolean {
  const trigger = doc.on !== undefined ? doc.on : doc["true"];
  if (typeof trigger === "string") return trigger === "pull_request";
  if (Array.isArray(trigger)) return trigger.includes("pull_request");
  if (isMapping(trigger)) return Object.hasOwn(trigger, "pull_request");
  return false;
}

/** No-op tails that stop a command from failing the step, matched at line end. */
const NON_FAILING_TAILS = [
  "|| true",
  "||true",
  "|| :",
  "|| exit 0",
  "|| /bin/true",
];

/** A ` #` comment marker: a tail after it would sit inside the comment. */
const COMMENT_MARKER = /(?:^|\s)#/;

/**
 * Whether a logical line ends in a no-op tail, so its command cannot fail the
 * step. The line is trimmed and one trailing `;` removed before matching. A
 * line with a ` #` comment marker is never non-failing, because the tail would
 * sit inside the comment and the command would still fail the step.
 */
function isNonFailing(line: string): boolean {
  if (COMMENT_MARKER.test(line)) return false;
  const body = line.trim().replace(/;$/, "").trimEnd();
  return NON_FAILING_TAILS.some((tail) => body.endsWith(tail));
}

/**
 * The logical lines of a `run` script. A line ending in `\` continues onto the
 * next line, so the two are joined with one space.
 */
function logicalLines(run: string): string[] {
  const lines: string[] = [];
  let carry: string | null = null;
  for (const raw of run.split("\n")) {
    const text: string = carry === null ? raw : `${carry} ${raw.trimStart()}`;
    const trimmed: string = text.trimEnd();
    if (trimmed.endsWith("\\")) {
      carry = trimmed.slice(0, -1).trimEnd();
    } else {
      lines.push(text);
      carry = null;
    }
  }
  if (carry !== null) lines.push(carry);
  return lines;
}

/**
 * Whether one `run` script contains a mutation-tool invocation that can fail
 * the step. Each logical line (see `logicalLines`) is checked unless it is
 * non-failing (see `isNonFailing`).
 */
function runFailsOnMutation(run: string): boolean {
  return logicalLines(run).some((line) =>
    !isNonFailing(line) &&
    (CARGO_MUTANTS.test(line) || DENO_MUTATION_TASK.test(line))
  );
}

/** Whether a job runs the mutation tool in a step that can fail the job. */
function jobRunsBlockingMutation(job: Mapping): boolean {
  if (isTrueFlag(job["continue-on-error"])) return false;
  const steps = job.steps;
  if (!Array.isArray(steps)) return false;
  return steps.some((step) =>
    isMapping(step) &&
    typeof step.run === "string" &&
    !isTrueFlag(step["continue-on-error"]) &&
    runFailsOnMutation(step.run)
  );
}

/**
 * Finds the first PR-triggered job that runs the mutation tool in a way that
 * can fail the workflow. Every workflow file is parsed, so `unreadable` is
 * complete even when a blocking job is found earlier in the sort order.
 *
 * Returns `{ blocking: null, unreadable: [] }` when `.github/workflows/` does
 * not exist. Any other directory-read error is thrown.
 */
export async function findBlockingMutationJob(
  repoPath: string,
): Promise<CiMutationContract> {
  const files = await listWorkflowFiles(repoPath);
  if (files === null) return { blocking: null, unreadable: [] };

  const unreadable: string[] = [];
  let blocking: BlockingMutationJob | null = null;

  for (const name of files) {
    let doc: unknown;
    try {
      const text = await Deno.readTextFile(
        `${repoPath}/${WORKFLOWS_DIR}${name}`,
      );
      doc = parseYaml(text);
    } catch {
      unreadable.push(name);
      continue;
    }
    if (!isMapping(doc)) {
      unreadable.push(name);
      continue;
    }
    if (blocking !== null || !triggersOnPullRequest(doc)) continue;
    if (!isMapping(doc.jobs)) continue;

    for (const [jobName, job] of Object.entries(doc.jobs)) {
      if (isMapping(job) && jobRunsBlockingMutation(job)) {
        blocking = { workflow: name, job: jobName };
        break;
      }
    }
  }

  return { blocking, unreadable };
}
