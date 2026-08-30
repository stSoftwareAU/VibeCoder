/**
 * Worker-token privilege scanner for the GitHub Actions audit (Issue #599,
 * part of #566).
 *
 * The operator's hard constraint is that the Vibe Coder must never be able to
 * change a GitHub ruleset: rulesets are how a human keeps builds clean before
 * a merge, so a worker that can edit them can also erase the gate protecting
 * the fleet. Nothing checked that constraint — it held only because the
 * worker did not choose to call those endpoints, which is a convention, not a
 * control.
 *
 * This scanner verifies it actively, read-only. Per monitored repo it reads
 * `repos/{owner}/{repo}` and inspects `.permissions`: `admin` or `maintain`
 * true means the token can create, edit and delete rulesets and change
 * repository settings. When either is granted it names the token's identity
 * and, for a GitHub App installation token, the granted `administration` /
 * `repository_hooks` permissions, so the escalation says exactly which grant
 * is too wide.
 *
 * Two invariants:
 *
 *   - **No write, ever.** The check never creates, modifies or deletes a
 *     ruleset to test access — it reads the permission surface only.
 *   - **Fail loud.** A lookup that errors (or returns no `.permissions`) is
 *     reported through `onLookupFailure` and yields no finding. Unknown scope
 *     is never reported as "verified safe".
 *
 * Shaped like `repo_settings_scanner.ts` — same pattern, opposite direction:
 * that one checks the repository is locked down enough, this one checks the
 * worker is not trusted too much.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type {
  GhCommandFn,
  WorkflowFindingSeverity,
} from "./workflow_scan_common.ts";

/** Stable id — re-runs update the open escalation rather than re-file it. */
export const WORKER_TOKEN_RULESET_FINDING_ID =
  "BP-WORKER-TOKEN-CAN-EDIT-RULESETS";

/**
 * Labels the escalation carries besides the scan label and `severity:high`:
 * a human must act (the worker cannot downgrade its own grant), and the
 * finding is a security one.
 */
export const WORKER_TOKEN_ESCALATION_LABELS: readonly string[] = [
  "needs-human",
  "security",
];

/**
 * Repository permissions that carry the rulesets API. GitHub's repository
 * payload reports `admin`, `maintain`, `push`, `triage` and `pull`; the first
 * two can create, edit and delete rulesets.
 */
const RULESET_CAPABLE = ["admin", "maintain"] as const;

/** App installation grants that widen a token beyond ordinary code writes. */
const WIDE_APP_GRANTS = ["administration", "repository_hooks"] as const;

/** One worker-token privilege finding, shaped like the settings findings. */
export interface WorkerTokenPrivilegeFinding {
  findingId: string;
  severity: WorkflowFindingSeverity;
  title: string;
  /** Always `worker GitHub token` — there is no file to point at. */
  file: string;
  lines: number;
  whyItMatters: string;
  suggestedFix: string;
  evidence: string;
  /** Extra issue labels beyond the scan label and `severity:*`. */
  labels: readonly string[];
}

/** Options for {@link scanWorkerTokenPrivileges}. */
export interface ScanWorkerTokenPrivilegesOptions {
  knownOpenFindingIds?: Iterable<string>;
  onLookupFailure?: (what: string, reason: string) => void;
}

