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
 * The flag is read fail-open: when detection did not run (unset), nothing is
 * skipped or failed — the pre-#1475 behaviour.
 *
 * Issue #1952 closed the two silences in that. The launcher now records a
 * verdict for every detection that ran, App auth included
 * ({@link workflowScopeVerdictFor}), so "unset" means only "nobody looked"
 * and the completion phase says so out loud. And because a check that fails
 * open still lets the push happen, GitHub's own refusal is recognised here
 * ({@link isWorkflowScopePushRefusal}): the run fails once with the fix
 * named, instead of spending five rebase attempts on a refusal no rebase can
 * fix and recording it as a generic push failure.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { redactedLineTail } from "./redacted_text.ts";

/** Stderr lines kept when quoting GitHub's refusal back to the operator. */
const REFUSAL_DETAIL_TAIL_LINES = 5;

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
 * What the launcher's preflight actually recorded (Issue #1952).
 *
 * The boolean below cannot tell "the token has the scope" from "nobody
 * looked", and the completion phase needs that difference: the first is a
 * pass, the second is a check that could not run and must say so.
 */
export type WorkflowScopeState = "granted" | "absent" | "unknown";

/**
 * The launcher's verdict, as three states.
 *
 * @param env - Environment reader, injectable for tests
 * @returns `"absent"` for a recorded `"false"`, `"granted"` for a recorded
 *   `"true"`, `"unknown"` when detection never ran or wrote something else
 */
export function workflowScopeState(
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): WorkflowScopeState {
  const recorded = (env(WORKFLOW_SCOPE_ENV) ?? "").trim().toLowerCase();
  if (recorded === "false") return "absent";
  if (recorded === "true") return "granted";
  return "unknown";
}

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
  return workflowScopeState(env) !== "absent";
}

/**
 * The launcher's detection result, in the shape the preflight has it.
 *
 * `ok: false` is a detection that could not run — `gh auth status` failed or
 * threw. It is deliberately not a synonym for "no scope": the two have
 * different consequences and the run must be able to tell them apart.
 */
export type WorkflowScopeDetection =
  | { ok: true; hasWorkflowScope: boolean; isAppAuth: boolean }
  | { ok: false };

/**
 * The verdict to record for a detection result (Issue #1952).
 *
 * A GitHub App installation token carries no OAuth scopes to read — its
 * workflow access comes from the app's `workflows` permission, which
 * `gh auth status` does not report — so the honest verdict is `"unknown"`:
 * nothing was established either way. That keeps the pre-#1475 fail-open
 * behaviour for App auth (nothing is skipped or failed), and if the
 * permission turns out to be missing the push-time refusal handler stops the
 * run once with the same diagnosis.
 *
 * @param detection - What the launcher's scope preflight found
 * @returns The state to record for the rest of the run
 */
export function workflowScopeVerdictFor(
  detection: WorkflowScopeDetection,
): WorkflowScopeState {
  if (!detection.ok) return "unknown";
  if (detection.isAppAuth) return "unknown";
  return detection.hasWorkflowScope ? "granted" : "absent";
}

/**
 * The {@link WORKFLOW_SCOPE_ENV} value for a verdict, or nothing to record.
 *
 * @param state - The verdict from {@link workflowScopeVerdictFor}
 * @returns `"true"` / `"false"`, or undefined when detection never answered —
 *   the environment then stays unset, which reads back as `"unknown"`
 */
export function recordedWorkflowScopeValue(
  state: WorkflowScopeState,
): string | undefined {
  if (state === "granted") return "true";
  if (state === "absent") return "false";
  return undefined;
}

/**
 * GitHub's own refusal, in every wording it ships (Issue #1952).
 *
 * The remote names the credential kind it is refusing — "an OAuth App", "a
 * Personal Access Token", "a GitHub App" — then the gated verb, then the
 * scope or permission the token wants. Matching the two fixed halves and
 * bounding what sits between them covers all three without guessing at the
 * trailing wording, which differs between OAuth scopes and fine-grained
 * permissions.
 */
const PUSH_REFUSAL_PATTERN =
  /refusing to allow .{0,80}?to create or update workflow/i;

/**
 * Whether a push failure is GitHub refusing a workflow file for want of the
 * scope — a refusal no fetch, rebase or retry can fix.
 *
 * @param text - Git's stderr, or any message carrying it
 * @returns True when the text is that refusal
 */
export function isWorkflowScopePushRefusal(text: string): boolean {
  // Git wraps the remote's line, so the refusal reaches us split across
  // newlines: flatten the whitespace before matching.
  return PUSH_REFUSAL_PATTERN.test(text.replace(/\s+/g, " "));
}

/**
 * The failure reason for a push GitHub refused for want of the scope.
 *
 * Carries the phrase `detectFailureCategory` keys `token_scope` on, so the
 * run record blames the host's credential rather than a generic push
 * failure, and says plainly that no recovery was attempted.
 *
 * @param detail - Git's own words, quoted so the operator sees the refusal
 * @returns One reason line, with the fix in it
 */
export function workflowScopePushRefusalMessage(detail: string): string {
  // Redacted before the cut, and capped at the same few lines every other
  // push failure quotes (Issue #1257): the remote URL in git's stderr can
  // carry the run's token, and this reason reaches the log and the issue.
  const quoted = redactedLineTail(detail.trim(), REFUSAL_DETAIL_TAIL_LINES)
    .split("\n").join(" | ");
  return `Push refused by GitHub: the token lacks the 'workflow' scope, and ` +
    `this branch creates or updates a file under ${WORKFLOWS_DIR}. No ` +
    `recovery was attempted — no rebase can supply a missing scope. Fix: ` +
    `${WORKFLOW_SCOPE_REMEDIATION}${quoted ? ` — git said: ${quoted}` : ""}`;
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
