/**
 * Duplicated-knowledge idle-task template (Issue #3609, template #17).
 *
 * Finds copy-pasted blocks that encode the **same knowledge** — the same
 * rule, the same sequence — where one call to an existing or extractable
 * helper would serve every copy, and files one issue per surviving
 * finding. Duplication is the measured signature of AI-assisted
 * development, and no other template looks for it: `dead-code` finds code
 * nothing calls, `orphan-deps` finds unused packages, `format-drift`
 * measures formatter drift. A block pasted into three live, called places
 * is invisible to all three.
 *
 * Modelled on `test_audit_template.ts` — single language-agnostic prompt,
 * no bucket, and the same outcome-only Claude contract:
 *
 *   - **Outcome-only Claude contract.** `prompts/duplicated_knowledge/v1.md`
 *     instructs Claude to file findings directly via `gh issue create`.
 *     `runTask` verifies the outcome by snapshotting the repo's open
 *     `duplicated-knowledge` issues before and after the scan and diffing
 *     them — no JSON parsing.
 *   - **Deterministic pre-pass.** `duplicate_block_scanner.ts` supplies
 *     candidate blocks via `{{DUPLICATE_BLOCKS}}`, exactly as
 *     `coverage_gap_scanner.ts` seeds `{{COVERAGE_GAPS}}` for test-audit.
 *     The pre-pass finds duplicated *text*; the prompt decides whether it
 *     is duplicated *knowledge*, and is biased towards silence.
 *   - **Label-ensure first.** The `duplicated-knowledge` label is not
 *     seeded anywhere else, so `runTask` ensures it before scanning.
 *   - **Dedup.** The known-open list is built from the repo's existing
 *     open `duplicated-knowledge` issues; Claude skips any finding whose
 *     `BP-…` id is in the list.
 *   - **Weekly cadence.** `cooldownHours: 168` caps the scan to once per
 *     week per repo (enforced by `idle_task_cooldown_gate.ts`).
 *
 * Registration happens at module load — importing this file is the only
 * thing callers need to do.
 *
 * Australian English used throughout (behaviour, organisation).
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
import { RUN_ID_ENV_VAR } from "../run_id.ts";
import { buildAttributionFooter } from "../idle_task_attribution.ts";
import {
  findDuplicateBlocks,
  renderDuplicateBlocks,
} from "../duplicate_block_scanner.ts";
import type { Result } from "../../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME = "duplicated-knowledge";

const DESCRIPTION =
  "Run the language-agnostic duplicated-knowledge scan against the target " +
  "repository — copy-pasted blocks of five or more lines that encode the " +
  "same rule and should call one existing helper — and file each surviving " +
  "finding as its own issue.";

/** Label every filed duplicated-knowledge finding carries. */
export const DUPLICATED_KNOWLEDGE_LABEL = "duplicated-knowledge";

/** Static wrapper title — dispatch matches against this string. */
export const DUPLICATED_KNOWLEDGE_ISSUE_TITLE =
  "Run a duplicated-knowledge scan";

/** Colour for the `duplicated-knowledge` label (matches the prompt seed). */
export const DUPLICATED_KNOWLEDGE_LABEL_COLOUR = "1D76DB";

/** Prompt template directory under `prompts/`. */
const PROMPT_NAME = "duplicated_knowledge";

/** Once-per-week-per-repo cap (enforced by `idle_task_cooldown_gate.ts`). */
const COOLDOWN_HOURS = 168;

/**
 * Body fingerprint that uniquely identifies a duplicated-knowledge
 * wrapper. Anchored to a Markdown heading at start-of-line, matching the
 * `test_audit_template` convention. The prompt's H1 is
 * `# Duplicated-Knowledge — Copy-Paste Blocks That Should Call a Helper
 * (v1)`; the `Duplicated-Knowledge` prefix is the load-bearing part, the
 * descriptive tail may evolve.
 */
export const DUPLICATED_KNOWLEDGE_BODY_FINGERPRINT =
  /^#+\s+Duplicated-Knowledge\b/m;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for {@link createDuplicatedKnowledgeTemplate}.
 *
 * Tests inject stubs for every external interaction (gh CLI, Claude,
 * prompt loader, label-ensure) so they never touch the network or block
 * on Claude.
 */
export interface DuplicatedKnowledgeTemplateDeps {
  /** gh CLI runner used for snapshots, dedup, and the wrapper veto. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Prompt loader — defaults to `loadPrompt`. */
  loadPromptFn?: (name: string) => Promise<Result<string>>;
  /**
   * Ensure the `duplicated-knowledge` label exists in the target repo.
   * Defaults to `ensureLabelExists`.
   */
  ensureLabelFn?: (repo: string) => Promise<Result<void>>;
  /**
   * Scan runner — invokes Claude with the assembled prompt. Defaults to
   * the production `claude_runner` wrapper. Returns `ok: true` when
   * Claude exited cleanly; the caller verifies the outcome by diffing the
   * snapshot.
   */
  runScanFn?: (opts: RunScanOptions) => Promise<Result<true, ScanError>>;
}

