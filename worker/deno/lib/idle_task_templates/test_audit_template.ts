/**
 * Test-audit idle-task template (Issue #2251, parent #2214, template #3).
 *
 * Runs the static test-suite maintainability and coverage-gap audit
 * (behaviour-based vs implementation-coupled — the informal WHAT/HOW
 * heuristic) against the target repository
 * and files one finding issue per surviving violation. Modelled on
 * `security_scan_template.ts` — single prompt, language-agnostic, no
 * bucket — with the same outcome-only Claude contract as
 * `best_practices_template.ts`:
 *
 *   - **Outcome-only Claude contract.** The orchestrating prompt at
 *     `prompts/test_audit/prompt.md` instructs Claude to file findings
 *     directly via `gh issue create`. `runTask` verifies the outcome by
 *     snapshotting the repo's open `test-audit`-labelled issues before
 *     and after the scan and diffing them — no JSON parsing.
 *   - **Label-ensure first.** Unlike `security`/`best-practices`, the
 *     `test-audit` label is not seeded anywhere else, so `runTask`
 *     ensures it exists before invoking the scan.
 *   - **Dedup.** The known-open list passed to Claude is built from the
 *     repo's existing open `test-audit` issues — Claude is instructed
 *     to skip any finding whose `BP-…` id is in the list.
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
  type OpenIssueTitle,
  renderOpenIssueTitles,
} from "../idle_task_snapshot.ts";
import { ensureLabelExists as defaultEnsureLabelExists } from "../label_operations.ts";
import { runIdleTaskClaude } from "../idle_task_claude_budget.ts";
import { RUN_ID_ENV_VAR } from "../run_id.ts";
import { buildAttributionFooter } from "../idle_task_attribution.ts";
import {
  findCoverageGaps,
  renderCoverageGaps,
} from "../coverage_gap_scanner.ts";
import type { Result } from "../../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME = "test-audit";

const DESCRIPTION =
  "Run the language-agnostic static test-suite maintainability and " +
  "coverage-gap audit (the informal WHAT/HOW behaviour-vs-implementation " +
  "heuristic) against the target repository and file each surviving " +
  "finding as its own issue.";

/** Label every filed test-audit finding carries. */
export const TEST_AUDIT_LABEL = "test-audit";

/** Static wrapper title — dispatch matches against this string. */
export const TEST_AUDIT_ISSUE_TITLE = "Run a test-audit scan";

/** Colour for the `test-audit` label (matches the prompt's seed colour). */
export const TEST_AUDIT_LABEL_COLOUR = "B60205";

/** Prompt template directory under `prompts/`. */
const PROMPT_NAME = "test_audit";

/** Once-per-week-per-repo cap (enforced by `idle_task_cooldown_gate.ts`). */
const COOLDOWN_HOURS = 168;

/**
 * Body fingerprint that uniquely identifies a test-audit wrapper.
 * Anchored to a Markdown heading at start-of-line, matching the
 * `security_scan_template` / `best_practices_template` convention. The
 * prompt's H1 is `# Test-Audit — Static Test-Suite Maintainability and
 * Coverage-Gap Audit (v7)`. The `Test-Audit` prefix is the load-bearing
 * fingerprint; the descriptive name and version suffix following the
 * em-dash may evolve.
 */
export const TEST_AUDIT_BODY_FINGERPRINT = /^#+\s+Test-Audit\b/m;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for {@link createTestAuditTemplate}.
 *
 * Tests inject stubs for every external interaction (gh CLI, Claude,
 * prompt loader, label-ensure) so they never touch the network or block
 * on Claude.
 */
export interface TestAuditTemplateDeps {
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
   * Ensure the `test-audit` label exists in the target repo. Defaults
   * to `ensureLabelExists`. Tests inject a stub so the filesystem and
   * network stay untouched.
   */
  ensureLabelFn?: (repo: string) => Promise<Result<void>>;
  /**
   * Test-audit scan runner — invokes Claude with the assembled prompt.
   * Defaults to the production `claude_runner` wrapper. Tests inject a
   * stub that returns success without invoking Claude.
   *
   * Returns `ok: true` when Claude exited cleanly; the caller verifies
   * the outcome by diffing the snapshot. `ok: false` surfaces the
   * structured error in the wrapper close summary.
   */
  runScanFn?: (opts: RunScanOptions) => Promise<Result<true, ScanError>>;
}

