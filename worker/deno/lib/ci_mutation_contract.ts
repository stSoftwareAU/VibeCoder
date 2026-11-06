/**
 * Decides whether the repository's CI blocks on a mutation-testing job, so the
 * worker's own mutation check survivors can be treated as blocking (Issue #4617).
 *
 * This approximates "a required check, or the job that feeds it". With the
 * base branch's required checks, a job counts when its check or an aggregator's
 * is required; without them any PR-triggered job that runs the mutation tool
 * and can fail the workflow is treated as blocking. A job that is marked
 * `continue-on-error`, or a step that is, or a command line that ends in a
 * no-op tail (`|| true`, `|| :`, `|| exit 0` or `|| /bin/true`; see
 * `isNonFailing`), cannot fail the workflow and so does not count.
 *
 * A job that calls a local reusable workflow is inspected through that
 * workflow's jobs, and the result names both (`caller (reusable called.yml:
 * inner)`). The local forms `./.github/workflows/...` and
 * `$/.github/workflows/...` are followed; a local `uses:` with an `@ref` is not.
 *
 * Known limits:
 * - Local `./` or `$/` `.github/workflows/*.yml|yaml` callees (`uses:`) that
 *   declare `workflow_call` are followed without a ref, including nested local
 *   calls: a called job that calls another local workflow is followed up to
 *   `MAX_REUSABLE_DEPTH` (nine) callee levels, so a deeper chain is bounded
 *   rather than unlimited, and a workflow already on the call path is not
 *   followed again.
 * - A remote reusable workflow (`owner/repo/.github/workflows/x.yml@ref`) is
 *   followed only when the caller passes `fetchRemoteWorkflow` (see
 *   `ci_mutation_lookup.ts`): at most `MAX_REMOTE_WORKFLOWS` distinct ones, to
 *   the same depth bound. One that cannot be read is reported in `unreadable`.
 *   A local `uses:` inside a remote workflow names a file of the remote
 *   repository, so it is not followed.
 * - Only cargo-mutants (`cargo mutants` or `cargo-mutants`, optionally with a
 *   `+toolchain` word such as `cargo +nightly mutants`) and `deno task` with a
 *   task name containing `mutat` are recognised. Other tools are not.
 * - Job-level `if:` and path filters are not evaluated, and the flags of a
 *   `deno task` command are not read. Without `requiredChecks` every
 *   PR-triggered job counts. With them (the base branch's rulesets and branch
 *   protection), a job counts only when its own check, or the check of a job
 *   that needs it directly or through others, is required, so a
 *   mutation job that no required check covers does not block. A job name
 *   holding an expression cannot be matched and counts. An empty list means
 *   unknown, not none required.
 * - A no-op tail is taken to cover the whole logical line, so
 *   `cargo mutants; echo done || true` is treated as non-failing even though
 *   the `cargo mutants` failure would stop the step.
 *
 * A mutation job that another job in the workflow lists under `needs` feeds
 * that aggregator, so a required check on the aggregator fails with it; the
 * aggregator is named in the result. The `cargo mutants` flags of the job's
 * command (package, features, exclude patterns, `--timeout`, `--cargo-arg`,
 * `--test-tool`) are carried so the worker's run uses them (see `extractCargoMutantsArgs`).
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
import { calledWorkflowPath } from "./pr_check_contexts.ts";
import { WORKFLOWS_DIR } from "./workflow_scope.ts";

/** A PR-triggered workflow job that runs the mutation tool and can fail. */
export interface BlockingMutationJob {
  /** Workflow file name, e.g. "mutants.yml". */
  workflow: string;
  /**
   * The job key under `jobs:`, or for a reusable call `caller key (reusable
   * called.yml: called job key)`. A nested call repeats the form inside the
   * called job key, e.g. `caller key (reusable a.yml: mid (reusable b.yml:
   * inner))`.
   */
  job: string;
  /**
   * The first job in the same workflow whose `needs` lists this job (the
   * aggregator that feeds a required check), when there is one.
   */
  aggregator?: string;
  /**
   * The `cargo mutants` flags of the job's command that change which mutants
   * are tried or how the tree builds (see `extractCargoMutantsArgs`), so the
   * worker's own run can use the same ones. The command may be in the called
   * workflow's job. Empty for other tools.
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

/** A remote reusable workflow call, split from its `uses:` string. */
export interface RemoteWorkflowRef {
  /** `owner/repo`. */
  repo: string;
  /** Repo-relative path, e.g. `.github/workflows/mutants.yml`. */
  path: string;
  /** The branch, tag or commit after `@`. */
  ref: string;
}

/** What the caller can look up beyond the checked-out tree (Issue #4617). */
export interface FindBlockingMutationJobOptions {
  /**
   * Reads a remote reusable workflow's text, or `null` when it cannot be read
   * (no access, not found). Without it a remote `uses:` is not followed.
   */
  fetchRemoteWorkflow?: (ref: RemoteWorkflowRef) => Promise<string | null>;
  /**
   * The check contexts the base branch requires (branch protection and
   * rulesets). When non-empty, only a job whose check, or the check of a job
   * that needs it, is required counts. Absent or empty means unknown, and any
   * PR-triggered job counts, as before.
   */
  requiredChecks?: readonly string[];
}

type Mapping = Record<string, unknown>;
class WorkflowScanBudgetExceeded extends Error {}

const CARGO_MUTANTS = /(?:^|[;&|])\s*cargo(?:\s+\+\S+)?[ -]mutants\b/;
const DENO_MUTATION_TASK = /\bdeno\s+task\s+\S*mutat\S*/i;
/**
 * The path of a local reusable workflow, as `calledWorkflowPath` returns it
 * (the `./` or `$/` prefix stripped and any `@ref` removed), naming a file
 * directly under `.github/workflows/`. Anchored, so `..`, subdirectories and
 * any other path do not match.
 */
const REUSABLE_CALL = /^\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)$/;
/**
 * A remote reusable workflow call: `owner/repo/.github/workflows/<name>.yml@ref`.
 * Anchored and character-limited, so an expression (`${{ }}`), `..` and
 * subdirectories do not match.
 */
