/**
 * Cross-repo fix capability (Issue #2941).
 *
 * When an assigned issue's root cause lives in an internal `stSoftwareAU/*`
 * dependency the worker can access (e.g. `@stsoftware/private-repo-14`), the worker
 * should fix it in that dependency's *own* repo by raising a PR there — in the
 * same run — rather than spinning the real fix out into follow-up issues.
 *
 * This module provides the three building blocks for that, all independently
 * testable with an injected command runner (no real network or git):
 *
 *   1. {@link classifyDependencySpec} — map a dependency spec
 *      (`jsr:@stsoftware/foo`, `npm:@stsoftware/foo`, or a bare
 *      `@stsoftware/foo`) to its candidate `stSoftwareAU/<repo>` GitHub repo,
 *      reusing the #1613 `@stsoftware` = internal classification rather than
 *      introducing a new one. Everything else is classified external.
 *   2. {@link probeCrossRepoAccess} / {@link resolveCrossRepoTarget} — confirm
 *      the dep is a real, reachable `stSoftwareAU/*` repo the worker can clone
 *      **and** open a PR against. "Can access" = clonable + the worker identity
 *      has `push` permission (the precondition for pushing a branch and opening
 *      a PR). Unreachable or non-`stSoftwareAU` deps are reported as external so
 *      callers fall back to the deferral path.
 *   3. {@link authoriseCrossRepoTarget} — decide whether a consuming repo may
 *      have a PR opened on its behalf in a given target repo. Ownership by
 *      `stSoftwareAU` is not authority on its own; the target must be a
 *      dependency the consuming repo's own manifest declares (Issue #1382).
 *   4. {@link openCrossRepoFixPr} — clone the dep repo, create a feature branch,
 *      apply the caller's fix, commit, push, and `gh pr create --repo
 *      stSoftwareAU/<dep> …`, then surface the dep PR URL back to the consuming
 *      run. Honours the feature-branch-only convention — it refuses to push to
 *      the dependency repo's default branch (the read-only invariant from
 *      `CLAUDE.md`, Issue #2584).
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { REPO_SLUG_PATTERN } from "./config.ts";
import {
  type ManifestFile,
  parseDenoManifest,
  parseNpmManifest,
} from "./orphan_deps_scanner.ts";
import { MAX_MANIFEST_SCAN_CHARS } from "./orphan_deps_suppression_scan.ts";

// ---------------------------------------------------------------------------
// Command runner (mirrors the injected-runner shape used elsewhere)
// ---------------------------------------------------------------------------

/** Output from a shell command. */
export interface CommandOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}

/** Injectable command runner (overridable for testing). */
export type RunCommand = (cmd: string[]) => Promise<CommandOutput>;

// ---------------------------------------------------------------------------
// Internal-scope classification (reuses the #1613 rule)
// ---------------------------------------------------------------------------

/** GitHub owner that hosts every internal dependency. */
export const INTERNAL_OWNER = "stSoftwareAU";

/**
 * Package scope that marks a dependency as internal. Matches the
 * `jsr:@stsoftware/*` / `npm:@stsoftware/*` exclude globs that give internal
 * deps a 0h quarantine window (Issue #1613 / #2536). Compared
 * case-insensitively.
 */
export const INTERNAL_SCOPE = "@stsoftware";

/** Outcome of classifying a single dependency spec. */
export type DependencyClassification =
  | {
    kind: "internal";
    /** The original spec, verbatim. */
    package: string;
    /** Bare package name (scope and version stripped), e.g. `private-repo-14`. */
    name: string;
    /** Candidate GitHub repo, e.g. `stSoftwareAU/private-repo-14`. */
    candidateRepo: string;
  }
  | { kind: "external"; package: string; reason: string };

/**
 * Strip an optional `jsr:` / `npm:` registry prefix from a dependency spec.
 * Any other prefix is left intact (it will fail the scope test below).
 */
function stripRegistryPrefix(spec: string): string {
  const lower = spec.toLowerCase();
  if (lower.startsWith("jsr:")) return spec.slice(4);
  if (lower.startsWith("npm:")) return spec.slice(4);
  return spec;
}

