/**
 * Does every workflow that reports a required status check also run on the
 * `merge_group` event? (Issue #4424)
 *
 * GitHub's merge queue runs the workflows on a `merge_group` event and waits
 * for the required checks to report on it. A required check whose workflow
 * never runs on `merge_group` never reports there, so the queue waits forever.
 * Enabling the queue on the default branch is therefore only safe once this
 * check passes.
 *
 * The verdict is three-valued and never guesses: `ok` when every required
 * context is reported by a workflow that has a `merge_group` trigger, `missing`
 * when one is definitively not (the queue would wait), and `unknown` when the
 * contexts or workflows cannot be established at all.
 *
 * Uses Australian English throughout (behaviour, organisation, authorised).
 */

import { parse as parseYaml } from "@std/yaml/parse";
import {
  type DerivedContext,
  pullRequestCheckContexts,
} from "./pr_check_contexts.ts";
import {
  type GhExec,
  isNotFoundError,
  isValidRepoSlug,
} from "./repo_rulesets.ts";
import type { WorkflowFile } from "./workflow_scan_common.ts";
import { readOnBlock } from "./workflow_trigger_scanner.ts";

/** The result of checking that required contexts can report on `merge_group`. */
export type MergeGroupCheck =
  | { status: "ok" }
  // Definitive: the queue would wait for a check that never reports.
  | {
    status: "missing";
    workflows: string[];
    contexts: string[];
    reason: string;
  }
  // Could not be established.
  | { status: "unknown"; reason: string };

/** Most workflow files a repository may carry before the check gives up. */
const MAX_WORKFLOW_FILES = 100;

/** A workflow file name the API path may safely interpolate. */
const WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9._-]+\.ya?ml$/;

/** Narrow an unknown to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The message of a thrown value, for a human-readable reason. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Quote and join a list for a reason sentence. */
function listOf(items: readonly string[], quote: string): string {
  return items.map((item) => `${quote}${item}${quote}`).join(", ");
}

/**
 * Does this parsed workflow have a `merge_group` trigger?
 *
 * Recognised: `on: merge_group` (string), `on: [pull_request, merge_group]`
 * (array), and `on: { merge_group: ... }` (mapping key, a null value counts).
 * A look-alike such as `merge_group_x` or `workflow_dispatch` is not.
 */
export function workflowHasMergeGroupTrigger(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;
  const on = readOnBlock(parsed);
  if (typeof on === "string") return on === "merge_group";
  if (Array.isArray(on)) return on.includes("merge_group");
  if (!isRecord(on)) return false;
  return "merge_group" in on;
}

/**
 * Can every required context report on the merge queue?
 *
 * Each required context is traced to the workflow that reports it: the gate
 * workflow when an aggregate gate covers it, else its own workflow. A required
 * context with no derived entry (for example one from a path-filtered
 * workflow) cannot be shown to run on `merge_group`, so it is `missing` too.
 *
 * Pure: reads only the given files.
 */
