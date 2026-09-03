/**
 * Supply-chain readiness idle-task template (Issue #2398, parent #2396,
 * template #5).
 *
 * Runs the static, evidence-backed supply-chain readiness audit against
 * the target repository and files one finding issue per surviving
 * recommendation. Modelled on `test_audit_template.ts` — single prompt,
 * language-agnostic, no bucket — with the same outcome-only Claude
 * contract:
 *
 *   - **Outcome-only Claude contract.** The orchestrating prompt at
 *     `prompts/supply_chain_readiness/prompt.md` instructs Claude to file
 *     findings directly via `gh issue create`. `runTask` verifies the
 *     outcome by snapshotting the repo's open
 *     `supply-chain-readiness`-labelled issues before and after the
 *     scan and diffing them — no JSON parsing.
 *   - **Label-ensure first.** The `supply-chain-readiness` label is
 *     not seeded anywhere else, so `runTask` ensures it exists before
 *     invoking the scan.
 *   - **Dedup.** The known-open list passed to Claude is built from
 *     the repo's existing open `supply-chain-readiness` issues —
 *     Claude is instructed to skip any finding whose `BP-…` id is in
 *     the list.
 *   - **Weekly cadence.** `cooldownHours: 168` caps the scan to once
 *     per week per repo (enforced by `idle_task_cooldown_gate.ts`).
 *
 * Registration happens at module load — importing this file is the
 * only thing callers need to do.
 *
 * Australian English spelling used throughout (behaviour,
 * organisation, authorised).
 */

import {
  type IdleTaskBodyOptions,
  type IdleTaskRunOptions,
  type IdleTaskRunResult,
  type IdleTaskShouldFileOptions,
  type IdleTaskTemplate,
  registerTemplate,
} from "../idle_task_template.ts";
import { runGhCommand as defaultGhCommand } from "../github.ts";
import { loadPrompt as defaultLoadPrompt } from "../prompt_manager.ts";
import {
  diffNewlyFiled,
  listAllOpenIssueTitles,
  listKnownOpenFindingIds,
  listOpenIssueNumbersByLabel,
  type OpenIssueTitle,
  parseGhJsonArray,
  renderOpenIssueTitles,
} from "../idle_task_snapshot.ts";
import { ensureLabelExists as defaultEnsureLabelExists } from "../label_operations.ts";
import { runIdleTaskClaude } from "../idle_task_claude_budget.ts";
import type { IdleTaskClaudeRunner } from "../idle_task_claude_budget.ts";
import type { ModelTier } from "../token_usage.ts";
import type { Result } from "../../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME = "supply-chain-readiness";

const DESCRIPTION =
  "Run the static, evidence-backed supply-chain readiness audit against " +
  "the target repository and file each surviving recommendation as its " +
  "own issue.";

/** Label every filed supply-chain-readiness finding carries. */
export const SUPPLY_CHAIN_READINESS_LABEL = "supply-chain-readiness";

/** Static wrapper title — dispatch matches against this string. */
export const SUPPLY_CHAIN_READINESS_ISSUE_TITLE =
  "Run a supply-chain readiness scan";

/** Colour for the `supply-chain-readiness` label (matches the prompt seed). */
export const SUPPLY_CHAIN_READINESS_LABEL_COLOUR = "5319E7";

/** Prompt template directory under `prompts/`. */
const PROMPT_NAME = "supply_chain_readiness";

/** Once-per-week-per-repo cap (enforced by `idle_task_cooldown_gate.ts`). */
const COOLDOWN_HOURS = 168;

/**
 * Body fingerprint that uniquely identifies a supply-chain-readiness
 * wrapper. Anchored to a Markdown heading at start-of-line, matching
 * the `security_scan_template` / `test_audit_template` convention.
 * The prompt's H1 is
 * `# Supply-chain readiness — Repo Posture Audit (v1)`.
 */
export const SUPPLY_CHAIN_READINESS_BODY_FINGERPRINT =
  /^#+\s+Supply-chain readiness\b/m;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for {@link createSupplyChainReadinessTemplate}.
 *
 * Tests inject stubs for every external interaction (gh CLI, Claude,
 * prompt loader, label-ensure) so they never touch the network or
 * block on Claude.
 */
export interface SupplyChainReadinessTemplateDeps {
  /** gh CLI runner used for snapshots, dedup, and the wrapper veto. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Prompt loader — defaults to `loadPrompt`. */
  loadPromptFn?: (name: string) => Promise<Result<string>>;
  /**
   * Ensure the `supply-chain-readiness` label exists in the target
   * repo. Defaults to `ensureLabelExists`. Tests inject a stub so the
   * filesystem and network stay untouched.
   */
  ensureLabelFn?: (repo: string) => Promise<Result<void>>;
  /**
   * Supply-chain readiness scan runner — invokes Claude with the
   * assembled prompt. Defaults to the production `claude_runner`
   * wrapper. Tests inject a stub that returns success without
   * invoking Claude.
   *
   * Returns `ok: true` when Claude exited cleanly; the caller verifies
   * the outcome by diffing the snapshot. `ok: false` surfaces the
   * structured error in the wrapper close summary.
   */
  runScanFn?: (opts: RunScanOptions) => Promise<Result<true, ScanError>>;
}

