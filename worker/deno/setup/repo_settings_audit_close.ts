/**
 * Close the fleet-filed `BP-REPO-*` audit issues that setup's repo hardening
 * fixed, once a read-back confirms the fix (Issue #2629, part of #2611).
 *
 * The weekly `github-actions-audit` files one issue per open repository
 * setting (`repo_settings_scanner.ts`); setup's `hardenRepo` (Issue #2626)
 * then closes that drift. Without this module the issues stayed open after
 * the settings were fixed, and a human closed each by hand. The setup pass
 * that hardens a repo (`repo_settings_harden_sync.ts`, Issue #2628) calls
 * {@link closeFixedRepoSettingsFindings} with that run's outcome.
 *
 * A finding counts as fixed only when all three hold:
 *
 *  1. **Its step ran cleanly this run.** Its id maps ({@link FINDING_STEP_KIND})
 *     to a hardening step kind whose results this run are all `applied`, or
 *     that has no result at all. `HardenResult.status` has no "unchanged":
 *     `planRepoSettingsHardening` plans nothing for a setting that already
 *     holds, and a surface that could not be read is a `failed` result of
 *     that kind — so "no result of that kind" is exactly "read, and already
 *     compliant". Any `failed`, `planned` (dry run) or `skipped` result of the
 *     kind makes it ineligible. A pass that aborted before planning (invalid
 *     slug, unknown default branch, a thrown fault — each recorded by
 *     `hardenRepo` as one failed `ruleset-reviews` read of `repos/<repo>`)
 *     read nothing, so it confirms nothing and closes nothing.
 *  2. **The re-scan completed.** `scanRepoSettings` is re-run through the same
 *     gh seam; any `onLookupFailure`, an unresolvable default branch or an
 *     unreadable CODEOWNERS lookup is a failed re-scan: nothing closes and one
 *     warning says so.
 *  3. **The re-scan no longer reports the id** — and, where the scanner's
 *     silence alone proves nothing, the read-back positively shows the fix:
 *     secret scanning / push protection must read `enabled` (a token without
 *     admin sees no `security_and_analysis`, and a private repo is exempted,
 *     both silently); CODEOWNERS-NOT-ENFORCED needs a CODEOWNERS file to have
 *     been checked; ALLOW-LIST-INCOMPLETE needs the repo to be on a `selected`
 *     allow-list.
 *
 * Only open issues carrying the finding's marker (parsed by the one
 * definition in `admin_only_finding.ts`) **and authored by a fleet login**
 * are touched: the marker sits in a body anyone may write, the author does
 * not. Each gets one comment naming the setup run and the settings changed,
 * then `gh issue close --reason completed`, through the caller's gh seam
 * (production: the `gh_spawn` chokepoint, which redacts the body and notes
 * the close). `BP-WORKER-TOKEN-CAN-EDIT-RULESETS` is never closed here —
 * setup cannot downgrade its own grant — and is not a `BP-REPO-*` id, so it
 * never parses as one.
 *
 * Never throws: every fault is a warning passed to `log` and returned.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { parseRepoSettingsFindingId } from "../lib/admin_only_finding.ts";
import {
  buildAllowedActionPatterns,
  findCodeownersOnDefaultBranch,
  type HardenRepoOutcome,
  type HardenStep,
} from "../lib/repo_settings_harden.ts";
import { scanRepoSettings } from "../lib/repo_settings_scanner.ts";
import { getRepoDefaultBranch } from "../lib/shell_helpers.ts";

/** Options for {@link closeFixedRepoSettingsFindings}. */
export interface CloseFixedFindingsOptions {
  repo: string;
  /** This run's `hardenRepo` result for the repo. */
  outcome: HardenRepoOutcome;
  ghCommandFn: (args: string[]) => Promise<string>;
  /** The fleet accounts the worker files audit findings as. */
  fleetLogins: readonly string[];
  /** Names the setup run in the closing comment. */
  runLabel: string;
  /** Warnings go here. */
  log: (line: string) => void;
  /**
   * The branch whose rules are re-scanned. Omitted: resolved through
   * `getRepoDefaultBranch` (the same look-up `hardenRepo` made).
   */
  defaultBranch?: string;
}

/** What {@link closeFixedRepoSettingsFindings} did. */
export interface CloseFixedFindingsResult {
  /** Issue numbers commented on and closed as completed. */
  closed: number[];
  /** Every warning, in the order it was logged. */
  warnings: string[];
}

/**
 * The hardening step kind that fixes each `BP-REPO-*` finding the scanner
 * files. A finding id absent from this map is never closed.
 */
export const FINDING_STEP_KIND: Readonly<Record<string, HardenStep["kind"]>> = {
  "BP-REPO-DEFAULT-TOKEN-WRITE": "workflow-token",
  "BP-REPO-ACTIONS-MAY-APPROVE-PRS": "workflow-token",
  "BP-REPO-ACTIONS-ALLOW-ALL": "actions-allow-list",
  "BP-REPO-ACTIONS-ALLOW-LIST-INCOMPLETE": "actions-allow-list",
  "BP-REPO-SHA-PIN-NOT-ENFORCED": "sha-pinning-required",
  "BP-REPO-RULESET-NO-REVIEW": "ruleset-reviews",
  "BP-REPO-CODEOWNERS-NOT-ENFORCED": "ruleset-reviews",
  "BP-REPO-SECRET-SCANNING-OFF": "secret-scanning",
  "BP-REPO-PUSH-PROTECTION-OFF": "secret-scanning",
};

