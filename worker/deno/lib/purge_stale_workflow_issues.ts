/**
 * Purge stale false-positive workflow-sync issues.
 *
 * Re-audits a repo and closes any open issue carrying a
 * `<!-- vibe-coder:workflow-sync:... -->` deduplication tag whose
 * underlying workflow now classifies as **present** under the current
 * detection logic. Issues that still classify as `partial` or `missing`
 * are left untouched.
 *
 * Issue #1582: Add command to close stale false-positive workflow-sync
 * partial-match issues.
 *
 * The deduplication tag formats are defined in
 * `worker/deno/setup/workflow_sync.ts`:
 *   - `<!-- vibe-coder:workflow-sync:<specId> -->` for missing-workflow issues
 *   - `<!-- vibe-coder:workflow-sync:partial:<specId> -->` for partial-match issues
 *
 * **The tag is not evidence the fleet filed the issue.** The search is
 * `"<!-- vibe-coder:workflow-sync:" in:body`, and on a public repository a
 * body is text anyone who can open an issue may write. What this module
 * does with a match is `gh issue close`, with `dryRun` off by default — so
 * an unverified match is untrusted content driving a destructive write on
 * somebody else's issue. Every match is therefore author-verified against
 * the fleet identity (`alert_dedup_authors.ts`) before it can be closed.
 *
 * **The fail direction is "close nothing".** Where the alerting dedups
 * fail towards raising a duplicate — noise a human clears in a moment —
 * this one fails towards leaving a stale issue open. A stale issue is
 * tidied on the next pass once the fleet identity is configured; an issue
 * closed by mistake is the one outcome nobody can undo from here.
 *
 * The `enhancement` label the sync tries to apply is deliberately **not**
 * used as a second scope. It is generic, target repositories relabel these
 * issues (the VibeCoder copy carries `work-on` instead), and
 * `createWorkflowIssue` falls back to filing without any label when the
 * label does not exist — so a label requirement would silently stop the
 * purge working rather than narrow it. Authorship is the scope that holds.
 */

import type { Result } from "../types.ts";
import {
  ALERT_DEDUP_JSON_FIELDS,
  type AlertDedupAuthorOptions,
  type AlertDedupRow,
  selectFleetAuthoredMatches,
} from "./alert_dedup_authors.ts";
import {
  detectRepoLanguages,
  type LanguageDetectorOptions,
  type RepoLanguages,
} from "./language_detector.ts";
import { getRepoVisibility, type RepoVisibility } from "./repo_visibility.ts";
import {
  auditRepoWorkflows,
  type WorkflowAuditOptions,
  type WorkflowAuditResult,
} from "./workflow_auditor.ts";
import { WORKFLOW_SPECS } from "./workflow_definitions.ts";
import { spawnGh } from "./gh_spawn.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Output from a shell command. */
export interface CommandOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Options for the purge operation.
 *
 * Extends {@link AlertDedupAuthorOptions}, so `fleetAuthors` (tests) or the
 * configured fleet identity (production) decides whose workflow-sync tag
 * may drive a close.
 */
