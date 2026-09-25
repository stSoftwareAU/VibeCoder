/**
 * Repository-settings hardening — the write-side twin of the audit's
 * settings pre-filer (Issues #4397, #4398, #4401).
 *
 * The weekly `github-actions-audit` reports the settings drift; this module
 * closes it, deliberately and reversibly, through the same read-only-then-
 * write `gh api` surfaces:
 *
 *  - workflow token: `default_workflow_permissions: read`,
 *    `can_approve_pull_request_reviews: false` (GHA-PERM-002)
 *  - `sha_pinning_required: true` (GHA-PERM-003) — every `uses:` in the
 *    tree is already SHA-pinned (`workflow_definitions_test.ts`)
 *  - `allowed_actions: selected` with GitHub-owned actions implicit and one
 *    `<owner>/<repo>@*` pattern per third-party action the workflows use
 *    (GHA-PERM-003 / GHA-HYGIENE-004)
 *  - secret scanning + push protection (GHA-MONITOR-004) — public
 *    repositories only: a private or internal repo needs the paid GitHub
 *    Secret Protection add-on, so the step is not planned there and the
 *    skip is printed rather than a write attempted and refused (Issue #2225)
 *  - the default branch's review requirement (GHA-PERM-004) — **opt-in
 *    only** (`requireReviews`): with one required approval and code-owner
 *    review, the fleet's autonomous merges stop until a human approves,
 *    which is a policy change the operator makes knowingly, not a default.
 *
 * Every step is planned from the CURRENT settings (nothing is written that
 * already holds), shown in dry-run, and applied only under `--apply`.
 * `hardenRepo` runs the whole read-plan-apply pass for one repository and
 * never throws; a read that fails with anything but a 404 is a `failed`
 * result and plans nothing (Issue #2626).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { parse as parseYaml } from "@std/yaml/parse";
// The ref pattern the fleet's milestone branches live under. Defined once,
// in repo_rulesets.ts: this module and the ruleset writer must agree on it
// byte-for-byte, and two literals that must agree are a drift waiting to
// happen. Re-exported because this module's name for it predates the move.
export { MILESTONE_REF_PATTERN } from "./repo_rulesets.ts";
import { isNotFoundError, MILESTONE_REF_PATTERN } from "./repo_rulesets.ts";
import { VIBE_RULESET_NAME } from "./default_branch_ruleset.ts";
import { getRepoDefaultBranch } from "./shell_helpers.ts";
import { readWorkflowFiles } from "./workflow_scan_common.ts";
import { extractUsesValue } from "./action_pin_scanner.ts";

type GhCommandFn = (args: string[]) => Promise<string>;

/** The `selected-actions` surface: what a "selected" allow-list permits. */
export interface SelectedActionsSnapshot {
  github_owned_allowed?: boolean;
  verified_allowed?: boolean;
  patterns_allowed?: string[];
}

/** The settings surfaces the planner reads. */
export interface RepoSettingsSnapshot {
  workflow?: {
    default_workflow_permissions?: string;
    can_approve_pull_request_reviews?: boolean;
  };
  actions?: {
    enabled?: boolean;
    allowed_actions?: string;
    sha_pinning_required?: boolean;
  };
  /**
   * Present when `allowed_actions` is "selected" (Issue #4424): lets the
   * planner extend an allow-list that is missing an action the workflows —
   * or the composite actions they call — need.
   */
  selectedActions?: SelectedActionsSnapshot;
  security?: Record<string, { status?: string } | undefined>;
  /**
   * The repository's visibility (`public`, `private`, `internal`) — read from
   * the same `repos/{repo}` response as `security` (Issue #2225). Secret
   * scanning and push protection are free only on a public repository, so the
   * step is not planned anywhere else.
   */
  visibility?: string;
  /** The boolean `private` flag, used when `visibility` is absent. */
  private?: boolean;
  rules?: Array<{ type?: string; parameters?: Record<string, unknown> }>;
  /**
   * The repo's branch rulesets, each already expanded to its full object
   * (Issue #3912 follow-up). The full object is needed because the rulesets
   * API takes a whole ruleset on write, so a planned change has to hand back
   * everything it did not touch.
   */
  rulesets?: RulesetSnapshot[];
}

/** One branch ruleset, as the rulesets API returns it. */
export interface RulesetSnapshot {
  id: number;
  name?: string;
  target?: string;
  enforcement?: string;
  // deno-lint-ignore no-explicit-any
  conditions?: any;
  // deno-lint-ignore no-explicit-any
  bypass_actors?: any;
  rules?: Array<{ type?: string; parameters?: Record<string, unknown> }>;
}

