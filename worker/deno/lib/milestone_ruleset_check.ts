/**
 * Setup-time verification of the `milestone/**` ruleset (Issue #586).
 *
 * Milestone branches are the collection branches a chain of child PRs lands
 * into. Two things have to be true of them at once, and they pull in opposite
 * directions:
 *
 * 1. **A PR into a milestone branch must be auto-mergeable.** GitHub can only
 *    arm auto-merge when something blocks the merge — a required status check
 *    or a required review. With no ruleset the PR is immediately mergeable, so
 *    auto-merge is refused and the fleet falls back to polling the checks
 *    itself (`direct_merge.ts`, Issue #926). One landing mechanism enforced by
 *    GitHub beats two enforced by us.
 * 2. **The branch sync must still land.** `syncMilestoneBranchWithDefault`
 *    merges the default branch into each milestone branch and pushes the
 *    result. A `required_status_checks` rule refuses that push from an
 *    account that cannot bypass it — the merge commit has no checks yet,
 *    because checks run *after* a push. The service account is deliberately
 *    not a bypass actor (an admin may bypass, the fleet may not), so a refused
 *    push raises or updates a sync PR instead (`git_pull.ts`,
 *    `milestone_sync_pr.ts`, Issue #589), which the same gate makes
 *    auto-mergeable.
 *
 * The worker itself never writes a milestone ruleset. Setup, running as the
 * operator, creates a missing one and aligns an existing one to the
 * GRQ-AutoTrader "milestone branches" template on every run, with no prompt
 * (Issue #2623) — {@link syncMilestoneRuleset}. The template never guesses a
 * check: it mirrors the default branch's, so a milestone PR is held to the
 * same bar as the PR that eventually merges the collection — **less any check
 * no merged milestone PR reports** (Issue #2684). A check whose workflow runs
 * only for PRs into the default branch can never report on a milestone PR,
 * and requiring it held every milestone PR BLOCKED for ever.
 *
 * The owner's spec for `milestone/**` (Issue #2684): required status checks
 * must pass, `strict_required_status_checks_policy` is **false** (the branch
 * need not be up to date), and there is **no** `pull_request` rule, so no
 * approval is required. {@link buildMilestoneRulesetBody} is the only body
 * the aligner writes, and it cannot express either.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  buildMilestoneRulesetBody,
  isValidRepoSlug,
  MILESTONE_REF_PATTERN,
  type RequiredStatusCheckBody,
  type RulesetBody,
  type RulesetBypassActorBody,
  type RulesetEnforcement,
} from "./repo_rulesets.ts";

/** Ref patterns that count as covering the milestone branches. */
const MILESTONE_REF_PATTERNS: readonly string[] = [
  MILESTONE_REF_PATTERN,
  "refs/heads/milestone/*",
  "~ALL",
];

/** A bypass entry as the ruleset API returns it. */
export interface RulesetBypassActor {
  actor_type?: string;
  actor_id?: number;
  bypass_mode?: string;
}

/** One rule as the ruleset API returns it, with the parameters we read. */
export interface RulesetRule {
  type?: string;
  parameters?: {
    required_approving_review_count?: number;
    required_status_checks?: Array<{
      context?: string;
      /** The app the check is pinned to, when it is pinned. */
      integration_id?: number;
    }>;
    strict_required_status_checks_policy?: boolean;
    /**
     * When true, the required checks gate merges but NOT branch creation.
     * A branch that does not exist yet has no check runs, so without this the
     * push that would create it is declined (Issue #3912 follow-up).
     */
    do_not_enforce_on_create?: boolean;
  };
}

/** A ruleset in the detail shape (`GET /repos/{repo}/rulesets/{id}`). */
export interface RulesetDetail {
  id?: number;
  name?: string;
  target?: string;
  enforcement?: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  rules?: RulesetRule[];
  bypass_actors?: RulesetBypassActor[];
}

/** What the worker needs to know about its own identity on the repo. */
export interface ServiceAccountContext {
  /** The service account's login. */
  login: string;
  /**
   * Its permission on the repository (`admin`, `maintain`, `write`, …), or
   * undefined when it could not be read — in which case bypass by repository
   * role cannot be proven and is reported as unproven, not as absent.
   */
  permission?: string;
}

/** Severity of one finding. */
export type MilestoneRulesetSeverity = "error" | "warning" | "info";

/** One thing setup has to say about the milestone ruleset. */
export interface MilestoneRulesetFinding {
  severity: MilestoneRulesetSeverity;
  /** Stable identifier, so a caller can suppress or test one finding. */
  code:
    | "no-milestone-ruleset"
    | "no-required-checks"
    | "direct-push-blocked"
    | "review-required"
    | "ruleset-disabled"
    | "create-blocked"
    | "unreportable-checks"
    | "no-automerge-gate"
    | "ruleset-read-failed"
    | "configured";
  message: string;
}

/**
 * Findings for required contexts that no PR into the branch ever reports.
 *
 * A required check that cannot report blocks its PRs for ever, and nothing
 * says so — the PR reads `MERGEABLE` and `BLOCKED` with no failing check to
 * point at. GRQ #4560 sat exactly there: its `milestone/**` ruleset required
 * `gitleaks` and `semgrep`, while eight workflows filtered their PR base with
 * `branches: ["*"]` — a single-segment glob that never matches
 * `milestone/4340-…`. Only `actionlint`, which used `["**"]`, ever ran.
 *
 * @param required - Contexts the ruleset demands.
 * @param reported - Check names seen on a recent PR into the same branch
 *   pattern; an empty list means nothing could be sampled, and nothing is
 *   claimed.
 */
export function unreportableChecks(
  required: readonly string[],
  reported: readonly string[],
): string[] {
  if (reported.length === 0) return [];
  const seen = new Set(reported);
  return required.filter((context) => !seen.has(context));
}

/** Repository-role ids GitHub uses in a `RepositoryRole` bypass actor. */
const ROLE_IDS: Record<number, string> = {
  1: "read",
  2: "triage",
  3: "write",
  4: "maintain",
  5: "admin",
};

/** Permissions that satisfy a `RepositoryRole` bypass of the given id. */
function permissionSatisfiesRole(
  permission: string | undefined,
  roleId: number | undefined,
): boolean {
  if (!permission || roleId === undefined) return false;
  const required = ROLE_IDS[roleId];
  if (!required) return false;
  const ladder = ["read", "triage", "write", "maintain", "admin"];
  const have = ladder.indexOf(permission);
  const need = ladder.indexOf(required);
  return have !== -1 && need !== -1 && have >= need;
}

