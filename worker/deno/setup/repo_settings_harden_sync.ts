/**
 * Setup's repo-settings hardening step (Issue #2628, part of #2611).
 *
 * Runs on every `setup` after the default-branch ruleset sync and hardens
 * each monitored repository's GitHub settings, writing only what has drifted:
 *
 *  - a read-only default workflow token, and Actions may not approve PRs;
 *  - SHA pinning required;
 *  - `allowed_actions: selected`, with every transitive `owner/repo@*` the
 *    workflows need unioned onto the existing list;
 *  - secret scanning and push protection on public repositories only;
 *  - code-owner review on the Vibe ruleset, but only once CODEOWNERS is on
 *    the default branch — a ruleset demanding owners that do not exist would
 *    stop every merge.
 *
 * It NEVER enables required approving reviews: one required approval stops
 * the fleet's autonomous merges, which is a policy choice for the operator.
 *
 * Per repository, in order: the CODEOWNERS writer (#2627), `hardenRepo` with
 * `apply: true` (#2626), then the closer that retires fleet-filed `BP-REPO-*`
 * audit issues the hardening fixed (#2629). Each repository runs in its own
 * try/catch, so one failure never stops the others; the step returns `false`
 * when any repository failed and never throws.
 *
 * RATE-LIMIT BUDGET: setup-time only, like `branch_protection_sync.ts` —
 * never wire this into the per-iteration loop.
 *
 * Uses Australian English throughout (behaviour, organisation, etc.).
 */

import {
  type CodeownersLocation,
  findCodeownersOnDefaultBranch,
  hardenRepo,
  type HardenRepoOptions,
  type HardenRepoOutcome,
  type HardenResult,
  type HardenStep,
} from "../lib/repo_settings_harden.ts";
import { isValidRepoSlug, renderInertRepoSlug } from "../lib/repo_slug.ts";

type GhCommandFn = (args: string[]) => Promise<string>;

/** What the CODEOWNERS writer did for one repository (#2627's contract). */
export type CodeownersSyncResult =
  | { status: "written"; path: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; message: string };

/** The CODEOWNERS writer (#2627's `syncCodeowners`). */
export type SyncCodeownersFn = (opts: {
  repo: string;
  workDir: string;
  owners: readonly string[];
  findOnDefaultBranch(repo: string): Promise<CodeownersLocation>;
}) => Promise<CodeownersSyncResult>;

/** The audit-issue closer (#2629's `closeFixedRepoSettingsFindings`). */
export type CloseFixedFindingsFn = (opts: {
  repo: string;
  outcome: HardenRepoOutcome;
  ghCommandFn: GhCommandFn;
  fleetLogins: readonly string[];
  runLabel: string;
  log(line: string): void;
}) => Promise<{ closed: number[]; warnings: string[] }>;

/** The slice of the setup config this step reads. */
export interface RepoSettingsHardenConfig {
  repos?: string[];
  /** The fleet accounts whose audit issues the closer may close. */
  service_accounts?: string[];
}

/** Everything the step touches, injectable. */
export interface RepoSettingsHardenDeps {
  /** The admin `gh` seam (`gh_config_dir`), as the ruleset sync uses. */
  ghCommandFn: GhCommandFn;
  /** `WORK_DIR`: each repo's checkout is `<workDir>/<repo name>`. */
  workDir: string;
  /** CODEOWNERS owners handed to the writer. */
  owners: readonly string[];
  syncCodeowners: SyncCodeownersFn;
  closeFixedFindings: CloseFixedFindingsFn;
  /** Test seam; defaults to the real {@link hardenRepo}. */
  hardenRepo?: (
    repo: string,
    options: HardenRepoOptions,
  ) => Promise<HardenRepoOutcome>;
  /** Test seam: the default-branch disk cache. */
  defaultBranchCachePath?: string;
  /** Names this run in the closer's comments. */
  runLabel?: string;
  log(line: string): void;
  warn(line: string): void;
}

/**
 * The settings every run checks. A kind with no result held already
 * (`unchanged`); `milestone-branch-create` is per ruleset, so it is counted
 * only when it wrote or failed.
 */
const CHECKED_KINDS: readonly HardenStep["kind"][] = [
  "workflow-token",
  "sha-pinning-required",
  "actions-allow-list",
  "secret-scanning",
  "ruleset-reviews",
];

interface RepoTally {
  applied: number;
  unchanged: number;
  skipped: number;
  failed: number;
  skips: string[];
  failures: string[];
}

