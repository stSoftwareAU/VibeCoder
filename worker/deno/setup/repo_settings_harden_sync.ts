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
 *  - CodeQL default setup, `default` query suite, on public repositories
 *    only (Issue #2704): written only when `not-configured`, never on a
 *    private repository (paid Code Security — not even read there), and
 *    never over a repository's own CodeQL workflow, which is reported;
 *  - private vulnerability reporting on public repositories only
 *    (Issue #3267), turned on with a bare PUT only when it reads
 *    `enabled: false`; a private or internal repository is not read, and
 *    its line says so;
 *  - one approving review on the default branch (Issue #2680), so fleet PRs
 *    wait for `/review-fleet-prs` or the owner instead of auto-merging
 *    unreviewed. A branch that takes direct pushes gets no pull_request rule
 *    (it would refuse every push); its line says so for the owner to decide;
 *  - code-owner review turned OFF in every repository ruleset that requires
 *    it: the fleet reviewer App cannot be a code owner, so its approval is
 *    the gate and CODEOWNERS only routes review requests;
 *  - merge commits allowed, with the default branch kept squash-only, so a
 *    milestone sync PR lands as a merge commit and converges without an
 *    admin bypass (Issue #2690);
 *  - every fleet account (`fleet_pr_authors` ∪ `service_accounts`) at write,
 *    never admin or maintain (Issue #2690). An organisation owner is admin
 *    everywhere whatever its repository role, so it is reported ONCE per
 *    organisation with the setting to change; setup never changes
 *    organisation membership;
 *  - Copilot code review as `copilot_code_review` says (Issue #2701): `off`
 *    removes the rule from every repository ruleset, deleting a ruleset it
 *    leaves empty; `on` makes sure the default branch carries it; `leave`
 *    (the default) reads and writes nothing. Each change is named on the
 *    repository's line, since each review is billed.
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
  isGitHubLogin,
} from "../lib/repo_settings_harden.ts";
import { isValidRepoSlug, renderInertRepoSlug } from "../lib/repo_slug.ts";
import type { CopilotCodeReviewMode } from "../types.ts";
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
  /** Fleet PR authors; with `service_accounts`, held at write (#2690). */
  fleet_pr_authors?: string[];
  /**
   * On, off or leave Copilot code review (Issue #2701), already validated by
   * the caller. Absent is `leave`.
   */
  copilot_code_review?: CopilotCodeReviewMode;
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
  "codeql-default-setup",
  "private-vulnerability-reporting",
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
  /** Copilot code review changes written, by title (Issue #2701). */
  copilot: string[];
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
    copilot: [],
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Count one repository's outcome into applied/unchanged/skipped/failed. */
function tallyOutcome(outcome: HardenRepoOutcome): RepoTally {
  const tally = emptyTally();
  const count = (r: HardenResult) => {
    if (r.status === "applied") {
      tally.applied++;
      // Each Copilot change moves a bill, so it is named (Issue #2701).
      if (r.step.kind === "copilot-code-review") {
        tally.copilot.push(r.step.title);
      }
    } else if (r.status === "planned") {
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
    } else if (kind === "codeql-default-setup" && outcome.codeqlSkipNote) {
      tally.skipped++;
      tally.skips.push(outcome.codeqlSkipNote);
    } else if (
      kind === "private-vulnerability-reporting" && outcome.pvrSkipNote
    ) {
      tally.skipped++;
      tally.skips.push(outcome.pvrSkipNote);
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
  if (tally.copilot.length > 0) parts.push(tally.copilot.join(", "));
  if (tally.failures.length > 0) {
    parts.push(`failed: ${tally.failures.join(", ")}`);
  }
  if (tally.skips.length > 0) parts.push(`skipped: ${tally.skips.join(", ")}`);
  if (codeowners) parts.push(describeCodeowners(codeowners));
  return parts.join("; ");
}

const UNKNOWN_LOGIN = "an unknown login";

/** The login `gh` is running as, for the identity line (Issue #2685). */
async function readLogin(gh: GhCommandFn): Promise<string> {
  try {
    const user = JSON.parse(await gh(["api", "user"])) as { login?: unknown };
    return typeof user.login === "string" ? user.login : UNKNOWN_LOGIN;
  } catch {
    return UNKNOWN_LOGIN;
  }
}

/**
 * The fleet accounts held at write (Issue #2690): `fleet_pr_authors` ∪
 * `service_accounts`, once each whatever the spelling.
 */
function fleetLogins(config: RepoSettingsHardenConfig): string[] {
  const seen = new Map<string, string>();
  for (
    const login of [
      ...(config.fleet_pr_authors ?? []),
      ...(config.service_accounts ?? []),
    ]
  ) {
    if (!seen.has(login.toLowerCase())) seen.set(login.toLowerCase(), login);
  }
  return [...seen.values()];
}

/**
 * Which fleet accounts own each organisation, read once per organisation
 * (Issue #2690). An owner is admin on every repository and no repository
 * setting can lower that, so each is reported ONCE, with the organisation
 * setting to change — setup never changes organisation membership. A user
 * account, or a login that is not a member, reads as a 404: not an owner.
 */
function orgOwnerLookup(
  fleetAccounts: readonly string[],
  deps: RepoSettingsHardenDeps,
): (org: string) => Promise<string[]> {
  const cache = new Map<string, Promise<string[]>>();
  const read = async (org: string): Promise<string[]> => {
    const owners: string[] = [];
    // A login that is not a GitHub login never reaches an API path.
    for (const login of fleetAccounts.filter(isGitHubLogin)) {
      try {
        const membership = JSON.parse(
          await deps.ghCommandFn([
            "api",
            `orgs/${org}/memberships/${login}`,
          ]),
        ) as { role?: unknown; state?: unknown };
        if (membership.role === "admin" && membership.state === "active") {
          owners.push(login);
        }
      } catch (err) {
        if (/\b404\b|Not Found/i.test(errorMessage(err))) continue;
        deps.warn(
          `Could not read ${login}'s role in the ${org} organisation ` +
            `(${errorMessage(err)}); its repository role is still checked.`,
        );
      }
    }
    for (const login of owners) {
      deps.warn(
        `${login} is an owner of the ${org} organisation, so it is admin on ` +
          `every repository there and no repository setting can lower that. ` +
          `Change it at https://github.com/orgs/${org}/people: find ${login}, ` +
          `choose Change role, then Member. Setup never changes organisation ` +
          `membership. As a Member it has the organisation's base ` +
          `permission, so grant it write on each monitored repository ` +
          `afterwards — the collaborator precheck ` +
          `(verify-monitored-collaborator) prints the commands.`,
      );
    }
    return owners;
  };
  return (org) => {
    let owners = cache.get(org);
    if (!owners) {
      owners = isValidRepoSlug(`${org}/x`) ? read(org) : Promise.resolve([]);
      cache.set(org, owners);
    }
    return owners;
  };
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
  const fleetAccounts = fleetLogins(config);
  const ownersOf = orgOwnerLookup(fleetAccounts, deps);
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
      // One default-branch lookup per repo, memoised for the writer.
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

      const outcome = await harden(repo, {
        apply: !dryRun,
        ghCommandFn: deps.ghCommandFn,
        fleetAccounts,
        orgOwners: await ownersOf(repo.split("/")[0] ?? ""),
        ...(login === UNKNOWN_LOGIN ? {} : { setupLogin: login }),
        ...(config.copilot_code_review
          ? { copilotCodeReview: config.copilot_code_review }
          : {}),
        ...(deps.defaultBranchCachePath
          ? { defaultBranchCachePath: deps.defaultBranchCachePath }
          : {}),
      });
      tally = tallyOutcome(outcome);

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
