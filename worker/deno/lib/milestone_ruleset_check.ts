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
 * 2. **The worker must still be able to push the branch directly.**
 *    `syncMilestoneBranchWithDefault` merges the default branch into each
 *    milestone branch and pushes the result. A `pull_request` rule blocks that
 *    push outright, and a `required_status_checks` rule blocks it too — the
 *    merge commit has no checks yet, because checks run *after* a push. Unless
 *    the service account is a bypass actor, protecting the branch silently
 *    breaks the sync that keeps it current (the Issue #4356 lesson, in a new
 *    place).
 *
 * This module **only reads and reports**. The worker does not write a
 * milestone ruleset: the operator owns it, and a configurator that guessed
 * here would be one misconfiguration away from freezing every milestone branch
 * in the fleet. Setup says what is wrong and what to change; a human decides.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  buildMilestoneRulesetBody,
  type RulesetBypassActorBody,
} from "./repo_rulesets.ts";

/** Ref patterns that count as covering the milestone branches. */
const MILESTONE_REF_PATTERNS: readonly string[] = [
  "refs/heads/milestone/**",
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
    required_status_checks?: Array<{ context?: string }>;
    strict_required_status_checks_policy?: boolean;
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
    | "configured";
  message: string;
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
          `'${ruleset.enforcement}', so it gates nothing.`,
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

    // The one that breaks the fleet rather than merely limiting it.
    const blocksPush = pullRequest !== undefined ||
      (checks !== undefined && contexts.length > 0);
    if (blocksPush) {
      const bypass = serviceAccountCanBypass(ruleset, account);
      if (!bypass.bypasses) {
        findings.push({
          severity: bypass.unproven ? "warning" : "error",
          code: "direct-push-blocked",
          message: bypass.unproven
            ? `ruleset '${name}' blocks direct pushes to \`milestone/**\` ` +
              `and carries a bypass this check cannot resolve (a User, Team, ` +
              `Integration or OrganizationAdmin actor). If it does not cover ` +
              `'${account.login}', the milestone branch sync — which merges ` +
              `the default branch in and pushes the result — will fail on ` +
              `every milestone branch (Issue #586).`
            : `ruleset '${name}' blocks direct pushes to \`milestone/**\` ` +
              `and '${account.login}' (permission ` +
              `'${account.permission ?? "unknown"}') is not a bypass actor. ` +
              `The milestone branch sync merges the default branch into each ` +
              `milestone branch and pushes the result; that push will be ` +
              `REJECTED, so milestone branches will drift behind the default ` +
              `line. Add '${account.login}' as a bypass actor on this ` +
              `ruleset, or raise its permission to match the RepositoryRole ` +
              `bypass it already has (Issue #586).`,
        });
      }
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
        "`milestone/**` is covered by a ruleset with required status checks " +
        "and the service account can still push it directly — milestone PRs " +
        "are auto-mergeable and the branch sync keeps working.",
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

/**
 * Read every ruleset on the repository in DETAIL shape.
 *
 * The list endpoint returns summaries with no `rules` and no `bypass_actors`,
 * so each ruleset is fetched by id — the only shape that can answer whether
 * the branch is gated and whether the service account can still push it.
 *
 * @returns The rulesets, or an empty list when they cannot be read (setup
 *   warns about what it can see; it does not fail the run over a read).
 */
export async function fetchRulesetDetails(
  repo: string,
  ghFn: GhJson,
): Promise<RulesetDetail[]> {
  let summaries: Array<{ id?: number }> = [];
  try {
    const raw = await ghFn(["api", `repos/${repo}/rulesets`]);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) summaries = parsed;
  } catch {
    return [];
  }

  const details: RulesetDetail[] = [];
  for (const summary of summaries) {
    if (typeof summary.id !== "number") continue;
    try {
      const raw = await ghFn(["api", `repos/${repo}/rulesets/${summary.id}`]);
      if (raw) details.push(JSON.parse(raw) as RulesetDetail);
    } catch {
      // A ruleset that cannot be read is reported by its absence, not by a
      // throw: setup's job here is to warn, never to fail.
    }
  }
  return details;
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
 */
export async function checkMilestoneRuleset(
  repo: string,
  login: string,
  ghFn: GhJson,
): Promise<MilestoneRulesetFinding[]> {
  const [rulesets, permission] = await Promise.all([
    fetchRulesetDetails(repo, ghFn),
    fetchServiceAccountPermission(repo, login, ghFn),
  ]);
  return assessMilestoneRuleset(rulesets, {
    login,
    ...(permission !== undefined ? { permission } : {}),
  });
}

// ---------------------------------------------------------------------------
// Creating the ruleset when it is missing (Issue #586)
// ---------------------------------------------------------------------------

/** Name of the milestone ruleset the worker creates when asked. */
export const MILESTONE_RULESET_NAME = "Vibe Coder milestone branches";

/** Outcome of {@link createMilestoneRuleset}. */
export type CreateMilestoneResult =
  | { ok: true; created: true; contexts: string[] }
  | { ok: true; created: false; reason: string }
  | { ok: false; error: Error };

/**
 * Create the `milestone/**` ruleset, mirroring the repository's own
 * default-branch gate.
 *
 * The required contexts are taken from the default-branch ruleset that is
 * already in place, so both gates agree on what "green" means and a milestone
 * PR is held to the same bar as the PR that eventually merges the collection.
 * When no default-branch ruleset exists there is nothing to mirror and nothing
 * is written — a guessed check set would block every milestone PR on a context
 * that never reports.
 *
 * Setup runs with the operator's own credentials, which is why this can write
 * at all: the worker's service account has `write`, and creating a ruleset
 * needs `admin`.
 */
export async function createMilestoneRuleset(
  repo: string,
  ghFn: GhJson,
  options: {
    /** Injected for tests; production reads the live rulesets. */
    rulesets?: RulesetDetail[];
    /** Bypass actors to carry over (defaults to the default branch's). */
    bypassActors?: RulesetBypassActorBody[];
  } = {},
): Promise<CreateMilestoneResult> {
  const rulesets = options.rulesets ?? await fetchRulesetDetails(repo, ghFn);

  if (rulesets.some(coversMilestoneBranches)) {
    return { ok: true, created: false, reason: "already covered" };
  }

  // Mirror the default-branch gate rather than invent one.
  const defaultBranchRuleset = rulesets.find((r) =>
    (r.conditions?.ref_name?.include ?? []).some((pattern) =>
      pattern === "~DEFAULT_BRANCH" || pattern.startsWith("refs/heads/")
    ) &&
    (r.rules ?? []).some((rule) =>
      rule.type === "required_status_checks" &&
      (rule.parameters?.required_status_checks ?? []).length > 0
    )
  );
  if (!defaultBranchRuleset) {
    return {
      ok: true,
      created: false,
      reason:
        "no existing ruleset requires status checks, so there is no check set " +
        "to mirror — a guessed one would block every milestone PR on a " +
        "context that never reports",
    };
  }

  const contexts = (defaultBranchRuleset.rules ?? [])
    .filter((rule) => rule.type === "required_status_checks")
    .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
    .map((check) => check.context)
    .filter((context): context is string => typeof context === "string");

  const bypassActors = options.bypassActors ??
    (defaultBranchRuleset.bypass_actors ?? [])
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

  const body = buildMilestoneRulesetBody(
    MILESTONE_RULESET_NAME,
    contexts,
    bypassActors,
  );

  try {
    await ghFn([
      "api",
      "-X",
      "POST",
      `repos/${repo}/rulesets`,
      "--input",
      "-",
      "--jq",
      ".id",
    ], JSON.stringify(body));
    return { ok: true, created: true, contexts };
  } catch (error) {
    return { ok: false, error: error as Error };
  }
}