/** One planned write. */
export interface HardenStep {
  kind:
    | "workflow-token"
    | "sha-pinning-required"
    | "actions-allow-list"
    | "secret-scanning"
    | "ruleset-reviews"
    | "milestone-branch-create";
  /** What the step closes. */
  title: string;
  method: "PUT" | "PATCH";
  /** `repos/{repo}/…` — the repo is filled in at apply time. */
  endpoint: string;
  body?: string;
  /** Operator-facing caveat, when the step changes how the fleet works. */
  warning?: string;
  /** A write that must precede `body` for it to take effect. */
  preWrite?: { method: "PUT" | "PATCH"; endpoint: string; body: string };
}

/** Options for {@link planRepoSettingsHardening}. */
export interface PlanOptions {
  /** `<owner>/<repo>@*` patterns for the third-party actions in use. */
  thirdPartyPatterns: readonly string[];
  /** Also plan the default branch's review requirement (fleet-stopping). */
  requireReviews: boolean;
  /**
   * Plan code-owner review only (Issue #4397): PRs that touch a path named
   * in `.github/CODEOWNERS` (workflows, actions, scripts) need an owner's
   * approval; every other PR keeps merging as before. `requireReviews`
   * takes precedence when both are set.
   */
  requireCodeOwnerReview?: boolean;
  defaultBranch: string;
}

const GITHUB_OWNED = new Set(["actions", "github"]);

/** GitHub owner and repository names: letters, digits, `-`, `_` and `.`. */
const COORDINATE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Whether `owner`/`repo` is a real GitHub coordinate (Issue #1235).
 *
 * Coordinates are parsed out of third-party `action.yml` manifests fetched
 * over the network, so they are untrusted. A step whose `uses:` names a
 * wildcard owner and repo would make {@link buildAllowedActionPatterns} emit
 * an everything-pattern that the apply step writes into the allow-list,
 * disabling the very control this module enforces; a `uses: ../../victim@x`
 * step would normalise the `repos/{owner}/{repo}/contents/…` endpoint into an
 * arbitrary API GET with the fleet's token. Only owner/repo name characters
 * pass, and the `.` and `..` path segments are rejected outright.
 */
export function isValidActionCoordinate(
  owner: string,
  repo: string,
): boolean {
  return [owner, repo].every((segment) =>
    COORDINATE_SEGMENT.test(segment) && segment !== "." && segment !== ".."
  );
}

/** Third-party `<owner>/<repo>@*` patterns from a list of `uses:` coordinates. */
export function buildAllowedActionPatterns(
  coordinates: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const c of coordinates) {
    const [owner, repo] = c.split("/");
    if (!owner || !repo) continue;
    // Defence in depth: an invalid coordinate is dropped, never widened
    // into a pattern (Issue #1235). The resolver reports the rejection.
    if (!isValidActionCoordinate(owner, repo)) continue;
    if (GITHUB_OWNED.has(owner.toLowerCase())) continue;
    out.add(`${owner}/${repo}@*`);
  }
  return [...out].sort();
}

/**
 * Whether an allow-list pattern (GitHub glob: `owner/repo@*`, `owner/*`,
 * `owner/repo@v1*`) permits every ref of the action a required
 * `owner/repo@*` pattern names (Issue #4424). `*` matches any run of
 * characters; the comparison is against a concrete ref so `owner/repo@v1*`
 * does not count as covering `owner/repo@*`.
 */
export function allowListCovers(
  patternsAllowed: readonly string[],
  required: string,
): boolean {
  const coordinate = required.endsWith("@*") ? required.slice(0, -2) : required;
  const probe = `${coordinate}@0000000000000000000000000000000000000000`;
  return patternsAllowed.some((pattern) => globMatches(pattern, probe));
}

/**
 * `*`-glob match, done by scanning rather than by a constructed `RegExp`:
 * the patterns come from the repository's own allow-list, and a dynamic
 * regular expression over them is a ReDoS surface the SAST gate rejects.
 * `*` matches any run of characters, including none.
 */
function globMatches(pattern: string, text: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return text === pattern;
  const head = parts[0] ?? "";
  const tail = parts[parts.length - 1] ?? "";
  if (!text.startsWith(head) || !text.endsWith(tail)) return false;
  if (text.length < head.length + tail.length) return false;
  let cursor = head.length;
  const limit = text.length - tail.length;
  for (const middle of parts.slice(1, -1)) {
    const found = text.indexOf(middle, cursor);
    if (found < 0 || found + middle.length > limit) return false;
    cursor = found + middle.length;
  }
  return true;
}

