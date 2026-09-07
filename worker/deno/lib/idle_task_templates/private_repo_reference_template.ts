/**
 * Private-repo-reference-audit idle-task template (Issue #3549, template
 * #16).
 *
 * A **public** repository must be fully self-contained for the public:
 * nothing in it may **directly reference** a private `stSoftwareAU`
 * repository — not tests, fixtures, benches, docs, or code comments. A
 * test that reaches a private repo (e.g. FLEET) can never run for the
 * public and belongs in the private repo instead; a committed fixture
 * captured from a private repo leaks private data; a doc/comment naming a
 * private repo points the public at something they cannot see.
 *
 * This template runs a static, evidence-backed audit of the target
 * repository for **direct private-repo references** and files one finding
 * issue per surviving concern. It is modelled on
 * `documentation_audit_template.ts` — a single language-agnostic prompt,
 * no bucket, and the same outcome-only Claude contract — with one crucial
 * difference: **it only ever runs against a public repo.**
 *
 *   - **Public-only gate.** Both `shouldFile` (the random-filer path) and
 *     `runTask` (the actual scan) read the audited repo's visibility from
 *     the GitHub API at scan time via {@link getRepoVisibility}. A
 *     private (or unknown, which fail-safes to private) repo is skipped
 *     entirely — no wrapper filed, no scan run. This is the hard safety
 *     property: the scan never runs against a private repo.
 *   - **Outcome-only Claude contract.** The orchestrating prompt in
 *     `prompts/private_repo_reference_audit/` (latest version loaded at
 *     runtime) instructs Claude to file findings directly via `gh issue
 *     create`. `runTask` verifies the outcome by snapshotting the repo's
 *     open `private-repo-reference` issues before and after the scan and
 *     diffing them — no JSON parsing.
 *   - **Label-ensure first.** The `private-repo-reference` label is not
 *     seeded anywhere else, so `runTask` ensures it exists before
 *     invoking the scan.
 *   - **Dedup.** The known-open list passed to Claude is built from the
 *     repo's existing open `private-repo-reference` issues — Claude is
 *     instructed to skip any finding whose `BP-…` id is in the list.
 *   - **Weekly cadence.** `cooldownHours: 168` caps the scan to once per
 *     week per repo (enforced by `idle_task_cooldown_gate.ts`).
 *
 * The scan files **issues only**, never a PR (`skipMilestone: true`). The
 * remediation the filed issues prescribe — deleting a test that reaches a
 * private repo, deleting a private-derived fixture, or rewording a
 * private-repo name mention to concept level — rides the normal work-on
 * flow on the filed issues, never here.
 *
 * Registration happens at module load — importing this file is the only
 * thing callers need to do.
 *
 * Australian English used throughout (behaviour, organisation,
 * authorised).
 */

import {
  type IdleTaskBodyOptions,
  idleTaskPromptsDir,
  type IdleTaskRunOptions,
  type IdleTaskRunResult,
  type IdleTaskShouldFileOptions,
  type IdleTaskTemplate,
  registerTemplate,
} from "../idle_task_template.ts";
import { runGhCommand as defaultGhCommand } from "../github.ts";
import type { AlertDedupAuthorOptions } from "../alert_dedup_authors.ts";
import { hasFleetAuthoredOpenIssueTitled } from "../idle_task_wrapper_dedup.ts";
import { loadPrompt as defaultLoadPrompt } from "../prompt_manager.ts";
import {
  diffNewlyFiled,
  listAllOpenIssueTitles,
  listKnownOpenFindingIds,
  listOpenIssueNumbersByLabel,
  NEWLY_FILED_UNKNOWN_SUMMARY,
  type OpenIssueTitle,
  renderOpenIssueTitles,
} from "../idle_task_snapshot.ts";
import { ensureLabelExists as defaultEnsureLabelExists } from "../label_operations.ts";
import { runIdleTaskClaude } from "../idle_task_claude_budget.ts";
import { RUN_ID_ENV_VAR } from "../run_id.ts";
import { buildAttributionFooter } from "../idle_task_attribution.ts";
import {
  getRepoVisibility as defaultGetRepoVisibility,
  type RepoVisibility,
} from "../repo_visibility.ts";
import type { Result } from "../../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME = "private-repo-reference-audit";