const REMOTE_REUSABLE =
  /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml)@([A-Za-z0-9_./-]+)$/;
/** Most distinct remote reusable workflows fetched for one repository. */
const MAX_REMOTE_WORKFLOWS = 8;
/**
 * Most local reusable workflow callee levels followed below a PR-triggered
 * caller: nine. A plain bound, so a deeper chain is bounded rather than
 * unlimited.
 */
const MAX_REUSABLE_DEPTH = 9;

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
 * Whether the trigger includes `event`, such as `pull_request` or
 * `workflow_call`. The `on` key may parse as the string "on" or as "true" (YAML
 * 1.1 boolean). Other events, such as `pull_request_target`, do not count.
 */
function triggersOn(doc: Mapping, event: string): boolean {
  const trigger = doc.on !== undefined ? doc.on : doc["true"];
  if (typeof trigger === "string") return trigger === event;
  if (Array.isArray(trigger)) return trigger.includes(event);
  if (isMapping(trigger)) return Object.hasOwn(trigger, event);
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
  "--timeout",
  "--cargo-arg",
  "--test-tool",
]);

/**
 * Value checks for the flags that need more than the general rule: the
 * per-mutant timeout is a number of seconds, the test tool is one of the two
 * tools cargo-mutants knows, and a cargo argument is itself a flag such as
 * `--release`, so it may start with `-`.
 */
const FLAG_VALUE_SHAPE: ReadonlyMap<string, RegExp> = new Map([
  ["--timeout", /^\d+(?:\.\d+)?$/],
  ["--test-tool", /^(?:cargo|nextest)$/],
  ["--cargo-arg", /^[\w.=:,@+/-]+$/],
]);