/** Result of {@link resolveTransitiveActionCoordinates}. */
export interface TransitiveActionCoordinates {
  /** `owner/repo` for every action reachable from the given references. */
  coordinates: string[];
  /**
   * `owner/repo@ref: reason` for each manifest that could not be read for a
   * reason other than "no manifest" (a JavaScript/Docker action has no
   * `steps`; a 404 is expected and silent). A 403 or a network failure is
   * reported so an incomplete allow-list is never mistaken for a full one.
   */
  unreadable: string[];
}

/** Steps a composite action's manifest declares. */
interface ActionManifest {
  runs?: { using?: string; steps?: Array<{ uses?: unknown }> };
}

const MAX_TRANSITIVE_DEPTH = 4;

/**
 * Follow the `uses:` chain of composite actions (Issue #4424).
 *
 * `allowed_actions=selected` is enforced against every action that runs,
 * including the ones a composite action pulls in — `aquasecurity/trivy-action`
 * runs `aquasecurity/setup-trivy`, which no workflow names. Reading each
 * third-party action's `action.yml` at its pinned ref (raw, via `gh api`)
 * and collecting `runs.steps[].uses` recursively yields the complete set.
 * Local (`./`) and `docker://` steps are not repository actions; GitHub-owned
 * ones are collected but {@link buildAllowedActionPatterns} keeps them
 * implicit.
 */
export async function resolveTransitiveActionCoordinates(
  references: readonly string[],
  gh: GhCommandFn,
): Promise<TransitiveActionCoordinates> {
  const coordinates = new Set<string>();
  const unreadable: string[] = [];
  const visited = new Set<string>();

  const visit = async (reference: string, depth: number): Promise<void> => {
    const at = reference.indexOf("@");
    const path = at >= 0 ? reference.slice(0, at) : reference;
    const ref = at >= 0 ? reference.slice(at + 1) : "";
    const [owner, repo] = path.split("/");
    if (!owner || !repo) return;
    // A manifest is third-party data: a wildcard or traversal coordinate
    // neither widens the allow-list nor becomes an API path, and the
    // rejection is reported rather than dropped (Issue #1235).
    if (!isValidActionCoordinate(owner, repo)) {
      unreadable.push(`${reference}: not a valid owner/repo coordinate`);
      return;
    }
    coordinates.add(`${owner}/${repo}`);
    if (visited.has(reference) || depth >= MAX_TRANSITIVE_DEPTH) return;
    visited.add(reference);
    if (GITHUB_OWNED.has(owner.toLowerCase())) return;

    const manifest = await readActionManifest(gh, owner, repo, ref);
    if (manifest.kind === "error") {
      unreadable.push(`${reference}: ${manifest.reason}`);
      return;
    }
    if (manifest.kind === "none") return;
    for (const step of manifest.value.runs?.steps ?? []) {
      const uses = typeof step.uses === "string" ? step.uses.trim() : "";
      if (!uses || uses.startsWith(".") || uses.startsWith("docker://")) {
        continue;
      }
      await visit(uses, depth + 1);
    }
  };

  for (const reference of references) await visit(reference, 0);
  return {
    coordinates: [...coordinates].sort(),
    unreadable,
  };
}

type ManifestRead =
  | { kind: "manifest"; value: ActionManifest }
  | { kind: "none" }
  | { kind: "error"; reason: string };

/** Read `action.yml` (then `action.yaml`) at `ref`; 404 on both = none. */
async function readActionManifest(
  gh: GhCommandFn,
  owner: string,
  repo: string,
  ref: string,
): Promise<ManifestRead> {
  // The endpoint is built from untrusted coordinates: refuse loudly rather
  // than let `..` or a wildcard steer the API path (Issue #1235).
  if (!isValidActionCoordinate(owner, repo)) {
    return { kind: "error", reason: "not a valid owner/repo coordinate" };
  }
  let lastReason = "";
  for (const file of ["action.yml", "action.yaml"]) {
    const endpoint = `repos/${owner}/${repo}/contents/${file}` +
      (ref ? `?ref=${encodeURIComponent(ref)}` : "");
    try {
      const raw = await gh([
        "api",
        endpoint,
        "-H",
        "Accept: application/vnd.github.raw+json",
      ]);
      const parsed = parseYaml(raw);
      if (parsed && typeof parsed === "object") {
        return { kind: "manifest", value: parsed as ActionManifest };
      }
      return { kind: "none" };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!/\b404\b|Not Found/i.test(reason)) {
        return { kind: "error", reason };
      }
      lastReason = reason;
    }
  }
  return lastReason ? { kind: "none" } : { kind: "none" };
}