/**
 * Classify a dependency spec as internal (an `stSoftwareAU/*` repo) or
 * external.
 *
 * Accepts `jsr:@stsoftware/foo`, `npm:@stsoftware/foo@^1.2.3`, and a bare
 * `@stsoftware/foo`. Anything outside the `@stsoftware` scope — unscoped
 * packages, other scopes, empty/malformed input — is classified external.
 *
 * The candidate repo preserves the package-name casing; the canonical repo
 * name is resolved later by {@link probeCrossRepoAccess} from the GitHub API.
 *
 * @param spec - The dependency spec (untrusted input — strictly validated).
 */
export function classifyDependencySpec(spec: string): DependencyClassification {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    return { kind: "external", package: spec, reason: "empty spec" };
  }

  const bare = stripRegistryPrefix(trimmed);
  if (!bare.startsWith("@")) {
    return {
      kind: "external",
      package: spec,
      reason: "unscoped package (not an @stsoftware dependency)",
    };
  }

  const slashIndex = bare.indexOf("/");
  if (slashIndex < 0) {
    return { kind: "external", package: spec, reason: "missing package name" };
  }

  const scope = bare.slice(0, slashIndex);
  if (scope.toLowerCase() !== INTERNAL_SCOPE) {
    return {
      kind: "external",
      package: spec,
      reason: `external scope '${scope}'`,
    };
  }

  // Strip a trailing version range (`@^1.2.3`, `@1.0.0`, `@latest`).
  let name = bare.slice(slashIndex + 1);
  const versionAt = name.indexOf("@");
  if (versionAt >= 0) name = name.slice(0, versionAt);
  name = name.trim();

  if (name.length === 0) {
    return { kind: "external", package: spec, reason: "empty package name" };
  }

  const candidateRepo = `${INTERNAL_OWNER}/${name}`;
  // The candidate becomes a filesystem path and a gh/git argument, so reject
  // anything outside the strict owner/repo shape (blocks `..`, slashes, etc.).
  if (!REPO_SLUG_PATTERN.test(candidateRepo)) {
    return {
      kind: "external",
      package: spec,
      reason: `package name '${name}' is not a valid repo name`,
    };
  }

  return { kind: "internal", package: spec, name, candidateRepo };
}

// ---------------------------------------------------------------------------
// Reachability / "can access" probe
// ---------------------------------------------------------------------------

/**
 * Result of probing whether the worker can clone a repo *and* open a PR
 * against it. "Reachable" requires both clonability and `push` permission —
 * the precondition for pushing a feature branch and creating a PR.
 */
export type CrossRepoAccess =
  | {
    reachable: true;
    repo: string;
    /**
     * The repo's default branch, when GitHub reported one. Callers that open
     * a PR against an already-pushed branch use it as the base and to refuse
     * a default-branch head (Issue #182).
     */
    defaultBranch?: string;
  }
  | { reachable: false; reason: string };

/**
 * Probe a candidate `owner/repo` for cross-repo PR access via exactly one
 * `gh api repos/<owner>/<repo>`.
 *
 * - command failure (404/403) → unreachable (repo missing or invisible).
 * - 200 with `permissions.push !== true` → unreachable (cannot push a branch
 *   / open a PR).
 * - 200 with `permissions.push === true` → reachable, returning the canonical
 *   `full_name` (so casing differences like `private-repo-14` → `private-repo-14` resolve).
 *
 * @param repo - Candidate repository in `owner/repo` form.
 * @param runner - Injected command runner.
 */
export async function probeCrossRepoAccess(
  repo: string,
  runner: RunCommand,
): Promise<CrossRepoAccess> {
  if (!REPO_SLUG_PATTERN.test(repo)) {
    return { reachable: false, reason: `invalid repo slug '${repo}'` };
  }

  const result = await runner(["gh", "api", `repos/${repo}`]);
  if (!result.success) {
    return {
      reachable: false,
      reason: "repo not found or not accessible (404/403)",
    };
  }

  let body: {
    full_name?: string;
    default_branch?: string;
    permissions?: { push?: boolean };
  };
  try {
    body = JSON.parse(result.stdout);
  } catch {
    return { reachable: false, reason: "unparseable repo metadata" };
  }

  if (body.permissions?.push !== true) {
    return {
      reachable: false,
      reason: "worker identity lacks push access (cannot open a PR)",
    };
  }

  const canonical = typeof body.full_name === "string" &&
      body.full_name.length > 0
    ? body.full_name
    : repo;

  const defaultBranch = typeof body.default_branch === "string" &&
      body.default_branch.length > 0
    ? body.default_branch
    : undefined;

  return {
    reachable: true,
    repo: canonical,
    ...(defaultBranch ? { defaultBranch } : {}),
  };
}