/** Whether a ruleset's conditions cover the milestone branches. */
export function coversMilestoneBranches(ruleset: RulesetDetail): boolean {
  const include = ruleset.conditions?.ref_name?.include ?? [];
  return include.some((pattern) =>
    MILESTONE_REF_PATTERNS.includes(pattern) ||
    pattern.startsWith("refs/heads/milestone/")
  );
}

/**
 * Whether the service account can push through this ruleset.
 *
 * A `User` bypass naming the account, or a `RepositoryRole` bypass at or below
 * the account's own permission. `OrganizationAdmin` and `Team` bypasses cannot
 * be resolved from here, so they are treated as unproven rather than absent —
 * the finding says so instead of asserting a break that may not exist.
 */
export function serviceAccountCanBypass(
  ruleset: RulesetDetail,
  account: ServiceAccountContext,
): { bypasses: boolean; unproven: boolean } {
  let unproven = false;
  for (const actor of ruleset.bypass_actors ?? []) {
    if (actor.bypass_mode === "pull_request") continue;
    switch (actor.actor_type) {
      case "User":
        // The API gives a numeric id, not a login, so a User bypass can only
        // be confirmed when it is the account's own id — which setup does not
        // resolve. Report it as unproven rather than guessing either way.
        unproven = true;
        break;
      case "RepositoryRole":
        if (permissionSatisfiesRole(account.permission, actor.actor_id)) {
          return { bypasses: true, unproven: false };
        }
        break;
      case "OrganizationAdmin":
      case "Team":
      case "Integration":
      case "DeployKey":
        unproven = true;
        break;
    }
  }
  return { bypasses: false, unproven };
}

/**
 * Assess the milestone-branch configuration and say what is wrong.
 *
 * Pure — the caller fetches the rulesets and the account's permission.
 *
 * @param rulesets - Every ruleset on the repository, in detail shape.
 * @param account - The service account the worker runs as.
 * @returns Findings, most severe first; a single `configured` info finding
 *   when everything the fleet needs is in place.
 */