/** Inputs to a test-audit Claude run. */
export interface RunScanOptions {
  repo: string;
  workDir: string;
  /** Stable ids already open as `test-audit` issues — skip-list. */
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
 * Substitute the two placeholders defined by `prompts/test_audit/prompt.md`.
 *
 * Empty id lists render as `(none)` — same convention as
 * `buildSecurityScanPrompt` so wrappers read naturally both standalone
 * and inline.
 *
 * Pure — no I/O.
 */
export function assembleTestAuditPrompt(
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
    /**
     * Pre-computed coverage gaps (Issue #2916) — already rendered for
     * the `{{COVERAGE_GAPS}}` placeholder. Defaults to the `(none)`
     * sentinel, which is what the file-time wrapper uses (the repo is
     * not cloned yet, so no pre-pass has run).
     */
    coverageGaps?: string;
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
  const coverageGaps = opts.coverageGaps && opts.coverageGaps.length > 0
    ? opts.coverageGaps
    : "(none)";
  return template
    .replaceAll("{{SUPPRESSED_IDS}}", suppressed)
    .replaceAll("{{KNOWN_OPEN_FINDING_IDS}}", known)
    .replaceAll("{{OPEN_ISSUE_TITLES}}", openIssues)
    .replaceAll("{{COVERAGE_GAPS}}", coverageGaps)
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
 *     `"Test-audit scan complete. Filed N issues: #A, #B, …"` with the
 *     numbers sorted ascending so the comment is deterministic.
 *
 * Exported so tests can assert on the exact wording.
 */
export function renderTestAuditSummary(newlyFiled: readonly number[]): string {
  if (newlyFiled.length === 0) return "no findings";
  const sorted = [...newlyFiled].sort((a, b) => a - b);
  const list = sorted.map((n) => `#${n}`).join(", ");
  return `Test-audit scan complete. Filed ${sorted.length} issues: ${list}`;
}

// ---------------------------------------------------------------------------
// Production Claude runner
// ---------------------------------------------------------------------------

/**
 * Default Claude runner. Loads `prompts/test_audit/prompt.md`, substitutes
 * placeholders, and invokes Claude with the same write-tool blocklist as
 * `best_practices_template.defaultRunScan`.
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

  // Issue #2916: run the deterministic coverage-gap pre-pass over the
  // cloned repo's Deno/TypeScript surface and hand the result to Claude
  // as a verified starting point for check 7. Best-effort — any failure
  // yields the `(none)` sentinel and the scan still self-drives on its
  // language-agnostic path.
  let coverageGaps = "(none)";
  try {
    const gaps = await findCoverageGaps({ workDir: opts.workDir });
    coverageGaps = renderCoverageGaps(gaps);
  } catch {
    // best-effort — leave the (none) sentinel
  }

  const prompt = assembleTestAuditPrompt(promptResult.value, {
    suppressedIds: opts.suppressedIds,
    knownOpenFindingIds: opts.knownOpenFindingIds,
    openIssueTitles: opts.openIssueTitles,
    coverageGaps,
  });

  const result = await runIdleTaskClaude({
    prompt,
    cwd: opts.workDir,
    phase: "test_audit",
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
      error: { kind: "timeout", message: "Claude test-audit scan timed out" },
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
 * Build the test-audit template using the supplied deps. Default deps
 * wire production behaviour; tests inject stubs.
 */
export function createTestAuditTemplate(
  deps: TestAuditTemplateDeps = {},
): IdleTaskTemplate {
  const ghCommandFn = deps.ghCommandFn ?? ((args) => defaultGhCommand(args));
  const dedupAuthors = deps.dedupAuthors ?? {};
  const loadPromptFn = deps.loadPromptFn ??
    ((name, promptsDir) => defaultLoadPrompt(name, promptsDir));
  const ensureLabelFn = deps.ensureLabelFn ??
    ((repo) =>
      defaultEnsureLabelExists(
        repo,
        TEST_AUDIT_LABEL,
        TEST_AUDIT_LABEL_COLOUR,
        "Static test-suite maintainability and coverage-gap audit finding",
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
        `test-audit: failed to load prompt template ${PROMPT_NAME}: ` +
          loaded.error.message,
      );
    }
    const attributionFooter = buildAttributionFooter({
      template: NAME,
      runId: Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown",
    });
    return assembleTestAuditPrompt(loaded.value, {
      suppressedIds: [],
      knownOpenFindingIds: [],
      attributionFooter,
    });
  }

  function buildIssueTitle(_repo: string): string {
    return TEST_AUDIT_ISSUE_TITLE;
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
        title: TEST_AUDIT_ISSUE_TITLE,
        context: "test-audit wrapper",
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
      // 1. Ensure the `test-audit` label exists before any filing. It is
      //    not seeded anywhere else, so the first run must create it.
      //    A soft failure is non-fatal — the prompt also creates the
      //    label defensively before filing.
      await ensureLabelFn(opts.repo);

      // 2. Snapshot the repo's open test-audit issues before any filing
      //    happens this run.
      const before = await listOpenIssueNumbersByLabel(
        opts.repo,
        TEST_AUDIT_LABEL,
        ghCommandFn,
      );

      // 3. Build the known-open list so Claude does not re-emit findings
      //    the repo already tracks.
      const knownOpenFindingIds = await listKnownOpenFindingIds(
        opts.repo,
        TEST_AUDIT_LABEL,
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
          summary: `test-audit failed: ${scanResult.error.kind} — ` +
            scanResult.error.message,
        };
      }

      // 5. Snapshot again and compute the newly-filed set.
      const after = await listOpenIssueNumbersByLabel(
        opts.repo,
        TEST_AUDIT_LABEL,
        ghCommandFn,
      );
      const newlyFiled = diffNewlyFiled(before, after);

      return {
        ok: true,
        summary: renderTestAuditSummary(newlyFiled),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `test-audit threw: ${message}`,
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
    matchesIdleTaskBody: (body) => TEST_AUDIT_BODY_FINGERPRINT.test(body),
    skipMilestone: true,
    outputLabel: TEST_AUDIT_LABEL,
    requiresStructuredOutput: true,
    cooldownHours: COOLDOWN_HOURS,
  };
}

/** Module-load registration so importing this file wires the template up. */
export const testAuditTemplate: IdleTaskTemplate = createTestAuditTemplate();

registerTemplate(testAuditTemplate);