const DESCRIPTION =
  "Run the public-repo private-reference audit against the target " +
  "repository — detect direct references to a private stSoftwareAU repo " +
  "(runtime access, committed private-derived data, or textual name " +
  "mentions in code/comments/docs) and file each surviving finding as its " +
  "own issue. Only ever runs against a public repo.";

/** Label every filed private-repo-reference finding carries. */
export const PRIVATE_REPO_REFERENCE_LABEL = "private-repo-reference";

/** Static wrapper title — dispatch matches against this string. */
export const PRIVATE_REPO_REFERENCE_ISSUE_TITLE =
  "Run a private-repo reference audit";

/** Colour for the `private-repo-reference` label (matches the prompt seed). */
export const PRIVATE_REPO_REFERENCE_LABEL_COLOUR = "5319E7";

/** Prompt template directory under `prompts/`. */
const PROMPT_NAME = "private_repo_reference_audit";

/** Once-per-week-per-repo cap (enforced by `idle_task_cooldown_gate.ts`). */
const COOLDOWN_HOURS = 168;

/**
 * Body fingerprint that uniquely identifies a private-repo-reference
 * wrapper. Anchored to a Markdown heading at start-of-line, matching the
 * `documentation_audit_template` convention. The prompt's H1 is
 * `# Private-Repo Reference Audit — Public Repos Must Not Reference
 * Private Repos (vN)` — the fingerprint is version-agnostic.
 */
export const PRIVATE_REPO_REFERENCE_BODY_FINGERPRINT =
  /^#+\s+Private-Repo Reference Audit\b/m;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for {@link createPrivateRepoReferenceTemplate}.
 *
 * Tests inject stubs for every external interaction (gh CLI, Claude,
 * prompt loader, label-ensure, visibility lookup) so they never touch the
 * network or block on Claude.
 */
export interface PrivateRepoReferenceTemplateDeps {
  /**
   * Author-verification inputs for the wrapper dedup search
   * ({@link hasFleetAuthoredOpenIssueTitled}). Omitted — every
   * production caller — reads the configured fleet identity.
   */
  dedupAuthors?: AlertDedupAuthorOptions;
  /** gh CLI runner used for snapshots, dedup, and the wrapper veto. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Prompt loader — defaults to `loadPrompt`. */
  loadPromptFn?: (
    name: string,
    promptsDir?: string,
  ) => Promise<Result<string>>;
  /**
   * Ensure the `private-repo-reference` label exists in the target repo.
   * Defaults to `ensureLabelExists`. Tests inject a stub so the
   * filesystem and network stay untouched.
   */
  ensureLabelFn?: (repo: string) => Promise<Result<void>>;
  /**
   * Resolve the audited repo's visibility. Defaults to
   * {@link getRepoVisibility}, which fail-safes to `"private"` on any
   * uncertainty. Tests inject a stub so the network stays untouched.
   */
  getVisibilityFn?: (
    repo: string,
  ) => Promise<Result<RepoVisibility, string>>;
  /**
   * Private-repo-reference scan runner — invokes Claude with the
   * assembled prompt. Defaults to the production `claude_runner` wrapper.
   * Tests inject a stub that returns success without invoking Claude.
   *
   * Returns `ok: true` when Claude exited cleanly; the caller verifies
   * the outcome by diffing the snapshot. `ok: false` surfaces the
   * structured error in the wrapper close summary.
   */
  runScanFn?: (opts: RunScanOptions) => Promise<Result<true, ScanError>>;
}

/** Inputs to a private-repo-reference Claude run. */
export interface RunScanOptions {
  repo: string;
  workDir: string;
  /** Stable ids already open as `private-repo-reference` issues — skip-list. */
  knownOpenFindingIds: string[];
  /**
   * Every issue currently open in the repo, whatever its label — the
   * cross-label dedup list (Issue #537).
   */
  openIssueTitles: OpenIssueTitle[];
  /** Stable ids the run should suppress (in-source markers, prior triage). */
  suppressedIds: string[];
}