export function assessMilestoneRuleset(
  rulesets: readonly RulesetDetail[],
  account: ServiceAccountContext,
  /**
   * Check names observed on a recent PR into a milestone branch, used to catch
   * a required context that can never report. Omit when none could be sampled
   * — the check is then skipped rather than guessed at.
   */
  reportedChecks: readonly string[] = [],
): MilestoneRulesetFinding[] {
  const covering = rulesets.filter(coversMilestoneBranches);

  if (covering.length === 0) {
    return [{
      severity: "warning",
      code: "no-milestone-ruleset",
      message:
        "no ruleset covers `milestone/**`, so GitHub cannot arm auto-merge " +
        "on a PR into a milestone branch — nothing blocks the merge for it " +
        "to wait on. The fleet falls back to polling the checks itself " +
        "(direct_merge.ts, Issue #926). Add a ruleset targeting " +
        "`refs/heads/milestone/**` with required status checks to make " +
        "landing GitHub-enforced (Issue #586).",
    }];
  }

  const findings: MilestoneRulesetFinding[] = [];

  for (const ruleset of covering) {
    const name = ruleset.name ?? `#${ruleset.id ?? "?"}`;

    if (ruleset.enforcement && ruleset.enforcement !== "active") {
      findings.push({
        severity: "warning",
        code: "ruleset-disabled",
        message:
          `ruleset '${name}' covers \`milestone/**\` but its enforcement is ` +
          `'${ruleset.enforcement}', so it gates nothing. Setup aligns its ` +
          `rules but leaves the enforcement a human chose (Issue #2623).`,
      });
      continue;
    }

    const rules = ruleset.rules ?? [];
    const checks = rules.find((r) => r.type === "required_status_checks");
    const pullRequest = rules.find((r) => r.type === "pull_request");
    const contexts = checks?.parameters?.required_status_checks ?? [];

    if (!checks || contexts.length === 0) {
      findings.push({
        severity: "warning",
        code: "no-required-checks",
        message:
          `ruleset '${name}' covers \`milestone/**\` but requires no status ` +
          `checks, so auto-merge still cannot be armed on a milestone PR.`,
      });
    }

    // Required checks enforced on branch CREATION cannot ever be satisfied.
    //
    // GitHub evaluates `required_status_checks` against the pushed commit, and
    // a branch that does not exist yet has no check runs — so the push that
    // would create it is declined, with "N of M required status checks are
    // expected". The milestone-branch self-heal therefore cannot open a
    // milestone branch at all, and every child issue escalates to
    // `needs-human` instead of starting work.
    //
    // Observed 2026-09-06 on a repository whose ruleset had six PR-only
    // checks: six issues on one milestone were stranded for twelve hours,
    // re-escalating each time the label was cleared, because the cause was on
    // the ruleset rather than the issues.
    //
    // It hides on any host whose account holds an admin bypass, which is why
    // this is worth checking at setup rather than waiting to be discovered:
    // the same fleet works on one host and stalls on another.
    //
    // The remedy is `do_not_enforce_on_create`, NOT removing the rule — the
    // checks still gate every merge, and `required_status_checks` must stay
    // present because that is what makes the base "protected" and lets
    // auto-merge be armed at PR creation (`pr_auto_merge.ts`).
    if (checks !== undefined && contexts.length > 0) {
      const exemptOnCreate =
        checks.parameters?.do_not_enforce_on_create === true;
      if (!exemptOnCreate) {
        findings.push({
          severity: "error",
          code: "create-blocked",
          message:
            `ruleset '${name}' enforces its required status checks on branch ` +
            `CREATION, so the milestone-branch self-heal cannot open a ` +
            `\`milestone/**\` branch: a branch that does not exist yet has no ` +
            `check runs to satisfy, and the push is declined. Every child ` +
            `issue on such a milestone escalates to \`needs-human\` instead of ` +
            `starting work. Set \`do_not_enforce_on_create\` on that rule — do ` +
            `NOT remove the rule, which would leave the base unprotected and ` +
            `silently stop auto-merge being armed.`,
        });
      }
    }

    // A gate the service account cannot bypass is the intended policy, and
    // the branch sync lands through a sync PR there (Issue #589), so it earns
    // no finding. A bypass this check cannot resolve might exempt the
    // service account, which the policy forbids — that is worth saying.
    const blocksPush = pullRequest !== undefined ||
      (checks !== undefined && contexts.length > 0);
    if (blocksPush) {
      const bypass = serviceAccountCanBypass(ruleset, account);
      if (!bypass.bypasses && bypass.unproven) {
        findings.push({
          severity: "warning",
          code: "direct-push-blocked",
          message: `ruleset '${name}' gates \`milestone/**\` and carries a ` +
            `bypass this check cannot resolve (a User, Team, Integration or ` +
            `OrganizationAdmin actor). If it exempts '${account.login}', the ` +
            `service account can push past the gate — which the operator's ` +
            `policy forbids: an admin may bypass, the fleet may not ` +
            `(Issue #586).`,
        });
      }
    }

    const missing = unreportableChecks(
      contexts.map((c) => c.context).filter((c): c is string =>
        typeof c === "string"
      ),
      reportedChecks,
    );
    if (missing.length > 0) {
      findings.push({
        severity: "error",
        code: "unreportable-checks",
        message:
          `ruleset '${name}' requires ${missing.length} check(s) that no ` +
          `milestone PR reports: ${missing.join(", ")}. Those PRs will read ` +
          `MERGEABLE and BLOCKED for ever, with no failing check to point ` +
          `at. Usually a workflow whose \`pull_request\` trigger filters on ` +
          `the default branch, or on \`branches: ["*"]\`, which matches one ` +
          'path segment and so never matches `milestone/...` — `["**"]` ' +
          `does (Issue #586). Setup drops such checks from its own ` +
          `'${MILESTONE_RULESET_NAME}' ruleset (Issue #2684).`,
      });
    }

    const approvals = pullRequest?.parameters?.required_approving_review_count;
    if (approvals !== undefined && approvals > 0) {
      findings.push({
        severity: "warning",
        code: "review-required",
        message:
          `ruleset '${name}' requires ${approvals} approving review(s) on ` +
          `\`milestone/**\`. Every child PR the fleet raises into a milestone ` +
          `branch will wait for a human, which is a review gate off the ` +
          `default branch.`,
      });
    }
  }

  if (findings.length === 0) {
    return [{
      severity: "info",
      code: "configured",
      message:
        "`milestone/**` is covered by a ruleset with required status checks, " +
        "so milestone PRs are auto-mergeable; the branch sync pushes " +
        "directly where the service account may and raises a sync PR where " +
        "it may not (Issue #589).",
    }];
  }

  const order: Record<MilestoneRulesetSeverity, number> = {
    error: 0,
    warning: 1,
    info: 2,
  };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ---------------------------------------------------------------------------
// The I/O half: fetch what the assessment needs
// ---------------------------------------------------------------------------

/** `gh` executor seam, matching `repo_rulesets.ts`. */
export type GhJson = (args: string[], stdin?: string) => Promise<string>;

/** Outcome of reading a repository's rulesets. */
export type RulesetRead =
  | { ok: true; rulesets: RulesetDetail[] }
  | { ok: false; error: Error };

/** The message of a thrown value, whatever it is. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A ruleset summary as the LIST endpoint returns it. */
interface RulesetSummary {
  id?: number;
  /** `Repository` for the repo's own rulesets, `Organization` for inherited. */
  source_type?: string;
  /** The org login, or `owner/repo`, the ruleset is defined on. */
  source?: string;
}

/**
 * The API path that serves one ruleset's detail.
 *
 * The list endpoint includes rulesets INHERITED from the organisation, and
 * those are not addressable under the repository: GitHub serves an org-level
 * ruleset from `/orgs/{org}/rulesets/{id}` and answers the repository path for
 * the same id with 404. Reading every id from the repository path therefore
 * failed the whole read on any repo whose organisation defines a ruleset —
 * which, now that a failed read is loud (Issue #678), would warn on every run
 * about a repository whose `milestone/**` ruleset is present and readable.
 */
function rulesetDetailPath(repo: string, summary: RulesetSummary): string {
  if (summary.source_type === "Organization" && summary.source) {
    return `orgs/${summary.source}/rulesets/${summary.id}`;
  }
  return `repos/${repo}/rulesets/${summary.id}`;
}

/**
 * Read every ruleset on the repository in DETAIL shape.
 *
 * The list endpoint returns summaries with no `rules` and no `bypass_actors`,
 * so each ruleset is fetched by id — the only shape that can answer whether
 * the branch is gated and whether the service account can still push it.
 *
 * A read that FAILS is reported as a failure, never as an empty repository
 * (Issue #678). Reading rulesets needs administration access on some
 * repositories and GitHub answers a read it will not serve with 404, so
 * swallowing the error made "cannot see it" look exactly like "it is not
 * there" — which is how setup kept offering to create a ruleset that already
 * existed. The same reasoning covers a single unreadable ruleset, an empty
 * response body and a summary carrying no id: each could be the milestone
 * ruleset, so the whole read fails rather than quietly omitting one.
 *
 * @returns The rulesets, or the error that stopped them being read.
 */
export async function readRulesetDetails(
  repo: string,
  ghFn: GhJson,
): Promise<RulesetRead> {
  let summaries: RulesetSummary[];
  try {
    const raw = await ghFn(["api", `repos/${repo}/rulesets`]);
    // An empty body is not an empty list: `gh` prints nothing when it could
    // not serve the read, and reading that as "no rulesets" is the same
    // silent failure this function exists to remove (Issue #678).
    if (!raw.trim()) {
      return {
        ok: false,
        error: new Error(
          "could not read the repository's rulesets: the list endpoint " +
            "answered with an empty body",
        ),
      };
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        error: new Error(
          "could not read the repository's rulesets: the list endpoint " +
            "answered with something that is not a list of rulesets",
        ),
      };
    }
    summaries = parsed;
  } catch (error) {
    return {
      ok: false,
      error: new Error(
        `could not read the repository's rulesets: ${messageOf(error)}`,
      ),
    };
  }

  const rulesets: RulesetDetail[] = [];
  for (const summary of summaries) {
    if (typeof summary.id !== "number") {
      return {
        ok: false,
        error: new Error(
          "could not read the repository's rulesets: the list endpoint " +
            "returned a ruleset with no id, which cannot be fetched",
        ),
      };
    }
    const path = rulesetDetailPath(repo, summary);
    try {
      const raw = await ghFn(["api", path]);
      if (!raw.trim()) {
        return {
          ok: false,
          error: new Error(
            `could not read ruleset ${summary.id}: the response was empty`,
          ),
        };
      }
      rulesets.push(JSON.parse(raw) as RulesetDetail);
    } catch (error) {
      return {
        ok: false,
        error: new Error(
          `could not read ruleset ${summary.id}: ${messageOf(error)}`,
        ),
      };
    }
  }
  return { ok: true, rulesets };
}

