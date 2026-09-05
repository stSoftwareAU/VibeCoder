/**
 * Orphan-dependency idle-task template (Issue #2904, parent #2902,
 * template #6).
 *
 * Foundation + wiring only. Registers `orphan-deps` as a draw-eligible
 * idle-task template with all framework plumbing in place; the detection
 * logic ships as a stub here (the prompt files nothing) and the sibling
 * sub-issues of #2902 flesh it out.
 *
 * Modelled on `supply_chain_readiness_template.ts` — single prompt,
 * language-agnostic, no bucket — with the same outcome-only Claude
 * contract:
 *
 *   - **Outcome-only Claude contract.** The orchestrating prompt at
 *     `prompts/orphan_deps/prompt.md` instructs Claude to file findings
 *     directly via `gh issue create`. `runTask` verifies the outcome by
 *     snapshotting the repo's open `orphan-deps`-labelled issues before
 *     and after the scan and diffing them — no JSON parsing.
 *   - **Label-ensure first.** The `orphan-deps` label is not seeded by
 *     the scan itself, so `runTask` ensures it exists before invoking
 *     the scan.
 *   - **Dedup.** The known-open list passed to Claude is built from the
 *     repo's existing open `orphan-deps` issues — Claude is instructed
 *     to skip any finding whose `BP-…` id is in the list.
 *   - **Weekly cadence.** `cooldownHours: 168` caps the scan to once per
 *     week per repo (enforced by `idle_task_cooldown_gate.ts`).
 *
 * Registration happens at module load — importing this file is the only
 * thing callers need to do.
 *
 * Australian English spelling used throughout (behaviour, organisation,
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
import { repoCheckoutPath } from "../repo_checkout_path.ts";
import { runIdleTaskClaude } from "../idle_task_claude_budget.ts";
import { RUN_ID_ENV_VAR } from "../run_id.ts";
import { buildAttributionFooter } from "../idle_task_attribution.ts";
import { collectInSourceSuppressedIds } from "../orphan_deps_suppression_scan.ts";
import { renderSuppressionSummary } from "../suppression_comments.ts";
import { defaultLogger } from "../logger.ts";
import type { Result } from "../../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME = "orphan-deps";

const DESCRIPTION =
  "Run the static, evidence-backed orphan-dependency audit against the " +
  "target repository and file each surviving finding as its own issue.";

/** Label every filed orphan-deps finding carries. */
export const ORPHAN_DEPS_LABEL = "orphan-deps";

/** Static wrapper title — dispatch matches against this string. */
export const ORPHAN_DEPS_ISSUE_TITLE = "Run an orphan-dependency scan";

/** Colour for the `orphan-deps` label (matches the prompt's seed colour). */
export const ORPHAN_DEPS_LABEL_COLOUR = "0E8A16";

/** Prompt template directory under `prompts/`. */
const PROMPT_NAME = "orphan_deps";

/** Once-per-week-per-repo cap (enforced by `idle_task_cooldown_gate.ts`). */
const COOLDOWN_HOURS = 168;

/**
 * Body fingerprint that uniquely identifies an orphan-deps wrapper.
 * Anchored to a Markdown heading at start-of-line, matching the
 * `supply_chain_readiness_template` / `test_audit_template` convention.
 * The prompt's H1 is `# Orphan-Dependency Scan — ...`.
 */
export const ORPHAN_DEPS_BODY_FINGERPRINT = /^#+\s+Orphan-Dependency Scan\b/m;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for {@link createOrphanDepsTemplate}.
 *
 * Tests inject stubs for every external interaction (gh CLI, Claude,
 * prompt loader, label-ensure) so they never touch the network or block
 * on Claude.
 */
export interface OrphanDepsTemplateDeps {
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
   * Ensure the `orphan-deps` label exists in the target repo. Defaults
   * to `ensureLabelExists`. Tests inject a stub so the filesystem and
   * network stay untouched.
   */
  ensureLabelFn?: (repo: string) => Promise<Result<void>>;
  /**
   * Orphan-dependency scan runner — invokes Claude with the assembled
   * prompt. Defaults to the production `claude_runner` wrapper. Tests
   * inject a stub that returns success without invoking Claude.
   *
   * Returns `ok: true` when Claude exited cleanly; the caller verifies
   * the outcome by diffing the snapshot. `ok: false` surfaces the
   * structured error in the wrapper close summary.
   */
  runScanFn?: (opts: RunScanOptions) => Promise<Result<true, ScanError>>;
  /**
   * Collect the `BP-` finding ids an operator has silenced in-source with
   * a `best-practice-ignore` / `orphan-deps-ignore` marker, read from the
   * cloned repo's dependency manifests. Defaults to the filesystem scan;
   * tests inject a stub so they never touch disk. Best-effort — a read
   * failure returns `[]` and the scan still runs.
   */
  collectSuppressedIdsFn?: (workDir: string) => Promise<string[]>;
}