/** Discriminated failure mode from `runScanFn`. */
export interface ScanError {
  kind: "prompt" | "claude" | "timeout";
  message: string;
}

// ---------------------------------------------------------------------------
// Visibility gate
// ---------------------------------------------------------------------------

/**
 * Return true only when `repo` is definitively public. A visibility
 * lookup error, or any non-public value, resolves to `false` so the audit
 * fails closed — it never runs against a private (or uncertain) repo.
 * Exported so tests can assert the gate directly.
 */
export async function isPublicRepo(
  repo: string,
  getVisibilityFn: (
    repo: string,
  ) => Promise<Result<RepoVisibility, string>>,
): Promise<boolean> {
  const result = await getVisibilityFn(repo);
  if (!result.ok) return false;
  return result.value === "public";
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * Substitute the placeholders defined by
 * `prompts/private_repo_reference_audit/prompt.md`.
 *
 * Empty id lists render as `(none)` — same convention as
 * `assembleDocumentationAuditPrompt` so wrappers read naturally both
 * standalone and inline.
 *
 * Pure — no I/O.
 */
export function assemblePrivateRepoReferencePrompt(
  template: string,
  opts: {
    suppressedIds: readonly string[];
    knownOpenFindingIds: readonly string[];
    /**
     * Every issue currently open in the target repo, whatever its
     * label (Issue #537) — the semantic second line of dedup. An
     * empty list renders the `(none)` sentinel.
     */
    openIssueTitles?: readonly OpenIssueTitle[];
    attributionFooter?: string;
  },
): string {
  const suppressed = opts.suppressedIds.length > 0
    ? opts.suppressedIds.join("\n")
    : "(none)";
  const known = opts.knownOpenFindingIds.length > 0
    ? opts.knownOpenFindingIds.join("\n")
    : "(none)";
  const openIssues = renderOpenIssueTitles(opts.openIssueTitles ?? []);
  const footer = opts.attributionFooter ?? "";
  return template
    .replaceAll("{{SUPPRESSED_IDS}}", suppressed)
    .replaceAll("{{KNOWN_OPEN_FINDING_IDS}}", known)
    .replaceAll("{{OPEN_ISSUE_TITLES}}", openIssues)
    .replaceAll("{{ATTRIBUTION_FOOTER}}", footer);
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

/**
 * Render the close-comment summary for the wrapper idle-task issue.
 *
 *   - No newly-filed issues → `"no findings"`.
 *   - One or more newly-filed issues →
 *     `"Private-repo reference audit complete. Filed N issues: #A, #B, …"`
 *     with the numbers sorted ascending so the comment is deterministic.
 *
 * Exported so tests can assert on the exact wording.
 */
export function renderPrivateRepoReferenceSummary(
  newlyFiled: readonly number[] | null,
): string {
  if (newlyFiled === null) return NEWLY_FILED_UNKNOWN_SUMMARY;
  if (newlyFiled.length === 0) return "no findings";
  const sorted = [...newlyFiled].sort((a, b) => a - b);
  const list = sorted.map((n) => `#${n}`).join(", ");
  return `Private-repo reference audit complete. Filed ${sorted.length} ` +
    `issues: ${list}`;
}

/** Summary returned when the audited repo is not public (scan skipped). */
export function renderSkippedPrivateSummary(repo: string): string {
  return `skipped: ${repo} is not a public repo — ` +
    `the private-repo reference audit only runs against public repos`;
}

// ---------------------------------------------------------------------------
// Production Claude runner
// ---------------------------------------------------------------------------

/**
 * Default Claude runner. Loads `prompts/private_repo_reference_audit/prompt.md`,
 * substitutes placeholders, and invokes Claude with the same write-tool
 * blocklist as `documentation_audit_template.defaultRunScan` — the scan
 * is read-only and files issues via `gh` only.
 *
 * Tests do NOT exercise this path — they inject a `runScanFn` stub. Kept
 * here so the production wiring is symmetric with the other templates.
 */
async function defaultRunScan(
  opts: RunScanOptions,
  loadPromptFn: (name: string) => Promise<Result<string>>,
): Promise<Result<true, ScanError>> {
  const promptResult = await loadPromptFn(PROMPT_NAME);
  if (!promptResult.ok) {
    return {
      ok: false,
      error: { kind: "prompt", message: promptResult.error.message },
    };
  }

  const prompt = assemblePrivateRepoReferencePrompt(promptResult.value, {
    suppressedIds: opts.suppressedIds,
    knownOpenFindingIds: opts.knownOpenFindingIds,
    openIssueTitles: opts.openIssueTitles,
  });

  const result = await runIdleTaskClaude({
    prompt,
    cwd: opts.workDir,
    phase: "private_repo_reference_audit",
    disallowedTools: [
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "EnterPlanMode",
      "ExitPlanMode",
    ],
  });
  if (!result.ok) {
    return {
      ok: false,
      error: { kind: "claude", message: result.error.message },
    };
  }
  const { exitCode, timedOut } = result.value;
  if (timedOut) {
    return {
      ok: false,
      error: {
        kind: "timeout",
        message: "Claude private-repo-reference scan timed out",
      },
    };
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      error: { kind: "claude", message: `Claude exited with code ${exitCode}` },
    };
  }
  return { ok: true, value: true };
}

// ---------------------------------------------------------------------------
// Template factory
// ---------------------------------------------------------------------------

/**
 * Build the private-repo-reference template using the supplied deps.
 * Default deps wire production behaviour; tests inject stubs.
 */
export function createPrivateRepoReferenceTemplate(
  deps: PrivateRepoReferenceTemplateDeps = {},
): IdleTaskTemplate {
  const ghCommandFn = deps.ghCommandFn ?? ((args) => defaultGhCommand(args));
  const dedupAuthors = deps.dedupAuthors ?? {};
  const loadPromptFn = deps.loadPromptFn ??
    ((name, promptsDir) => defaultLoadPrompt(name, promptsDir));
  const ensureLabelFn = deps.ensureLabelFn ??
    ((repo) =>
      defaultEnsureLabelExists(
        repo,
        PRIVATE_REPO_REFERENCE_LABEL,
        PRIVATE_REPO_REFERENCE_LABEL_COLOUR,
        "Public repo directly references a private repo",
      ));
  const getVisibilityFn = deps.getVisibilityFn ??
    ((repo) => defaultGetRepoVisibility(repo));
  const runScanFn = deps.runScanFn ??
    ((opts) => defaultRunScan(opts, loadPromptFn));

  async function buildIssueBody(opts: IdleTaskBodyOptions): Promise<string> {
    // Issue #2077: the wrapper body IS the prompt — fully substituted at
    // file time so a developer reading the issue sees concrete values
    // rather than `{{...}}` placeholders.
    const loaded = await loadPromptFn(PROMPT_NAME, idleTaskPromptsDir(opts));
    if (!loaded.ok) {
      throw new Error(
        `private-repo-reference-audit: failed to load prompt template ` +
          `${PROMPT_NAME}: ${loaded.error.message}`,
      );
    }
    const attributionFooter = buildAttributionFooter({
      template: NAME,
      runId: Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown",
    });
    return assemblePrivateRepoReferencePrompt(loaded.value, {
      suppressedIds: [],
      knownOpenFindingIds: [],
      attributionFooter,
    });
  }

  function buildIssueTitle(_repo: string): string {
    return PRIVATE_REPO_REFERENCE_ISSUE_TITLE;
  }

  async function shouldFile(
    opts: IdleTaskShouldFileOptions,
  ): Promise<boolean> {
    // Public-only gate: never file the wrapper on a private (or
    // uncertain) repo. This is the check's defining constraint — a
    // private repo may legitimately reference its private siblings.
    if (!(await isPublicRepo(opts.repo, getVisibilityFn))) {
      return false;
    }
    // Refuse to pile on while a wrapper is still being triaged. The
    // generic backlog gate handles open-findings count separately via
    // the `outputLabel` declaration below.
    if (
      await hasFleetAuthoredOpenIssueTitled({
        repo: opts.repo,
        title: PRIVATE_REPO_REFERENCE_ISSUE_TITLE,
        context: "private-repo-reference wrapper",
        ghCommand: ghCommandFn,
        ...dedupAuthors,
      })
    ) {
      return false;
    }
    return true;
  }

  async function runTask(opts: IdleTaskRunOptions): Promise<IdleTaskRunResult> {
    try {
      // 0. Public-only gate (defence in depth). Even if a wrapper was
      //    seeded on a private repo — e.g. via the operator "seed all"
      //    path that bypasses shouldFile — the scan itself must never run
      //    against a private repo. Skipping is a success (nothing to do),
      //    not a failure.
      if (!(await isPublicRepo(opts.repo, getVisibilityFn))) {
        return {
          ok: true,
          summary: renderSkippedPrivateSummary(opts.repo),
        };
      }

      // 1. Ensure the `private-repo-reference` label exists before any
      //    filing. It is not seeded anywhere else, so the first run must
      //    create it. A soft failure is non-fatal — the prompt also
      //    creates the label defensively before filing.
      await ensureLabelFn(opts.repo);

      // 2. Snapshot the repo's open private-repo-reference issues before
      //    any filing happens this run.
      const before = await listOpenIssueNumbersByLabel(
        opts.repo,
        PRIVATE_REPO_REFERENCE_LABEL,
        ghCommandFn,
      );

      // 3. Build the known-open list so Claude does not re-emit findings
      //    the repo already tracks.
      const knownOpenFindingIds = await listKnownOpenFindingIds(
        opts.repo,
        PRIVATE_REPO_REFERENCE_LABEL,
        ghCommandFn,
        "BP-",
        // Author-verified dedup (Issue #1243): a finding-id marker in an
        // issue body anybody can write is not evidence the fleet filed it.
        dedupAuthors,
      );

      // Repo-wide open-issue titles (Issue #537) — the semantic second
      // line of dedup, so a finding already open under another label is
      // not re-filed. A gh failure returns an empty list, which renders
      // `(none)` and leaves the scan running.
      const openIssueTitles = await listAllOpenIssueTitles(
        opts.repo,
        ghCommandFn,
      );

      // 4. Invoke Claude. It files surviving findings via `gh issue
      //    create` directly — no JSON parsing here.
      const scanResult = await runScanFn({
        repo: opts.repo,
        workDir: opts.workDir,
        knownOpenFindingIds,
        openIssueTitles,
        suppressedIds: [],
      });
      if (!scanResult.ok) {
        return {
          ok: false,
          summary:
            `private-repo-reference-audit failed: ${scanResult.error.kind} — ` +
            scanResult.error.message,
        };
      }

      // 5. Snapshot again and compute the newly-filed set.
      const after = await listOpenIssueNumbersByLabel(
        opts.repo,
        PRIVATE_REPO_REFERENCE_LABEL,
        ghCommandFn,
      );
      const newlyFiled = diffNewlyFiled(before, after);

      return {
        ok: true,
        summary: renderPrivateRepoReferenceSummary(newlyFiled),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `private-repo-reference-audit threw: ${message}`,
      };
    }
  }

  return {
    name: NAME,
    description: DESCRIPTION,
    buildIssueTitle,
    buildIssueBody,
    shouldFile,
    runTask,
    matchesIdleTaskBody: (body) =>
      PRIVATE_REPO_REFERENCE_BODY_FINGERPRINT.test(body),
    skipMilestone: true,
    outputLabel: PRIVATE_REPO_REFERENCE_LABEL,
    requiresStructuredOutput: true,
    cooldownHours: COOLDOWN_HOURS,
  };
}

/** Module-load registration so importing this file wires the template up. */
export const privateRepoReferenceTemplate: IdleTaskTemplate =
  createPrivateRepoReferenceTemplate();

registerTemplate(privateRepoReferenceTemplate);
