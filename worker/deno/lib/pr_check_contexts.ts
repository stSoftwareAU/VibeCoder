/**
 * The check contexts a pull request into a branch always reports, derived
 * from the workflows themselves (Issue #858).
 *
 * A hand-maintained list of required status checks drifts silently, and this
 * repository's list drifted in both directions: `validate` was never added
 * (so two red commits auto-merged onto `main`, PRs #825 and #832), and jobs
 * added to CI later — `validate (no-runtime)` among them — were never added
 * to the ruleset either. Naming the two missing contexts fixes the instance;
 * deriving the set from the workflows closes the class.
 *
 * The rule is deliberately narrow: only a workflow that runs on **every** PR
 * into the branch contributes. A path-filtered workflow (`dependency-audit`)
 * does not report on every PR, and requiring one of its contexts would leave
 * the merge box waiting for a check that never arrives — the exact failure
 * `default_branch_ruleset.ts` avoids by intersecting with reported names.
 *
 * Anything this module cannot resolve — a job name carrying a non-matrix
 * expression, a matrix `include`/`exclude`, a reusable-workflow job — throws
 * rather than guessing. A wrong context here is a merge gate that either
 * never fires or never clears.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { anyBranchMatches } from "./workflow_branch_glob.ts";
import type { WorkflowFile } from "./workflow_scan_common.ts";
import { readOnBlock } from "./workflow_trigger_scanner.ts";

/** One check context, and the workflow job that reports it. */
export interface DerivedContext {
  /** The check name GitHub reports, e.g. `validate (tests 1/4)`. */
  context: string;
  /** Repo-relative workflow path, e.g. `.github/workflows/validate-scripts.yml`. */
  workflow: string;
  /** The job key inside that workflow. */
  job: string;
}

/** A context that runs on every PR and is deliberately not required. */
export interface ExemptContext {
  context: string;
  /** Why it is not required. Recorded so the exemption is a decision. */
  reason: string;
}

/**
 * Contexts that report on a `main` PR and are deliberately **not** required.
 *
 * Each entry is a decision, not an oversight — a new CI job is missing from
 * the ruleset until someone either requires it or adds it here with a reason.
 */
export const EXEMPT_CONTEXTS: readonly ExemptContext[] = [
  {
    context: "Full-history secrets sweep (gitleaks + trufflehog)",
    reason: "the weekly full-history sweep; its `if:` skips it on every pull " +
      "request, so requiring it would gate merges on a job that never runs",
  },
  {
    context: "Review dependency changes",
    reason:
      "advisory today — making the dependency review block a merge is a " +
      "separate operator decision from Issue #858, taken once it is green",
  },
  {
    context: "integration tests (not a required check)",
    reason:
      "the integration suites (PR #1170); they copy one of the repository's " +
      "own `.sh`/`.ps1` scripts into a temp tree and spawn `bash` or `pwsh`, " +
      "so requiring them would put a provisioned PowerShell between every " +
      "change and its merge — the exact cost #907 took out of the gate. The " +
      "job still runs on every PR and its result is still read; it just " +
      "cannot block one",
  },
  {
    context: "milestone-resurrection",
    reason:
      "milestone-only (Issue #1048); its `if:` skips every PR whose base and " +
      "head are both outside `milestone/*`, so requiring it on `main` would " +
      "gate ordinary merges on a job that never reports",
  },
];

/** The result of comparing the required contexts against the derived ones. */
export interface ContextReconciliation {
  /** Contexts every PR reports that the ruleset does not require. */
  missing: string[];
  /** Required contexts nothing reports — a merge box that never clears. */
  phantom: string[];
  /** Exemptions naming a context no workflow reports any more. */
  staleExemptions: string[];
}

/** Narrow an unknown to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fail loud, naming the workflow and job that cannot be resolved. */
function reject(workflow: string, job: string, detail: string): never {
  throw new Error(`${workflow}: job "${job}" ${detail}`);
}

/**
 * Does this workflow run on **every** pull request into `branch`?
 *
 * `on: pull_request` with no filters, or with a `branches` list matching
 * `branch`, qualifies. A `paths`/`paths-ignore` filter, a `types` list that
 * excludes `opened`, or a branch list that does not match, does not.
 */
function runsOnEveryPullRequest(parsed: unknown, branch: string): boolean {
  if (!isRecord(parsed)) return false;
  const on = readOnBlock(parsed);
  if (typeof on === "string") return on === "pull_request";
  if (Array.isArray(on)) return on.includes("pull_request");
  if (!isRecord(on)) return false;
  if (!("pull_request" in on)) return false;

  const pr = on["pull_request"];
  if (pr === null || pr === undefined) return true;
  if (!isRecord(pr)) return false;

  if ("paths" in pr || "paths-ignore" in pr) return false;
  if ("types" in pr) {
    const types = pr["types"];
    if (!Array.isArray(types) || !types.includes("opened")) return false;
  }
  if ("branches-ignore" in pr) {
    return !anyBranchMatches(pr["branches-ignore"], branch);
  }
  if ("branches" in pr) return anyBranchMatches(pr["branches"], branch);
  return true;
}

