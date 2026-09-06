/**
 * Cross-repo dependency-PR bridge (Issue #182).
 *
 * The coding guidelines injected into every run require an agent whose root
 * cause lives in an internal `stSoftwareAU/*` dependency to fix it there and
 * **raise a PR in that dependency's own repo, in the same run**. The agent
 * cannot: its `gh` guard shim bakes the run's write-repo allowlist — the claim
 * repo, and nothing else — into the child at spawn time, so
 * `gh pr create --repo stSoftwareAU/<dep>` is refused with
 * `[SECURITY] [WRITE_REPO_BLOCKED]`. `GRQ#4206` burned two whole runs on that
 * one blocked call, leaving the finished fix stranded on an unreferenced
 * branch.
 *
 * This module is the sanctioned path, and it changes no boundary the agent
 * runs behind:
 *
 *   1. The agent pushes the branch to the dependency repo (`git` is not
 *      guarded) and **declares** the PR it wants with a marker in its output
 *      ({@link CROSS_REPO_PR_MARKER_NAME}).
 *   2. The worker parses that declaration ({@link detectCrossRepoPrDeclaration}),
 *      validates the target — internal owner, a dependency the consuming repo
 *      actually declares, reachable, pushable, a branch that really exists on
 *      the dependency remote, and not the default branch — then opens the PR
 *      through its own `spawnGh` chokepoint ({@link openDeclaredCrossRepoPr}).
 *   3. The dependency PR URL is cross-linked back onto the consuming issue;
 *      anything that stops the PR being opened is escalated to a human rather
 *      than dropped ({@link handOffCrossRepoPr}).
 *
 * The agent's own egress boundary is untouched: the write happens in the
 * worker process, behind a grant scoped to that one `gh pr create`
 * (`withScopedWriteRepo`). Every value in the declaration is untrusted model
 * output, so each is shape-validated before it becomes a `gh` argument.
 *
 * Release-gating is unchanged (docs/CROSS-REPO-FIX.md): the worker opens the
 * dependency PR and stops. It never merges or publishes it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubClient, Logger, Result } from "../types.ts";
import { REPO_SLUG_PATTERN } from "./config.ts";
import {
  authoriseCrossRepoTarget,
  INTERNAL_OWNER,
  probeCrossRepoAccess,
  type RunCommand,
} from "./cross_repo_fix.ts";
import { spawnGh } from "./gh_spawn.ts";
import { withScopedWriteRepo } from "./write_repo_allowlist.ts";
import {
  escalateToHuman as defaultEscalateToHuman,
  type EscalateToHumanOptions,
  type EscalateToHumanOutcome,
} from "./needs_human_escalation.ts";

/**
 * The marker an agent emits to declare a dependency PR for the worker to
 * open. An HTML comment, matching the existing marker conventions
 * (`<!-- analysis-only -->`, `<!-- vibe-suspicious-image-detected … -->`).
 *
 * Canonical form (on its own line):
 *
 *   <!-- vibe-cross-repo-pr repo="stSoftwareAU/Dep" branch="fix/123-thing"
 *        base="<base-branch>" title="Fix the thing" summary="why" -->
 *
 * `repo`, `branch` and `title` are required; `base` defaults to the
 * dependency's default branch and `summary` is folded into the PR body.
 */
export const CROSS_REPO_PR_MARKER_NAME = "vibe-cross-repo-pr";

/** Maximum length of a declared PR title. */
const MAX_TITLE_LENGTH = 200;
/** Maximum length of the declared summary folded into the PR body. */
const MAX_SUMMARY_LENGTH = 1500;
/** Maximum length of a branch / base ref. */
const MAX_REF_LENGTH = 240;

/** A dependency PR the agent declared and the worker may open. */
export interface CrossRepoPrDeclaration {
  /** Dependency repo in `owner/repo` form. */
  repo: string;
  /** Head branch the run already pushed to that repo. */
  branch: string;
  /** PR title. */
  title: string;
  /** Base branch; defaults to the dependency's default branch. */
  base?: string;
  /** Short rationale folded into the PR body. */
  summary?: string;
}

/** Outcome of scanning agent output for a declaration. */
export type CrossRepoPrDetection =
  | { status: "none" }
  | { status: "declared"; declaration: CrossRepoPrDeclaration }
  | { status: "malformed"; reason: string };