/**
 * The finding for a ruleset state that could not be read (Issue #678).
 *
 * Says plainly that nothing is known, so no caller mistakes it for "the
 * ruleset is missing" and offers to create one.
 */
export function rulesetReadFailedFinding(
  error: Error,
): MilestoneRulesetFinding {
  return {
    severity: "warning",
    code: "ruleset-read-failed",
    message: `${error.message}. Setup cannot tell which branches are gated, ` +
      `so it reports nothing further here and does not offer to create the ` +
      `\`milestone/**\` ruleset — an unreadable state is never reported as ` +
      `missing (Issue #678). Check that the identity setup reads with can ` +
      `read this repository's rulesets; on some repositories that needs ` +
      `admin.`,
  };
}

/**
 * The service account's permission on the repository.
 *
 * @returns The permission string, or undefined when it cannot be read — which
 *   the assessment reports as unproven rather than as absent.
 */
export async function fetchServiceAccountPermission(
  repo: string,
  login: string,
  ghFn: GhJson,
): Promise<string | undefined> {
  try {
    const raw = await ghFn([
      "api",
      `repos/${repo}/collaborators/${login}/permission`,
      "--jq",
      ".permission",
    ]);
    const permission = raw.trim();
    return permission.length > 0 ? permission : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check one repository's milestone-branch configuration.
 *
 * Read-only: two `gh` reads per ruleset plus one permission read, at setup
 * time only — the same budget discipline `branch_protection_sync.ts` documents.
 * A caller that has already read the rulesets passes them in and spends none
 * of that budget twice.
 *
 * @returns The findings, or a single `ruleset-read-failed` warning when the
 *   rulesets could not be read — never a "missing ruleset" claim built on a
 *   read that failed (Issue #678).
 */
export async function checkMilestoneRuleset(
  repo: string,
  login: string,
  ghFn: GhJson,
  options: {
    rulesets?: readonly RulesetDetail[];
    /** A sample the caller already took, so the check and the sync agree. */
    reportedChecks?: readonly string[];
  } = {},
): Promise<MilestoneRulesetFinding[]> {
  const [read, permission, reportedChecks] = await Promise.all([
    options.rulesets
      ? Promise.resolve<RulesetRead>({
        ok: true,
        rulesets: [...options.rulesets],
      })
      : readRulesetDetails(repo, ghFn),
    fetchServiceAccountPermission(repo, login, ghFn),
    options.reportedChecks
      ? Promise.resolve([...options.reportedChecks])
      : fetchMilestonePrCheckNames(repo, ghFn),
  ]);
  if (!read.ok) return [rulesetReadFailedFinding(read.error)];
  return assessMilestoneRuleset(read.rulesets, {
    login,
    ...(permission !== undefined ? { permission } : {}),
  }, reportedChecks);
}

/** How many merged milestone PRs {@link fetchMilestonePrCheckSample} reads. */
const MILESTONE_PR_SAMPLE = 5;

/** What recent merged milestone PRs reported (Issue #2684). */
export interface MilestonePrCheckSample {
  /** Every name any sampled PR reported, in first-seen order. */
  union: string[];
  /** The names EVERY sampled PR reported, in first-seen order. */
  everyPr: string[];
}

/**
 * Check names reported by recent MERGED PRs into a milestone branch.
 *
 * The sample is what makes {@link unreportableChecks} answerable and what the
 * aligner intersects the default branch's checks with (Issue #2684). Only
 * merged PRs count:
 *
 * - An open PR may still be running. GRQ-AutoTrader's open milestone PR had
 *   not reached its final `gate` job when it was sampled, so setup claimed
 *   `gate` never reports — on a repository where every merged milestone PR
 *   reports it.
 * - Anyone who can open a PR chooses which workflows it runs. A merged PR
 *   went through the gate, so no outsider can shrink the sample and have the
 *   aligner drop a check.
 *
 * `union` is the evidence a check CAN report, so one PR whose path filters
 * skipped a workflow does not drop that check. `everyPr` is the stricter
 * evidence the TagsTS fallback needs, because there a name is ADDED: only a
 * check every PR reported can be required without wedging the next one.
 * A PR with no rollup at all proves nothing and is left out of both.
 *
 * @returns Both lists, empty when no merged milestone PR could be sampled —
 *   in which case nothing is claimed.
 */
export async function fetchMilestonePrCheckSample(
  repo: string,
  ghFn: GhJson,
): Promise<MilestonePrCheckSample> {
  const none = { union: [], everyPr: [] };
  let parsed: unknown;
  try {
    const raw = await ghFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "merged",
      "--search",
      "base:milestone",
      "--limit",
      String(MILESTONE_PR_SAMPLE),
      "--json",
      "statusCheckRollup",
    ]);
    parsed = raw ? JSON.parse(raw) : [];
  } catch {
    // A listing that cannot be read proves nothing.
    return none;
  }
  if (!Array.isArray(parsed)) return none;

  const perPr: string[][] = [];
  for (const pr of parsed) {
    const rollup = pr?.statusCheckRollup;
    if (!Array.isArray(rollup)) continue;
    const names = (rollup as Array<{ name?: string; context?: string }>)
      .map((check) => check.name ?? check.context)
      .filter((name): name is string =>
        typeof name === "string" && name.length > 0
      );
    if (names.length > 0) perPr.push(names);
  }
  const union = [...new Set(perPr.flat())];
  return {
    union,
    everyPr: union.filter((name) => perPr.every((pr) => pr.includes(name))),
  };
}

/** The union of {@link fetchMilestonePrCheckSample}, for the findings. */
export async function fetchMilestonePrCheckNames(
  repo: string,
  ghFn: GhJson,
): Promise<string[]> {
  return (await fetchMilestonePrCheckSample(repo, ghFn)).union;
}

// ---------------------------------------------------------------------------
// Creating or aligning the ruleset (Issues #586, #2623)
// ---------------------------------------------------------------------------

/** Name setup gives every `milestone/**` ruleset it creates or aligns. */
export const MILESTONE_RULESET_NAME = "Vibe Coder milestone branches";

/** Enforcement values GitHub accepts, so an aligned one is written back as is. */
const ENFORCEMENTS: readonly RulesetEnforcement[] = [
  "active",
  "disabled",
  "evaluate",
];

/** What every milestone ruleset should carry, mirrored from the default branch. */
export interface MilestoneTemplateSource {
  checks: RequiredStatusCheckBody[];
  bypassActors: RulesetBypassActorBody[];
}

/** One write {@link planMilestoneRulesetSync} decided on. */
export type MilestoneRulesetWrite =
  | { kind: "create"; body: RulesetBody }
  | { kind: "align"; id: number; previousName: string; body: RulesetBody };

/** What setup should do to make `milestone/**` match the template. */
export interface MilestoneRulesetSyncPlan {
  writes: MilestoneRulesetWrite[];
  /** Rulesets setup will not write, each with the reason. */
  skipped: Array<{ ruleset: string; reason: string }>;
  /** Every context the default branch requires, in its order. */
  mirrored: string[];
  /**
   * Default-branch contexts left off `milestone/**` because no merged
   * milestone PR reports them (Issue #2684). Empty when nothing was sampled.
   */
  dropped: string[];
  /** Whether any merged milestone PR's checks could be sampled. */
  sampled: boolean;
  /**
   * Checks required in place of the default branch's when none of those
   * reports on a milestone PR (TagsTS, Issue #2684): the names every sampled
   * milestone PR reported, so milestone PRs are still held to clean CI.
   */
  substituted: string[];
}

/**
 * Whether this ruleset is the one setup owns: its include is exactly
 * `refs/heads/milestone/**`. A broader ruleset that also covers milestone
 * branches is left untouched (Issue #2623).
 */
export function isExactMilestoneRuleset(ruleset: RulesetDetail): boolean {
  const include = ruleset.conditions?.ref_name?.include ?? [];
  return include.length === 1 && include[0] === MILESTONE_REF_PATTERN;
}

/** Whether a ruleset has at least one required status check. */
function requiresChecks(ruleset: RulesetDetail): boolean {
  return (ruleset.rules ?? []).some((rule) =>
    rule.type === "required_status_checks" &&
    (rule.parameters?.required_status_checks ?? []).length > 0
  );
}

/** Bypass actors of `ruleset` in the shape a ruleset write accepts. */
function mirroredBypassActors(
  ruleset: RulesetDetail | undefined,
): RulesetBypassActorBody[] {
  return (ruleset?.bypass_actors ?? [])
    .filter((actor): actor is Required<RulesetBypassActor> =>
      actor.actor_type !== undefined && actor.actor_id !== undefined &&
      actor.bypass_mode !== undefined
    )
    .filter((actor) =>
      actor.actor_type === "RepositoryRole" || actor.actor_type === "Team" ||
      actor.actor_type === "Integration" ||
      actor.actor_type === "OrganizationAdmin"
    )
    .map((actor) => ({
      actor_type: actor.actor_type as RulesetBypassActorBody["actor_type"],
      actor_id: actor.actor_id,
      bypass_mode: actor.bypass_mode as RulesetBypassActorBody["bypass_mode"],
    }));
}

/**
 * The checks and bypass actors to mirror onto `milestone/**`.
 *
 * Taken from the default-branch ruleset — the first one requiring checks, or
 * failing that the first one at all, so a check-less default branch still
 * lends its bypass actors. A milestone-only ruleset is never its own source.
 * Each check keeps its `integration_id` when it has one.
 *
 * @param defaultBranch - The resolved default branch; without it any ruleset
 *   on `~DEFAULT_BRANCH` or an explicit `refs/heads/` ref counts.
 */
export function milestoneTemplateSource(
  rulesets: readonly RulesetDetail[],
  defaultBranch?: string,
): MilestoneTemplateSource {
  const candidates = rulesets.filter((ruleset) =>
    !targetsOnlyMilestoneBranches(ruleset) &&
    (defaultBranch
      ? coversDefaultBranch(ruleset, defaultBranch)
      : (ruleset.conditions?.ref_name?.include ?? []).some((pattern) =>
        pattern === "~DEFAULT_BRANCH" || pattern.startsWith("refs/heads/")
      ))
  );
  const mirror = candidates.find(requiresChecks) ?? candidates[0];

  const checks: RequiredStatusCheckBody[] = [];
  const seen = new Set<string>();
  for (const rule of mirror?.rules ?? []) {
    if (rule.type !== "required_status_checks") continue;
    for (const check of rule.parameters?.required_status_checks ?? []) {
      if (typeof check.context !== "string" || check.context === "") continue;
      const id = check.integration_id;
      const key = `${check.context}\u0000${typeof id === "number" ? id : ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      checks.push(
        typeof id === "number"
          ? { context: check.context, integration_id: id }
          : { context: check.context },
      );
    }
  }
  return { checks, bypassActors: mirroredBypassActors(mirror) };
}

/** The parts of a ruleset the template governs, in a comparable form. */
function templateShape(ruleset: RulesetDetail | RulesetBody): string {
  const rules = ((ruleset.rules ?? []) as RulesetRule[]).map((rule) => {
    if (rule.type !== "required_status_checks") return { type: rule.type };
    const parameters = rule.parameters ?? {};
    return {
      type: rule.type,
      strict: parameters.strict_required_status_checks_policy === true,
      exemptOnCreate: parameters.do_not_enforce_on_create === true,
      checks: (parameters.required_status_checks ?? [])
        .map((check) => `${check.context}@${check.integration_id ?? ""}`)
        .sort(),
    };
  }).map((rule) => JSON.stringify(rule)).sort();
  const bypass = ((ruleset.bypass_actors ?? []) as RulesetBypassActor[])
    .map((actor) =>
      `${actor.actor_type}:${actor.actor_id}:${actor.bypass_mode}`
    )
    .sort();
  return JSON.stringify({ name: ruleset.name, rules, bypass });
}

/** The contexts a ruleset currently requires. */
function currentContexts(ruleset: RulesetDetail): Set<string> {
  const contexts = new Set<string>();
  for (const rule of ruleset.rules ?? []) {
    if (rule.type !== "required_status_checks") continue;
    for (const check of rule.parameters?.required_status_checks ?? []) {
      if (typeof check.context === "string") contexts.add(check.context);
    }
  }
  return contexts;
}

/**
 * Decide, without writing, what makes `milestone/**` match the template.
 *
 * - Nothing covers `milestone/**` → create one, `active`.
 * - Each ruleset whose include is exactly `refs/heads/milestone/**` and whose
 *   name, rules, checks, strict policy, create exemption or bypass actors
 *   differ → align it. Rules the template lacks are dropped; enforcement is
 *   never changed, and neither are the ref conditions' excludes.
 * - A ruleset already matching the template gets no write.
 *
 * The checks are the default branch's, intersected with the names merged
 * milestone PRs report (Issue #2684) — the default-branch ruleset's own rule
 * (`default_branch_ruleset.ts`): a required check nothing reports holds every
 * PR BLOCKED for ever. With no sample there is no evidence either way, so a
 * new ruleset requires nothing and an existing one keeps what it has: never
 * adding an unproven check, and never stripping a gate an armed PR is
 * waiting on.
 *
 * When the default branch requires checks but NONE of them reports on a
 * milestone PR (TagsTS), requiring nothing would let a milestone PR merge on
 * no CI at all, against the owner's spec. The names every sampled milestone
 * PR reported are required instead, and named as substituted.
 *
 * @param reportedChecks - The sample's union, from
 *   {@link fetchMilestonePrCheckSample}; empty when nothing could be sampled.
 * @param everyPrChecks - The sample's names every PR reported; the only
 *   evidence strong enough to ADD a check the default branch does not require.
 */
export function planMilestoneRulesetSync(
  rulesets: readonly RulesetDetail[],
  defaultBranch: string | undefined,
  reportedChecks: readonly string[],
  everyPrChecks: readonly string[] = [],
): MilestoneRulesetSyncPlan {
  const { checks, bypassActors } = milestoneTemplateSource(
    rulesets,
    defaultBranch,
  );
  const sampled = reportedChecks.length > 0;
  const reported = new Set(reportedChecks);
  const mirrored = [...new Set(checks.map((check) => check.context))];
  const substituted = sampled && mirrored.length > 0 &&
      !mirrored.some((c) => reported.has(c))
    ? [...everyPrChecks]
    : [];
  const plan: MilestoneRulesetSyncPlan = {
    writes: [],
    skipped: [],
    mirrored,
    dropped: sampled ? mirrored.filter((c) => !reported.has(c)) : [],
    sampled,
    substituted,
  };
  /** The template's checks this evidence shows a milestone PR reports. */
  const evidenced = (
    evidence: ReadonlySet<string>,
  ): RequiredStatusCheckBody[] =>
    substituted.length > 0 && evidence === reported
      ? substituted.map((context) => ({ context }))
      : checks.filter((check) => evidence.has(check.context));

  if (!rulesets.some(coversMilestoneBranches)) {
    plan.writes.push({
      kind: "create",
      body: buildMilestoneRulesetBody(
        MILESTONE_RULESET_NAME,
        evidenced(reported),
        bypassActors,
      ),
    });
    return plan;
  }

  for (const ruleset of rulesets.filter(isExactMilestoneRuleset)) {
    const name = ruleset.name ?? `#${ruleset.id ?? "?"}`;
    if (typeof ruleset.id !== "number") {
      plan.skipped.push({ ruleset: name, reason: "it has no id to update" });
      continue;
    }
    const enforcement = (ruleset.enforcement ?? "active") as RulesetEnforcement;
    if (!ENFORCEMENTS.includes(enforcement)) {
      plan.skipped.push({
        ruleset: name,
        reason: `its enforcement '${enforcement}' is not one setup recognises`,
      });
      continue;
    }
    const built = buildMilestoneRulesetBody(
      MILESTONE_RULESET_NAME,
      evidenced(sampled ? reported : currentContexts(ruleset)),
      bypassActors,
      enforcement,
    );
    // A full-document PUT: bypass actors are always sent, so a stale actor is
    // removed rather than left behind by an omitted field.
    const body: RulesetBody = {
      ...built,
      conditions: {
        ref_name: {
          include: [MILESTONE_REF_PATTERN],
          exclude: [...(ruleset.conditions?.ref_name?.exclude ?? [])],
        },
      },
      bypass_actors: bypassActors,
    };
    if (templateShape(ruleset) === templateShape(body)) continue;
    plan.writes.push({
      kind: "align",
      id: ruleset.id,
      previousName: name,
      body,
    });
  }
  return plan;
}

/** What happened to one planned write, or to a ruleset setup would not write. */
export type MilestoneSyncOutcome =
  | { kind: "created"; ruleset: string; id?: number; body: RulesetBody }
  | {
    kind: "aligned";
    ruleset: string;
    previousName: string;
    id: number;
    body: RulesetBody;
  }
  | {
    kind: "failed";
    action: "create" | "align";
    ruleset: string;
    error: Error;
  }
  | { kind: "skipped"; ruleset: string; reason: string };

/** Outcome of {@link syncMilestoneRuleset}. */
export type MilestoneSyncResult =
  | (
    & { ok: true; outcomes: MilestoneSyncOutcome[] }
    & Pick<
      MilestoneRulesetSyncPlan,
      "mirrored" | "dropped" | "sampled" | "substituted"
    >
  )
  | { ok: false; error: Error };

/**
 * Create or align the `milestone/**` ruleset to the template (Issue #2623).
 *
 * No prompt, on any run. Each write is attempted on its own, so one refused
 * write is reported as `failed` without stopping the rest. Setup calls this
 * with the operator's credentials: a ruleset write needs `admin`, and only
 * that identity can see the bypass actors a full-document PUT must carry
 * (Issue #595) — so it re-reads the rulesets itself rather than trusting a
 * service-account read.
 *
 * @param options.rulesets - Injected for tests; production reads them.
 * @param options.defaultBranch - The branch whose checks are mirrored.
 * @param options.sample - A milestone-PR sample the caller already took;
 *   taken here with {@link fetchMilestonePrCheckSample} when absent.
 * @returns The outcomes, or the read error — an unreadable state is never
 *   taken for "nothing covers `milestone/**`" (Issue #678).
 */
export async function syncMilestoneRuleset(
  repo: string,
  ghFn: GhJson,
  options: {
    rulesets?: RulesetDetail[];
    defaultBranch?: string;
    sample?: MilestonePrCheckSample;
  } = {},
): Promise<MilestoneSyncResult> {
  if (!isValidRepoSlug(repo)) {
    return { ok: false, error: new Error(`Invalid repo slug: ${repo}`) };
  }
  let rulesets = options.rulesets;
  if (!rulesets) {
    const read = await readRulesetDetails(repo, ghFn);
    if (!read.ok) return { ok: false, error: read.error };
    rulesets = read.rulesets;
  }

  const sample = options.sample ??
    await fetchMilestonePrCheckSample(repo, ghFn);
  const plan = planMilestoneRulesetSync(
    rulesets,
    options.defaultBranch,
    sample.union,
    sample.everyPr,
  );
  const outcomes: MilestoneSyncOutcome[] = plan.skipped.map((skip) => ({
    kind: "skipped",
    ...skip,
  }));
  for (const write of plan.writes) {
    const payload = JSON.stringify(write.body);
    try {
      if (write.kind === "create") {
        const raw = await ghFn([
          "api",
          "-X",
          "POST",
          `repos/${repo}/rulesets`,
          "--input",
          "-",
          "--jq",
          ".id",
        ], payload);
        const id = Number(raw.trim());
        outcomes.push({
          kind: "created",
          ruleset: write.body.name,
          ...(Number.isInteger(id) && id > 0 ? { id } : {}),
          body: write.body,
        });
      } else {
        await ghFn([
          "api",
          "-X",
          "PUT",
          `repos/${repo}/rulesets/${write.id}`,
          "--input",
          "-",
        ], payload);
        outcomes.push({
          kind: "aligned",
          ruleset: write.body.name,
          previousName: write.previousName,
          id: write.id,
          body: write.body,
        });
      }
    } catch (error) {
      outcomes.push({
        kind: "failed",
        action: write.kind,
        ruleset: write.kind === "create" ? write.body.name : write.previousName,
        error: explainRulesetWriteFailure(error, repo),
      });
    }
  }
  return {
    ok: true,
    outcomes,
    mirrored: plan.mirrored,
    dropped: plan.dropped,
    sampled: plan.sampled,
    substituted: plan.substituted,
  };
}

/**
 * The rulesets as they stand after the successful writes, so what setup then
 * reports describes the repository it left behind, not the one it found.
 */
export function applyMilestoneSyncOutcomes(
  rulesets: readonly RulesetDetail[],
  outcomes: readonly MilestoneSyncOutcome[],
): RulesetDetail[] {
  // A written body is the detail shape GitHub would now return, minus ids.
  const asDetail = (body: RulesetBody, id?: number): RulesetDetail => ({
    ...(body as unknown as RulesetDetail),
    ...(id !== undefined ? { id } : {}),
  });
  const next = [...rulesets];
  for (const outcome of outcomes) {
    if (outcome.kind === "aligned") {
      const index = next.findIndex((ruleset) => ruleset.id === outcome.id);
      const detail = asDetail(outcome.body, outcome.id);
      if (index === -1) next.push(detail);
      else next[index] = detail;
    } else if (outcome.kind === "created") {
      next.push(asDetail(outcome.body, outcome.id));
    }
  }
  return next;
}

/**
 * Turn a refused ruleset write into an error that names the cause.
 *
 * GitHub answers a ruleset write from a non-admin with 404, not 403, so the
 * bare "Not Found" names neither the cause nor the fix (Issue #595). Every
 * repository in a fleet run failed this way, identically, with nothing to act
 * on.
 */
function explainRulesetWriteFailure(error: unknown, repo: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (!/not found/i.test(message)) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(
    `${message} — writing a ruleset needs ADMIN on ${repo}, and GitHub ` +
      `reports insufficient permission as 404. Check that the identity ` +
      `running setup administers this repository (the worker's service ` +
      `account holds 'write', which is not enough).`,
  );
}

// ---------------------------------------------------------------------------
// Repairing a ruleset that refuses branch CREATION (Issue #2067)
// ---------------------------------------------------------------------------

/** Outcome of {@link repairMilestoneRulesetCreateBlock}. */
export type RepairMilestoneResult =
  | { ok: true; repaired: true; ruleset: string }
  | { ok: true; repaired: false; reason: string }
  | { ok: false; error: Error };

/**
 * Whether every ref this ruleset matches is a milestone branch.
 *
 * The repair below writes without asking, so its blast radius has to be the
 * fleet's own namespace. A ruleset including `~ALL` or the default branch
 * gates refs the fleet does not own; that one is reported by
 * {@link assessMilestoneRuleset} for a human to decide on instead.
 */
export function targetsOnlyMilestoneBranches(ruleset: RulesetDetail): boolean {
  const include = ruleset.conditions?.ref_name?.include ?? [];
  return include.length > 0 &&
    include.every((pattern) => pattern.startsWith("refs/heads/milestone/"));
}

/**
 * The milestone ruleset whose required checks refuse branch creation, if any.
 *
 * Read-only, so a caller can decide without writing. A rule whose
 * `do_not_enforce_on_create` is absent counts as blocking: GitHub defaults it
 * to false, which is exactly the shape this repo's own builder wrote before
 * Issue #2067.
 */
export function planMilestoneRulesetRepair(
  rulesets: readonly RulesetDetail[],
): RulesetDetail | null {
  return rulesets.find((ruleset) =>
    typeof ruleset.id === "number" &&
    (ruleset.enforcement ?? "active") === "active" &&
    targetsOnlyMilestoneBranches(ruleset) &&
    (ruleset.rules ?? []).some((rule) =>
      rule.type === "required_status_checks" &&
      (rule.parameters?.required_status_checks ?? []).length > 0 &&
      rule.parameters?.do_not_enforce_on_create !== true
    )
  ) ?? null;
}

/**
 * The full-document body that exempts a ruleset's checks from branch
 * creation, carrying every other rule, condition and bypass actor through
 * unchanged.
 *
 * A ruleset write is a PUT of the whole document, so a body rebuilt from the
 * checks alone would silently drop `deletion`, `non_fast_forward` and any
 * rule an admin added (the Issue #1290 lesson, in a second place).
 */
export function buildCreateExemptRulesetBody(
  ruleset: RulesetDetail,
): Record<string, unknown> {
  return {
    name: ruleset.name,
    target: ruleset.target ?? "branch",
    enforcement: ruleset.enforcement ?? "active",
    bypass_actors: ruleset.bypass_actors ?? [],
    conditions: ruleset.conditions,
    rules: (ruleset.rules ?? []).map((rule) =>
      rule.type === "required_status_checks"
        ? {
          ...rule,
          parameters: {
            ...(rule.parameters ?? {}),
            do_not_enforce_on_create: true,
          },
        }
        : rule
    ),
  };
}

/**
 * Exempt a `milestone/**` ruleset's required checks from branch creation.
 *
 * This is the other half of the Issue #2067 fix. Setting the flag in
 * {@link buildMilestoneRulesetBody} stops the trap being created; this clears
 * it from the repositories already carrying one, which cannot clear
 * themselves — the worker's service account holds `write`, and a ruleset
 * write needs `admin`, so only setup (running as the operator) can do it.
 *
 * Idempotent: a repository whose ruleset is already exempt is not written.
 *
 * @param repo - `owner/repo` slug.
 * @param ghFn - `gh` runner, which must hold `admin` on the repository.
 * @param options.rulesets - Injected for tests; production reads the live
 *   rulesets under the caller's own identity (Issue #595).
 */
export async function repairMilestoneRulesetCreateBlock(
  repo: string,
  ghFn: GhJson,
  options: { rulesets?: RulesetDetail[] } = {},
): Promise<RepairMilestoneResult> {
  if (!isValidRepoSlug(repo)) {
    return { ok: false, error: new Error(`Invalid repo slug: ${repo}`) };
  }
  let rulesets = options.rulesets;
  if (!rulesets) {
    // A read that failed must never be reported as "nothing to repair" —
    // that would call a broken repository healthy (Issue #678).
    const read = await readRulesetDetails(repo, ghFn);
    if (!read.ok) return { ok: false, error: read.error };
    rulesets = read.rulesets;
  }

  const target = planMilestoneRulesetRepair(rulesets);
  if (!target) {
    return {
      ok: true,
      repaired: false,
      reason: "no milestone ruleset blocks branch creation",
    };
  }

  try {
    await ghFn(
      [
        "api",
        "-X",
        "PUT",
        `repos/${repo}/rulesets/${target.id}`,
        "--input",
        "-",
      ],
      JSON.stringify(buildCreateExemptRulesetBody(target)),
    );
    return {
      ok: true,
      repaired: true,
      ruleset: target.name ?? `#${target.id}`,
    };
  } catch (error) {
    return { ok: false, error: explainRulesetWriteFailure(error, repo) };
  }
}

// ---------------------------------------------------------------------------
// The default branch (Issue #553)
// ---------------------------------------------------------------------------

/**
 * Whether a ruleset covers the repository's default branch.
 *
 * `~DEFAULT_BRANCH` is GitHub's own alias and survives a rename; an explicit
 * `refs/heads/<name>` is matched against the branch the caller resolved.
 */
export function coversDefaultBranch(
  ruleset: RulesetDetail,
  defaultBranch: string,
): boolean {
  const include = ruleset.conditions?.ref_name?.include ?? [];
  return include.some((pattern) =>
    pattern === "~DEFAULT_BRANCH" || pattern === "~ALL" ||
    pattern === `refs/heads/${defaultBranch}`
  );
}

/**
 * Whether GitHub can arm auto-merge on a PR into this branch.
 *
 * Auto-merge exists to wait for something. GitHub therefore refuses to arm it
 * on a PR nothing blocks, so the base branch must require **status checks** or
 * **approving reviews** — a ruleset that only forbids deletion and
 * force-pushes gates the branch without ever blocking a merge.
 *
 * This is the whole of Issue #553's "auto-merge not set, apparently at
 * random": it is not random, it is deterministic on this property.
 * `NEAT-AI-Rebase`, the repository in that issue's example, carries a
 * `Develop` ruleset requiring zero checks and zero approvals.
 */
export function canArmAutoMerge(
  rulesets: readonly RulesetDetail[],
  defaultBranch: string,
): boolean {
  return rulesets
    .filter((ruleset) =>
      (ruleset.enforcement ?? "active") === "active" &&
      coversDefaultBranch(ruleset, defaultBranch)
    )
    .some((ruleset) =>
      (ruleset.rules ?? []).some((rule) => {
        if (rule.type === "required_status_checks") {
          return (rule.parameters?.required_status_checks ?? []).length > 0;
        }
        if (rule.type === "pull_request") {
          return (rule.parameters?.required_approving_review_count ?? 0) > 0;
        }
        return false;
      })
    );
}

/**
 * Report whether the fleet's PRs into the default branch can be auto-merged.
 *
 * Read-only, and deliberately says nothing when auto-merge IS available: the
 * healthy case is the common one and setup already prints a line per repo.
 *
 * @returns A finding when auto-merge cannot be armed, else null.
 */
export function assessDefaultBranchAutoMerge(
  rulesets: readonly RulesetDetail[],
  defaultBranch: string,
): MilestoneRulesetFinding | null {
  if (canArmAutoMerge(rulesets, defaultBranch)) return null;

  const covering = rulesets.filter((ruleset) =>
    coversDefaultBranch(ruleset, defaultBranch)
  );
  const detail = covering.length === 0
    ? `no ruleset covers '${defaultBranch}'`
    : `the ruleset(s) covering '${defaultBranch}' (${
      covering.map((r) => `'${r.name ?? r.id}'`).join(", ")
    }) require no status checks and no approving reviews`;

  return {
    severity: "warning",
    code: "no-automerge-gate",
    message:
      `auto-merge cannot be armed on a PR into '${defaultBranch}': ${detail}. ` +
      `GitHub refuses to arm auto-merge on a PR nothing blocks, so the ` +
      `worker's PRs there merge outright when they are already clean and ` +
      `carry no auto-merge when they are not — which reads as auto-merge ` +
      `being set at random (Issue #553). Require at least one status check ` +
      `or one approving review on that branch to make landing deterministic.`,
  };
}