function emptyTally(): RepoTally {
  return {
    applied: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    skips: [],
    failures: [],
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Why code-owner review was not asked for, from the default-branch lookup. */
function codeOwnerSkipReason(location: CodeownersLocation): string {
  return location.state === "error"
    ? `code-owner review: CODEOWNERS lookup failed: ${location.message}`
    : "code-owner review: no CODEOWNERS on the default branch";
}

/** Count one repository's outcome into applied/unchanged/skipped/failed. */
function tallyOutcome(
  outcome: HardenRepoOutcome,
  location: CodeownersLocation,
): RepoTally {
  const tally = emptyTally();
  const count = (r: HardenResult) => {
    if (r.status === "applied") tally.applied++;
    else if (r.status === "failed") {
      tally.failed++;
      tally.failures.push(`${r.step.kind} (${r.detail ?? "failed"})`);
    } else if (r.status === "skipped") {
      tally.skipped++;
      tally.skips.push(`${r.step.kind}: ${r.detail ?? "skipped"}`);
    }
  };
  for (const r of outcome.results) count(r);
  for (const kind of CHECKED_KINDS) {
    if (outcome.results.some((r) => r.step.kind === kind)) continue;
    if (kind === "secret-scanning" && outcome.skipNote) {
      tally.skipped++;
      tally.skips.push(outcome.skipNote);
    } else if (kind === "ruleset-reviews" && location.state !== "present") {
      tally.skipped++;
      tally.skips.push(codeOwnerSkipReason(location));
    } else {
      tally.unchanged++;
    }
  }
  return tally;
}

function describeCodeowners(result: CodeownersSyncResult): string {
  switch (result.status) {
    case "written":
      return `codeowners: written ${result.path}`;
    case "skipped":
      return `codeowners: skipped (${result.reason})`;
    case "error":
      return `codeowners: error ${result.message}`;
  }
}

function formatLine(
  repo: string,
  tally: RepoTally,
  codeowners: CodeownersSyncResult | undefined,
): string {
  const parts = [
    `${repo}: ${tally.applied} applied, ${tally.unchanged} unchanged, ` +
    `${tally.skipped} skipped, ${tally.failed} failed`,
  ];
  if (tally.failures.length > 0) {
    parts.push(`failed: ${tally.failures.join(", ")}`);
  }
  if (tally.skips.length > 0) parts.push(`skipped: ${tally.skips.join(", ")}`);
  if (codeowners) parts.push(describeCodeowners(codeowners));
  return parts.join("; ");
}

/**
 * Harden every monitored repository's settings (Issue #2628). Returns `false`
 * when any repository failed — setup reports that like any other non-fatal
 * step — and never throws.
 */
export async function runRepoSettingsHarden(
  config: RepoSettingsHardenConfig,
  deps: RepoSettingsHardenDeps,
): Promise<boolean> {
  const repos = config.repos ?? [];
  const harden = deps.hardenRepo ?? hardenRepo;
  const totals = emptyTally();
  let failedRepos = 0;

  for (const repo of repos) {
    let tally = emptyTally();
    let codeowners: CodeownersSyncResult | undefined;
    try {
      // A path is derived from the slug, so a `..` never reaches the disk.
      if (!isValidRepoSlug(repo)) {
        throw new Error(
          "invalid owner/repo slug — refusing to derive a path from it",
        );
      }
      // One default-branch lookup per repo, shared by the writer and the
      // code-owner decision: they must agree on what they saw.
      let lookup: Promise<CodeownersLocation> | undefined;
      const findOnDefaultBranch = (slug: string) =>
        slug === repo
          ? (lookup ??= findCodeownersOnDefaultBranch(slug, deps.ghCommandFn))
          : findCodeownersOnDefaultBranch(slug, deps.ghCommandFn);

      try {
        codeowners = await deps.syncCodeowners({
          repo,
          workDir: deps.workDir,
          owners: deps.owners,
          findOnDefaultBranch,
        });
      } catch (err) {
        codeowners = { status: "error", message: errorMessage(err) };
      }
      const location = await findOnDefaultBranch(repo);

      const outcome = await harden(repo, {
        apply: true,
        ghCommandFn: deps.ghCommandFn,
        workDir: `${deps.workDir}/${repo.split("/")[1]}`,
        requireCodeOwnerReview: location.state === "present",
        // Never the fleet-stopping approval rule — see the module comment.
        requireReviews: false,
        ...(deps.defaultBranchCachePath
          ? { defaultBranchCachePath: deps.defaultBranchCachePath }
          : {}),
      });
      tally = tallyOutcome(outcome, location);

      await closeFindings(repo, outcome, config, deps);
    } catch (err) {
      tally.failed++;
      tally.failures.push(`harden (${errorMessage(err)})`);
    }
    if (codeowners?.status === "error") {
      tally.failed++;
    }

    const line = formatLine(renderInertRepoSlug(repo), tally, codeowners);
    if (tally.failed > 0) {
      failedRepos++;
      deps.warn(line);
    } else {
      deps.log(line);
    }
    totals.applied += tally.applied;
    totals.unchanged += tally.unchanged;
    totals.skipped += tally.skipped;
    totals.failed += tally.failed;
  }

  if (repos.length > 0) {
    deps.log(
      `Repo-settings hardening: ${totals.applied} applied, ` +
        `${totals.unchanged} unchanged, ${totals.skipped} skipped, ` +
        `${totals.failed} failed across ${repos.length} repo(s); ` +
        `${failedRepos} repo(s) failed`,
    );
  }
  return failedRepos === 0;
}

/**
 * Retire the audit issues this run fixed (#2629). Its faults are warnings:
 * the settings were hardened either way, so they never fail the step.
 */
async function closeFindings(
  repo: string,
  outcome: HardenRepoOutcome,
  config: RepoSettingsHardenConfig,
  deps: RepoSettingsHardenDeps,
): Promise<void> {
  try {
    const result = await deps.closeFixedFindings({
      repo,
      outcome,
      ghCommandFn: deps.ghCommandFn,
      fleetLogins: config.service_accounts ?? [],
      runLabel: deps.runLabel ?? "setup repo-settings-harden",
      // The closer logs each warning as it happens and also returns it, so
      // the returned list is not printed a second time.
      log: deps.warn,
    });
    if (result.closed.length > 0) {
      deps.log(
        `${repo}: closed fixed audit issue(s) ${
          result.closed.map((n) => `#${n}`).join(", ")
        }`,
      );
    }
  } catch (err) {
    deps.warn(`${repo}: audit-issue close skipped: ${errorMessage(err)}`);
  }
}