/** The matrix combinations a job expands into, as `matrix.<key>` bindings. */
function matrixCombinations(
  workflow: string,
  job: string,
  strategy: unknown,
): Array<Record<string, string>> {
  const matrix = isRecord(strategy) ? strategy["matrix"] : undefined;
  if (matrix === undefined) return [{}];
  if (!isRecord(matrix)) {
    reject(workflow, job, "has a strategy matrix that is not a mapping");
  }
  if ("include" in matrix || "exclude" in matrix) {
    reject(
      workflow,
      job,
      "uses a matrix include/exclude, which this check cannot expand — " +
        "name its contexts explicitly or add them to the exemption list",
    );
  }

  let combinations: Array<Record<string, string>> = [{}];
  for (const [key, values] of Object.entries(matrix)) {
    if (!Array.isArray(values) || values.length === 0) {
      reject(workflow, job, `has a matrix axis "${key}" that is not a list`);
    }
    combinations = combinations.flatMap((base) =>
      values.map((value) => ({ ...base, [key]: String(value) }))
    );
  }
  return combinations;
}

/** Substitute `${{ matrix.<key> }}` references in a job name template. */
function resolveName(
  workflow: string,
  job: string,
  template: string,
  bindings: Record<string, string>,
): string {
  let name = template;
  for (const [key, value] of Object.entries(bindings)) {
    // The axis name comes from the workflow file, so it is escaped before it
    // reaches a pattern — a key carrying regex metacharacters must match
    // literally, never widen the substitution.
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    name = name.replaceAll(
      new RegExp(`\\$\\{\\{\\s*matrix\\.${escaped}\\s*\\}\\}`, "g"),
      value,
    );
  }
  if (name.includes("${{")) {
    reject(
      workflow,
      job,
      `has a name that cannot be resolved statically: "${template}"`,
    );
  }
  return name;
}

/** The contexts one job reports, expanded over its matrix. */
function jobContexts(
  workflow: string,
  job: string,
  definition: unknown,
): string[] {
  if (!isRecord(definition)) return [];
  if ("uses" in definition) {
    reject(
      workflow,
      job,
      "calls a reusable workflow, whose check names this module does not " +
        "derive — require its contexts explicitly",
    );
  }
  const combinations = matrixCombinations(
    workflow,
    job,
    definition["strategy"],
  );
  const template = typeof definition["name"] === "string"
    ? definition["name"]
    : undefined;

  return combinations.map((bindings) => {
    if (template !== undefined) {
      return resolveName(workflow, job, template, bindings);
    }
    // GitHub names an unnamed matrix job `<job> (<value>, <value>)`.
    const values = Object.values(bindings);
    return values.length === 0 ? job : `${job} (${values.join(", ")})`;
  });
}

/**
 * Every check context a pull request into `branch` always reports.
 *
 * Composite actions and workflows that do not run on every such PR are
 * ignored; the result is ordered by workflow path then job, so a caller's
 * assertions stay deterministic.
 */
export function pullRequestCheckContexts(
  files: WorkflowFile[],
  branch: string,
): DerivedContext[] {
  const derived: DerivedContext[] = [];
  const seen = new Map<string, string>();

  for (const file of files) {
    if (file.kind !== "workflow") continue;
    if (!runsOnEveryPullRequest(file.parsed, branch)) continue;
    const jobs = isRecord(file.parsed) ? file.parsed["jobs"] : undefined;
    if (!isRecord(jobs)) continue;

    for (const [job, definition] of Object.entries(jobs)) {
      for (const context of jobContexts(file.path, job, definition)) {
        const owner = seen.get(context);
        if (owner !== undefined) {
          throw new Error(
            `${file.path}: check context "${context}" is also reported by ` +
              `${owner} — two jobs cannot share one context`,
          );
        }
        seen.set(context, `${file.path} (${job})`);
        derived.push({ context, workflow: file.path, job });
      }
    }
  }
  return derived;
}

/**
 * Compare the ruleset's required contexts against what CI reports.
 *
 * Both directions matter: a context CI reports and the ruleset omits is a
 * check that cannot block a merge (the Issue #858 bug), and a required
 * context nothing reports is a merge box that never clears.
 */
export function reconcileRequiredContexts(
  required: string[],
  derived: DerivedContext[],
  exempt: readonly ExemptContext[] = EXEMPT_CONTEXTS,
): ContextReconciliation {
  const requiredSet = new Set(required);
  const derivedSet = new Set(derived.map((d) => d.context));
  const exemptSet = new Set(exempt.map((e) => e.context));

  return {
    missing: derived
      .map((d) => d.context)
      .filter((c) => !requiredSet.has(c) && !exemptSet.has(c)),
    phantom: required.filter((c) => !derivedSet.has(c)),
    staleExemptions: [...exemptSet].filter((c) => !derivedSet.has(c)),
  };
}