/** Open issues read per repo; more than this is warned about, not paged. */
const OPEN_ISSUE_LIMIT = 200;

/** A step kind is clean when every result of that kind this run was applied. */
function kindRanCleanly(
  outcome: HardenRepoOutcome,
  kind: HardenStep["kind"],
): boolean {
  return outcome.results
    .filter((r) => r.step.kind === kind)
    .every((r) => r.status === "applied");
}

/**
 * The finding ids whose hardening step ran this run as `applied` or was not
 * needed at all (see the module doc for why "no result" means unchanged).
 */
export function eligibleFindingIds(outcome: HardenRepoOutcome): Set<string> {
  const out = new Set<string>();
  for (const [id, kind] of Object.entries(FINDING_STEP_KIND)) {
    if (kindRanCleanly(outcome, kind)) out.add(id);
  }
  return out;
}

/** True when `hardenRepo` gave up before reading any surface. */
function hardeningAborted(repo: string, outcome: HardenRepoOutcome): boolean {
  return outcome.results.some((r) =>
    r.status === "failed" && r.step.kind === "ruleset-reviews" &&
    r.step.endpoint === `repos/${repo}`
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The applied step titles that fixed `id`, for the closing comment. */
function changedSettings(
  outcome: HardenRepoOutcome,
  id: string,
): string[] {
  const kind = FINDING_STEP_KIND[id];
  return outcome.results
    .filter((r) => r.step.kind === kind && r.status === "applied")
    .map((r) => r.step.title);
}

function closingComment(
  id: string,
  runLabel: string,
  changed: readonly string[],
): string {
  const what = changed.length > 0
    ? "Settings changed by this run:\n\n" +
      changed.map((t) => `- ${t}`).join("\n")
    : "No change was needed: the setting was already compliant when this " +
      "run read it.";
  return `## Fixed — confirmed by setup's read-back\n\n` +
    `The setup run **${runLabel}** hardened this repository's settings. ` +
    `${what}\n\n` +
    `A re-scan of the repository settings after hardening no longer ` +
    `reports \`${id}\`, so this finding is closed as completed ` +
    `(Issue #2629). If the setting drifts again, the next audit re-files it.`;
}

interface OpenIssue {
  number: number;
  body: string;
  author: string;
}

async function listOpenIssues(
  repo: string,
  gh: (args: string[]) => Promise<string>,
): Promise<OpenIssue[]> {
  const raw = await gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--json",
    "number,body,author",
    "--limit",
    String(OPEN_ISSUE_LIMIT),
  ]);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("issue list is not an array");
  const out: OpenIssue[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const row = item as {
      number?: unknown;
      body?: unknown;
      author?: { login?: unknown } | null;
    };
    if (typeof row.number !== "number" || typeof row.body !== "string") {
      continue;
    }
    const login = row.author?.login;
    if (typeof login !== "string") continue;
    out.push({ number: row.number, body: row.body, author: login });
  }
  return out;
}

/**
 * Re-scan `repo` and return the eligible ids the read-back confirms fixed, or
 * a reason the re-scan failed.
 */
async function confirmFixed(
  opts: CloseFixedFindingsOptions,
  eligible: ReadonlySet<string>,
): Promise<{ ok: true; fixed: Set<string> } | { ok: false; reason: string }> {
  const { repo, outcome } = opts;
  let branch = opts.defaultBranch;
  if (!branch) {
    const resolved = await getRepoDefaultBranch(repo, opts.ghCommandFn);
    if (!resolved.ok) {
      return {
        ok: false,
        reason: `default branch unknown: ${resolved.error.message}`,
      };
    }
    branch = resolved.value;
  }
  const codeowners = await findCodeownersOnDefaultBranch(
    repo,
    opts.ghCommandFn,
  );
  if (codeowners.state === "error") {
    return { ok: false, reason: codeowners.message };
  }

  // Every settings read the re-scan makes, kept for the positive checks.
  const seen = new Map<string, unknown>();
  const recordingGh = async (args: string[]): Promise<string> => {
    const raw = await opts.ghCommandFn(args);
    if (args[0] === "api" && args[1]) {
      try {
        seen.set(args[1], JSON.parse(raw));
      } catch {
        // The scanner reports an unparseable body itself.
      }
    }
    return raw;
  };
  const failures: string[] = [];
  const findings = await scanRepoSettings(repo, recordingGh, {
    defaultBranch: branch,
    hasCodeowners: codeowners.state === "present",
    requiredActionPatterns: buildAllowedActionPatterns(outcome.coordinates),
    onLookupFailure: (what, reason) => failures.push(`${what}: ${reason}`),
  });
  if (failures.length > 0) {
    return { ok: false, reason: failures.join("; ") };
  }

  const reported = new Set(findings.map((f) => f.findingId));
  const repoInfo = seen.get(`repos/${repo}`) as {
    security_and_analysis?: Record<string, { status?: string } | undefined>;
  } | undefined;
  const statusOf = (key: string) =>
    repoInfo?.security_and_analysis?.[key]?.status;
  const actions = seen.get(`repos/${repo}/actions/permissions`) as {
    allowed_actions?: string;
  } | undefined;
  // Where the scanner's silence proves nothing, the read-back must show it.
  const positive: Record<string, () => boolean> = {
    "BP-REPO-SECRET-SCANNING-OFF": () =>
      statusOf("secret_scanning") === "enabled",
    "BP-REPO-PUSH-PROTECTION-OFF": () =>
      statusOf("secret_scanning_push_protection") === "enabled",
    "BP-REPO-CODEOWNERS-NOT-ENFORCED": () => codeowners.state === "present",
    "BP-REPO-ACTIONS-ALLOW-LIST-INCOMPLETE": () =>
      actions?.allowed_actions === "selected",
  };
  const fixed = new Set<string>();
  for (const id of eligible) {
    if (reported.has(id)) continue;
    const check = positive[id];
    if (check && !check()) continue;
    fixed.add(id);
  }
  return { ok: true, fixed };
}

