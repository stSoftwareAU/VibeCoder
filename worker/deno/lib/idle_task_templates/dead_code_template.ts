/**
 * Dead-code & unused-export idle-task template (Issue #2912, parent
 * #2903, Boy Scout check #1).
 *
 * Runs the static dead-code & unused-export scan against the target
 * repository and files one finding issue per surviving removal
 * candidate. Modelled on `supply_chain_readiness_template.ts` and
 * `test_audit_template.ts` — single prompt, ecosystem-aware, no bucket —
 * with the same outcome-only Claude contract:
 *
 *   - **Issue-only — never a PR.** The orchestrating prompt at
 *     `prompts/dead_code/prompt.md` instructs Claude to file findings
 *     directly via `gh issue create` and explicitly forbids opening a
 *     pull request or editing any file. `runTask` verifies the outcome
 *     by snapshotting the repo's open `dead-code`-labelled issues before
 *     and after the scan and diffing them — no JSON parsing.
 *   - **Label-ensure first.** The `dead-code` label is not seeded
 *     anywhere else, so `runTask` ensures it exists before invoking the
 *     scan.
 *   - **Dedup.** The known-open list passed to Claude is built from the
 *     repo's existing open `dead-code` issues — Claude is instructed to
 *     skip any finding whose `BP-…` id is in the list.
 *   - **Weekly cadence.** `cooldownHours: 168` caps the scan to once per
 *     week per repo (enforced by `idle_task_cooldown_gate.ts`).
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
import type { Result } from "../../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME = "dead-code";

const DESCRIPTION =
  "Run the static dead-code & unused-export scan against the target " +
  "repository and file each conservative removal candidate as its own " +
  "issue. Issue-only — never opens a pull request.";

/** Label every filed dead-code finding carries. */
export const DEAD_CODE_LABEL = "dead-code";

/** Static wrapper title — dispatch matches against this string. */
export const DEAD_CODE_ISSUE_TITLE = "Run a dead-code & unused-export scan";

/** Colour for the `dead-code` label (matches the prompt's seed colour). */
export const DEAD_CODE_LABEL_COLOUR = "5319E7";

/** Prompt template directory under `prompts/`. */
const PROMPT_NAME = "dead_code";

/** Once-per-week-per-repo cap (enforced by `idle_task_cooldown_gate.ts`). */
const COOLDOWN_HOURS = 168;

/**
 * Body fingerprint that uniquely identifies a dead-code wrapper. Anchored
 * to a Markdown heading at start-of-line, matching the
 * `test_audit_template` / `supply_chain_readiness_template` convention.
 * The prompt's H1 is `# Dead-Code & Unused-Export Scan (v1)`.
 */
export const DEAD_CODE_BODY_FINGERPRINT = /^#+\s+Dead-Code\b/m;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for {@link createDeadCodeTemplate}.
 *
 * Tests inject stubs for every external interaction (gh CLI, Claude,
 * prompt loader, label-ensure) so they never touch the network or block
 * on Claude.
 */
export interface DeadCodeTemplateDeps {
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
   * Ensure the `dead-code` label exists in the target repo. Defaults to
   * `ensureLabelExists`. Tests inject a stub so the filesystem and
   * network stay untouched.
   */
  ensureLabelFn?: (repo: string) => Promise<Result<void>>;
  /**
   * Dead-code scan runner — invokes Claude with the assembled prompt.
   * Defaults to the production `claude_runner` wrapper. Tests inject a
   * stub that returns success without invoking Claude.
   *
   * Returns `ok: true` when Claude exited cleanly; the caller verifies
   * the outcome by diffing the snapshot. `ok: false` surfaces the
   * structured error in the wrapper close summary.
   */
  runScanFn?: (opts: RunScanOptions) => Promise<Result<true, ScanError>>;
}