/** Resolved cross-repo target: an internal-reachable dep, or external. */
export type CrossRepoTarget =
  | { kind: "internal-reachable"; package: string; repo: string }
  | { kind: "external"; package: string; reason: string };

/**
 * Resolve a dependency spec to a cross-repo target.
 *
 * Combines {@link classifyDependencySpec} and {@link probeCrossRepoAccess}:
 * an external spec is returned without a probe; an internal spec is probed and
 * returned as `internal-reachable` only when clonable with push access.
 * Internal-but-unreachable deps fall back to `external` so callers defer
 * (open a follow-up / bump) instead of attempting an impossible PR.
 *
 * @param spec - The dependency spec.
 * @param runner - Injected command runner.
 */
export async function resolveCrossRepoTarget(
  spec: string,
  runner: RunCommand,
): Promise<CrossRepoTarget> {
  const classification = classifyDependencySpec(spec);
  if (classification.kind === "external") {
    return { kind: "external", package: spec, reason: classification.reason };
  }

  const access = await probeCrossRepoAccess(
    classification.candidateRepo,
    runner,
  );
  if (!access.reachable) {
    return { kind: "external", package: spec, reason: access.reason };
  }

  return { kind: "internal-reachable", package: spec, repo: access.repo };
}

// ---------------------------------------------------------------------------
// Dependency-manifest authorisation (Issue #1382)
// ---------------------------------------------------------------------------

/**
 * Manifest paths read from the **consuming** repo when authorising a
 * cross-repo write target.
 *
 * Repo-relative paths rather than the bare filenames
 * `ORPHAN_DEPS_MANIFEST_FILES` carries, because each is fetched with a single
 * `gh api repos/<owner>/<repo>/contents/<path>` call. `worker/deno/deno.json`
 * is listed because this repo keeps its own manifest there rather than at the
 * root; a repo that has none of these simply authorises nothing.
 */
export const CONSUMING_MANIFEST_PATHS: readonly string[] = [
  "deno.json",
  "deno.jsonc",
  "package.json",
  "worker/deno/deno.json",
];

/** Whether a declared cross-repo write target is authorised, and why not. */
export type CrossRepoAuthorisation =
  | {
    authorised: true;
    /** `self` — the consuming repo itself; `dependency` — a declared dep. */
    via: "self" | "dependency";
    /** Manifest that declared it (absent for `self`). */
    manifestPath?: string;
  }
  | { authorised: false; reason: string };

/**
 * Decide whether a consuming repo may have a PR opened on its behalf in
 * `targetRepo`.
 *
 * Membership of {@link INTERNAL_OWNER} is *ownership*, not authority: the
 * fleet works many separate tenant repositories under that one owner, and a
 * run working one of them has no legitimate reason to write to a sibling it
 * does not depend on. Authority here is the consuming repo's own dependency
 * manifest — the target must resolve, through the same
 * {@link classifyDependencySpec} rule used everywhere else, to a dependency
 * that repo actually declares.
 *
 * The manifests are read from the consuming repo's **default branch on
 * GitHub**, never from the run's working tree: the working tree is writable
 * by the agent whose output produced the request being authorised, so it
 * cannot also be the authority for it. A manifest that cannot be read is not
 * an authorisation — the decision fails closed.
 *
 * Never throws; a failed read is a skipped manifest.
 *
 * @param consumingRepo - The repo the run was claimed against (`owner/repo`).
 * @param targetRepo - The declared write target (untrusted, `owner/repo`).
 * @param runner - Injected command runner.
 */