/**
 * The operator-facing note printed when the secret-scanning step is exempt
 * (Issue #2225) — the skip is stated, never left silent.
 */
export const SECRET_PROTECTION_SKIP_NOTE =
  "secret scanning / push protection: skipped — private repository needs " +
  "paid GitHub Secret Protection";

/**
 * True when secret scanning and push protection cost money on this
 * repository (Issue #2225): they are free on a public repository, and need
 * the paid GitHub Secret Protection add-on on a private or internal one.
 *
 * Decided by visibility alone — no licence lookup. An unreadable visibility
 * is never treated as exempt, so the check degrades to today's behaviour
 * rather than silently passing.
 */
export function needsPaidSecretProtection(
  visibility?: string,
  isPrivate?: boolean,
): boolean {
  const known = visibility?.toLowerCase();
  if (known === "private" || known === "internal") return true;
  if (known === "public") return false;
  return isPrivate === true;
}

/**
 * True when a secret-scanning step would have been planned but is exempt
 * because the repository is private or internal (Issue #2225). Shared by the
 * planner and the command so the plan and its note cannot disagree.
 */
export function isSecretScanningSkipped(
  snapshot: RepoSettingsSnapshot,
): boolean {
  const sec = snapshot.security;
  if (!sec) return false;
  const scanning = sec["secret_scanning"]?.status;
  const push = sec["secret_scanning_push_protection"]?.status;
  if (scanning === "enabled" && push === "enabled") return false;
  return needsPaidSecretProtection(snapshot.visibility, snapshot.private);
}