/** What the bridge did with a declaration. */
export type CrossRepoPrHandOffResult =
  | { status: "opened" | "existing"; prUrl: string }
  | { status: "escalated"; reason: string };

/** A dependency PR the worker opened (or found already open). */
export interface CrossRepoPrOutcome {
  status: "opened" | "existing";
  prUrl: string;
  repo: string;
  branch: string;
}

const MARKER_RE = new RegExp(
  `<!--\\s*${CROSS_REPO_PR_MARKER_NAME}\\b([^]*?)-->`,
  "i",
);

/**
 * Matches every `name="…"` / `name='…'` attribute in the marker's inner text.
 * Hardcoded rather than built per attribute name: the name is data, matched
 * against the captured group, so no pattern is ever compiled from a variable.
 */
const ATTRIBUTE_RE = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Extract one attribute from the marker's inner text. */
function attribute(inner: string, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const match of inner.matchAll(ATTRIBUTE_RE)) {
    if (match[1]?.toLowerCase() !== wanted) continue;
    return match[2] ?? match[3];
  }
  return undefined;
}

/**
 * Flatten and length-cap an untrusted marker field so it is safe to put in a
 * `gh` argument and a published PR body: control characters (including
 * newlines) collapse to spaces and HTML-comment breakout sequences are
 * neutralised. Exported for testing.
 */
export function sanitiseDeclarationField(
  raw: string | undefined,
  maxLen: number,
): string {
  if (!raw) return "";
  let out = raw
    // Keep a space inside the token so a longer run cannot re-form it.
    .replace(/-->/g, "- ->")
    .replace(/<!--/g, "<!- -")
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (out.length > maxLen) out = out.slice(0, maxLen).trimEnd() + "…";
  return out;
}

/**
 * Whether a ref is a safe git ref *and* a safe `gh` argument: ordinary branch
 * characters only, no leading `-` (which `gh` would read as a flag), and no
 * `..` / empty path segments.
 */
function isSafeRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > MAX_REF_LENGTH) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) return false;
  if (ref.includes("..") || ref.includes("//") || ref.endsWith("/")) {
    return false;
  }
  return true;
}

/**
 * Scan agent output for a dependency-PR declaration.
 *
 * Detection is strict: only the explicit marker fires. A marker that is
 * present but unusable (missing field, unsafe ref, flag-shaped title) is
 * reported as `malformed` rather than ignored — the whole point of the bridge
 * is that a declared-but-unopened PR never disappears silently.
 */
export function detectCrossRepoPrDeclaration(
  output: string | undefined | null,
): CrossRepoPrDetection {
  if (!output) return { status: "none" };
  const markerMatch = MARKER_RE.exec(output);
  if (!markerMatch) return { status: "none" };

  const inner = markerMatch[1] ?? "";
  const repo = sanitiseDeclarationField(attribute(inner, "repo"), 120);
  const branch = sanitiseDeclarationField(
    attribute(inner, "branch"),
    MAX_REF_LENGTH,
  );
  const title = sanitiseDeclarationField(
    attribute(inner, "title"),
    MAX_TITLE_LENGTH,
  );
  const base = sanitiseDeclarationField(
    attribute(inner, "base"),
    MAX_REF_LENGTH,
  );
  const summary = sanitiseDeclarationField(
    attribute(inner, "summary"),
    MAX_SUMMARY_LENGTH,
  );

  const missing = [
    repo.length === 0 ? "repo" : "",
    branch.length === 0 ? "branch" : "",
    title.length === 0 ? "title" : "",
  ].filter((f) => f.length > 0);
  if (missing.length > 0) {
    return {
      status: "malformed",
      reason: `the declaration is missing required field(s): ${
        missing.join(", ")
      }`,
    };
  }

  if (!REPO_SLUG_PATTERN.test(repo)) {
    return {
      status: "malformed",
      reason: `'${repo}' is not an owner/repo slug`,
    };
  }
  if (!isSafeRef(branch)) {
    return {
      status: "malformed",
      reason: `'${branch}' is not a usable branch`,
    };
  }
  if (base.length > 0 && !isSafeRef(base)) {
    return { status: "malformed", reason: `'${base}' is not a usable base` };
  }
  if (title.startsWith("-")) {
    return {
      status: "malformed",
      reason: "the title starts with '-', which gh would read as a flag",
    };
  }

  return {
    status: "declared",
    declaration: {
      repo,
      branch,
      title,
      ...(base.length > 0 ? { base } : {}),
      ...(summary.length > 0 ? { summary } : {}),
    },
  };
}