export interface PurgeOptions extends AlertDedupAuthorOptions {
  /** Override for command execution (testing). */
  runCommand?: (cmd: string[]) => Promise<CommandOutput>;
  /** Custom gh config directory (from .config.json gh_config_dir). */
  ghConfigDir?: string;
  /** When true, report what would be closed without invoking gh issue close. */
  dryRun?: boolean;
  /** Sink for the author-verification diagnostics. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

/** Issue kind, derived from the deduplication tag. */
export type IssueTagKind = "missing" | "partial";

/** Information about a candidate issue carrying a workflow-sync tag. */
export interface CandidateIssue {
  number: number;
  specId: string;
  kind: IssueTagKind;
}

/** Result of purging a single repo. */
export interface PurgeResult {
  repo: string;
  /** Issues that were (or would be, in dry-run) closed because the spec is now present. */
  closed: CandidateIssue[];
  /** Issues left open because the spec is still partial or missing. */
  kept: CandidateIssue[];
  /**
   * Issues that were (or would be, in dry-run) closed because the underlying
   * spec is not applicable to this repository — typically a `public-only`
   * spec on a private repo (Issue #1755).
   */
  notApplicable: CandidateIssue[];
  /** Issues that should have been closed but the close call failed. */
  failures: CandidateIssue[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Default command runner using Deno.Command with optional gh config.
 *
 * Issue #3703: a `gh` command is delegated to the shared chokepoint so the
 * issue-close mutation is allowlist-checked and journalled; any other binary
 * is spawned directly.
 */
function createDefaultRunCommand(
  ghConfigDir?: string,
): (cmd: string[]) => Promise<CommandOutput> {
  const extraEnv = ghConfigDir ? { GH_CONFIG_DIR: ghConfigDir } : undefined;
  return async (cmd: string[]): Promise<CommandOutput> => {
    if (cmd[0] === "gh") {
      const result = await spawnGh(
        cmd.slice(1),
        extraEnv ? { env: extraEnv } : {},
      );
      return {
        success: result.success,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      };
    }
    const command = new Deno.Command(cmd[0]!, {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "piped",
      ...(extraEnv ? { env: { ...Deno.env.toObject(), ...extraEnv } } : {}),
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

/**
 * Tag prefix used to discover all workflow-sync issues in a repo.
 *
 * Matches both `<!-- vibe-coder:workflow-sync:<specId> -->` and
 * `<!-- vibe-coder:workflow-sync:partial:<specId> -->`.
 */
const TAG_SEARCH_PREFIX = "<!-- vibe-coder:workflow-sync:";

/**
 * Extract the spec ID and kind (partial vs missing) from an issue body.
 *
 * Partial tags are checked first because they share the missing-tag prefix
 * but are strictly more specific.
 *
 * @returns `{ specId, kind }` if a tag is found, otherwise `null`.
 */
export function extractSpecIdFromIssueBody(
  body: string,
): { specId: string; kind: IssueTagKind } | null {
  const partial = body.match(
    /<!--\s*vibe-coder:workflow-sync:partial:([^\s>]+)\s*-->/,
  );
  if (partial) return { specId: partial[1]!, kind: "partial" };

  const missing = body.match(
    /<!--\s*vibe-coder:workflow-sync:([^\s>]+)\s*-->/,
  );
  if (missing) return { specId: missing[1]!, kind: "missing" };

  return null;
}

/** One tag-matching issue, with the author that makes the match verifiable. */
interface PurgeCandidateRow extends AlertDedupRow {
  body: string;
}

/**
 * Fetch open workflow-sync issues from a repo via `gh issue list`.
 *
 * Requests the author alongside the body: a tag match that cannot be
 * attributed is not a candidate for closing.
 */
async function listWorkflowSyncIssues(
  repo: string,
  runner: (cmd: string[]) => Promise<CommandOutput>,
): Promise<Result<PurgeCandidateRow[], string>> {
  const result = await runner([
    "gh",
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--search",
    `"${TAG_SEARCH_PREFIX}" in:body`,
    "--json",
    ALERT_DEDUP_JSON_FIELDS,
    "--limit",
    "200",
  ]);

  if (!result.success) {
    return {
      ok: false,
      error: `gh issue list failed for ${repo}: ${
        result.stderr || "unknown error"
      }`,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout) as PurgeCandidateRow[];
    return { ok: true, value: parsed };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to parse gh issue list output: ${message}`,
    };
  }
}

/** Reason used when building a closing comment. */
type CloseReason = "now-present" | "not-applicable";

/** Idempotency marker embedded in the not-applicable closing comment. */
function notApplicableMarker(specId: string): string {
  return `<!-- vibe-coder:purge-not-applicable:${specId} -->`;
}

/** Build the closing comment posted on a stale workflow-sync issue. */
function buildClosingComment(
  candidate: CandidateIssue,
  reason: CloseReason,
): string {
  if (reason === "not-applicable") {
    return `Closing automatically: the \`${candidate.specId}\` workflow is not applicable to this repository — it requires features (such as GitHub Advanced Security for \`dependency-review\`) that are unavailable on private repos. See issue #1750 for context.

${notApplicableMarker(candidate.specId)}

*Closed by \`purge-stale-workflow-issues\` (Issue #1755).*`;
  }

  const detectionReason = candidate.kind === "partial"
    ? `Re-audit detected a valid implementation of \`${candidate.specId}\` that the original detector flagged as a partial match.`
    : `Re-audit detected the \`${candidate.specId}\` workflow is now present.`;
  return `${detectionReason}

Closing automatically: this issue is no longer applicable under the updated workflow detection logic. See umbrella issue #1577 for context.

*Closed by \`purge-stale-workflow-issues\` (Issue #1582).*`;
}

/** Close an issue with a comment via the gh CLI. */
async function closeIssue(
  repo: string,
  candidate: CandidateIssue,
  reason: CloseReason,
  runner: (cmd: string[]) => Promise<CommandOutput>,
): Promise<boolean> {
  const result = await runner([
    "gh",
    "issue",
    "close",
    String(candidate.number),
    "--repo",
    repo,
    "--comment",
    buildClosingComment(candidate, reason),
  ]);
  return result.success;
}

/**
 * Build a set of spec IDs whose visibility scope is `public-only`.
 *
 * Used on private repos to identify candidate issues whose underlying spec
 * is not applicable and should be closed (Issue #1755).
 */
function buildPublicOnlySpecIds(): Set<string> {
  const ids = new Set<string>();
  for (const spec of WORKFLOW_SPECS) {
    if (spec.visibilityScope === "public-only") {
      ids.add(spec.id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Purge stale false-positive workflow-sync issues for a single repo.
 *
 * Steps:
 * 1. List open issues whose body contains a workflow-sync tag.
 * 2. Re-audit the repo's workflows using the current detection logic.
 * 3. For each candidate, if the spec is now classified as `present`, close
 *    the issue with an explanatory comment. Otherwise leave it open.
 *
 * @param repo - Repository in `owner/repo` form.
 * @param options - Optional configuration.
 * @returns `Result<PurgeResult, string>` — error is surfaced for fatal
 *   failures (issue listing, language detection, audit). Per-issue close
 *   failures are recorded in `failures` rather than aborting the run.
 */
export async function purgeStaleWorkflowIssuesForRepo(
  repo: string,
  options: PurgeOptions = {},
): Promise<Result<PurgeResult, string>> {
  const runner = options.runCommand ??
    createDefaultRunCommand(options.ghConfigDir);
  const log = options.log ?? ((message: string) => console.warn(message));

  // 1. List candidate issues.
  const issuesResult = await listWorkflowSyncIssues(repo, runner);
  if (!issuesResult.ok) {
    return { ok: false, error: issuesResult.error };
  }

  // 2. Parse spec IDs from issue bodies, keeping only the tags a fleet
  // account actually wrote. A tag anybody can type must never reach
  // `gh issue close`, and an unresolvable fleet closes nothing at all.
  const tagged = issuesResult.value.filter((issue) =>
    extractSpecIdFromIssueBody(issue.body) !== null
  );
  const verified = await selectFleetAuthoredMatches(
    tagged,
    `workflow-sync purge ${repo}`,
    options,
    log,
    "no issue is closed — an unverifiable match must never drive a " +
      "destructive write, and a stale issue left open is recoverable " +
      "where a wrongly closed one is not",
  );
  const candidates: CandidateIssue[] = [];
  for (const issue of verified) {
    const tag = extractSpecIdFromIssueBody(issue.body)!;
    candidates.push({
      number: issue.number,
      specId: tag.specId,
      kind: tag.kind,
    });
  }

  // Short-circuit: nothing to do.
  if (candidates.length === 0) {
    return {
      ok: true,
      value: {
        repo,
        closed: [],
        kept: [],
        notApplicable: [],
        failures: [],
      },
    };
  }

  // 3. Determine repository visibility so we can detect candidates whose
  // spec is not applicable to this repo (e.g. dependency-review on a
  // private repo). On lookup failure, fail-safe to "private" — matching
  // the workflow auditor (Issue #1753) so a private-only behaviour is
  // applied consistently when the answer is uncertain.
  let visibility: RepoVisibility = "private";
  try {
    const visResult = await getRepoVisibility(repo, {
      runCommand: runner,
      ghConfigDir: options.ghConfigDir,
    });
    if (visResult.ok) {
      visibility = visResult.value;
    }
  } catch {
    // Fail-safe — leave visibility as "private".
  }

  const closed: CandidateIssue[] = [];
  const kept: CandidateIssue[] = [];
  const notApplicable: CandidateIssue[] = [];
  const failures: CandidateIssue[] = [];

  // 4. Filter out candidates whose spec is not applicable to this repo.
  // Only public-only specs on private repos qualify today.
  let auditCandidates: CandidateIssue[] = candidates;
  if (visibility === "private") {
    const publicOnlySpecIds = buildPublicOnlySpecIds();
    const remaining: CandidateIssue[] = [];
    for (const candidate of candidates) {
      if (!publicOnlySpecIds.has(candidate.specId)) {
        remaining.push(candidate);
        continue;
      }
      if (options.dryRun) {
        notApplicable.push(candidate);
        continue;
      }
      const ok = await closeIssue(repo, candidate, "not-applicable", runner);
      if (ok) {
        notApplicable.push(candidate);
      } else {
        failures.push(candidate);
      }
    }
    auditCandidates = remaining;
  }

  // Short-circuit: if every candidate was handled by the visibility filter,
  // skip the language detection + audit entirely.
  if (auditCandidates.length === 0) {
    return {
      ok: true,
      value: { repo, closed, kept, notApplicable, failures },
    };
  }

  // 5. Re-audit the repo to learn the current classification.
  const langOpts: LanguageDetectorOptions = {
    runCommand: runner,
    ghConfigDir: options.ghConfigDir,
  };
  const auditOpts: WorkflowAuditOptions = {
    runCommand: runner,
    ghConfigDir: options.ghConfigDir,
  };

  const langResult = await detectRepoLanguages(repo, langOpts);
  if (!langResult.ok) {
    return {
      ok: false,
      error: `Language detection failed: ${langResult.error}`,
    };
  }
  const languages: RepoLanguages = langResult.value;

  const auditResult = await auditRepoWorkflows(repo, languages, auditOpts);
  if (!auditResult.ok) {
    return { ok: false, error: `Workflow audit failed: ${auditResult.error}` };
  }
  const audit: WorkflowAuditResult = auditResult.value;

  const presentSpecIds = new Set(audit.present.map((m) => m.spec.id));

  // 6. Decide and act per remaining candidate.
  for (const candidate of auditCandidates) {
    if (!presentSpecIds.has(candidate.specId)) {
      kept.push(candidate);
      continue;
    }

    if (options.dryRun) {
      closed.push(candidate);
      continue;
    }

    const ok = await closeIssue(repo, candidate, "now-present", runner);
    if (ok) {
      closed.push(candidate);
    } else {
      failures.push(candidate);
    }
  }

  return { ok: true, value: { repo, closed, kept, notApplicable, failures } };
}

/**
 * Purge stale workflow-sync issues across multiple repos.
 *
 * Iterates each repo in turn and aggregates results. A failure on one
 * repo does not abort the others — its error string is captured per-repo.
 */
export async function purgeStaleWorkflowIssuesForAllRepos(
  repos: string[],
  options: PurgeOptions = {},
): Promise<{ repo: string; result: Result<PurgeResult, string> }[]> {
  const out: { repo: string; result: Result<PurgeResult, string> }[] = [];
  for (const repo of repos) {
    if (!repo) continue;
    const result = await purgeStaleWorkflowIssuesForRepo(repo, options);
    out.push({ repo, result });
  }
  return out;
}
