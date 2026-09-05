/**
 * One-shot backfill that relabels existing "Workflow best-practice findings"
 * issues with the correct `severity:*` + category labels (Issue #2336).
 *
 * The forward-path reconciliation in `best_practices_sync.ts` (Issue #2335)
 * only fires when the auditor still produces ≥1 finding on the next sync. If
 * the underlying workflow was already fixed, `syncBestPracticesForRepo`
 * returns early on zero findings and never touches the existing issue — so
 * historic issues filed with only `enhancement` would never be relabelled.
 *
 * This module provides an explicitly-invokable, idempotent backfill:
 *
 *   1. List open issues carrying `BEST_PRACTICES_MARKER` in their body.
 *   2. Parse the highest severity from the body's rendered
 *      `severity: **<X>**` lines (the format owned by `renderFinding()`).
 *   3. Derive the labels via the shared `deriveBestPracticeLabels` helper.
 *   4. Skip issues already carrying the correct labels (idempotent).
 *   5. Otherwise ensure each label exists and add it — never removing
 *      `enhancement` or any other existing label.
 *
 * Recovers silently: per-issue and per-repo failures are caught and skipped
 * so the pass never crashes on unattended machines.
 *
 * **The marker is not evidence the fleet filed the issue.** The search is
 * `"<!-- vibe-coder:best-practices-sync -->" in:body`, the severities are
 * parsed straight out of the matched body, and the derived labels are then
 * **written** onto every match. A body is text anyone who can open an
 * issue may write, so an unverified match lets an outsider choose which
 * issues the fleet labels and what it labels them. Every match is
 * author-verified against the fleet identity
 * (`lib/alert_dedup_authors.ts`) before a label is written.
 *
 * **The fail direction is "write nothing".** An unresolvable fleet
 * relabels no issue at all: an un-backfilled label is fixed by the next
 * pass, a label written onto a stranger's issue is a write the fleet
 * should never have made. The category label the sync applies is
 * deliberately not used as a second scope — the historic issues this
 * backfill exists for are precisely the ones that lack it.
 */

import type { BestPracticeFinding } from "../lib/workflow_best_practices.ts";
import { addLabelToIssue } from "../lib/label_operations.ts";
import {
  BEST_PRACTICES_MARKER,
  buildLabelDeps,
  deriveBestPracticeLabels,
  ensureDerivedLabels,
  type GhCommandFn,
} from "./best_practices_sync.ts";
import {
  ALERT_DEDUP_JSON_FIELDS,
  type AlertDedupAuthorOptions,
  type AlertDedupRow,
  selectFleetAuthoredMatches,
} from "../lib/alert_dedup_authors.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for `relabelBestPracticesForRepo`.
 *
 * Extends {@link AlertDedupAuthorOptions}: `fleetAuthors` (tests) or the
 * configured fleet identity (production) decides whose marker issue may be
 * relabelled.
 */
export interface RelabelRepoOptions extends AlertDedupAuthorOptions {
  /** Command runner override (testing). */
  ghCommandFn?: GhCommandFn;
  /** Custom `gh` config directory. */
  ghConfigDir?: string;
  /** Cache directory for label lookups (testing — overrides the default). */
  labelCacheDir?: string;
  /** When true, report intended changes without mutating any issue. */
  dryRun?: boolean;
  /** Sink for the author-verification diagnostics. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

/** Options for `relabelBestPracticesForAllRepos`. */
export interface RelabelAllOptions extends RelabelRepoOptions {
  /** Monitored repos in `owner/repo` form. */
  repos: string[];
}

/** Per-repo result of a backfill run. */
export interface RelabelResult {
  ok: boolean;
  repo: string;
  /** Number of marker issues matched. */
  scanned: number;
  /** Number of issues that had labels added. */
  relabelled: number;
  /** Number of issues already correctly labelled (left untouched). */
  skipped: number;
  /** Error message when the repo-level scan failed. */
  error?: string;
}

interface ExistingIssue {
  number: number;
  labels: string[];
  body: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Parse every rendered `severity: **<X>**` value from an issue body, in
 * document order. Matches the format produced by `renderFinding()` in
 * `best_practices_sync.ts`. Returns an empty array when none are present.
 */
export function parseSeveritiesFromBody(
  body: string,
): BestPracticeFinding["severity"][] {
  const out: BestPracticeFinding["severity"][] = [];
  const re = /severity:\s*\*\*(high|medium|low)\*\*/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.push(m[1]!.toLowerCase() as BestPracticeFinding["severity"]);
  }
  return out;
}

/** Build the default `gh` runner (mirrors best_practices_sync.defaultRunner). */
function defaultRunner(ghConfigDir?: string): GhCommandFn {
  return async (cmd: string[]): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
  }> => {
    const env = ghConfigDir
      ? { ...Deno.env.toObject(), GH_CONFIG_DIR: ghConfigDir }
      : undefined;
    const command = new Deno.Command(cmd[0]!, {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "piped",
      env,
    });
    const result = await command.output();
    const decoder = new TextDecoder();
    return {
      success: result.success,
      stdout: decoder.decode(result.stdout).trim(),
      stderr: decoder.decode(result.stderr).trim(),
    };
  };
}