/** Inputs to a supply-chain readiness Claude run. */
export interface RunScanOptions {
  repo: string;
  workDir: string;
  /** Stable ids already open as `supply-chain-readiness` issues. */
  knownOpenFindingIds: string[];
  /**
   * Every issue currently open in the repo, whatever its label — the
   * cross-label dedup list (Issue #537).
   */
  openIssueTitles: OpenIssueTitle[];
  /** Stable ids the run should suppress (in-source markers, prior triage). */
  suppressedIds: string[];
  /**
   * Model tier the wrapper was filed for (Issue #4010). Passed through as
   * `RunClaudeOptions.model`; omitted leaves the phase default in force.
   */
  model?: ModelTier;
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
 * Substitute the two placeholders defined by
 * `prompts/supply_chain_readiness/prompt.md`.
 *
 * Empty id lists render as `(none)` — same convention as
 * `assembleTestAuditPrompt` so wrappers read naturally both
 * standalone and inline.
 *
 * Pure — no I/O.
 */
export function assembleSupplyChainReadinessPrompt(
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
  },
): string {
  const suppressed = opts.suppressedIds.length > 0
    ? opts.suppressedIds.join("\n")
    : "(none)";
  const known = opts.knownOpenFindingIds.length > 0
    ? opts.knownOpenFindingIds.join("\n")
    : "(none)";
  const openIssues = renderOpenIssueTitles(opts.openIssueTitles ?? []);
  return template
    .replaceAll("{{SUPPRESSED_IDS}}", suppressed)
    .replaceAll("{{KNOWN_OPEN_FINDING_IDS}}", known)
    .replaceAll("{{OPEN_ISSUE_TITLES}}", openIssues);
}

// ---------------------------------------------------------------------------
// gh snapshot helpers
// ---------------------------------------------------------------------------

/**
 * Return true when an open wrapper titled exactly
 * `Run a supply-chain readiness scan` already exists in `repo`. Used
 * to prevent piling new wrappers on top of an un-triaged one. A gh
 * failure is treated as "no open wrapper" so the gate never stalls
 * scanning on a transient hiccup.
 */