export async function authoriseCrossRepoTarget(
  consumingRepo: string,
  targetRepo: string,
  runner: RunCommand,
): Promise<CrossRepoAuthorisation> {
  if (!REPO_SLUG_PATTERN.test(consumingRepo)) {
    return {
      authorised: false,
      reason: `'${consumingRepo}' is not an owner/repo slug`,
    };
  }
  if (!REPO_SLUG_PATTERN.test(targetRepo)) {
    return {
      authorised: false,
      reason: `'${targetRepo}' is not an owner/repo slug`,
    };
  }

  const wanted = targetRepo.toLowerCase();
  if (wanted === consumingRepo.toLowerCase()) {
    return { authorised: true, via: "self" };
  }

  let manifestsRead = 0;
  for (const path of CONSUMING_MANIFEST_PATHS) {
    const read = await runner([
      "gh",
      "api",
      `repos/${consumingRepo}/contents/${path}`,
      "-H",
      "Accept: application/vnd.github.raw",
    ]);
    if (!read.success) continue;
    // Bounded like every other untrusted manifest read (Issue #3942): the
    // file's size is not this module's to trust.
    const rawText = read.stdout.slice(0, MAX_MANIFEST_SCAN_CHARS);
    if (rawText.trim().length === 0) continue;
    manifestsRead++;

    const file: ManifestFile = { path, rawText };
    const declared = path.endsWith("package.json")
      ? parseNpmManifest(file)
      : parseDenoManifest(file);
    for (const dependency of declared) {
      const classification = classifyDependencySpec(dependency.name);
      if (classification.kind !== "internal") continue;
      if (classification.candidateRepo.toLowerCase() === wanted) {
        return { authorised: true, via: "dependency", manifestPath: path };
      }
    }
  }

  return {
    authorised: false,
    reason: manifestsRead === 0
      ? `no dependency manifest could be read from ${consumingRepo}, so no ` +
        "cross-repo target can be authorised"
      : `${targetRepo} is not a dependency ${consumingRepo} declares`,
  };
}

// ---------------------------------------------------------------------------
// Cross-repo PR orchestration
// ---------------------------------------------------------------------------

/** Inputs for {@link openCrossRepoFixPr}. */
export interface CrossRepoFixRequest {
  /** Target dependency repo in `owner/repo` form (canonical, from the probe). */
  repo: string;
  /** Feature branch to create and push. Must not be the repo's default. */
  branch: string;
  /** PR title. */
  title: string;
  /** PR body. */
  body: string;
  /** Commit message for the fix commit. */
  commitMessage: string;
  /** Parent directory to clone the dep repo into. */
  workDir: string;
  /**
   * Apply the fix to the freshly-cloned repo. Receives the absolute path to the
   * checked-out working tree; the caller mutates files there. The orchestration
   * stages and commits everything after this resolves.
   */
  applyFix: (repoDir: string) => Promise<void>;
  /**
   * Base branch for the PR. When omitted, the dep repo's default branch is
   * resolved from `origin/HEAD` and used.
   */
  base?: string;
}

/** Outcome of a successful cross-repo PR. */
export interface CrossRepoFixResult {
  /** URL of the PR opened in the dependency repo. */
  prUrl: string;
  /** Canonical repo the PR was opened against. */
  repo: string;
  /** Feature branch that was pushed. */
  branch: string;
}

/** Join a directory and a path segment with a single separator. */
function joinPath(dir: string, segment: string): string {
  return dir.endsWith("/") ? `${dir}${segment}` : `${dir}/${segment}`;
}

/** Resolve the cloned repo's default branch from `origin/HEAD`. */
async function resolveDefaultBranch(
  repoDir: string,
  runner: RunCommand,
): Promise<string | null> {
  const result = await runner([
    "git",
    "-C",
    repoDir,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
  ]);
  if (!result.success) return null;
  const ref = result.stdout.trim().replace("refs/remotes/origin/", "");
  return ref.length > 0 ? ref : null;
}