/**
 * Comment on and close (`--reason completed`) every open, fleet-authored
 * issue whose `BP-REPO-*` finding this run's hardening fixed and the re-scan
 * confirms is gone. Never throws.
 */
export async function closeFixedRepoSettingsFindings(
  opts: CloseFixedFindingsOptions,
): Promise<CloseFixedFindingsResult> {
  const result: CloseFixedFindingsResult = { closed: [], warnings: [] };
  const warn = (line: string) => {
    result.warnings.push(line);
    opts.log(line);
  };
  const { repo } = opts;
  try {
    if (hardeningAborted(repo, opts.outcome)) {
      warn(
        `[repo-settings-audit-close] ${repo}: hardening did not complete ` +
          `this run — no audit issue is closed.`,
      );
      return result;
    }
    const eligible = eligibleFindingIds(opts.outcome);
    if (eligible.size === 0) return result;
    const fleet = new Set(opts.fleetLogins.map((l) => l.toLowerCase()));
    if (fleet.size === 0) {
      warn(
        `[repo-settings-audit-close] ${repo}: no fleet login is known, so no ` +
          `audit issue can be verified as fleet-filed — none is closed.`,
      );
      return result;
    }

    const confirmed = await confirmFixed(opts, eligible);
    if (!confirmed.ok) {
      warn(
        `[repo-settings-audit-close] ${repo}: the settings re-scan failed ` +
          `(${confirmed.reason}) — no audit issue is closed.`,
      );
      return result;
    }
    if (confirmed.fixed.size === 0) return result;

    let issues: OpenIssue[];
    try {
      issues = await listOpenIssues(repo, opts.ghCommandFn);
    } catch (err) {
      warn(
        `[repo-settings-audit-close] ${repo}: could not list open issues ` +
          `(${errorMessage(err)}) — no audit issue is closed.`,
      );
      return result;
    }
    if (issues.length >= OPEN_ISSUE_LIMIT) {
      warn(
        `[repo-settings-audit-close] ${repo}: the open-issue list hit the ` +
          `${OPEN_ISSUE_LIMIT}-issue limit — audit issues beyond it are not ` +
          `seen and stay open.`,
      );
    }

    for (const issue of issues) {
      const id = parseRepoSettingsFindingId(issue.body);
      if (!id || !confirmed.fixed.has(id)) continue;
      if (!fleet.has(issue.author.toLowerCase())) continue;
      await closeOne(opts, issue.number, id, result, warn);
    }
  } catch (err) {
    warn(
      `[repo-settings-audit-close] ${repo}: unexpected fault ` +
        `(${errorMessage(err)}) — audit issues not yet closed stay open.`,
    );
  }
  return result;
}

async function closeOne(
  opts: CloseFixedFindingsOptions,
  number: number,
  id: string,
  result: CloseFixedFindingsResult,
  warn: (line: string) => void,
): Promise<void> {
  const { repo } = opts;
  const issue = String(number);
  try {
    await opts.ghCommandFn([
      "issue",
      "comment",
      issue,
      "--repo",
      repo,
      "--body",
      closingComment(id, opts.runLabel, changedSettings(opts.outcome, id)),
    ]);
  } catch (err) {
    warn(
      `[repo-settings-audit-close] ${repo}#${number}: could not comment ` +
        `(${errorMessage(err)}) — ${id} left open.`,
    );
    return;
  }
  try {
    await opts.ghCommandFn([
      "issue",
      "close",
      issue,
      "--repo",
      repo,
      "--reason",
      "completed",
    ]);
    result.closed.push(number);
  } catch (err) {
    warn(
      `[repo-settings-audit-close] ${repo}#${number}: could not close ` +
        `(${errorMessage(err)}) — ${id} left open.`,
    );
  }
}