/** Plan the writes that close each open setting; empty when hardened. */
export function planRepoSettingsHardening(
  snapshot: RepoSettingsSnapshot,
  options: PlanOptions,
): HardenStep[] {
  const steps: HardenStep[] = [];
  const w = snapshot.workflow;
  if (
    w &&
    (w.default_workflow_permissions !== "read" ||
      w.can_approve_pull_request_reviews !== false)
  ) {
    steps.push({
      kind: "workflow-token",
      title:
        "Default GITHUB_TOKEN read-only; Actions may not create or approve pull requests",
      method: "PUT",
      endpoint: "actions/permissions/workflow",
      body: JSON.stringify({
        default_workflow_permissions: "read",
        can_approve_pull_request_reviews: false,
      }),
    });
  }
  const a = snapshot.actions;
  if (a && a.sha_pinning_required !== true) {
    // sha_pinning_required rides on the same endpoint as allowed_actions;
    // sending only the flag leaves allowed_actions as it is.
    steps.push({
      kind: "sha-pinning-required",
      title: "Require actions to be pinned to a full-length commit SHA",
      method: "PUT",
      endpoint: "actions/permissions",
      // allowed_actions is left exactly as it is: the allow-list is its
      // own step with its own caveat — flipping to "selected" here with no
      // list would block every third-party action.
      body: JSON.stringify({
        enabled: true,
        allowed_actions: a.allowed_actions ?? "all",
        sha_pinning_required: true,
      }),
    });
  }
  const selected = snapshot.selectedActions;
  if (a && a.allowed_actions === "selected" && selected) {
    const have = selected.patterns_allowed ?? [];
    const missing = options.thirdPartyPatterns.filter((p) =>
      !allowListCovers(have, p)
    );
    if (missing.length > 0) {
      const union = [...new Set([...have, ...missing])].sort();
      steps.push({
        kind: "actions-allow-list",
        title:
          `Extend the action allow-list with the action(s) the workflows or their composite steps use but the list omits: ${
            missing.join(", ")
          }`,
        method: "PUT",
        endpoint: "actions/permissions/selected-actions",
        body: JSON.stringify({
          github_owned_allowed: selected.github_owned_allowed ?? true,
          verified_allowed: selected.verified_allowed ?? false,
          patterns_allowed: union,
        }),
      });
    }
  }
  if (a && a.allowed_actions === "all") {
    steps.push({
      kind: "actions-allow-list",
      title:
        "Allow GitHub-owned actions plus the third-party actions the workflows use, nothing else",
      method: "PUT",
      endpoint: "actions/permissions/selected-actions",
      body: JSON.stringify({
        github_owned_allowed: true,
        verified_allowed: false,
        patterns_allowed: [...options.thirdPartyPatterns],
      }),
      // The list only takes effect under allowed_actions=selected: flip it
      // in the same step (keeping SHA-pin enforcement on) so an applied
      // list is never an empty one.
      preWrite: {
        method: "PUT",
        endpoint: "actions/permissions",
        body: JSON.stringify({
          enabled: true,
          allowed_actions: "selected",
          sha_pinning_required: true,
        }),
      },
      warning:
        "A workflow that later adds an action outside this list fails to run until the list is extended.",
    });
  }
  const sec = snapshot.security;
  if (sec && !isSecretScanningSkipped(snapshot)) {
    const scanning = sec["secret_scanning"]?.status;
    const push = sec["secret_scanning_push_protection"]?.status;
    if (scanning !== "enabled" || push !== "enabled") {
      steps.push({
        kind: "secret-scanning",
        title: "Enable secret scanning and push protection",
        method: "PATCH",
        endpoint: "",
        body: JSON.stringify({
          security_and_analysis: {
            secret_scanning: { status: "enabled" },
            secret_scanning_push_protection: { status: "enabled" },
          },
        }),
        warning:
          "A private repository needs GitHub Secret Protection for this; without the licence the write is refused.",
      });
    }
  }
  const pr = snapshot.rules?.find((r) => r.type === "pull_request")
    ?.parameters;
  if (
    !options.requireReviews && options.requireCodeOwnerReview &&
    snapshot.rules && (!pr || pr.require_code_owner_review !== true)
  ) {
    steps.push({
      kind: "ruleset-reviews",
      title:
        `Require code-owner review on ${options.defaultBranch} (owned paths only; approval count unchanged)`,
      method: "PUT",
      endpoint: `rulesets/${options.defaultBranch}`,
      body: JSON.stringify({ require_code_owner_review: true }),
      warning:
        "PRs that touch a path named in .github/CODEOWNERS (workflows, actions, scripts) now wait for an owner's approval; every other PR — including the fleet's — merges as before (Issue #4397).",
    });
  }
  if (options.requireReviews && snapshot.rules) {
    const approvals = typeof pr?.required_approving_review_count === "number"
      ? pr.required_approving_review_count as number
      : 0;
    if (!pr || approvals < 1 || pr.require_code_owner_review !== true) {
      steps.push({
        kind: "ruleset-reviews",
        title:
          `Require one approving review and code-owner review on ${options.defaultBranch}`,
        method: "PUT",
        endpoint: `rulesets/${options.defaultBranch}`,
        body: JSON.stringify({
          require_code_owner_review: true,
          required_approving_review_count: 1,
        }),
        warning:
          "Stops the fleet's autonomous auto-merge on the default branch until a human approves each PR — apply knowingly.",
      });
    }
  }
  // A milestone ruleset that enforces its status checks on branch CREATION
  // makes the fleet's milestone branches impossible to open (Issue #3912).
  //
  // `required_status_checks` is evaluated against the pushed commit, and a
  // branch that does not exist yet has no check runs, so the push is declined
  // — observed on 2026-09-06 as "5 of 6 required status checks are expected
  // … push declined due to repository rule violations". The self-heal that
  // recreates a missing milestone branch cannot succeed at all, and only an
  // account with an admin bypass gets through, which is why this hides on
  // hosts that happen to run as one.
  //
  // The fix is one flag, not removing the rule. `do_not_enforce_on_create`
  // lets the branch be created while still requiring every check to MERGE,
  // and — the part that matters for throughput — keeps `required_status_checks`
  // present, which is exactly what `isBaseProtected` looks for when deciding
  // whether to arm auto-merge at PR creation. Dropping the rule instead would
  // make the base unprotected and silently disable auto-merge arming.
  for (const ruleset of snapshot.rulesets ?? []) {
    if (ruleset.target !== undefined && ruleset.target !== "branch") continue;
    const includes: string[] = ruleset.conditions?.ref_name?.include ?? [];
    if (!includes.includes(MILESTONE_REF_PATTERN)) continue;
    const checks = ruleset.rules?.find((r) =>
      r.type === "required_status_checks"
    );
    if (!checks) continue;
    if (checks.parameters?.do_not_enforce_on_create === true) continue;

    steps.push({
      kind: "milestone-branch-create",
      title:
        `Ruleset '${
          ruleset.name ?? ruleset.id
        }': allow milestone branches to be created ` +
        `(required checks still gate the merge)`,
      method: "PUT",
      endpoint: `rulesets/${ruleset.id}`,
      body: JSON.stringify({
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
      }),
    });
  }

  return steps;
}

/** Outcome of one step. */
export interface HardenResult {
  step: HardenStep;
  /** `skipped`: deliberately not attempted; `detail` says why (Issue #2626). */
  status: "planned" | "applied" | "failed" | "skipped";
  detail?: string;
}

