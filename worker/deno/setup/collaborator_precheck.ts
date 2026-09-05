/**
 * Setup-time collaborator precheck for monitored repositories
 * (Issue #2326).
 *
 * When a repo is added to the monitored list but the worker's GitHub user
 * has not been invited as a collaborator, the worker spins forever:
 * `claimIssue` swallows the resulting 422 and reports "Issue not available"
 * every iteration. This precheck catches that misconfiguration once, at
 * setup time, the moment a new repo is added.
 *
 * RATE-LIMIT BUDGET — READ BEFORE WIRING THIS ANYWHERE NEW.
 * This precheck must run ONLY at setup time (once per `setup.sh` invocation,
 * plus on `VIBE_ADD_REPOS` events). It must NEVER be called from the
 * per-iteration main loop (`run_core.ts`), `issue_finder.ts`, `idle-detect`,
 * or any other per-tick path. The worker already issues ~400 gh API calls per
 * tick; this command spends one `GET /repos/<owner>/<repo>` per monitored repo
 * and is only affordable because it runs once per setup, not once per loop.
 * The runtime-side relief valve for revoked-mid-run perms is Issue #2325's
 * fix in `claim_issue.ts` — not this command.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { readHostname } from "../lib/identity_guard.ts";
import {
  ALERT_DEDUP_JSON_FIELDS,
  type AlertDedupAuthorOptions,
  type AlertDedupRow,
  selectFleetAuthoredMatches,
} from "../lib/alert_dedup_authors.ts";

/** Output from a shell command. */
export interface CommandOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}

/** Injectable command runner (overridable for testing). */
export type RunCommand = (cmd: string[]) => Promise<CommandOutput>;

/** Classification of the worker token's access to a monitored repo. */
export type RepoAccessStatus = "ok" | "not_visible" | "not_assignable";

/** A repo the worker cannot work, with the reason. */
export interface CollaboratorMiss {
  repo: string;
  status: Exclude<RepoAccessStatus, "ok">;
}

/**
 * Options for the precheck.
 *
 * Extends {@link AlertDedupAuthorOptions}: `fleetAuthors` (tests) or the
 * configured fleet identity (production) decides whose dedup tag may
 * receive the follow-up comment.
 */