/** Inputs to a duplicated-knowledge Claude run. */
export interface RunScanOptions {
  repo: string;
  workDir: string;
  /** Stable ids already open as `duplicated-knowledge` issues — skip-list. */
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
 * Substitute the placeholders defined by
 * `prompts/duplicated_knowledge/v1.md`.
 *
 * Empty inputs render as `(none)` — the same convention as the sibling
 * scan templates, so a wrapper reads naturally both standalone and inline.
 *
 * Pure — no I/O.
 */
export function assembleDuplicatedKnowledgePrompt(
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
     * Pre-computed candidate blocks, already rendered for the
     * `{{DUPLICATE_BLOCKS}}` placeholder. Defaults to the `(none)`
     * sentinel, which is what the file-time wrapper uses (the repo is not
     * cloned yet, so no pre-pass has run).
     */
    duplicateBlocks?: string;
  },
): string {
  const suppressed = opts.suppressedIds.length > 0
    ? opts.suppressedIds.join("\n")
    : "(none)";
  const known = opts.knownOpenFindingIds.length > 0
    ? opts.knownOpenFindingIds.join("\n")
    : "(none)";
  const openIssues = renderOpenIssueTitles(opts.openIssueTitles ?? []);
  const blocks = opts.duplicateBlocks && opts.duplicateBlocks.length > 0
    ? opts.duplicateBlocks
    : "(none)";
  const footer = opts.attributionFooter ?? "";
  return template
    .replaceAll("{{SUPPRESSED_IDS}}", suppressed)
    .replaceAll("{{KNOWN_OPEN_FINDING_IDS}}", known)
    .replaceAll("{{OPEN_ISSUE_TITLES}}", openIssues)
    .replaceAll("{{DUPLICATE_BLOCKS}}", blocks)
    .replaceAll("{{ATTRIBUTION_FOOTER}}", footer);
}

// ---------------------------------------------------------------------------
// gh snapshot helpers
// ---------------------------------------------------------------------------

/**
 * Return true when an open wrapper titled exactly
 * `Run a duplicated-knowledge scan` already exists in `repo`. Used to
 * prevent piling new wrappers on top of an un-triaged one. A gh failure is
 * treated as "no open wrapper" so the gate never stalls scanning on a
 * transient hiccup.
 */