export function checkMergeGroupCoverage(
  files: WorkflowFile[],
  requiredContexts: readonly string[],
  branch: string,
): MergeGroupCheck {
  if (requiredContexts.length === 0) return { status: "ok" };

  let derived: DerivedContext[];
  try {
    derived = pullRequestCheckContexts(files, branch);
  } catch (error) {
    return { status: "unknown", reason: messageOf(error) };
  }

  const byContext = new Map(derived.map((d) => [d.context, d]));
  const workflows = new Set<string>();
  const gapContexts = new Set<string>();
  const unreported = new Set<string>();

  for (const required of requiredContexts) {
    const entry = byContext.get(required);
    if (entry === undefined) {
      unreported.add(required);
      continue;
    }

    let reporting = entry.workflow;
    if (entry.coveredBy !== undefined) {
      const gate = byContext.get(entry.coveredBy);
      if (gate === undefined) {
        return {
          status: "unknown",
          reason: `the gate "${entry.coveredBy}" that covers "${required}" ` +
            "is not among the derived check contexts",
        };
      }
      reporting = gate.workflow;
    }

    const file = files.find((f) => f.path === reporting);
    if (!workflowHasMergeGroupTrigger(file?.parsed)) {
      workflows.add(reporting);
      gapContexts.add(required);
    }
  }

  if (workflows.size === 0 && unreported.size === 0) return { status: "ok" };

  const sortedWorkflows = [...workflows].sort();
  const sortedGapContexts = [...gapContexts].sort();
  const sortedUnreported = [...unreported].sort();
  const contexts = [...new Set([...sortedGapContexts, ...sortedUnreported])]
    .sort();

  const problems: string[] = [];
  const fixes: string[] = [];
  if (sortedWorkflows.length > 0) {
    const one = sortedWorkflows.length === 1;
    problems.push(
      `${one ? "workflow" : "workflows"} ${listOf(sortedWorkflows, "`")} ` +
        `${one ? "has" : "have"} no \`merge_group\` trigger, so the required ` +
        `check(s) ${listOf(sortedGapContexts, '"')} ${
          one ? "it reports" : "they report"
        } ` +
        "would never report on the merge queue",
    );
    fixes.push(
      `add \`merge_group:\` to the \`on:\` block of ${
        listOf(sortedWorkflows, "`")
      } (job selection that reads the diff must then use ` +
        "`github.event.merge_group.base_sha` and `head_sha`, and run " +
        "everything when the diff cannot be read)",
    );
  }
  if (sortedUnreported.length > 0) {
    problems.push(
      `required check(s) ${listOf(sortedUnreported, '"')} come from no ` +
        "workflow that runs on every pull request, so they cannot be shown " +
        "to report on the merge queue",
    );
    fixes.push(
      "make the workflow that reports them run on every pull request and on " +
        "`merge_group`, or stop requiring them",
    );
  }

  return {
    status: "missing",
    workflows: sortedWorkflows,
    contexts,
    reason: `${problems.join("; and ")}; to fix, ${fixes.join("; and ")}.`,
  };
}

/**
 * Read every workflow file of a remote repository through the `gh` API.
 *
 * A missing `.github/workflows` directory is an empty set, not a failure.
 * Names are allowlisted before they reach an API path; anything else is
 * skipped, never fetched. More than {@link MAX_WORKFLOW_FILES} files is a
 * failure, never a partial read.
 */
export async function readRemoteWorkflowFiles(
  repo: string,
  ghFn: GhExec,
): Promise<{ ok: true; files: WorkflowFile[] } | { ok: false; error: string }> {
  if (!isValidRepoSlug(repo)) {
    return { ok: false, error: `"${repo}" is not a valid owner/repo slug` };
  }

  let listing: unknown;
  try {
    listing = JSON.parse(
      await ghFn(["api", `repos/${repo}/contents/.github/workflows`]),
    );
  } catch (error) {
    if (isNotFoundError(error)) return { ok: true, files: [] };
    return {
      ok: false,
      error: `could not list .github/workflows in ${repo}: ${messageOf(error)}`,
    };
  }
  if (!Array.isArray(listing)) {
    return {
      ok: false,
      error: `the .github/workflows listing for ${repo} is not a directory`,
    };
  }

  const names = listing
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .filter((entry) => entry["type"] === "file")
    .map((entry) => entry["name"])
    .filter((name): name is string =>
      typeof name === "string" &&
      WORKFLOW_NAME_PATTERN.test(name) &&
      !name.includes("..")
    );

  if (names.length > MAX_WORKFLOW_FILES) {
    return {
      ok: false,
      error: `${repo} has ${names.length} workflow files; the check reads at ` +
        `most ${MAX_WORKFLOW_FILES} and will not pass on a partial read`,
    };
  }

  const files: WorkflowFile[] = [];
  for (const name of names) {
    let rawText: string;
    try {
      rawText = await ghFn([
        "api",
        `repos/${repo}/contents/.github/workflows/${name}`,
        "-H",
        "Accept: application/vnd.github.raw+json",
      ]);
    } catch (error) {
      return {
        ok: false,
        error: `could not read .github/workflows/${name} in ${repo}: ` +
          messageOf(error),
      };
    }
    let parsed: unknown = null;
    try {
      parsed = parseYaml(rawText);
    } catch {
      parsed = null;
    }
    files.push({
      path: `.github/workflows/${name}`,
      rawText,
      parsed,
      kind: "workflow",
    });
  }
  return { ok: true, files };
}

/**
 * Check a repository's required contexts against its workflows' `merge_group`
 * triggers. A failure to read the workflows is `unknown`, never `ok`.
 */
export async function checkRepoMergeGroupCoverage(
  repo: string,
  branch: string,
  requiredContexts: readonly string[],
  ghFn: GhExec,
): Promise<MergeGroupCheck> {
  const read = await readRemoteWorkflowFiles(repo, ghFn);
  if (!read.ok) return { status: "unknown", reason: read.error };
  return checkMergeGroupCoverage(read.files, requiredContexts, branch);
}
