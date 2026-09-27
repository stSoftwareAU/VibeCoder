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
 *  - one approving review on the default branch (Issue #2680), so fleet PRs
 *    wait for `/review-fleet-prs` or the owner instead of auto-merging
 *    unreviewed. A branch that takes direct pushes gets no pull_request rule
 *    (it would refuse every push); its line says so for the owner to decide;
 *  - code-owner review on the Vibe ruleset, but only once CODEOWNERS is on
 *    the default branch — a ruleset demanding owners that do not exist would
 *    stop every merge.
 *
 * Per repository, in order: the CODEOWNERS writer (#2627), `hardenRepo` with
 * `apply: true` (#2626), then the closer that retires fleet-filed `BP-REPO-*`
 * audit issues the hardening fixed (#2629). Each repository runs in its own
 * try/catch, so one failure never stops the others; the step returns `false`
 * when any repository failed and never throws.
 *
 * IDENTITY (Issue #2685): every write here needs repository admin, so the
 * step runs as the operator's own `gh` login — never the fleet account in
 * `gh_config_dir`, which holds `write` by design and got a 403 or 404 on
 * every repository. The first line names the login. Admin is checked once
 * per repository (`repos/{repo}` `.permissions.admin`) before anything else;
 * a repository without it is left alone, and one line says the run "needs an
 * admin login" rather than a raw 403 or 404 per setting.
 *
 * DRY RUN (Issue #2685): `dryRun` plans every repository and writes nothing —
 * no settings, no CODEOWNERS file, no audit-issue comment or close.
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
import type {
  CodeownersSyncOptions,
  CodeownersSyncResult,
} from "./codeowners_sync.ts";

import type {
  CloseFixedFindingsOptions,
  CloseFixedFindingsResult,
} from "./repo_settings_audit_close.ts";

export type { CodeownersSyncResult };

type GhCommandFn = (args: string[]) => Promise<string>;

/** The CODEOWNERS writer (#2627's `syncCodeowners`). */
export type SyncCodeownersFn = (
  opts: CodeownersSyncOptions,
) => Promise<CodeownersSyncResult>;

/** The audit-issue closer (#2629's `closeFixedRepoSettingsFindings`). */
export type CloseFixedFindingsFn = (
  opts: CloseFixedFindingsOptions,
) => Promise<CloseFixedFindingsResult>;

/** The slice of the setup config this step reads. */
export interface RepoSettingsHardenConfig {
  repos?: string[];
  /** The fleet accounts whose audit issues the closer may close. */
  service_accounts?: string[];
}

/** Everything the step touches, injectable. */
export interface RepoSettingsHardenDeps {
  /**
   * The operator's own `gh` login (Issue #2685) — the identity that holds
   * admin. Never the fleet's `gh_config_dir`, which holds `write`.
   */
  ghCommandFn: GhCommandFn;
  /** Plan and report only; nothing is written anywhere (Issue #2685). */
  dryRun?: boolean;
  /** `WORK_DIR`: the CODEOWNERS writer's checkout is `<workDir>/<name>`. */
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
  "default-branch-approval",
  "ruleset-reviews",
];

interface RepoTally {
  applied: number;
  /** Steps a dry run would have written (Issue #2685). */
  planned: number;
  plans: string[];
  unchanged: number;
  skipped: number;
  failed: number;
  skips: string[];
  failures: string[];
}

function emptyTally(): RepoTally {
  return {
    applied: 0,
    planned: 0,
    plans: [],
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
    else if (r.status === "planned") {
      tally.planned++;
      tally.plans.push(r.step.kind);
    } else if (r.status === "failed") {
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

/** "N applied", or in a dry run "N planned" (Issue #2685). */
function written(tally: RepoTally, dryRun: boolean): string {
  return dryRun ? `${tally.planned} planned` : `${tally.applied} applied`;
}

function formatLine(
  repo: string,
  tally: RepoTally,
  codeowners: CodeownersSyncResult | undefined,
  dryRun: boolean,
): string {
  const parts = [
    `${repo}: ${written(tally, dryRun)}, ${tally.unchanged} unchanged, ` +
    `${tally.skipped} skipped, ${tally.failed} failed`,
  ];
  if (tally.plans.length > 0) {
    parts.push(`would apply: ${tally.plans.join(", ")}`);
  }
  if (tally.failures.length > 0) {
    parts.push(`failed: ${tally.failures.join(", ")}`);
  }
  if (tally.skips.length > 0) parts.push(`skipped: ${tally.skips.join(", ")}`);
  if (codeowners) parts.push(describeCodeowners(codeowners));
  return parts.join("; ");
}

/** The login `gh` is running as, for the identity line (Issue #2685). */
async function readLogin(gh: GhCommandFn): Promise<string> {
  try {
    const user = JSON.parse(await gh(["api", "user"])) as { login?: unknown };
    return typeof user.login === "string" ? user.login : "an unknown login";
  } catch {
    return "an unknown login";
  }
}

/**
 * Whether the `gh` identity holds admin on `repo` (Issue #2685): the
 * `.permissions.admin` flag GitHub returns for the caller. Every write this
 * step makes needs it, so it is asked once, up front.
 */
async function holdsAdmin(repo: string, gh: GhCommandFn): Promise<boolean> {
  const info = JSON.parse(await gh(["api", `repos/${repo}`])) as {
    permissions?: { admin?: unknown };
  };
  return info.permissions?.admin === true;
}

/**
 * Harden every monitored repository's settings (Issue #2628). Returns `false`
 * when any repository failed or lacked admin — setup reports that like any
 * other non-fatal step — and never throws.
 */
export async function runRepoSettingsHarden(
  config: RepoSettingsHardenConfig,
  deps: RepoSettingsHardenDeps,
): Promise<boolean> {
  const repos = config.repos ?? [];
  if (repos.length === 0) return true;
  const harden = deps.hardenRepo ?? hardenRepo;
  const dryRun = deps.dryRun === true;
  const totals = emptyTally();
  let failedRepos = 0;
  const needsAdmin: string[] = [];

  const login = await readLogin(deps.ghCommandFn);
  deps.log(
    `Repo-settings hardening runs as ${login}, your own gh login — not the ` +
      `fleet account in gh_config_dir, which holds write only` +
      (dryRun ? " (dry run: nothing is written)" : ""),
  );

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
      if (!await holdsAdmin(repo, deps.ghCommandFn)) {
        // Reported once, below, for every such repository.
        needsAdmin.push(renderInertRepoSlug(repo));
        continue;
      }
      // One default-branch lookup per repo, shared by the writer and the
      // code-owner decision: they must agree on what they saw.
      let lookup: Promise<CodeownersLocation> | undefined;
      const findOnDefaultBranch = (slug: string) =>
        slug === repo
          ? (lookup ??= findCodeownersOnDefaultBranch(slug, deps.ghCommandFn))
          : findCodeownersOnDefaultBranch(slug, deps.ghCommandFn);

      // The writer writes a file, so a dry run does not call it.
      try {
        codeowners = dryRun
          ? { status: "skipped", reason: "dry run" }
          : await deps.syncCodeowners({
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
        apply: !dryRun,
        ghCommandFn: deps.ghCommandFn,
        requireCodeOwnerReview: location.state === "present",
        ...(deps.defaultBranchCachePath
          ? { defaultBranchCachePath: deps.defaultBranchCachePath }
          : {}),
      });
      tally = tallyOutcome(outcome, location);

      // The closer comments on and closes issues: never in a dry run.
      if (!dryRun) await closeFindings(repo, outcome, config, deps);
    } catch (err) {
      tally.failed++;
      tally.failures.push(`harden (${errorMessage(err)})`);
    }
    if (codeowners?.status === "error") {
      tally.failed++;
    }

    const line = formatLine(
      renderInertRepoSlug(repo),
      tally,
      codeowners,
      dryRun,
    );
    if (tally.failed > 0) {
      failedRepos++;
      deps.warn(line);
    } else {
      deps.log(line);
    }
    totals.applied += tally.applied;
    totals.planned += tally.planned;
    totals.unchanged += tally.unchanged;
    totals.skipped += tally.skipped;
    totals.failed += tally.failed;
  }

  if (needsAdmin.length > 0) {
    failedRepos += needsAdmin.length;
    deps.warn(
      `Repo-settings hardening needs an admin login: ${login} is not an ` +
        `admin on ${needsAdmin.length} repo(s) (${needsAdmin.join(", ")}), ` +
        `so they were left alone. Run setup logged in to gh as a repository ` +
        `admin (gh auth login).`,
    );
  }
  deps.log(
    `Repo-settings hardening: ${written(totals, dryRun)}, ` +
      `${totals.unchanged} unchanged, ${totals.skipped} skipped, ` +
      `${totals.failed} failed across ${repos.length} repo(s); ` +
      `${failedRepos} repo(s) failed`,
  );
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
