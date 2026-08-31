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
          // Not an error against the ruleset: refusing the service account is
          // the intended policy (an admin may bypass, the fleet may not). It
          // is a warning about the worker, which still pushes directly.
          severity: "warning",
          code: "direct-push-blocked",
          message: bypass.unproven
            ? `ruleset '${name}' gates \`milestone/**\` and carries a bypass ` +
              `this check cannot resolve (a User, Team, Integration or ` +
              `OrganizationAdmin actor). If it exempts '${account.login}', ` +
              `the service account can push past the gate — which the ` +
              `operator's policy forbids: an admin may bypass, the fleet may ` +
              `not (Issue #586).`
            : `ruleset '${name}' gates \`milestone/**\` and ` +
              `'${account.login}' (permission ` +
              `'${account.permission ?? "unknown"}') correctly cannot bypass ` +
              `it. The milestone branch sync still pushes directly, so that ` +
              `push is REJECTED and milestone branches drift behind the ` +
              `default line. The RULESET is right; the sync must raise a pull ` +
              `request instead of pushing (Issue #589).`,
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
          `at. Usually a workflow filtering its PR base with ` +
          '`branches: ["*"]`, which matches one path segment and so never ' +
          'matches `milestone/...` — `["**"]` does (Issue #586).',
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

/** Outcome of reading a repository's rulesets. */
export type RulesetRead =
  | { ok: true; rulesets: RulesetDetail[] }
  | { ok: false; error: Error };

/** The message of a thrown value, whatever it is. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
 * existed. The same reasoning covers a single unreadable ruleset: the one that
 * could not be read may be the milestone ruleset, so the whole read fails
 * rather than quietly omitting it.
 *
 * @returns The rulesets, or the error that stopped them being read.
 */
