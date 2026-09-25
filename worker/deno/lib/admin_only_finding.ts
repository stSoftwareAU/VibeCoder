/**
 * Detect an issue that a worker structurally cannot resolve because its fix is
 * a repository-admin action (Issue #53).
 *
 * `repo_settings_scanner.ts` files `BP-REPO-*` findings — ruleset review not
 * required, secret scanning off, default token read-write, … — whose suggested
 * fix is always "Repository admin action — the worker cannot change repository
 * settings." When a human bulk-triages such a finding to `work-on`, the worker
 * claims it, runs an agent that (correctly) changes nothing, and the completion
 * phase fails "no commits ahead". Because the claim releases as `no_pr`, the
 * still-`work-on` issue goes straight back into the pool: a permanent, futile
 * loop burning agent minutes every cycle for an issue no worker can close.
 *
 * This is the pure detection used by the up-front hand-off in `issue_worker.ts`
 * — recognise the finding from its body and hand it to a human before cloning
 * the repo or running Claude.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * The `BP-REPO-*` finding-id marker every repo-settings finding body carries.
 * The single definition: the admin-only hand-off below and setup's close-out
 * of fixed findings (Issue #2629) both read it through
 * {@link parseRepoSettingsFindingId}.
 */
const REPO_SETTINGS_FINDING_MARKER =
  /<!--\s*finding-id:\s*(BP-REPO-[A-Z0-9-]+)\s*-->/i;

/**
 * The `BP-REPO-*` finding id an issue body's marker names (upper-cased, e.g.
 * `BP-REPO-DEFAULT-TOKEN-WRITE`), or `null` when the body carries no such
 * marker. Any other finding family — `BP-WORKER-*`, `BP-LINTER-*`, `SEC-*` —
 * is `null`: only repo-settings findings are parsed here.
 */
export function parseRepoSettingsFindingId(issueBody: string): string | null {
  if (!issueBody) return null;
  const match = REPO_SETTINGS_FINDING_MARKER.exec(issueBody);
  return match?.[1] ? match[1].toUpperCase() : null;
}

/**
 * The prose the scanner puts at the head of every suggested fix — a second,
 * independent signal in case the structural marker is ever absent (e.g. a body
 * a human re-typed).
 */
const REPO_ADMIN_ACTION_PROSE = /the worker cannot change repository settings/i;

/**
 * True when the issue body identifies a repository-admin finding the worker
 * cannot action (a `BP-REPO-*` finding, or the scanner's admin-action prose).
 */
export function isAdminOnlyRepoSettingsIssue(issueBody: string): boolean {
  if (!issueBody) return false;
  return parseRepoSettingsFindingId(issueBody) !== null ||
    REPO_ADMIN_ACTION_PROSE.test(issueBody);
}