export interface CollaboratorPrecheckOptions extends AlertDedupAuthorOptions {
  /** `org/repo` slugs from `.config.json`. */
  repos: readonly string[];
  /** Custom gh config directory (from `.config.json` `gh_config_dir`). */
  ghConfigDir?: string;
  /**
   * Worker identity guard allowlist (`service_accounts`) from `.config.json`
   * (Issue #4030). An empty list means the #3528 guard cannot enforce, and is
   * reported in the consolidated issue exactly like a non-collaborator repo —
   * the per-run `[SECURITY]` log line scrolled past unread for months.
   *
   * Omit it entirely (undefined) to skip the identity check; the setup CLI
   * always supplies it, so the check runs on every real setup.
   */
  serviceAccounts?: readonly string[];
  /** Override for command execution (testing). */
  runCommand?: RunCommand;
  /** Repo the consolidated issue is filed against. */
  targetRepo?: string;
  /** Sink for the author-verification diagnostics. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

/** Outcome of a full precheck pass. */
export interface CollaboratorPrecheckResult {
  /** Resolved worker login, or undefined when the lookup failed. */
  workerUser?: string;
  /** Repos that are not visible or not assignable. */
  misses: CollaboratorMiss[];
  /**
   * True when `service_accounts` is empty, so the #3528 identity guard cannot
   * enforce on this host (Issue #4030). False when not checked.
   */
  identityGuardInactive: boolean;
  /** True when a new consolidated issue was created. */
  issueFiled: boolean;
  /** True when an existing open issue was commented instead. */
  issueUpdated: boolean;
  /** Populated when the pass could not complete (e.g. auth failure). */
  error?: string;
}

/** Dedup marker embedded in the consolidated issue body. */
export const PRECHECK_DEDUP_TAG = "<!-- vibe-coder:collaborator-precheck -->";

/** Repo the consolidated issue is filed against by default. */
const DEFAULT_TARGET_REPO = "stSoftwareAU/VibeCoder";

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

/** Create a default runner using `Deno.Command` with optional gh config. */
function createDefaultRunCommand(ghConfigDir?: string): RunCommand {
  return async (cmd: string[]): Promise<CommandOutput> => {
    const env = ghConfigDir
      ? { ...Deno.env.toObject(), GH_CONFIG_DIR: ghConfigDir }
      : undefined;
    const command = new Deno.Command(cmd[0]!, {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "piped",
      env,
    });
    const output = await command.output();
    const decoder = new TextDecoder();
    return {
      success: output.success,
      stdout: decoder.decode(output.stdout).trim(),
      stderr: decoder.decode(output.stderr).trim(),
    };
  };
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Resolve the authenticated worker login dynamically (no hardcoded user).
 * Mirrors the `gh api user` lookup `get_github_user` does in run_core.
 */
async function resolveWorkerUser(
  runner: RunCommand,
): Promise<string | undefined> {
  const result = await runner(["gh", "api", "user", "--jq", ".login"]);
  if (!result.success) return undefined;
  const login = result.stdout.trim();
  return login.length > 0 ? login : undefined;
}

/**
 * Classify the worker token's access to a single repo via exactly one
 * `GET /repos/<owner>/<repo>`.
 *
 * - command failure (404/403) → `not_visible`
 * - 200 with `permissions.triage !== true` → `not_assignable`
 * - 200 with `permissions.triage === true` → `ok`
 */
export async function classifyRepoAccess(
  repo: string,
  runner: RunCommand,
): Promise<RepoAccessStatus> {
  const result = await runner(["gh", "api", `repos/${repo}`]);
  if (!result.success) {
    // 404 (can't see the repo) and 403 (no access) both mean the worker
    // cannot be assigned issues here.
    return "not_visible";
  }
  try {
    const body = JSON.parse(result.stdout) as {
      permissions?: { triage?: boolean };
    };
    return body.permissions?.triage === true ? "ok" : "not_assignable";
  } catch {
    // Unparseable body — treat conservatively as not assignable so the
    // misconfiguration surfaces rather than being silently ignored.
    return "not_assignable";
  }
}

/** Human-readable explanation of each miss status. */
function statusExplanation(status: CollaboratorMiss["status"]): string {
  return status === "not_visible"
    ? "worker token cannot see this repo (404/403)"
    : "worker has read access but cannot be assigned issues (`triage` is false)";
}

/** Build the consolidated issue title for the findings in hand. */
function issueTitle(
  misses: readonly CollaboratorMiss[],
  identityGuardInactive: boolean,
): string {
  if (misses.length === 0 && identityGuardInactive) {
    return "Worker identity guard is inactive — service_accounts is not configured";
  }
  return "Worker is not a collaborator on one or more monitored repos";
}

/**
 * Section reporting an inactive worker identity guard (Issue #4030).
 *
 * Empty when the guard is active — the issue then reads exactly as it did.
 */
function identityGuardSection(
  workerUser: string,
  identityGuardInactive: boolean,
  hostname: string,
): string {
  if (!identityGuardInactive) return "";

  return `
### Worker identity guard is INACTIVE

\`service_accounts\` is empty in \`.config.json\` on host \`${hostname}\`, so the
#3528 identity guard cannot enforce: this host is running as \`${workerUser}\`
and any drift to another account goes undetected (exactly how #4028 hid two
monitored repos for days).

Fix it by re-running setup with the fleet's service accounts:

\`\`\`bash
VIBE_SERVICE_ACCOUNTS="${workerUser}" ./setup.sh
\`\`\`

List **every** account the fleet authenticates as — the allowlist is shared by
all hosts, not per-host.
`;
}

/** Build the consolidated issue body listing every affected repo. */
export function buildIssueBody(
  workerUser: string,
  misses: readonly CollaboratorMiss[],
  identityGuardInactive = false,
  hostname = "unknown-host",
): string {
  const rows = misses
    .map((m) =>
      `- \`${m.repo}\` — ${m.status} (${statusExplanation(m.status)})`
    )
    .join("\n");

  const inviteCommands = misses
    .map((m) =>
      `gh api -X PUT repos/${m.repo}/collaborators/${workerUser} -f permission=triage`
    )
    .join("\n");

  const guardSection = identityGuardSection(
    workerUser,
    identityGuardInactive,
    hostname,
  );

  if (misses.length === 0) {
    // Identity guard only — no repo access problem to report.
    return `## Setup precheck failed
${guardSection}
---
*Raised automatically by the VibeCoder setup precheck (Issues #2326, #4030).*
${PRECHECK_DEDUP_TAG}`;
  }

  return `## Collaborator precheck failed

The worker user \`${workerUser}\` cannot be assigned issues on the following
monitored repositories. Until this is fixed the worker will repeatedly fail to
claim their open issues and waste API budget every loop.

### Affected repositories

${rows}

### How to fix — run as a repo admin

\`\`\`bash
# Grant the worker triage (assignable) access on each repo:
${inviteCommands}
\`\`\`

After granting access, re-run \`setup.sh\` to confirm the precheck passes.
${guardSection}
---
*Raised automatically by the VibeCoder collaborator precheck (Issue #2326).*
${PRECHECK_DEDUP_TAG}`;
}

/**
 * Find an existing open **fleet-filed** precheck issue by dedup tag.
 *
 * The follow-up posted onto a match is not a bare "still broken" note: it
 * carries the ready-to-run `gh api …/collaborators` invite commands for
 * every affected repository. A dedup tag is a string in an issue body, so
 * an unverified match would hand that text to an issue somebody else
 * opened. Only a fleet-authored match counts, and `--limit 1` is widened
 * so one planted issue cannot occupy the only slot the search returns.
 *
 * @returns The issue number, or `undefined` — which files a fresh issue.
 */
async function findOpenPrecheckIssue(
  targetRepo: string,
  runner: RunCommand,
  options: AlertDedupAuthorOptions,
  log: (message: string) => void,
): Promise<number | undefined> {
  const result = await runner([
    "gh",
    "issue",
    "list",
    "--repo",
    targetRepo,
    "--state",
    "open",
    "--search",
    `"${PRECHECK_DEDUP_TAG}" in:body`,
    "--json",
    ALERT_DEDUP_JSON_FIELDS,
    "--limit",
    "20",
  ]);
  if (!result.success) return undefined;
  let rows: (AlertDedupRow & { body?: string })[];
  try {
    rows = JSON.parse(result.stdout) as (AlertDedupRow & { body?: string })[];
  } catch {
    return undefined;
  }
  const verified = await selectFleetAuthoredMatches(
    rows.filter((row) => (row.body ?? "").includes(PRECHECK_DEDUP_TAG)),
    `collaborator precheck ${targetRepo}`,
    options,
    log,
    "a fresh issue is filed — the follow-up carries collaborator-invite " +
      "commands and must never be posted onto an issue the fleet did not open",
  );
  return verified[0]?.number;
}

/**
 * Precheck every monitored repo for worker collaborator access, and report an
 * inactive worker identity guard alongside it (Issue #4030).
 *
 * Files exactly one consolidated issue against the target repo when any repo
 * is misconfigured or the identity guard cannot enforce; comments on an
 * existing open issue rather than duplicating.
 */
export async function verifyMonitoredCollaborators(
  options: CollaboratorPrecheckOptions,
): Promise<CollaboratorPrecheckResult> {
  const runner = options.runCommand ??
    createDefaultRunCommand(options.ghConfigDir);
  const targetRepo = options.targetRepo ?? DEFAULT_TARGET_REPO;

  // Undefined means the caller did not ask for the identity check.
  const identityGuardInactive = options.serviceAccounts !== undefined &&
    options.serviceAccounts.filter((a) => a.trim().length > 0).length === 0;

  const workerUser = await resolveWorkerUser(runner);
  if (!workerUser) {
    return {
      workerUser: undefined,
      misses: [],
      identityGuardInactive,
      issueFiled: false,
      issueUpdated: false,
      error: "Could not resolve the worker GitHub user (gh api user failed)",
    };
  }

  const misses: CollaboratorMiss[] = [];
  for (const repo of options.repos) {
    const status = await classifyRepoAccess(repo, runner);
    if (status !== "ok") {
      misses.push({ repo, status });
    }
  }

  if (misses.length === 0 && !identityGuardInactive) {
    return {
      workerUser,
      misses,
      identityGuardInactive,
      issueFiled: false,
      issueUpdated: false,
    };
  }

  const body = buildIssueBody(
    workerUser,
    misses,
    identityGuardInactive,
    readHostname(),
  );
  const existing = await findOpenPrecheckIssue(
    targetRepo,
    runner,
    options,
    options.log ?? ((message: string) => console.warn(message)),
  );

  if (existing !== undefined) {
    const comment = await runner([
      "gh",
      "issue",
      "comment",
      String(existing),
      "--repo",
      targetRepo,
      "--body",
      body,
    ]);
    return {
      workerUser,
      misses,
      identityGuardInactive,
      issueFiled: false,
      issueUpdated: comment.success,
      error: comment.success
        ? undefined
        : "Failed to comment on existing precheck issue",
    };
  }

  const created = await runner([
    "gh",
    "issue",
    "create",
    "--repo",
    targetRepo,
    "--title",
    issueTitle(misses, identityGuardInactive),
    "--body",
    body,
  ]);

  return {
    workerUser,
    misses,
    identityGuardInactive,
    issueFiled: created.success,
    issueUpdated: false,
    error: created.success ? undefined : "Failed to create precheck issue",
  };
}