/** Read one endpoint as JSON; report a failure rather than returning a guess. */
async function readJson<T>(
  gh: GhCommandFn,
  endpoint: string,
  what: string,
  onFailure?: (what: string, reason: string) => void,
): Promise<T | undefined> {
  try {
    return JSON.parse(await gh(["api", endpoint])) as T;
  } catch (err) {
    onFailure?.(what, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

/** True when the identity looks like a GitHub App installation token. */
function isAppToken(identity: { login?: string; type?: string }): boolean {
  return identity.type === "Bot" || (identity.login ?? "").endsWith("[bot]");
}

/**
 * Read the worker token's own permissions on `repo` and return a finding when
 * they include `admin` or `maintain` — either of which lets the worker delete
 * the ruleset that gates merges.
 *
 * Every call is a read; nothing is created, modified or deleted.
 */
export async function scanWorkerTokenPrivileges(
  repo: string,
  ghCommandFn: GhCommandFn,
  options: ScanWorkerTokenPrivilegesOptions = {},
): Promise<WorkerTokenPrivilegeFinding[]> {
  const known = new Set(options.knownOpenFindingIds ?? []);
  if (known.has(WORKER_TOKEN_RULESET_FINDING_ID)) return [];

  const onLookupFailure = options.onLookupFailure;
  const what = `repos/${repo} (.permissions)`;
  const repoInfo = await readJson<{ permissions?: Record<string, unknown> }>(
    ghCommandFn,
    `repos/${repo}`,
    what,
    onLookupFailure,
  );
  if (!repoInfo) return [];
  const permissions = repoInfo.permissions;
  if (!permissions || typeof permissions !== "object") {
    // Unknown scope is not safe scope — say so rather than returning clean.
    onLookupFailure?.(
      what,
      "the repository payload carried no .permissions object, so the token's " +
        "scope could not be read",
    );
    return [];
  }

  const granted = RULESET_CAPABLE.filter((p) => permissions[p] === true);
  if (granted.length === 0) return [];

  // Only now — with a genuine finding to describe — spend the extra reads
  // that name whose token it is and which App grant is too wide.
  const identity = await readJson<{ login?: string; type?: string }>(
    ghCommandFn,
    "user",
    "user (worker token identity)",
    onLookupFailure,
  );
  const who = identity?.login ?? "unknown (identity lookup failed)";

  let appGrants = "";
  // An installation token cannot read `user`; a failed identity read is
  // itself a signal that the token may be an App's.
  if (identity === undefined || isAppToken(identity)) {
    const installation = await readJson<{
      app_slug?: string;
      permissions?: Record<string, string>;
    }>(
      ghCommandFn,
      `repos/${repo}/installation`,
      `repos/${repo}/installation (App permissions)`,
      onLookupFailure,
    );
    const appPermissions = installation?.permissions ?? {};
    const wide = WIDE_APP_GRANTS
      .filter((g) => appPermissions[g] !== undefined)
      .map((g) => `${g}=${appPermissions[g]}`);
    if (wide.length > 0) {
      appGrants = `; App \`${
        installation?.app_slug ?? "unknown"
      }\` installation grants ${wide.join(", ")}`;
    }
  }

  const permissionList = granted.map((p) => `${p}=true`).join(", ");

  return [{
    findingId: WORKER_TOKEN_RULESET_FINDING_ID,
    severity: "high",
    title:
      `🔴 The worker's GitHub token holds \`${
        granted[0]
      }\` on ${repo} — it can ` +
      "delete the ruleset that gates merges",
    file: "worker GitHub token",
    lines: 0,
    whyItMatters:
      `The token this worker runs with resolves ${permissionList} on ${repo}. ` +
      "Either grant carries the rulesets API, so the worker can create, edit " +
      "and delete rulesets and change repository settings — including the " +
      "required status check ruleset that keeps a build green before a merge. " +
      "The gate meant to constrain the fleet sits inside the fleet's own blast " +
      "radius, and until this check existed the constraint held only because " +
      "the worker did not call those endpoints (Issue #599, part of #566).",
    suggestedFix:
      "Human action — the worker cannot downgrade its own grant. Set the " +
      `service account's access to ${repo} to \`write\` (push), which keeps ` +
      "branches, pull requests and issues working while removing ruleset and " +
      "settings access; for a GitHub App installation, narrow the " +
      "installation's `administration` permission (and `repository_hooks` if " +
      "granted) to read or none. The audit clears this finding on its next " +
      "run once the permissions read back without `admin` or `maintain`.",
    evidence:
      `repos/${repo} .permissions: ${permissionList}; token identity: ${who}` +
      appGrants,
    labels: WORKER_TOKEN_ESCALATION_LABELS,
  }];
}