async function hasOpenDuplicatedKnowledgeWrapper(
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
      `"${DUPLICATED_KNOWLEDGE_ISSUE_TITLE}" in:title`,
      "--json",
      "number,title",
      "--limit",
      "10",
    ]);
  } catch {
    return false;
  }
  for (
    const item of parseGhJsonArray(raw, "find duplicated-knowledge wrapper")
  ) {
    if (item === null || typeof item !== "object") continue;
    const title = (item as { title?: unknown }).title;
    if (
      typeof title === "string" &&
      title.trim() === DUPLICATED_KNOWLEDGE_ISSUE_TITLE
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
 *   - One or more → `"Duplicated-knowledge scan complete. Filed N issues:
 *     #A, #B, …"` with the numbers sorted ascending so the comment is
 *     deterministic.
 */
export function renderDuplicatedKnowledgeSummary(
  newlyFiled: readonly number[],
): string {
  if (newlyFiled.length === 0) return "no findings";
  const sorted = [...newlyFiled].sort((a, b) => a - b);
  const list = sorted.map((n) => `#${n}`).join(", ");
  return `Duplicated-knowledge scan complete. Filed ${sorted.length} issues: ${list}`;
}

// ---------------------------------------------------------------------------
// Production Claude runner
// ---------------------------------------------------------------------------

/**
 * Default Claude runner. Loads `prompts/duplicated_knowledge/v1.md`, runs
 * the deterministic duplicate-block pre-pass over the cloned repo,
 * substitutes the placeholders, and invokes Claude with the same
 * write-tool blocklist as the sibling scan templates.
 *
 * Tests do NOT exercise this path — they inject a `runScanFn` stub.
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

  // Deterministic pre-pass over the cloned repo. Best-effort: any failure
  // yields the `(none)` sentinel and the scan still self-drives on its
  // language-agnostic path. The pre-pass narrows the search; it never
  // stands in for the knowledge-vs-text judgement.
  let duplicateBlocks = "(none)";
  try {
    const blocks = await findDuplicateBlocks({ workDir: opts.workDir });
    duplicateBlocks = renderDuplicateBlocks(blocks);
  } catch {
    // best-effort — leave the (none) sentinel
  }

  const prompt = assembleDuplicatedKnowledgePrompt(promptResult.value, {
    suppressedIds: opts.suppressedIds,
    knownOpenFindingIds: opts.knownOpenFindingIds,
    openIssueTitles: opts.openIssueTitles,
    duplicateBlocks,
  });

  const result = await runIdleTaskClaude({
    prompt,
    cwd: opts.workDir,
    phase: "duplicated_knowledge",
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
        message: "Claude duplicated-knowledge scan timed out",
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
 * Build the duplicated-knowledge template using the supplied deps.
 * Default deps wire production behaviour; tests inject stubs.
 */
export function createDuplicatedKnowledgeTemplate(
  deps: DuplicatedKnowledgeTemplateDeps = {},
): IdleTaskTemplate {
  const ghCommandFn = deps.ghCommandFn ?? ((args) => defaultGhCommand(args));
  const loadPromptFn = deps.loadPromptFn ?? ((name) => defaultLoadPrompt(name));
  const ensureLabelFn = deps.ensureLabelFn ??
    ((repo) =>
      defaultEnsureLabelExists(
        repo,
        DUPLICATED_KNOWLEDGE_LABEL,
        DUPLICATED_KNOWLEDGE_LABEL_COLOUR,
        "Copy-pasted block that should call one existing helper",
      ));
  const runScanFn = deps.runScanFn ??
    ((opts) => defaultRunScan(opts, loadPromptFn));

  async function buildIssueBody(_opts: IdleTaskBodyOptions): Promise<string> {
    // Issue #2077: the wrapper body IS the prompt — fully substituted at
    // file time so a developer reading the issue sees concrete values
    // rather than `{{...}}` placeholders. The repo is not cloned yet, so
    // the pre-pass list renders as `(none)`.
    const loaded = await loadPromptFn(PROMPT_NAME);
    if (!loaded.ok) {
      throw new Error(
        `duplicated-knowledge: failed to load prompt template ${PROMPT_NAME}: ` +
          loaded.error.message,
      );
    }
    const attributionFooter = buildAttributionFooter({
      template: NAME,
      runId: Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown",
    });
    return assembleDuplicatedKnowledgePrompt(loaded.value, {
      suppressedIds: [],
      knownOpenFindingIds: [],
      attributionFooter,
    });
  }

  function buildIssueTitle(_repo: string): string {
    return DUPLICATED_KNOWLEDGE_ISSUE_TITLE;
  }

  async function shouldFile(
    opts: IdleTaskShouldFileOptions,
  ): Promise<boolean> {
    // Refuse to pile on while a wrapper is still being triaged. The
    // generic backlog gate handles the open-findings count separately via
    // the `outputLabel` declaration below.
    if (await hasOpenDuplicatedKnowledgeWrapper(opts.repo, ghCommandFn)) {
      return false;
    }
    return true;
  }

  async function runTask(opts: IdleTaskRunOptions): Promise<IdleTaskRunResult> {
    try {
      // 1. Ensure the `duplicated-knowledge` label exists before any
      //    filing. It is not seeded anywhere else, so the first run must
      //    create it. A soft failure is non-fatal — the prompt also
      //    creates the label defensively before filing.
      await ensureLabelFn(opts.repo);

      // 2. Snapshot the repo's open duplicated-knowledge issues before any
      //    filing happens this run.
      const before = await listOpenIssueNumbersByLabel(
        opts.repo,
        DUPLICATED_KNOWLEDGE_LABEL,
        ghCommandFn,
      );

      // 3. Build the known-open list so Claude does not re-emit findings
      //    the repo already tracks.
      const knownOpenFindingIds = await listKnownOpenFindingIds(
        opts.repo,
        DUPLICATED_KNOWLEDGE_LABEL,
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
          summary: `duplicated-knowledge failed: ${scanResult.error.kind} — ` +
            scanResult.error.message,
        };
      }

      // 5. Snapshot again and compute the newly-filed set.
      const after = await listOpenIssueNumbersByLabel(
        opts.repo,
        DUPLICATED_KNOWLEDGE_LABEL,
        ghCommandFn,
      );
      const newlyFiled = diffNewlyFiled(before, after);

      return {
        ok: true,
        summary: renderDuplicatedKnowledgeSummary(newlyFiled),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `duplicated-knowledge threw: ${message}`,
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
      DUPLICATED_KNOWLEDGE_BODY_FINGERPRINT.test(body),
    skipMilestone: true,
    outputLabel: DUPLICATED_KNOWLEDGE_LABEL,
    requiresStructuredOutput: true,
    cooldownHours: COOLDOWN_HOURS,
  };
}

/** Module-load registration so importing this file wires the template up. */
export const duplicatedKnowledgeTemplate: IdleTaskTemplate =
  createDuplicatedKnowledgeTemplate();

registerTemplate(duplicatedKnowledgeTemplate);