/** Options for {@link applyRepoSettingsPlan}. */
export interface ApplyOptions {
  apply: boolean;
  ghCommandFn: GhCommandFn;
}

/** Dry-run (report) or apply each step; a failed write is a result, not a throw. */
export async function applyRepoSettingsPlan(
  repo: string,
  plan: readonly HardenStep[],
  options: ApplyOptions,
): Promise<HardenResult[]> {
  const out: HardenResult[] = [];
  for (const step of plan) {
    if (!options.apply) {
      out.push({ step, status: "planned" });
      continue;
    }
    if (step.kind === "ruleset-reviews") {
      // Rulesets are updated by id, not by branch: resolve the ruleset that
      // targets the default branch and PUT its pull_request rule.
      out.push(await applyRulesetReviews(repo, step, options.ghCommandFn));
      continue;
    }
    const endpoint = step.endpoint
      ? `repos/${repo}/${step.endpoint}`
      : `repos/${repo}`;
    try {
      if (step.preWrite) {
        await ghWrite(
          options.ghCommandFn,
          step.preWrite.method,
          `repos/${repo}/${step.preWrite.endpoint}`,
          step.preWrite.body,
        );
      }
      await ghWrite(options.ghCommandFn, step.method, endpoint, step.body);
      out.push({ step, status: "applied" });
    } catch (err) {
      out.push({
        step,
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/**
 * `gh api --method M endpoint --input <file>`: the body goes through a temp
 * file because the gh seam is argv-only (no stdin) and nested JSON does not
 * fit `-f` fields.
 */
async function ghWrite(
  gh: GhCommandFn,
  method: "PUT" | "PATCH",
  endpoint: string,
  body: string | undefined,
): Promise<void> {
  const args = ["api", "--method", method, endpoint];
  if (body === undefined) {
    await gh(args);
    return;
  }
  const file = await Deno.makeTempFile({
    prefix: "vibe-settings-",
    suffix: ".json",
  });
  try {
    await Deno.writeTextFile(file, body);
    await gh([...args, "--input", file]);
  } finally {
    await Deno.remove(file).catch(() => {});
  }
}

async function applyRulesetReviews(
  repo: string,
  step: HardenStep,
  gh: GhCommandFn,
): Promise<HardenResult> {
  try {
    const raw = await gh(["api", `repos/${repo}/rulesets`]);
    const rulesets = JSON.parse(raw) as Array<
      { id: number; name: string; enforcement: string }
    >;
    const branch = step.endpoint.replace(/^rulesets\//, "");
    // The fleet's own ruleset wins over a legacy one named after the branch
    // (Issue #2626): it is the one `ensureDefaultBranchRuleset` maintains.
    const active = (name: string) =>
      rulesets.find((r) => r.name === name && r.enforcement === "active");
    const target = active(VIBE_RULESET_NAME) ?? active(branch);
    if (!target) {
      return {
        step,
        status: "failed",
        detail: `no active ruleset named ${branch} or "${VIBE_RULESET_NAME}"`,
      };
    }
    const full = JSON.parse(
      await gh(["api", `repos/${repo}/rulesets/${target.id}`]),
    ) as {
      rules?: Array<{ type: string; parameters?: Record<string, unknown> }>;
    };
    const desired = JSON.parse(step.body ?? "{}") as Record<string, unknown>;
    if (!(full.rules ?? []).some((r) => r.type === "pull_request")) {
      return {
        step,
        status: "failed",
        detail: `ruleset ${target.id} has no pull_request rule to update`,
      };
    }
    const rules = (full.rules ?? []).map((r) =>
      r.type === "pull_request"
        ? { ...r, parameters: { ...(r.parameters ?? {}), ...desired } }
        : r
    );
    await ghWrite(
      gh,
      "PUT",
      `repos/${repo}/rulesets/${target.id}`,
      JSON.stringify({ rules }),
    );
    return { step, status: "applied" };
  } catch (err) {
    return {
      step,
      status: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Every repository `uses:` reference in the checkout's workflows, with its
 * ref (`owner/repo@sha`), so composite manifests can be read at the pinned
 * revision (Issue #4424). Local and docker steps are not repository actions.
 */
export async function collectUsesReferences(
  workDir: string,
): Promise<string[]> {
  const files = await readWorkflowFiles(workDir);
  const out = new Set<string>();
  for (const file of files) {
    for (const line of file.rawText.split("\n")) {
      const value = extractUsesValue(line);
      if (!value || value.startsWith(".") || value.startsWith("docker://")) {
        continue;
      }
      const at = value.indexOf("@");
      const path = at >= 0 ? value.slice(0, at) : value;
      const [owner, repo] = path.split("/");
      if (owner && repo) out.add(value);
    }
  }
  return [...out].sort();
}

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type SurfaceRead<T> =
  | { ok: true; value: T | undefined }
  | { ok: false; detail: string };

/**
 * One settings read (Issue #2626): a 404 is an absent surface, any other
 * error is a failure — never a silent `undefined` a plan could be built on.
 */
async function readSurface<T>(
  gh: GhCommandFn,
  endpoint: string,
): Promise<SurfaceRead<T>> {
  try {
    return { ok: true, value: JSON.parse(await gh(["api", endpoint])) as T };
  } catch (err) {
    if (isNotFoundError(err)) return { ok: true, value: undefined };
    return {
      ok: false,
      detail: `could not read ${endpoint}: ${errorMessage(err)}`,
    };
  }
}

/** A failed result standing in for a surface that could not be read. */
function readFailure(
  kind: HardenStep["kind"],
  endpoint: string,
  detail: string,
): HardenResult {
  return {
    step: { kind, title: `Read ${endpoint}`, method: "PUT", endpoint },
    status: "failed",
    detail,
  };
}

/** Options for {@link hardenRepo}. */
export interface HardenRepoOptions {
  apply: boolean;
  ghCommandFn: GhCommandFn;
  /** The repo's local checkout; its workflows feed the allow-list. */
  workDir: string;
  requireCodeOwnerReview?: boolean;
  /** Fleet-stopping one-approval rule — off unless explicitly asked for. */
  requireReviews?: boolean;
  /** Operator-vouched `owner/repo` coordinates (`--allow-action`). */
  extraCoordinates?: readonly string[];
  /** Test seam: the default-branch disk cache (defaults to the worker's). */
  defaultBranchCachePath?: string;
}

/** What {@link hardenRepo} found and did. */
export interface HardenRepoOutcome {
  results: HardenResult[];
  /** {@link SECRET_PROTECTION_SKIP_NOTE} when that step was exempted. */
  skipNote?: string;
  /** The allow-list's action coordinates (empty without a checkout). */
  coordinates: string[];
  /** How many workflow `uses:` references fed the allow-list. */
  referenceCount: number;
  /** Actions whose manifest could not be read (allow-list may be short). */
  unreadable: string[];
}

/**
 * Snapshot, plan and (under `apply`) write one repository's settings
 * hardening (Issue #2626). Never throws: every fault — an unknown default
 * branch, an unreadable surface, a refused write — is a `failed` result, and
 * nothing is planned from a surface that could not be read.
 */
export async function hardenRepo(
  repo: string,
  options: HardenRepoOptions,
): Promise<HardenRepoOutcome> {
  const outcome: HardenRepoOutcome = {
    results: [],
    coordinates: [],
    referenceCount: 0,
    unreadable: [],
  };
  try {
    await hardenRepoInto(repo, options, outcome);
  } catch (err) {
    outcome.results.push(
      readFailure("ruleset-reviews", `repos/${repo}`, errorMessage(err)),
    );
  }
  return outcome;
}

async function hardenRepoInto(
  repo: string,
  options: HardenRepoOptions,
  outcome: HardenRepoOutcome,
): Promise<void> {
  const gh = options.ghCommandFn;
  const results = outcome.results;
  if (!REPO_PATTERN.test(repo)) {
    results.push(
      readFailure("ruleset-reviews", `repos/${repo}`, "invalid repo name"),
    );
    return;
  }
  const defaultBranch = await getRepoDefaultBranch(
    repo,
    gh,
    options.defaultBranchCachePath,
  );
  if (!defaultBranch.ok) {
    results.push(
      readFailure(
        "ruleset-reviews",
        `repos/${repo}`,
        `default branch unknown: ${defaultBranch.error.message}`,
      ),
    );
    return;
  }
  const branch = defaultBranch.value;

  // Reads each surface; a failure is recorded and the surface left undefined.
  const read = async <T>(
    kind: HardenStep["kind"],
    endpoint: string,
  ): Promise<T | undefined> => {
    const r = await readSurface<T>(gh, endpoint);
    if (r.ok) return r.value;
    results.push(readFailure(kind, endpoint, r.detail));
    return undefined;
  };

  // One read of the repository serves both the security settings and the
  // visibility that decides whether hardening them is free (Issue #2225).
  const repoInfo = await read<{
    security_and_analysis?: RepoSettingsSnapshot["security"];
    visibility?: string;
    private?: boolean;
  }>("secret-scanning", `repos/${repo}`);
  const snapshot: RepoSettingsSnapshot = {
    workflow: await read(
      "workflow-token",
      `repos/${repo}/actions/permissions/workflow`,
    ),
    actions: await read(
      "sha-pinning-required",
      `repos/${repo}/actions/permissions`,
    ),
    security: repoInfo?.security_and_analysis,
    visibility: repoInfo?.visibility,
    private: repoInfo?.private,
    rules: await read(
      "ruleset-reviews",
      `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`,
    ),
  };
  // The repo's branch rulesets, each expanded (Issue #3912 follow-up): the
  // rulesets API takes a complete ruleset on write.
  const rulesetList = await read<Array<{ id?: number; target?: string }>>(
    "milestone-branch-create",
    `repos/${repo}/rulesets`,
  );
  if (Array.isArray(rulesetList)) {
    const expanded: RulesetSnapshot[] = [];
    for (const entry of rulesetList) {
      if (typeof entry.id !== "number") continue;
      if (entry.target !== undefined && entry.target !== "branch") continue;
      const full = await read<RulesetSnapshot>(
        "milestone-branch-create",
        `repos/${repo}/rulesets/${entry.id}`,
      );
      if (full) expanded.push(full);
    }
    if (expanded.length > 0) snapshot.rulesets = expanded;
  }
  if (snapshot.actions?.allowed_actions === "selected") {
    snapshot.selectedActions = await read(
      "actions-allow-list",
      `repos/${repo}/actions/permissions/selected-actions`,
    );
  }

  // Without a checkout the allow-list would be built from nothing, so the
  // step is skipped and said so rather than writing an empty list.
  const hasCheckout = await Deno.stat(`${options.workDir}/.git`).then(
    () => true,
    () => false,
  );
  if (hasCheckout) {
    const references = await collectUsesReferences(options.workDir);
    const transitive = await resolveTransitiveActionCoordinates(
      references,
      gh,
    );
    outcome.referenceCount = references.length;
    outcome.unreadable = transitive.unreadable;
    outcome.coordinates = [
      ...new Set([
        ...transitive.coordinates,
        ...(options.extraCoordinates ?? []),
      ]),
    ].sort();
  }
  const plan = planRepoSettingsHardening(snapshot, {
    thirdPartyPatterns: buildAllowedActionPatterns(outcome.coordinates),
    requireReviews: options.requireReviews === true,
    requireCodeOwnerReview: options.requireCodeOwnerReview === true,
    defaultBranch: branch,
  });
  const allowListStep = plan.find((s) => s.kind === "actions-allow-list");
  const runnable = hasCheckout
    ? plan
    : plan.filter((s) => s.kind !== "actions-allow-list");
  results.push(
    ...await applyRepoSettingsPlan(repo, runnable, {
      apply: options.apply,
      ghCommandFn: gh,
    }),
  );
  if (!hasCheckout) {
    results.push({
      step: allowListStep ?? {
        kind: "actions-allow-list",
        title: "Allow-list the actions the workflows use",
        method: "PUT",
        endpoint: "actions/permissions/selected-actions",
      },
      status: "skipped",
      detail: "no local checkout",
    });
  }
  // The exempted step is stated in the output, never silently absent.
  if (isSecretScanningSkipped(snapshot)) {
    outcome.skipNote = SECRET_PROTECTION_SKIP_NOTE;
  }
}

/** Where a repo's CODEOWNERS file is, as read from its default branch. */
export type CodeownersLocation =
  | { state: "present"; path: string }
  | { state: "absent" }
  | { state: "error"; message: string };

/** The locations GitHub reads CODEOWNERS from, in its precedence order. */
const CODEOWNERS_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
] as const;

/**
 * Find the CODEOWNERS file on the default branch (Issue #2626). Only a 404
 * at every location is `absent`; any other error is `error`, so a flaky read
 * is never mistaken for a missing file.
 */
export async function findCodeownersOnDefaultBranch(
  repo: string,
  ghCommandFn: GhCommandFn,
): Promise<CodeownersLocation> {
  if (!REPO_PATTERN.test(repo)) {
    return { state: "error", message: `invalid repo name: ${repo}` };
  }
  for (const path of CODEOWNERS_PATHS) {
    try {
      await ghCommandFn(["api", `repos/${repo}/contents/${path}`]);
      return { state: "present", path };
    } catch (err) {
      if (isNotFoundError(err)) continue;
      return {
        state: "error",
        message: `could not read ${path}: ${errorMessage(err)}`,
      };
    }
  }
  return { state: "absent" };
}