async function hasOpenSupplyChainReadinessWrapper(
  repo: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await ghCommandFn([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      `"${SUPPLY_CHAIN_READINESS_ISSUE_TITLE}" in:title`,
      "--json",
      "number,title",
      "--limit",
      "10",
    ]);
  } catch {
    return false;
  }
  for (
    const item of parseGhJsonArray(raw, "find supply-chain-readiness wrapper")
  ) {
    if (item === null || typeof item !== "object") continue;
    const title = (item as { title?: unknown }).title;
    if (
      typeof title === "string" &&
      title.trim() === SUPPLY_CHAIN_READINESS_ISSUE_TITLE
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

/**
 * Render the close-comment summary for the wrapper idle-task issue.
 *
 *   - No newly-filed issues → `"no findings"`.
 *   - One or more newly-filed issues →
 *     `"Supply-chain readiness scan complete. Filed N issues: #A, #B, …"`
 *     with the numbers sorted ascending so the comment is
 *     deterministic.
 *
 * Exported so tests can assert on the exact wording.
 */
export function renderSupplyChainReadinessSummary(
  newlyFiled: readonly number[],
): string {
  if (newlyFiled.length === 0) return "no findings";
  const sorted = [...newlyFiled].sort((a, b) => a - b);
  const list = sorted.map((n) => `#${n}`).join(", ");
  return `Supply-chain readiness scan complete. Filed ${sorted.length} issues: ${list}`;
}

// ---------------------------------------------------------------------------
// Production Claude runner
// ---------------------------------------------------------------------------

/**
 * Default Claude runner. Loads `prompts/supply_chain_readiness/prompt.md`,
 * substitutes placeholders, and invokes Claude with the same
 * write-tool blocklist as `test_audit_template.defaultRunScan`.
 *
 * The template injects a `runScanFn` stub in most tests; `runClaudeFn` is
 * injectable so the tier-threading path (Issue #4010) is covered here too.
 */
export async function runSupplyChainReadinessScan(
  opts: RunScanOptions,
  loadPromptFn: (name: string) => Promise<Result<string>>,
  runClaudeFn?: IdleTaskClaudeRunner,
): Promise<Result<true, ScanError>> {
  const promptResult = await loadPromptFn(PROMPT_NAME);
  if (!promptResult.ok) {
    return {
      ok: false,
      error: { kind: "prompt", message: promptResult.error.message },
    };
  }

  const prompt = assembleSupplyChainReadinessPrompt(promptResult.value, {
    suppressedIds: opts.suppressedIds,
    knownOpenFindingIds: opts.knownOpenFindingIds,
    openIssueTitles: opts.openIssueTitles,
  });

  // Always via `runIdleTaskClaude` so the idle-task budget (#3657) is applied;
  // only the underlying runner is injectable, and only for tests.
  const result = await runIdleTaskClaude(
    {
      prompt,
      cwd: opts.workDir,
      phase: "supply_chain_readiness",
      disallowedTools: [
        "Write",
        "Edit",
        "MultiEdit",
        "NotebookEdit",
        "EnterPlanMode",
        "ExitPlanMode",
      ],
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    },
    undefined,
    runClaudeFn,
  );
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
        message: "Claude supply-chain readiness scan timed out",
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
 * Build the supply-chain readiness template using the supplied deps.
 * Default deps wire production behaviour; tests inject stubs.
 */
export function createSupplyChainReadinessTemplate(
  deps: SupplyChainReadinessTemplateDeps = {},
): IdleTaskTemplate {
  const ghCommandFn = deps.ghCommandFn ?? ((args) => defaultGhCommand(args));
  const loadPromptFn = deps.loadPromptFn ?? ((name) => defaultLoadPrompt(name));
  const ensureLabelFn = deps.ensureLabelFn ??
    ((repo) =>
      defaultEnsureLabelExists(
        repo,
        SUPPLY_CHAIN_READINESS_LABEL,
        SUPPLY_CHAIN_READINESS_LABEL_COLOUR,
        "Supply-chain readiness finding",
      ));
  const runScanFn = deps.runScanFn ??
    ((opts) => runSupplyChainReadinessScan(opts, loadPromptFn));

  async function buildIssueBody(_opts: IdleTaskBodyOptions): Promise<string> {
    // Issue #2077: the wrapper body IS the prompt — fully substituted
    // at file time so a developer reading the issue sees concrete
    // values rather than `{{...}}` placeholders.
    const loaded = await loadPromptFn(PROMPT_NAME);
    if (!loaded.ok) {
      throw new Error(
        `supply-chain-readiness: failed to load prompt template ${PROMPT_NAME}: ` +
          loaded.error.message,
      );
    }
    return assembleSupplyChainReadinessPrompt(loaded.value, {
      suppressedIds: [],
      knownOpenFindingIds: [],
    });
  }

  function buildIssueTitle(_repo: string): string {
    return SUPPLY_CHAIN_READINESS_ISSUE_TITLE;
  }

  async function shouldFile(
    opts: IdleTaskShouldFileOptions,
  ): Promise<boolean> {
    // Refuse to pile on while a wrapper is still being triaged. The
    // generic backlog gate handles open-findings count separately via
    // the `outputLabel` declaration below.
    if (await hasOpenSupplyChainReadinessWrapper(opts.repo, ghCommandFn)) {
      return false;
    }
    return true;
  }

  async function runTask(opts: IdleTaskRunOptions): Promise<IdleTaskRunResult> {
    try {
      // 1. Ensure the `supply-chain-readiness` label exists before any
      //    filing. It is not seeded anywhere else, so the first run
      //    must create it. A soft failure is non-fatal — the prompt
      //    also creates the label defensively before filing.
      await ensureLabelFn(opts.repo);

      // 2. Snapshot the repo's open supply-chain-readiness issues
      //    before any filing happens this run.
      const before = await listOpenIssueNumbersByLabel(
        opts.repo,
        SUPPLY_CHAIN_READINESS_LABEL,
        ghCommandFn,
      );

      // 3. Build the known-open list so Claude does not re-emit
      //    findings the repo already tracks.
      const knownOpenFindingIds = await listKnownOpenFindingIds(
        opts.repo,
        SUPPLY_CHAIN_READINESS_LABEL,
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
      //    Issue #4010: honour the tier the wrapper was filed for; an
      //    unstamped wrapper leaves the phase default in force.
      const scanResult = await runScanFn({
        repo: opts.repo,
        workDir: opts.workDir,
        knownOpenFindingIds,
        openIssueTitles,
        suppressedIds: [],
        ...(opts.modelTier !== undefined ? { model: opts.modelTier } : {}),
      });
      if (!scanResult.ok) {
        return {
          ok: false,
          summary:
            `supply-chain-readiness failed: ${scanResult.error.kind} — ` +
            scanResult.error.message,
        };
      }

      // 5. Snapshot again and compute the newly-filed set.
      const after = await listOpenIssueNumbersByLabel(
        opts.repo,
        SUPPLY_CHAIN_READINESS_LABEL,
        ghCommandFn,
      );
      const newlyFiled = diffNewlyFiled(before, after);

      return {
        ok: true,
        summary: renderSupplyChainReadinessSummary(newlyFiled),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `supply-chain-readiness threw: ${message}`,
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
      SUPPLY_CHAIN_READINESS_BODY_FINGERPRINT.test(body),
    skipMilestone: true,
    outputLabel: SUPPLY_CHAIN_READINESS_LABEL,
    requiresStructuredOutput: true,
    cooldownHours: COOLDOWN_HOURS,
  };
}

/** Module-load registration so importing this file wires the template up. */
export const supplyChainReadinessTemplate: IdleTaskTemplate =
  createSupplyChainReadinessTemplate();

registerTemplate(supplyChainReadinessTemplate);