/** Flags whose value may start with `-`. */
const DASH_VALUE_FLAGS = new Set(["--cargo-arg"]);

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
  const clean = (flag: string, raw: string): string | null => {
    const value = raw.replace(/^(["'])(.*)\1$/, "$2");
    if (
      value === "" || value.length > MAX_FLAG_VALUE_LENGTH ||
      (value.startsWith("-") && !DASH_VALUE_FLAGS.has(flag)) ||
      /[;&|`$<>\\]/.test(value)
    ) return null;
    const shape = FLAG_VALUE_SHAPE.get(flag);
    return shape === undefined || shape.test(value) ? value : null;
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
      const value = clean(word.slice(0, eq), word.slice(eq + 1));
      if (value !== null) out.push(word.slice(0, eq), value);
      continue;
    }
    // A following flag is not this flag's value; it is read on its own turn.
    if (
      VALUE_FLAGS.has(word) && i + 1 < words.length &&
      (DASH_VALUE_FLAGS.has(word) || !words[i + 1]!.startsWith("-"))
    ) {
      const value = clean(word, words[i + 1]!);
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

/** The blocking line of a job, and the called job it came from, if any. */
interface JobHit {
  line: string;
  /**
   * Set when the line is in a job of a local reusable workflow the job calls.
   * `file` is that first callee; `job` is its job key, or for a deeper nested
   * call the inner display string (`mid (reusable b.yml: inner)`).
   */
  called?: { file: string; job: string };
}

/** The remote call a `uses:` string names, or `null` when it is not one. */
export function remoteWorkflowRef(uses: unknown): RemoteWorkflowRef | null {
  if (typeof uses !== "string") return null;
  const match = REMOTE_REUSABLE.exec(uses);
  if (match === null || match[2]!.includes("..")) return null;
  // `.` and `..` match the name characters but would steer the API path.
  if (match[1]!.split("/").some((part) => part === "." || part === "..")) {
    return null;
  }
  return { repo: match[1]!, path: match[2]!, ref: match[3]! };
}

/**
 * The reusable workflow a job `uses:`, with the key it is stored under.
 *
 * A local one has the `./` or `$/` form with no `@ref`, names a file directly
 * under `.github/workflows/`, is parsed and declares `workflow_call`. A remote
 * one (`owner/repo/.github/workflows/x.yml@ref`) is followed when the caller
 * fetched it. A workflow already on the call path `chain` is not followed
 * again. A relative call inside a remote workflow uses that repository and ref.
 */
function reusableCallee(
  job: Mapping,
  parsed: Map<string, Mapping>,
  chain: readonly string[],
): { file: string; doc: Mapping } | null {
  const uses = job.uses;
  if (typeof uses !== "string") return null;
  if (remoteWorkflowRef(uses) !== null) {
    const doc = parsed.get(uses);
    return doc === undefined || chain.includes(uses)
      ? null
      : { file: uses, doc };
  }
  if (uses.includes("@")) return null;
  if (!/^(\.|\$)\//.test(uses)) return null;
  const path = calledWorkflowPath(job);
  if (path === null) return null;
  const match = REUSABLE_CALL.exec(path);
  if (match === null) return null;
  const remote = remoteWorkflowRef(chain.at(-1));
  if (remote !== null) {
    const file = `${remote.repo}/${path}@${remote.ref}`;
    const doc = parsed.get(file);
    return doc === undefined || chain.includes(file) ? null : { file, doc };
  }
  const file = match[1]!;
  if (chain.includes(file)) return null;
  const doc = parsed.get(file);
  if (doc === undefined || !triggersOn(doc, "workflow_call")) return null;
  return { file, doc };
}

/**
 * The blocking line for one job of a PR-triggered workflow: the job's own steps
 * first. Otherwise, when the job `uses:` a local reusable workflow that declares
 * `workflow_call`, the blocking line of that workflow's jobs, which may in turn
 * call local reusable workflows (see `reusableCallee`). A remote `uses:` is followed only
 * when it was fetched; a local `uses:` with an `@ref` is not followed. `chain` lists the workflow files on the current call
 * path, the top-level caller first, so `chain.length - 1` callee levels have
 * been entered and no callee is followed past `MAX_REUSABLE_DEPTH` (nine).
 * Every job visited charges `budget`. Alternative matrix paths use separate
 * seen sets, while sharing the budget, so each path is scanned and fan-out stays
 * bounded across the whole call tree.
 */
function blockingJobHit(
  job: unknown,
  jobs: Mapping,
  jobName: string,
  parsed: Map<string, Mapping>,
  seen: WeakSet<object>,
  budget: { remaining: number },
  chain: readonly string[],
  required: readonly string[],
  prefix = "",
  inherited = false,
): JobHit | null {
  // Charge even non-mappings, so repeated reusable calls cannot fan out freely.
  if (--budget.remaining < 0) throw new WorkflowScanBudgetExceeded();
  if (!isMapping(job)) return null;
  const callee = reusableCallee(job, parsed, chain);
  const feeds = requiredFeeder(
    jobs,
    jobName,
    required,
    prefix,
    callee !== null,
  );
  const covered = inherited || feeds !== null;
  const line = blockingMutationLine(job, seen, budget);
  if (line !== null) return covered ? { line } : null;
  if (chain.length > MAX_REUSABLE_DEPTH) return null;
  if (callee === null) return null;
  const calledJobs = callee.doc.jobs;
  if (!isMapping(calledJobs)) return null;
  const displayName = typeof job.name === "string" ? job.name : jobName;
  const caller = `${prefix}${displayName}`;
  const prefixes = new Set([`${caller} / `]);
  for (const context of required) {
    if (!context.startsWith(`${caller} (`)) continue;
    const end = context.indexOf(") / ", caller.length + 2);
    if (end !== -1) prefixes.add(context.slice(0, end + 4));
  }
  for (const childPrefix of prefixes) {
    for (const [calledJob, body] of Object.entries(calledJobs)) {
      const hit = blockingJobHit(
        body,
        calledJobs,
        calledJob,
        parsed,
        prefixes.size > 1 ? new WeakSet<object>() : seen,
        budget,
        [
          ...chain,
          callee.file,
        ],
        required,
        childPrefix,
        covered,
      );
      if (hit !== null) {
        return {
          line: hit.line,
          called: {
            file: callee.file,
            job: hit.called === undefined
              ? calledJob
              : `${calledJob} (reusable ${hit.called.file}: ${hit.called.job})`,
          },
        };
      }
    }
  }
  return null;
}

/**
 * Finds the first PR-triggered job that runs the mutation tool in a way that
 * can fail the workflow, directly or through local reusable workflows it calls,
 * nested up to `MAX_REUSABLE_DEPTH` (nine) callee levels. Every workflow file
 * is read and parsed first, so `unreadable` is complete even when a blocking
 * job is found
 * earlier in the sort order.
 *
 * Returns `{ blocking: null, unreadable: [] }` when `.github/workflows/` does
 * not exist. Any other directory-read error is thrown.
 */
export async function findBlockingMutationJob(
  repoPath: string,
  options: FindBlockingMutationJobOptions = {},
): Promise<CiMutationContract> {
  const unreadable: string[] = [];
  const files = await listWorkflowFiles(repoPath, unreadable);
  if (files === null) return { blocking: null, unreadable: [] };

  // Pass 1: read and parse every file, keyed by file name in sorted order.
  const parsed = new Map<string, Mapping>();
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
    parsed.set(name, doc);
  }

  // Pass 1b: fetch the remote reusable workflows the local ones call.
  if (options.fetchRemoteWorkflow !== undefined) {
    await fetchRemoteWorkflows(parsed, options.fetchRemoteWorkflow, unreadable);
  }
  const required = options.requiredChecks ?? [];

  // Pass 2: detect in sorted file order.
  let blocking: BlockingMutationJob | null = null;

  for (const name of files) {
    const doc = parsed.get(name);
    if (doc === undefined) continue;
    if (blocking !== null || !triggersOn(doc, "pull_request")) continue;
    if (!isMapping(doc.jobs)) continue;

    const seen = new WeakSet<object>();
    const budget = { remaining: MAX_WORKFLOW_BYTES };
    for (const [jobName, job] of Object.entries(doc.jobs)) {
      let hit: JobHit | null;
      try {
        hit = blockingJobHit(job, doc.jobs, jobName, parsed, seen, budget, [
          name,
        ], required);
      } catch (error) {
        if (!(error instanceof WorkflowScanBudgetExceeded)) throw error;
        unreadable.push(name);
        break;
      }
      if (hit !== null) {
        const feeds = requiredFeeder(doc.jobs, jobName, required);
        const aggregator = feeds ?? findAggregator(doc.jobs, jobName);
        blocking = {
          workflow: name,
          job: hit.called === undefined
            ? jobName
            : `${jobName} (reusable ${hit.called.file}: ${hit.called.job})`,
          ...(aggregator !== undefined ? { aggregator } : {}),
          cargoArgs: extractCargoMutantsArgs(hit.line),
          tool: CARGO_MUTANTS.test(hit.line) ? "cargo" : "deno_task",
        };
        break;
      }
    }
  }

  return { blocking, unreadable: unreadable.sort() };
}

/** The remote reusable calls in the jobs of one parsed workflow. */
function remoteCalls(doc: Mapping, caller?: string): string[] {
  if (!isMapping(doc.jobs)) return [];
  return Object.values(doc.jobs).flatMap((job) => {
    if (!isMapping(job)) return [];
    if (remoteWorkflowRef(job.uses) !== null) return [job.uses as string];
    const remote = remoteWorkflowRef(caller);
    const path = calledWorkflowPath(job);
    if (remote === null || path === null || REUSABLE_CALL.exec(path) === null) {
      return [];
    }
    return [`${remote.repo}/${path}@${remote.ref}`];
  });
}

/**
 * Fetches the remote reusable workflows that local workflows call, and those
 * they call in turn, into `parsed` keyed by the full `uses:` string. At most
 * `MAX_REMOTE_WORKFLOWS` distinct workflows are fetched and at most
 * `MAX_REUSABLE_DEPTH` levels followed. One that cannot be fetched, parsed, or
 * does not declare `workflow_call` is reported in `unreadable` by its `uses:`
 * string, so its contract is unknown rather than treated as non-blocking.
 */
async function fetchRemoteWorkflows(
  parsed: Map<string, Mapping>,
  fetchText: NonNullable<FindBlockingMutationJobOptions["fetchRemoteWorkflow"]>,
  unreadable: string[],
): Promise<void> {
  const tried = new Set<string>();
  let level = [...parsed.values()].filter((d) =>
    triggersOn(d, "pull_request") || triggersOn(d, "workflow_call")
  ).flatMap((doc) => remoteCalls(doc));
  for (let depth = 0; depth <= MAX_REUSABLE_DEPTH; depth++) {
    const next: string[] = [];
    for (const uses of level) {
      if (tried.has(uses)) continue;
      tried.add(uses);
      if (tried.size > MAX_REMOTE_WORKFLOWS) {
        unreadable.push(uses);
        continue;
      }
      const ref = remoteWorkflowRef(uses)!;
      let doc: unknown;
      try {
        const text = await fetchText(ref);
        if (text === null || text.length > MAX_WORKFLOW_BYTES) {
          unreadable.push(uses);
          continue;
        }
        doc = parseYaml(text);
      } catch {
        unreadable.push(uses);
        continue;
      }
      if (!isMapping(doc) || !triggersOn(doc, "workflow_call")) {
        unreadable.push(uses);
        continue;
      }
      parsed.set(uses, doc);
      next.push(...remoteCalls(doc, uses));
    }
    if (next.length === 0) return;
    level = next;
  }
}

/**
 * Whether the job, or a job that needs it (directly or through others),
 * reports a required check (Issue #4617). Returns `undefined` when nothing is
 * known about required checks or the job's own check is required with no
 * aggregator in between, the name of the first required job that needs it when
 * an aggregator feeds the required check, and `null` when the required checks
 * are known and neither the job nor anything that needs it is among them. A
 * job name holding an expression cannot be matched, so it counts as required.
 */
function requiredFeeder(
  jobs: Mapping,
  jobName: string,
  required: readonly string[],
  prefix = "",
  skipOwn = false,
): string | null | undefined {
  if (required.length === 0) return undefined;
  const reports = (key: string): boolean => {
    const job = jobs[key];
    const name = isMapping(job) && typeof job.name === "string"
      ? job.name
      : key;
    return (name.includes("${{") &&
      required.some((context) => context.startsWith(prefix))) ||
      required.some((context) =>
        context === `${prefix}${name}` ||
        (context.startsWith(`${prefix}${name} (`) &&
          !context.slice((`${prefix}${name} (`).length).includes(" / "))
      );
  };
  if (!skipOwn && reports(jobName)) return undefined;
  const seen = new Set([jobName]);
  const queue = [jobName];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [name, job] of Object.entries(jobs)) {
      if (seen.has(name) || !isMapping(job)) continue;
      const needs = job.needs;
      const needed = typeof needs === "string"
        ? [needs]
        : Array.isArray(needs)
        ? needs
        : [];
      if (!needed.includes(current)) continue;
      if (reports(name)) return name;
      seen.add(name);
      queue.push(name);
    }
  }
  return null;
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
