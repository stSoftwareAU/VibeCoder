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
 * A mutation job that another job in the workflow lists under `needs` feeds
 * that aggregator, so a required check on the aggregator fails with it; the
 * aggregator is named in the result. The `cargo mutants` flags of the job's
 * command (package, features, exclude patterns) are carried so the worker's
 * run uses them (see `extractCargoMutantsArgs`).
 *
 * Files that cannot be read or parsed, symlinks and files over 1 MiB are
 * reported in `unreadable` rather than being treated as non-blocking silently,
 * so the caller can log them. Script continuation joins are linear and each
 * YAML step mapping is scanned once per file, including aliased mappings.
 * Aggregator lookup scans each aliased needs array once.
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
  /**
   * The first job in the same workflow whose `needs` lists this job (the
   * aggregator that feeds a required check), when there is one.
   */
  aggregator?: string;
  /**
   * The `cargo mutants` flags of the job's command that change which mutants
   * are tried or how the tree builds (see `extractCargoMutantsArgs`), so the
   * worker's own run can use the same ones. Empty for other tools.
   */
  cargoArgs: string[];
  /** Mutation tool run by this CI command. */
  tool: "cargo" | "deno_task";
}

/** Result of scanning a repository's workflows for a blocking mutation job. */
export interface CiMutationContract {
  /** The first qualifying job in sorted file order, or `null` if none. */
  blocking: BlockingMutationJob | null;
  /** Workflow file names that could not be read or parsed. */
  unreadable: string[];
}

type Mapping = Record<string, unknown>;
class WorkflowScanBudgetExceeded extends Error {}

const CARGO_MUTANTS = /(?:^|[;&|])\s*cargo(?:\s+\+\S+)?[ -]mutants\b/;
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
 * `null` when that directory does not exist. Non-directory entries that are
 * not regular files (including symlinks) are reported as unreadable. Any other
 * read error propagates.
 */