export async function readRulesetDetails(
  repo: string,
  ghFn: GhJson,
): Promise<RulesetRead> {
  let summaries: Array<{ id?: number }>;
  try {
    const raw = await ghFn(["api", `repos/${repo}/rulesets`]);
    const parsed = raw ? JSON.parse(raw) : [];
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
    if (typeof summary.id !== "number") continue;
    try {
      const raw = await ghFn(["api", `repos/${repo}/rulesets/${summary.id}`]);
      if (!raw) {
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
  options: { rulesets?: readonly RulesetDetail[] } = {},
): Promise<MilestoneRulesetFinding[]> {
  const [read, permission, reportedChecks] = await Promise.all([
    options.rulesets
      ? Promise.resolve<RulesetRead>({
        ok: true,
        rulesets: [...options.rulesets],
      })
      : readRulesetDetails(repo, ghFn),
    fetchServiceAccountPermission(repo, login, ghFn),
    fetchMilestonePrCheckNames(repo, ghFn),
  ]);
  if (!read.ok) return [rulesetReadFailedFinding(read.error)];
  return assessMilestoneRuleset(read.rulesets, {
    login,
    ...(permission !== undefined ? { permission } : {}),
  }, reportedChecks);
}

/**
 * Check names seen on the most recent PR into a milestone branch.
 *
 * The sample is what makes {@link unreportableChecks} answerable: a required
 * context is only provably unreportable against a PR that actually ran. Open
 * PRs first, then merged ones, because a merged PR's checks are the strongest
 * evidence of what the base really runs.
 *
 * @returns The check names, or an empty list when no milestone PR could be
 *   sampled — in which case nothing is claimed.
 */
export async function fetchMilestonePrCheckNames(
  repo: string,
  ghFn: GhJson,
): Promise<string[]> {
  for (const state of ["open", "merged"]) {
    try {
      const raw = await ghFn([
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        state,
        "--search",
        "base:milestone",
        "--limit",
        "1",
        "--json",
        "statusCheckRollup",
      ]);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed) || parsed.length === 0) continue;
      const rollup = parsed[0]?.statusCheckRollup;
      if (!Array.isArray(rollup) || rollup.length === 0) continue;
      const names = rollup
        .map((check: { name?: string; context?: string }) =>
          check.name ?? check.context
        )
        .filter((name: unknown): name is string => typeof name === "string");
      if (names.length > 0) return names;
    } catch {
      // A listing that cannot be read proves nothing; try the next state.
    }
  }
  return [];
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

/** What creating the `milestone/**` ruleset would do, decided without writing. */
export type MilestoneRulesetPlan =
  /** A ruleset already covers `milestone/**` — there is nothing to create. */
  | { kind: "covered" }
  /** It can be created, mirroring `mirror`'s required contexts. */
  | { kind: "creatable"; contexts: string[]; mirror: RulesetDetail }
  /** It cannot be created, and `reason` says why an answer would not help. */
  | { kind: "not-creatable"; reason: string };

/**
 * Decide what a create would do, without writing anything (Issue #678).
 *
 * Setup asks the operator whether to create the ruleset, and a question whose
 * only possible outcome is a refusal must never be asked: on a repository
 * whose default branch takes direct pushes there is no gate to mirror, so
 * answering yes creates nothing and the same question returns on every run.
 * This is the predicate that stops that, and the one {@link
 * createMilestoneRuleset} writes from — one decision, one place.
 *
 * @param rulesets - Every ruleset on the repository, in detail shape.
 */
export function planMilestoneRuleset(
  rulesets: readonly RulesetDetail[],
): MilestoneRulesetPlan {
  if (rulesets.some(coversMilestoneBranches)) return { kind: "covered" };

  // Mirror the default-branch gate rather than invent one.
  const mirror = rulesets.find((r) =>
    (r.conditions?.ref_name?.include ?? []).some((pattern) =>
      pattern === "~DEFAULT_BRANCH" || pattern.startsWith("refs/heads/")
    ) &&
    (r.rules ?? []).some((rule) =>
      rule.type === "required_status_checks" &&
      (rule.parameters?.required_status_checks ?? []).length > 0
    )
  );
  if (!mirror) {
    return {
      kind: "not-creatable",
      reason:
        "no existing ruleset requires status checks, so there is no check set " +
        "to mirror — a guessed one would block every milestone PR on a " +
        "context that never reports",
    };
  }

  const contexts = (mirror.rules ?? [])
    .filter((rule) => rule.type === "required_status_checks")
    .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
    .map((check) => check.context)
    .filter((context): context is string => typeof context === "string");

  return { kind: "creatable", contexts, mirror };
}

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
  let rulesets = options.rulesets;
  if (!rulesets) {
    // A read that failed must never be mistaken for "nothing covers
    // `milestone/**`" — that would create a second, conflicting ruleset
    // (Issue #678).
    const read = await readRulesetDetails(repo, ghFn);
    if (!read.ok) return { ok: false, error: read.error };
    rulesets = read.rulesets;
  }

  const plan = planMilestoneRuleset(rulesets);
  if (plan.kind === "covered") {
    return { ok: true, created: false, reason: "already covered" };
  }
  if (plan.kind === "not-creatable") {
    return { ok: true, created: false, reason: plan.reason };
  }
  const { contexts, mirror: defaultBranchRuleset } = plan;

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
    const message = error instanceof Error ? error.message : String(error);
    // GitHub answers a ruleset write from a non-admin with 404, not 403, so
    // the bare "Not Found" names neither the cause nor the fix (Issue #595).
    // Every repository in a fleet run failed this way, identically, with
    // nothing to act on.
    if (/not found/i.test(message)) {
      return {
        ok: false,
        error: new Error(
          `${message} — creating a ruleset needs ADMIN on ${repo}, and ` +
            `GitHub reports insufficient permission as 404. Check that the ` +
            `identity running setup administers this repository (the ` +
            `worker's service account holds 'write', which is not enough).`,
        ),
      };
    }
    return { ok: false, error: error as Error };
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