/** Inputs to an orphan-dependency Claude run. */
export interface RunScanOptions {
  repo: string;
  workDir: string;
  /** Stable ids already open as `orphan-deps` issues — skip-list. */
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
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * Substitute the placeholders defined by `prompts/orphan_deps/prompt.md`.
 *
 * Empty id lists render as `(none)` — same convention as
 * `assembleSupplyChainReadinessPrompt` so wrappers read naturally both
 * standalone and inline. The attribution footer renders as the empty
 * string when not supplied.
 *
 * Pure — no I/O.
 */
export function assembleOrphanDepsPrompt(
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
 *     `"Orphan-dependency scan complete. Filed N issues: #A, #B, …"` with
 *     the numbers sorted ascending so the comment is deterministic.
 *   - Any in-source suppression marker seen during the run is listed on a
 *     trailing sentence (Issue #3712) so an active waiver is visible in
 *     the scan report, not only in the manifest it silences.
 *
 * Exported so tests can assert on the exact wording.
 */
export function renderOrphanDepsSummary(
  newlyFiled: readonly number[] | null,
  suppressionReport: string = renderSuppressionSummary(),
): string {
  let head: string;
  if (newlyFiled === null) {
    head = NEWLY_FILED_UNKNOWN_SUMMARY;
  } else if (newlyFiled.length === 0) {
    head = "no findings";
  } else {
    head = `Orphan-dependency scan complete. Filed ${newlyFiled.length} ` +
      `issues: ${
        [...newlyFiled].sort((a, b) => a - b).map((n) => `#${n}`).join(", ")
      }`;
  }
  return suppressionReport.length > 0 ? `${head} ${suppressionReport}` : head;
}

// ---------------------------------------------------------------------------
// Production Claude runner
// ---------------------------------------------------------------------------

/**
 * Default Claude runner. Loads `prompts/orphan_deps/prompt.md`, substitutes
 * placeholders, and invokes Claude with the same write-tool blocklist as
 * `supply_chain_readiness_template.defaultRunScan`.
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

  const prompt = assembleOrphanDepsPrompt(promptResult.value, {
    suppressedIds: opts.suppressedIds,
    knownOpenFindingIds: opts.knownOpenFindingIds,
    openIssueTitles: opts.openIssueTitles,
  });

  const result = await runIdleTaskClaude({
    prompt,
    cwd: opts.workDir,
    phase: "orphan_deps",
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
        message: "Claude orphan-dependency scan timed out",
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
 * Build the orphan-dependency template using the supplied deps. Default
 * deps wire production behaviour; tests inject stubs.
 */
export function createOrphanDepsTemplate(
  deps: OrphanDepsTemplateDeps = {},
): IdleTaskTemplate {
  const ghCommandFn = deps.ghCommandFn ?? ((args) => defaultGhCommand(args));
  const dedupAuthors = deps.dedupAuthors ?? {};
  const loadPromptFn = deps.loadPromptFn ??
    ((name, promptsDir) => defaultLoadPrompt(name, promptsDir));
  const ensureLabelFn = deps.ensureLabelFn ??
    ((repo) =>
      defaultEnsureLabelExists(
        repo,
        ORPHAN_DEPS_LABEL,
        ORPHAN_DEPS_LABEL_COLOUR,
        "Orphan / unmaintained dependency finding",
      ));
  const runScanFn = deps.runScanFn ??
    ((opts) => defaultRunScan(opts, loadPromptFn));
  const collectSuppressedIdsFn = deps.collectSuppressedIdsFn ??
    // Issue #3942: surface the scan's input-cap notices — no silent caps.
    ((workDir) =>
      collectInSourceSuppressedIds(workDir, {
        logFn: (message) => defaultLogger.warn(message),
      }));

  async function buildIssueBody(opts: IdleTaskBodyOptions): Promise<string> {
    // Issue #2077: the wrapper body IS the prompt — fully substituted at
    // file time so a developer reading the issue sees concrete values
    // rather than `{{...}}` placeholders.
    const loaded = await loadPromptFn(PROMPT_NAME, idleTaskPromptsDir(opts));
    if (!loaded.ok) {
      throw new Error(
        `orphan-deps: failed to load prompt template ${PROMPT_NAME}: ` +
          loaded.error.message,
      );
    }
    const attributionFooter = buildAttributionFooter({
      template: NAME,
      runId: Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown",
    });
    return assembleOrphanDepsPrompt(loaded.value, {
      suppressedIds: [],
      knownOpenFindingIds: [],
      attributionFooter,
    });
  }

  function buildIssueTitle(_repo: string): string {
    return ORPHAN_DEPS_ISSUE_TITLE;
  }

  async function shouldFile(
    opts: IdleTaskShouldFileOptions,
  ): Promise<boolean> {
    // Refuse to pile on while a wrapper is still being triaged. The
    // generic backlog gate handles open-findings count separately via
    // the `outputLabel` declaration below.
    if (
      await hasFleetAuthoredOpenIssueTitled({
        repo: opts.repo,
        title: ORPHAN_DEPS_ISSUE_TITLE,
        context: "orphan-deps wrapper",
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
      // 1. Ensure the `orphan-deps` label exists before any filing. A
      //    soft failure is non-fatal — the prompt also creates the label
      //    defensively before filing.
      await ensureLabelFn(opts.repo);

      // 2. Snapshot the repo's open orphan-deps issues before any filing
      //    happens this run.
      const before = await listOpenIssueNumbersByLabel(
        opts.repo,
        ORPHAN_DEPS_LABEL,
        ghCommandFn,
      );

      // 3. Build the known-open list so Claude does not re-emit findings
      //    the repo already tracks.
      const knownOpenFindingIds = await listKnownOpenFindingIds(
        opts.repo,
        ORPHAN_DEPS_LABEL,
        ghCommandFn,
      );

      // 4. Collect the in-source suppressed ids so a finding silenced with
      //    a `best-practice-ignore` / `orphan-deps-ignore` marker is
      //    dropped on this run. Best-effort — never blocks the scan.
      //    Issue #3292: read the repo's own checkout, not the parent work
      //    dir that holds every clone (the #2880 pattern) — the manifest
      //    allow-list lives under the repo root.
      const suppressedIds = await collectSuppressedIdsFn(
        repoCheckoutPath(opts.workDir, opts.repo),
      );

      // Repo-wide open-issue titles (Issue #537) — the semantic second
      // line of dedup, so a finding already open under another label is
      // not re-filed. A gh failure returns an empty list, which renders
      // `(none)` and leaves the scan running.
      const openIssueTitles = await listAllOpenIssueTitles(
        opts.repo,
        ghCommandFn,
      );

      // 5. Invoke Claude. It files surviving findings via `gh issue
      //    create` directly — no JSON parsing here.
      const scanResult = await runScanFn({
        repo: opts.repo,
        workDir: opts.workDir,
        knownOpenFindingIds,
        openIssueTitles,
        suppressedIds,
      });
      if (!scanResult.ok) {
        return {
          ok: false,
          summary: `orphan-deps failed: ${scanResult.error.kind} — ` +
            scanResult.error.message,
        };
      }

      // 6. Snapshot again and compute the newly-filed set.
      const after = await listOpenIssueNumbersByLabel(
        opts.repo,
        ORPHAN_DEPS_LABEL,
        ghCommandFn,
      );
      const newlyFiled = diffNewlyFiled(before, after);

      return {
        ok: true,
        summary: renderOrphanDepsSummary(newlyFiled),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `orphan-deps threw: ${message}`,
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
    matchesIdleTaskBody: (body) => ORPHAN_DEPS_BODY_FINGERPRINT.test(body),
    skipMilestone: true,
    outputLabel: ORPHAN_DEPS_LABEL,
    requiresStructuredOutput: true,
    cooldownHours: COOLDOWN_HOURS,
  };
}

/** Module-load registration so importing this file wires the template up. */
export const orphanDepsTemplate: IdleTaskTemplate = createOrphanDepsTemplate();

registerTemplate(orphanDepsTemplate);