/** Inputs to a dead-code Claude run. */
export interface RunScanOptions {
  repo: string;
  workDir: string;
  /** Stable ids already open as `dead-code` issues — skip-list. */
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
 * Substitute the three placeholders defined by `prompts/dead_code/prompt.md`.
 *
 * Empty id lists render as `(none)` — same convention as
 * `assembleTestAuditPrompt` so wrappers read naturally both standalone
 * and inline.
 *
 * Pure — no I/O.
 */
export function assembleDeadCodePrompt(
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
 *     `"Dead-code scan complete. Filed N issues: #A, #B, …"` with the
 *     numbers sorted ascending so the comment is deterministic.
 *
 * Exported so tests can assert on the exact wording.
 */
export function renderDeadCodeSummary(
  newlyFiled: readonly number[] | null,
): string {
  if (newlyFiled === null) return NEWLY_FILED_UNKNOWN_SUMMARY;
  if (newlyFiled.length === 0) return "no findings";
  const sorted = [...newlyFiled].sort((a, b) => a - b);
  const list = sorted.map((n) => `#${n}`).join(", ");
  return `Dead-code scan complete. Filed ${sorted.length} issues: ${list}`;
}

// ---------------------------------------------------------------------------
// Production Claude runner
// ---------------------------------------------------------------------------

/**
 * Default Claude runner. Loads `prompts/dead_code/prompt.md`, substitutes
 * placeholders, and invokes Claude with the same write-tool blocklist as
 * `test_audit_template.defaultRunScan` — the scan is issue-only, so the
 * write tools are blocked outright.
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

  const prompt = assembleDeadCodePrompt(promptResult.value, {
    suppressedIds: opts.suppressedIds,
    knownOpenFindingIds: opts.knownOpenFindingIds,
    openIssueTitles: opts.openIssueTitles,
  });

  const result = await runIdleTaskClaude({
    prompt,
    cwd: opts.workDir,
    phase: "dead_code",
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
      error: { kind: "timeout", message: "Claude dead-code scan timed out" },
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
 * Build the dead-code template using the supplied deps. Default deps wire
 * production behaviour; tests inject stubs.
 */
export function createDeadCodeTemplate(
  deps: DeadCodeTemplateDeps = {},
): IdleTaskTemplate {
  const ghCommandFn = deps.ghCommandFn ?? ((args) => defaultGhCommand(args));
  const dedupAuthors = deps.dedupAuthors ?? {};
  const loadPromptFn = deps.loadPromptFn ??
    ((name, promptsDir) => defaultLoadPrompt(name, promptsDir));
  const ensureLabelFn = deps.ensureLabelFn ??
    ((repo) =>
      defaultEnsureLabelExists(
        repo,
        DEAD_CODE_LABEL,
        DEAD_CODE_LABEL_COLOUR,
        "Dead-code & unused-export finding",
      ));
  const runScanFn = deps.runScanFn ??
    ((opts) => defaultRunScan(opts, loadPromptFn));

  async function buildIssueBody(opts: IdleTaskBodyOptions): Promise<string> {
    // Issue #2077: the wrapper body IS the prompt — fully substituted at
    // file time so a developer reading the issue sees concrete values
    // rather than `{{...}}` placeholders.
    const loaded = await loadPromptFn(PROMPT_NAME, idleTaskPromptsDir(opts));
    if (!loaded.ok) {
      throw new Error(
        `dead-code: failed to load prompt template ${PROMPT_NAME}: ` +
          loaded.error.message,
      );
    }
    const attributionFooter = buildAttributionFooter({
      template: NAME,
      runId: Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown",
    });
    return assembleDeadCodePrompt(loaded.value, {
      suppressedIds: [],
      knownOpenFindingIds: [],
      attributionFooter,
    });
  }

  function buildIssueTitle(_repo: string): string {
    return DEAD_CODE_ISSUE_TITLE;
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
        title: DEAD_CODE_ISSUE_TITLE,
        context: "dead-code wrapper",
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
      // 1. Ensure the `dead-code` label exists before any filing. It is
      //    not seeded anywhere else, so the first run must create it. A
      //    soft failure is non-fatal — the prompt also creates the label
      //    defensively before filing.
      await ensureLabelFn(opts.repo);

      // 2. Snapshot the repo's open dead-code issues before any filing
      //    happens this run.
      const before = await listOpenIssueNumbersByLabel(
        opts.repo,
        DEAD_CODE_LABEL,
        ghCommandFn,
      );

      // 3. Build the known-open list so Claude does not re-emit findings
      //    the repo already tracks.
      const knownOpenFindingIds = await listKnownOpenFindingIds(
        opts.repo,
        DEAD_CODE_LABEL,
        ghCommandFn,
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
          summary: `dead-code failed: ${scanResult.error.kind} — ` +
            scanResult.error.message,
        };
      }

      // 5. Snapshot again and compute the newly-filed set.
      const after = await listOpenIssueNumbersByLabel(
        opts.repo,
        DEAD_CODE_LABEL,
        ghCommandFn,
      );
      const newlyFiled = diffNewlyFiled(before, after);

      return {
        ok: true,
        summary: renderDeadCodeSummary(newlyFiled),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `dead-code threw: ${message}`,
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
    matchesIdleTaskBody: (body) => DEAD_CODE_BODY_FINGERPRINT.test(body),
    skipMilestone: true,
    outputLabel: DEAD_CODE_LABEL,
    requiresStructuredOutput: true,
    cooldownHours: COOLDOWN_HOURS,
  };
}

/** Module-load registration so importing this file wires the template up. */
export const deadCodeTemplate: IdleTaskTemplate = createDeadCodeTemplate();

registerTemplate(deadCodeTemplate);