/** Production `gh` runner — every call goes through the worker chokepoint. */
const productionRunner: RunCommand = async (cmd) => {
  const args = cmd[0] === "gh" ? cmd.slice(1) : cmd;
  try {
    const result = await spawnGh(args);
    return {
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    // A refusal from the allowlist (or a spawn fault) is a failed command, not
    // a thrown surprise for the caller — it still surfaces as an error Result.
    return {
      success: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
};

/** Options for {@link openDeclaredCrossRepoPr}. */
export interface OpenDeclaredCrossRepoPrOptions {
  /** The validated declaration from {@link detectCrossRepoPrDeclaration}. */
  declaration: CrossRepoPrDeclaration;
  /** The repo the run was claimed against (cross-linked in the PR body). */
  consumingRepo: string;
  /** The consuming issue number. */
  issueNumber: number;
  /** Injected `gh` runner (tests). Defaults to the `spawnGh` chokepoint. */
  runner?: RunCommand;
}

/** Compose the dependency PR body. */
function buildPrBody(
  options: OpenDeclaredCrossRepoPrOptions,
  base: string,
): string {
  const { declaration, consumingRepo, issueNumber } = options;
  const lines = [
    `Fixes the root cause of ${consumingRepo}#${issueNumber} here, in the ` +
    "dependency's own repo.",
  ];
  if (declaration.summary) lines.push("", declaration.summary);
  lines.push(
    "",
    `**Head:** \`${declaration.branch}\` → **base:** \`${base}\``,
    "",
    "Raised by the Vibe Coder worker on behalf of the run working " +
      `${consumingRepo}#${issueNumber}: the agent pushed the branch, and the ` +
      "worker opened this PR after validating the target as a declared " +
      "dependency of that repo, reachable and pushable (Issue #182).",
    "",
    "**Do not auto-merge on the worker's behalf** — releasing this dependency " +
      "is a human decision.",
  );
  return lines.join("\n");
}

/**
 * Validate a declared dependency PR and open it.
 *
 * Refuses — with an error `Result`, never a thrown exception — when the target
 * is not an internal `stSoftwareAU/*` repo, is not a dependency the consuming
 * repo declares ({@link authoriseCrossRepoTarget}), is unreachable or
 * unpushable, when the head branch does not exist on the dependency remote
 * (i.e. the run never pushed it), or when the head is the dependency's default
 * branch. An open PR for the same head is reused instead of duplicated, so a
 * re-run is safe.
 *
 * The owner check alone is deliberately not the gate (Issue #1382). Many
 * separate tenant repositories share the `stSoftwareAU` owner, and the whole
 * declaration is parsed out of the run's own generated text, so ownership
 * establishes only that the target is in-house — not that this run has any
 * business writing to it.
 *
 * The single `gh pr create` runs inside {@link withScopedWriteRepo}, so the
 * worker's write-repo allowlist opens for that one call and closes again.
 */
export async function openDeclaredCrossRepoPr(
  options: OpenDeclaredCrossRepoPrOptions,
): Promise<Result<CrossRepoPrOutcome>> {
  const { declaration } = options;
  const runner = options.runner ?? productionRunner;
  const { repo, branch } = declaration;

  if (!REPO_SLUG_PATTERN.test(repo)) {
    return {
      ok: false,
      error: new Error(`Invalid repository slug '${repo}'.`),
    };
  }
  const owner = repo.slice(0, repo.indexOf("/"));
  if (owner.toLowerCase() !== INTERNAL_OWNER.toLowerCase()) {
    return {
      ok: false,
      error: new Error(
        `Refusing to open a PR in '${repo}': only internal ` +
          `${INTERNAL_OWNER}/* dependency repos are eligible for the ` +
          "cross-repo bridge.",
      ),
    };
  }
  if (!isSafeRef(branch)) {
    return {
      ok: false,
      error: new Error(`Refusing an unsafe head branch '${branch}'.`),
    };
  }
  if (declaration.base !== undefined && !isSafeRef(declaration.base)) {
    return {
      ok: false,
      error: new Error(`Refusing an unsafe base branch '${declaration.base}'.`),
    };
  }

  // 1. Authorised target. Internal ownership is not authority on its own: the
  //    fleet works many separate tenant repos under the one owner, and this
  //    declaration was parsed from the run's own generated output. The target
  //    must additionally be a dependency the consuming repo itself declares,
  //    read from that repo's default branch rather than from the run's
  //    working tree — which the agent can edit (Issue #1382).
  const authorisation = await authoriseCrossRepoTarget(
    options.consumingRepo,
    repo,
    runner,
  );
  if (!authorisation.authorised) {
    return {
      ok: false,
      error: new Error(
        `Refusing to open a PR in '${repo}': ${authorisation.reason}.`,
      ),
    };
  }

  // 2. Internal + reachable + pushable.
  const access = await probeCrossRepoAccess(repo, runner);
  if (!access.reachable) {
    return {
      ok: false,
      error: new Error(`Cannot open a PR in ${repo}: ${access.reason}.`),
    };
  }
  const target = access.repo;

  // 3. The head must already exist on the dependency remote — the bridge
  //    opens a PR for a branch the run pushed, it never creates one.
  const head = await runner([
    "gh",
    "api",
    `repos/${target}/branches/${branch}`,
  ]);
  if (!head.success) {
    return {
      ok: false,
      error: new Error(
        `Branch '${branch}' does not exist on ${target} — push it before ` +
          "declaring the PR.",
      ),
    };
  }

  // 4. Never open a PR whose head is the dependency's default branch.
  if (access.defaultBranch && branch === access.defaultBranch) {
    return {
      ok: false,
      error: new Error(
        `Refusing to open a PR whose head is the default branch '${branch}' ` +
          `of ${target}: the default branch is read-only (Issue #2584).`,
      ),
    };
  }
  const base = declaration.base ?? access.defaultBranch;

  // 5. Reuse an already-open PR for this head rather than duplicating it.
  const existing = await runner([
    "gh",
    "pr",
    "list",
    "--repo",
    target,
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "url",
    "--jq",
    ".[0].url // empty",
  ]);
  const existingUrl = existing.success ? existing.stdout.trim() : "";
  if (existingUrl.length > 0) {
    return {
      ok: true,
      value: { status: "existing", prUrl: existingUrl, repo: target, branch },
    };
  }

  // 6. Open it — the one write the scoped grant covers.
  const args = [
    "gh",
    "pr",
    "create",
    "--repo",
    target,
    "--head",
    branch,
    "--title",
    declaration.title,
    "--body",
    buildPrBody(options, base ?? "the default branch"),
  ];
  if (base) args.push("--base", base);

  const created = await withScopedWriteRepo(target, () => runner(args));
  if (!created.success) {
    return {
      ok: false,
      error: new Error(`Failed to open a PR in ${target}: ${created.stderr}`),
    };
  }
  const prUrl = created.stdout.trim();
  if (prUrl.length === 0) {
    return {
      ok: false,
      error: new Error(`PR created in ${target} but no URL was returned.`),
    };
  }

  return { ok: true, value: { status: "opened", prUrl, repo: target, branch } };
}

/** Injectable dependencies for {@link handOffCrossRepoPr} (testing). */
export interface HandOffCrossRepoPrDeps {
  /** Override the escalation chokepoint. Defaults to `escalateToHuman`. */
  escalate?: (
    options: EscalateToHumanOptions,
  ) => Promise<Result<EscalateToHumanOutcome>>;
  /** Ensure the `needs-human` label exists (forwarded to the escalation). */
  ensureLabelExists?: (
    repo: string,
    labelName: string,
    colour?: string,
    description?: string,
  ) => Promise<Result<void>>;
}

/** Options accepted by {@link handOffCrossRepoPr}. */
export interface HandOffCrossRepoPrOptions {
  ghClient: GitHubClient;
  /** The consuming repo the run was claimed against. */
  repo: string;
  /** The consuming issue number. */
  issueNumber: number;
  needsHumanLabel: string;
  githubUser: string;
  /** The detection from {@link detectCrossRepoPrDeclaration}. */
  detection: CrossRepoPrDetection;
  logger: Logger;
  /** Injected `gh` runner (tests). */
  runner?: RunCommand;
  deps?: HandOffCrossRepoPrDeps;
}

/** The `**Next step:**` text when the bridge could not open the PR. */
function buildEscalationNextStep(
  detection: CrossRepoPrDetection,
): string {
  if (detection.status === "declared") {
    const { repo, branch, base, title } = detection.declaration;
    return (
      `Open the PR by hand in ${repo}: head \`${branch}\`` +
      (base ? `, base \`${base}\`` : "") +
      `, title "${title}". Then remove \`needs-human\`. The branch is already ` +
      "pushed — only the PR is missing."
    );
  }
  return (
    "The agent declared a dependency PR the worker could not act on. Check " +
    "the run's output for the pushed branch and open the PR by hand, then " +
    "remove `needs-human`."
  );
}

/**
 * Open the dependency PR an agent declared, or escalate.
 *
 * On success the dependency PR URL is cross-linked onto the consuming issue.
 * On any refusal or failure the issue is handed to a human via the guarded
 * `escalateToHuman` chokepoint (Issue #1471) with the branch details, so the
 * fix is never left stranded on an unreferenced branch — the exact failure
 * this bridge exists to end.
 *
 * Never throws: the surrounding phase continues either way, because the
 * consuming repo's own PR may still be raised by the completion phase.
 */
export async function handOffCrossRepoPr(
  options: HandOffCrossRepoPrOptions,
): Promise<CrossRepoPrHandOffResult> {
  const {
    ghClient,
    repo,
    issueNumber,
    needsHumanLabel,
    githubUser,
    detection,
    logger,
  } = options;
  const escalate = options.deps?.escalate ?? defaultEscalateToHuman;

  const escalateFailure = async (
    reason: string,
  ): Promise<CrossRepoPrHandOffResult> => {
    logger.error(
      "Declared dependency PR was not opened — escalating (Issue #182)",
      { repo, issueNumber, reason },
    );
    try {
      await escalate({
        ghClient,
        repo,
        target: { kind: "issue", number: issueNumber },
        needsHumanLabel,
        heading: "Dependency PR could not be opened",
        reason:
          "the run declared a PR in an internal dependency repo, but the " +
          `worker could not open it: ${reason}`,
        nextStep: buildEscalationNextStep(detection),
        dedupKey: `cross-repo-pr-${issueNumber}`,
        githubUser,
        deps: {
          ...(options.deps?.ensureLabelExists
            ? { github: { ensureLabelExists: options.deps.ensureLabelExists } }
            : {}),
        },
        logger,
      });
    } catch (err) {
      logger.error("Cross-repo PR escalation failed", {
        repo,
        issueNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { status: "escalated", reason };
  };

  if (detection.status === "none") {
    return { status: "escalated", reason: "no declaration" };
  }
  if (detection.status === "malformed") {
    return await escalateFailure(detection.reason);
  }

  const result = await openDeclaredCrossRepoPr({
    declaration: detection.declaration,
    consumingRepo: repo,
    issueNumber,
    ...(options.runner ? { runner: options.runner } : {}),
  });
  if (!result.ok) return await escalateFailure(result.error.message);

  const { prUrl, status } = result.value;
  logger.info(
    status === "existing"
      ? "Dependency PR already open — cross-linking it (Issue #182)"
      : "Opened the declared dependency PR (Issue #182)",
    { repo, issueNumber, depRepo: result.value.repo, prUrl },
  );
  try {
    await ghClient.postComment(
      repo,
      issueNumber,
      `🔀 **Dependency PR ${
        status === "existing" ? "already open" : "opened"
      }:** ` +
        `${prUrl}\n\n` +
        `The root cause was fixed in \`${result.value.repo}\` on branch ` +
        `\`${result.value.branch}\`, and the worker opened the PR there on the ` +
        "agent's behalf (the agent's own `gh` boundary covers this repo only). " +
        "Releasing that dependency stays a human decision — this run will not " +
        "merge or publish it.",
    );
  } catch (err) {
    logger.error("Failed to cross-link the dependency PR on the issue", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { status, prUrl };
}