/**
 * List open **fleet-filed** issues carrying the best-practices marker,
 * returning each issue's number, labels, and body.
 *
 * The author is requested alongside the body and the match is verified
 * before the issue becomes a relabel candidate — a marker in a body is not
 * evidence the fleet filed the issue, and what happens to a candidate is a
 * label write.
 */
async function findMarkerIssues(
  repo: string,
  runner: GhCommandFn,
  options: AlertDedupAuthorOptions,
  log: (message: string) => void,
): Promise<ExistingIssue[]> {
  const result = await runner([
    "gh",
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--search",
    `"${BEST_PRACTICES_MARKER}" in:body`,
    "--json",
    `${ALERT_DEDUP_JSON_FIELDS},labels`,
    "--limit",
    "100",
  ]);
  if (!result.success) {
    throw new Error(result.stderr || result.stdout || "gh issue list failed");
  }
  const parsed = JSON.parse(result.stdout) as (AlertDedupRow & {
    labels?: { name: string }[];
  })[];
  const verified = await selectFleetAuthoredMatches(
    parsed.filter((iss) => (iss.body ?? "").includes(BEST_PRACTICES_MARKER)),
    `best-practices relabel ${repo}`,
    options,
    log,
    "no label is written — the backfill must never write labels onto an " +
      "issue the fleet did not file",
  );
  return verified.map((iss) => ({
    number: iss.number,
    labels: (iss.labels ?? []).map((l) => l.name),
    body: iss.body ?? "",
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Backfill labels for one repository. Idempotent and silent: issues already
 * carrying the derived labels are skipped, and per-issue failures are caught
 * so the pass continues. A repo-level failure (e.g. the issue list query)
 * is reported in the result but never thrown.
 */
export async function relabelBestPracticesForRepo(
  repo: string,
  options: RelabelRepoOptions = {},
): Promise<RelabelResult> {
  const runner = options.ghCommandFn ?? defaultRunner(options.ghConfigDir);

  let issues: ExistingIssue[];
  try {
    issues = await findMarkerIssues(
      repo,
      runner,
      options,
      options.log ?? ((message: string) => console.warn(message)),
    );
  } catch (err) {
    return {
      ok: false,
      repo,
      scanned: 0,
      relabelled: 0,
      skipped: 0,
      error: `Failed to list marker issues: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  let relabelled = 0;
  let skipped = 0;
  const deps = buildLabelDeps(runner, options.labelCacheDir);

  for (const issue of issues) {
    try {
      const severities = parseSeveritiesFromBody(issue.body);
      // Only severity drives the derivation; supply minimal stubs.
      const findings = severities.map((severity) => ({ severity }));
      const desired = deriveBestPracticeLabels(findings);
      const missing = desired.filter((l) => !issue.labels.includes(l));

      if (missing.length === 0) {
        skipped++;
        continue;
      }

      if (options.dryRun) {
        relabelled++;
        continue;
      }

      const ensured = await ensureDerivedLabels(repo, missing, deps);
      let addedAny = false;
      for (const label of ensured) {
        const res = await addLabelToIssue(repo, issue.number, label, deps);
        if (res.ok) addedAny = true;
      }
      if (addedAny) relabelled++;
    } catch {
      // Silent per-issue recovery — never abort the repo pass.
    }
  }

  return { ok: true, repo, scanned: issues.length, relabelled, skipped };
}

/**
 * Backfill labels across every monitored repository. Iterates serially so a
 * failure on one repo never blocks the next.
 */
export async function relabelBestPracticesForAllRepos(
  options: RelabelAllOptions,
): Promise<RelabelResult[]> {
  const runner = options.ghCommandFn ?? defaultRunner(options.ghConfigDir);
  const results: RelabelResult[] = [];
  for (const repo of options.repos) {
    if (!repo) continue;
    const result = await relabelBestPracticesForRepo(repo, {
      ghCommandFn: runner,
      labelCacheDir: options.labelCacheDir,
      dryRun: options.dryRun,
      ...(options.fleetAuthors !== undefined
        ? { fleetAuthors: options.fleetAuthors }
        : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.loadConfigFn !== undefined
        ? { loadConfigFn: options.loadConfigFn }
        : {}),
      ...(options.log !== undefined ? { log: options.log } : {}),
    });
    results.push(result);
  }
  return results;
}