async function listWorkflowFiles(
  repoPath: string,
  unreadable: string[],
): Promise<string[] | null> {
  const dir = `${repoPath}/${WORKFLOWS_DIR}`;
  const names: string[] = [];
  try {
    for (const component of [".github", ".github/workflows"]) {
      if (!(await Deno.lstat(`${repoPath}/${component}`)).isDirectory) {
        unreadable.push(component);
        return [];
      }
    }
    for await (const entry of Deno.readDir(dir)) {
      if (!isWorkflowName(entry.name)) continue;
      if (entry.isFile) names.push(entry.name);
      else if (!entry.isDirectory) unreadable.push(entry.name);
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
  let parts: string[] = [];
  for (const raw of run.split("\n")) {
    const text = parts.length === 0 ? raw : raw.trimStart();
    const trimmed = text.trimEnd();
    if (trimmed.endsWith("\\")) {
      parts.push(trimmed.slice(0, -1).trimEnd());
    } else {
      parts.push(text);
      lines.push(parts.join(" "));
      parts = [];
    }
  }
  if (parts.length > 0) lines.push(parts.join(" "));
  return lines;
}

/**
 * The first blocking mutation command line of a job (the line `cargoArgs` is
 * read from), or `null` when no step of the job runs the tool in a way that
 * can fail it. Share `seen` across a file's jobs to bound alias scanning.
 */
export function blockingMutationLine(
  job: Mapping,
  seen = new WeakSet<object>(),
  budget = { remaining: MAX_WORKFLOW_BYTES },
): string | null {
  if (isTrueFlag(job["continue-on-error"])) return null;
  const steps = job.steps;
  if (!Array.isArray(steps)) return null;
  for (const step of steps) {
    // Charge even aliases and non-mappings: an aliased array can be revisited
    // by many jobs without adding any new mappings or run characters.
    if (--budget.remaining < 0) throw new WorkflowScanBudgetExceeded();
    // YAML aliases share object identity, including across jobs. Scan each
    // eligible mapping once per file so aliases cannot multiply run work.
    if (!isMapping(step) || seen.has(step)) continue;
    seen.add(step);
    if (
      typeof step.run !== "string" ||
      isTrueFlag(step["continue-on-error"])
    ) continue;
    const run = step.run;
    budget.remaining -= run.length;
    if (budget.remaining < 0) throw new WorkflowScanBudgetExceeded();
    const line = logicalLines(run).find((l) =>
      !isNonFailing(l) && (CARGO_MUTANTS.test(l) || DENO_MUTATION_TASK.test(l))
    );
    if (line !== undefined) return line;
  }
  return null;
}

/** Longest flag value taken from a workflow file. */
const MAX_FLAG_VALUE_LENGTH = 500;

/** `cargo mutants` flags that take a value, as `--flag value` or `--flag=value`. */
const VALUE_FLAGS = new Set([
  "--package",
  "-p",
  "--exclude",
  "-e",
  "--re",
  "--regex",
  "--examine-regex",
  "--exclude-regex",
  "-f",
  "--file",
  "--exclude-re",
  "-E",
  "--examine-re",
  "-F",
  "--features",
]);

/** `cargo mutants` flags without a value. */
const BOOLEAN_FLAGS = new Set([
  "--workspace",
  "--all-features",
  "--no-default-features",
]);

/**
 * The `cargo mutants` flags in one command line that decide which mutants are
 * tried or how the tree builds: package, workspace, feature and the
 * exclude/examine patterns. Output, diff, jobs, timeout and shuffle flags are
 * left to the worker. Values are passed as separate argv words (never through
 * a shell); a value that is empty, starts with `-`, holds a shell
 * metacharacter outside a quoted pair, or exceeds the length cap drops that
 * flag.
 */
export function extractCargoMutantsArgs(line: string): string[] {
  const match = CARGO_MUTANTS.exec(line);
  if (match === null) return [];
  const at = match.index + match[0].indexOf("cargo");
  // A quoted value may hold spaces; the quotes are removed by `clean`.
  const words = line.slice(at).match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) ?? [];
  const out: string[] = [];
  const clean = (raw: string): string | null => {
    const value = raw.replace(/^(["'])(.*)\1$/, "$2");
    if (
      value === "" || value.length > MAX_FLAG_VALUE_LENGTH ||
      value.startsWith("-") || /[;&|`$<>\\]/.test(value)
    ) return null;
    return value;
  };
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === ";" || word === "&&" || word === "||" || word === "|") break;
    if (BOOLEAN_FLAGS.has(word)) {
      out.push(word);
      continue;
    }
    const eq = word.indexOf("=");
    if (eq > 0 && VALUE_FLAGS.has(word.slice(0, eq))) {
      const value = clean(word.slice(eq + 1));
      if (value !== null) out.push(word.slice(0, eq), value);
      continue;
    }
    // A following flag is not this flag's value; it is read on its own turn.
    if (
      VALUE_FLAGS.has(word) && i + 1 < words.length &&
      !words[i + 1]!.startsWith("-")
    ) {
      const value = clean(words[i + 1]!);
      i++;
      if (value !== null) out.push(word, value);
    }
  }
  return out;
}

/** The first job whose `needs` lists `jobName`, if any. */
export function findAggregator(
  jobs: Mapping,
  jobName: string,
): string | undefined {
  const seen = new WeakSet<object>();
  for (const [name, job] of Object.entries(jobs)) {
    if (!isMapping(job) || name === jobName) continue;
    const needs = job.needs;
    if (typeof needs === "string") {
      if (needs === jobName) return name;
    } else if (Array.isArray(needs) && !seen.has(needs)) {
      seen.add(needs);
      if (needs.includes(jobName)) return name;
    }
  }
  return undefined;
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
  const unreadable: string[] = [];
  const files = await listWorkflowFiles(repoPath, unreadable);
  if (files === null) return { blocking: null, unreadable: [] };

  let blocking: BlockingMutationJob | null = null;

  for (const name of files) {
    let doc: unknown;
    try {
      const path = `${repoPath}/${WORKFLOWS_DIR}${name}`;
      const stat = await Deno.lstat(path);
      if (!stat.isFile || stat.size > MAX_WORKFLOW_BYTES) {
        unreadable.push(name);
        continue;
      }
      const text = await readWorkflow(path);
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

    const seen = new WeakSet<object>();
    const budget = { remaining: MAX_WORKFLOW_BYTES };
    for (const [jobName, job] of Object.entries(doc.jobs)) {
      let line: string | null;
      try {
        line = isMapping(job) ? blockingMutationLine(job, seen, budget) : null;
      } catch (error) {
        if (!(error instanceof WorkflowScanBudgetExceeded)) throw error;
        unreadable.push(name);
        break;
      }
      if (line !== null) {
        const aggregator = findAggregator(doc.jobs, jobName);
        blocking = {
          workflow: name,
          job: jobName,
          ...(aggregator !== undefined ? { aggregator } : {}),
          cargoArgs: extractCargoMutantsArgs(line),
          tool: CARGO_MUTANTS.test(line) ? "cargo" : "deno_task",
        };
        break;
      }
    }
  }

  return { blocking, unreadable: unreadable.sort() };
}

/** Bound both allocation and reads, including a file growing after lstat. */
const MAX_WORKFLOW_BYTES = 1024 * 1024;

async function readWorkflow(path: string): Promise<string> {
  using file = await Deno.open(path, { read: true });
  const stat = await file.stat();
  if (!stat.isFile || stat.size > MAX_WORKFLOW_BYTES) {
    throw new Error("Workflow is not a regular file within the size cap");
  }
  const bytes = new Uint8Array(MAX_WORKFLOW_BYTES + 1);
  let used = 0;
  while (used < bytes.length) {
    const read = await file.read(bytes.subarray(used));
    if (read === null) return new TextDecoder().decode(bytes.subarray(0, used));
    used += read;
  }
  throw new Error("Workflow exceeds the size cap");
}
