/**
 * The `workflow` OAuth scope, and what the worker does without it
 * (Issue #1475).
 *
 * GitHub refuses any push from an OAuth token that creates or updates a file
 * under `.github/workflows/` unless the token carries the `workflow` scope —
 * "refusing to allow an OAuth App to create or update workflow … without
 * `workflow` scope". The launcher already detects the scope at start-up
 * (`run_worker.ts` → `gh_auth.ts`) and exports it as
 * {@link WORKFLOW_SCOPE_ENV}; before this module only `bump_deps.ts` read it.
 * On GRQ-25 a token without the scope was seen at preflight, and the worker
 * then claimed two issues whose whole deliverable was a workflow file and
 * lost both at the push, after a full agent run each.
 *
 * Three uses, all reading the same flag:
 *
 *   - the claim scan skips an issue that is workflow work
 *     ({@link issueLooksLikeWorkflowWork});
 *   - the completion phase fails a run before pushing when the diff touches
 *     a workflow ({@link isWorkflowPath}), with the fix in the message;
 *   - the preflight says so at WARN with the same fix.
 *
 * The flag is read fail-open: when detection did not run (unset), or the
 * token is a GitHub App installation token (no OAuth scopes), nothing is
 * skipped or failed — the pre-#1475 behaviour.
 *
 * Australian English throughout (behaviour, organisation).
 */

/** Set by the launcher's scope preflight: `"true"` or `"false"`. */
export const WORKFLOW_SCOPE_ENV = "GH_TOKEN_HAS_WORKFLOW_SCOPE";

/** What to do about it, in one line that fits a log or a comment. */
export const WORKFLOW_SCOPE_REMEDIATION =
  "grant the worker account the `workflow` OAuth scope " +
  "(`gh auth refresh -s workflow`), re-provision `gh/hosts.yml`, and " +
  "restart the worker (Issue #1475)";

/** Directory GitHub protects behind the `workflow` scope. */
export const WORKFLOWS_DIR = ".github/workflows/";

/**
 * Whether the active token can push workflow files.
 *
 * @param env - Environment reader, injectable for tests
 * @returns False only when the preflight recorded `"false"`; unset or any
 *   other value reads as true, so a missing preflight never blocks work
 */
export function tokenHasWorkflowScope(
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): boolean {
  return (env(WORKFLOW_SCOPE_ENV) ?? "").trim().toLowerCase() !== "false";
}

/** Whether a repo-relative path is one GitHub gates behind the scope. */
export function isWorkflowPath(path: string): boolean {
  const normalised = path.trim().replace(/^\.\//, "").replace(/\\/g, "/");
  return normalised.startsWith(WORKFLOWS_DIR);
}

/** The changed paths that need the scope, in the order given. */
export function workflowPathsIn(paths: readonly string[]): string[] {
  return paths.filter(isWorkflowPath);
}

/**
 * A cheap read of an issue's title and body: is the deliverable a workflow?
 *
 * Deliberately narrow — a title naming a workflow or GitHub Actions, or a
 * body naming the `.github/workflows` directory. A false positive costs one
 * skipped issue on a mis-scoped host until the scope is granted; a false
 * negative costs a whole agent run, which is what the completion-phase check
 * is for.
 *
 * @param title - Issue title
 * @param body - Issue body, may be absent
 * @returns True when the issue reads as workflow work
 */
export function issueLooksLikeWorkflowWork(
  title: string,
  body: string | undefined,
): boolean {
  if (/\b(workflows?|github actions?)\b/i.test(title)) return true;
  if (/\.github\/workflows\b/i.test(title)) return true;
  return /\.github\/workflows\b/i.test(body ?? "");
}