/**
 * Open a PR in a dependency repo, in the current run.
 *
 * Sequence: clone (shallow, all branches) → resolve default branch → guard
 * against a default-branch push → create the feature branch → apply the
 * caller's fix → stage → commit → push → `gh pr create --repo …`. The PR URL
 * printed by `gh` is surfaced back so the consuming run can cross-link it.
 *
 * Any failed step returns an error `Result` (never throws), so the caller can
 * fall back to the deferral path. The default-branch guard enforces the
 * read-only invariant (Issue #2584): the worker never pushes directly to a
 * repo's default branch — every change rides a feature-branch PR.
 *
 * @param req - The cross-repo fix request.
 * @param runner - Injected command runner.
 */
export async function openCrossRepoFixPr(
  req: CrossRepoFixRequest,
  runner: RunCommand,
): Promise<Result<CrossRepoFixResult>> {
  if (!REPO_SLUG_PATTERN.test(req.repo)) {
    return {
      ok: false,
      error: new Error(`Invalid repository slug '${req.repo}'.`),
    };
  }
  if (req.branch.trim().length === 0) {
    return {
      ok: false,
      error: new Error("A feature branch name is required."),
    };
  }

  const repoName = req.repo.slice(req.repo.indexOf("/") + 1);
  const repoDir = joinPath(req.workDir, repoName);

  // 1. Clone (shallow, every branch — mirrors the worker's primary clone).
  const clone = await runner([
    "gh",
    "repo",
    "clone",
    req.repo,
    repoDir,
    "--",
    "--depth=1",
    "--no-single-branch",
  ]);
  if (!clone.success) {
    return {
      ok: false,
      error: new Error(`Failed to clone ${req.repo}: ${clone.stderr}`),
    };
  }

  // 2. Resolve the default branch and refuse a direct default-branch push.
  const defaultBranch = await resolveDefaultBranch(repoDir, runner);
  if (defaultBranch !== null && req.branch === defaultBranch) {
    return {
      ok: false,
      error: new Error(
        `Refusing to push to the default branch '${req.branch}' of ` +
          `${req.repo}: the default branch is read-only (Issue #2584). ` +
          `Use a feature branch.`,
      ),
    };
  }
  const base = req.base ?? defaultBranch ?? undefined;

  // 3. Create the feature branch.
  const checkout = await runner([
    "git",
    "-C",
    repoDir,
    "checkout",
    "-b",
    req.branch,
  ]);
  if (!checkout.success) {
    return {
      ok: false,
      error: new Error(
        `Failed to create branch '${req.branch}': ${checkout.stderr}`,
      ),
    };
  }

  // 4. Apply the caller's fix to the working tree.
  try {
    await req.applyFix(repoDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: new Error(`applyFix failed: ${message}`) };
  }

  // 5. Stage everything the fix produced.
  const add = await runner(["git", "-C", repoDir, "add", "-A"]);
  if (!add.success) {
    return {
      ok: false,
      error: new Error(`Failed to stage changes: ${add.stderr}`),
    };
  }

  // 6. Commit.
  const commit = await runner([
    "git",
    "-C",
    repoDir,
    "commit",
    "-m",
    req.commitMessage,
  ]);
  if (!commit.success) {
    return {
      ok: false,
      error: new Error(
        `Failed to commit (no changes, or commit error): ${commit.stderr}`,
      ),
    };
  }

  // 7. Push the feature branch (creating the upstream).
  const push = await runner([
    "git",
    "-C",
    repoDir,
    "push",
    "-u",
    "origin",
    req.branch,
  ]);
  if (!push.success) {
    return {
      ok: false,
      error: new Error(`Failed to push '${req.branch}': ${push.stderr}`),
    };
  }

  // 8. Open the PR against the dependency repo.
  const prArgs = [
    "gh",
    "pr",
    "create",
    "--repo",
    req.repo,
    "--head",
    req.branch,
    "--title",
    req.title,
    "--body",
    req.body,
  ];
  if (base) prArgs.push("--base", base);

  const pr = await runner(prArgs);
  if (!pr.success) {
    return {
      ok: false,
      error: new Error(`Failed to open PR in ${req.repo}: ${pr.stderr}`),
    };
  }

  const prUrl = pr.stdout.trim();
  if (prUrl.length === 0) {
    return {
      ok: false,
      error: new Error(`PR created in ${req.repo} but no URL was returned.`),
    };
  }

  return {
    ok: true,
    value: { prUrl, repo: req.repo, branch: req.branch },
  };
}
