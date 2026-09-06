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
 *  - secret scanning + push protection (GHA-MONITOR-004) — a private repo
 *    needs GitHub Secret Protection; the write may be refused, which is
 *    reported, never hidden
 *  - the default branch's review requirement (GHA-PERM-004) — **opt-in
 *    only** (`requireReviews`): with one required approval and code-owner
 *    review, the fleet's autonomous merges stop until a human approves,
 *    which is a policy change the operator makes knowingly, not a default.
 *
 * Every step is planned from the CURRENT settings (nothing is written that
 * already holds), shown in dry-run, and applied only under `--apply`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { parse as parseYaml } from "@std/yaml/parse";

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
  rules?: Array<{ type?: string; parameters?: Record<string, unknown> }>;
}

/** One planned write. */
export interface HardenStep {
  kind:
    | "workflow-token"
    | "sha-pinning-required"
    | "actions-allow-list"
    | "secret-scanning"
    | "ruleset-reviews";
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
  return patternsAllowed.some((pattern) => {
    const re = new RegExp(
      "^" + pattern.split("*").map(escapeRegExp).join(".*") + "$",
    );
    return re.test(probe);
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  if (sec) {
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
  return steps;
}

/** Outcome of one step. */
export interface HardenResult {
  step: HardenStep;
  status: "planned" | "applied" | "failed";
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
    const target = rulesets.find((r) =>
      r.name === branch && r.enforcement === "active"
    );
    if (!target) {
      return {
        step,
        status: "failed",
        detail: `no active ruleset named ${branch}`,
      };
    }
    const full = JSON.parse(
      await gh(["api", `repos/${repo}/rulesets/${target.id}`]),
    ) as {
      rules?: Array<{ type: string; parameters?: Record<string, unknown> }>;
    };
    const desired = JSON.parse(step.body ?? "{}") as Record<string, unknown>;
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
