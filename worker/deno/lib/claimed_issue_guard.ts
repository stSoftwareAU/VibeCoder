/**
 * Per-run claimed-issue guard state (Issue #222).
 *
 * A coding run claims exactly one issue. The agent it spawns may comment on
 * that issue, label it, and edit its body — but closing, reopening, locking,
 * transferring or deleting it is a lifecycle decision the worker or a human
 * makes, never the implementing agent. VibeCoder#222: an agent blocked on an
 * unfinished dependency closed its own claimed issue as `not planned`, and the
 * worker then mis-reported the run as analysis-only.
 *
 * This module holds the state the `gh` guard shim bakes into the agent's
 * wrapper: which issue is claimed, and which lifecycle verbs the run
 * nevertheless permits. It mirrors `write_repo_allowlist.ts` exactly — an
 * `AsyncLocalStorage` context so two concurrent slots never share one
 * another's claim, falling back to a process-wide default context for the
 * single-slot case.
 *
 * Inert until a run seeds it: a flow that never calls
 * {@link seedClaimedIssueGuard} (the planning route, whose prompt legitimately
 * closes the issue after filing sub-issues) is unaffected.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Lifecycle verbs a coding run permits on its own claimed issue.
 *
 * `edit` only. The worker's own escalation guidance tells the agent to run
 * `gh issue edit <n> --add-label needs-human` when it needs a human, and the
 * reserved-label denylist in `gh_guard_decision.ts` already stops that edit
 * applying a workflow label it must not. Every other lifecycle verb — `close`,
 * `reopen`, `delete`, `transfer`, `lock`, `unlock`, `pin`, `unpin` — is
 * refused: none of them is ever the implementing agent's decision.
 */
export const DEFAULT_CLAIMED_ISSUE_ALLOWED_VERBS: readonly string[] = ["edit"];

/** The issue a run has claimed, and the lifecycle verbs it permits. */
export interface ClaimedIssue {
  /** `owner/repo` of the claimed issue. */
  repo: string;
  /** The claimed issue number. */
  issueNumber: number;
  /** Lifecycle verbs the agent may still use on issues in `repo`. */
  allowedVerbs: readonly string[];
}

/** Per-slot state: the claim, or `undefined` when no run has seeded one. */
interface ClaimedIssueGuardContext {
  claimed?: ClaimedIssue;
}

/** The process-wide default context — single-slot behaviour. */
const defaultContext: ClaimedIssueGuardContext = {};

/** Ambient per-slot context, mirroring the write-repo allowlist. */
const contextStorage = new AsyncLocalStorage<ClaimedIssueGuardContext>();

/** The context the current async scope is running in. */
function ctx(): ClaimedIssueGuardContext {
  return contextStorage.getStore() ?? defaultContext;
}

/** A fresh, unseeded context. */
export function createClaimedIssueGuardContext(): ClaimedIssueGuardContext {
  return {};
}

/**
 * Run `fn` with its own claimed-issue context, so a concurrent slot's claim
 * cannot be seen or clobbered.
 */
export function withClaimedIssueGuardContext<T>(
  context: ClaimedIssueGuardContext,
  fn: () => Promise<T>,
): Promise<T> {
  return contextStorage.run(context, fn);
}

/**
 * Seed the guard for a new coding run.
 *
 * @param repo - `owner/repo` of the claimed issue.
 * @param issueNumber - The claimed issue number.
 * @param allowedVerbs - Lifecycle verbs this run permits. Defaults to
 *   {@link DEFAULT_CLAIMED_ISSUE_ALLOWED_VERBS}; a route whose prompt
 *   legitimately closes the issue passes its own list.
 */
export function seedClaimedIssueGuard(
  repo: string,
  issueNumber: number,
  allowedVerbs: readonly string[] = DEFAULT_CLAIMED_ISSUE_ALLOWED_VERBS,
): void {
  const slug = repo.trim();
  if (slug.length === 0 || !Number.isFinite(issueNumber)) return;
  ctx().claimed = {
    repo: slug,
    issueNumber,
    allowedVerbs: allowedVerbs.map((v) => v.trim().toLowerCase()).filter((v) =>
      v.length > 0
    ),
  };
}

/**
 * Clear the guard between runs, so one run's claim never leaks into the next
 * (the main loop's own cross-repo maintenance must stay unguarded).
 */
export function resetClaimedIssueGuard(): void {
  ctx().claimed = undefined;
}

/** The current run's claimed issue, or `undefined` when none is seeded. */
export function claimedIssueGuard(): ClaimedIssue | undefined {
  return ctx().claimed;
}
