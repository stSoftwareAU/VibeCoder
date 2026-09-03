/**
 * Retro idle-task template (Issue #664, template #18).
 *
 * Reads a **finished piece of work** in the target repo — the most recent
 * merged pull request with enough surviving evidence, its issue, its
 * commits, and its review and check feedback — and proposes improvements
 * to the **environment** that run worked in, not to the code it wrote.
 * Five categories fire only on evidence: navigation, automated checks,
 * coding standards, steering-file size, and information access. Tool
 * economy and no-ops are deliberately out of scope — both need the session
 * transcript, which the merged artefacts do not carry.
 *
 * Suggestion-only: the scan files **at most one** issue listing the
 * surviving candidates in severity order, each naming the surface it would
 * change, and alters nothing itself.
 *
 * Modelled on `duplicated_knowledge_template.ts` — single language-agnostic
 * prompt, no bucket, and the same outcome-only Claude contract:
 *
 *   - **Outcome-only Claude contract.** `prompts/retro/prompt.md` instructs
 *     Claude to file the issue directly via `gh issue create`. `runTask`
 *     verifies the outcome by snapshotting the repo's open `retro` issues
 *     before and after the scan and diffing them — no JSON parsing.
 *   - **Label-ensure first.** The `retro` label is not seeded anywhere
 *     else, so `runTask` ensures it before scanning.
 *   - **Dedup.** Both framework lists are fetched repo-wide: the
 *     known-open `BP-` finding ids (one marker per candidate, so a
 *     recurring candidate is skipped rather than re-filed) and every open
 *     issue title, whatever its label.
 *   - **Weekly cadence.** `cooldownHours: 168` caps the retro to once per
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
import type { Result } from "../../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME = "retro";

const DESCRIPTION =
  "Retrospect the most recent finished piece of work in the target " +
  "repository — the merged pull request, its issue, its commits and its " +
  "review feedback — and file one suggestion-only issue listing the " +
  "environment improvements it evidences, most severe first.";

/** Label the filed retro issue carries. */
export const RETRO_LABEL = "retro";

/** Static wrapper title — dispatch matches against this string. */
export const RETRO_ISSUE_TITLE = "Run a retro on a finished run";

/** Colour for the `retro` label (matches the prompt seed). */
export const RETRO_LABEL_COLOUR = "0052CC";

/** Prompt template directory under `prompts/`. */
const PROMPT_NAME = "retro";

/** Once-per-week-per-repo cap (enforced by `idle_task_cooldown_gate.ts`). */
const COOLDOWN_HOURS = 168;

/**
 * Body fingerprint that uniquely identifies a retro wrapper. Anchored to a
 * Markdown heading at start-of-line, matching the sibling-template
 * convention. The prompt's H1 is `# Retro — Environment Improvements From a
 * Finished Run (v1)`; the `Retro` prefix is the load-bearing part, the
 * descriptive tail may evolve.
 */
export const RETRO_BODY_FINGERPRINT = /^#+\s+Retro\b/m;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for {@link createRetroTemplate}.
 *
 * Tests inject stubs for every external interaction (gh CLI, Claude,
 * prompt loader, label-ensure) so they never touch the network or block on
 * Claude.
 */
export interface RetroTemplateDeps {
  /** gh CLI runner used for snapshots, dedup, and the wrapper veto. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Prompt loader — defaults to `loadPrompt`. */
  loadPromptFn?: (name: string) => Promise<Result<string>>;
  /**
   * Ensure the `retro` label exists in the target repo. Defaults to
   * `ensureLabelExists`.
   */
  ensureLabelFn?: (repo: string) => Promise<Result<void>>;
  /**
   * Scan runner — invokes Claude with the assembled prompt. Defaults to
   * the production `claude_runner` wrapper. Returns `ok: true` when Claude
   * exited cleanly; the caller verifies the outcome by diffing the
   * snapshot.
   */
  runScanFn?: (opts: RunScanOptions) => Promise<Result<true, ScanError>>;
}

/** Inputs to a retro Claude run. */
export interface RunScanOptions {
  repo: string;
  workDir: string;
  /** Stable ids already open as issues in this repo — skip-list. */
  knownOpenFindingIds: string[];
  /**
   * Every issue currently open in the repo, whatever its label — the
   * cross-label dedup list.
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
 * Substitute the placeholders defined by `prompts/retro/prompt.md`.
 *
 * Empty inputs render as `(none)` — the same convention as the sibling
 * scan templates, so a wrapper reads naturally both standalone and inline.
 *
 * Pure — no I/O.
 */
export function assembleRetroPrompt(
  template: string,
  opts: {
    suppressedIds: readonly string[];
    knownOpenFindingIds: readonly string[];
    /**
     * Every issue currently open in the target repo, whatever its label —
     * the semantic second line of dedup. An empty list renders the
     * `(none)` sentinel.
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
// gh snapshot helpers
// ---------------------------------------------------------------------------

/**
 * Return true when an open wrapper titled exactly `Run a retro on a
 * finished run` already exists in `repo`. Used to prevent piling new
 * wrappers on top of an un-triaged one. A gh failure is treated as "no
 * open wrapper" so the gate never stalls scanning on a transient hiccup.
 */
async function hasOpenRetroWrapper(
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
      `"${RETRO_ISSUE_TITLE}" in:title`,
      "--json",
      "number,title",
      "--limit",
      "10",
    ]);
  } catch {
    return false;
  }
  for (const item of parseGhJsonArray(raw, "find retro wrapper")) {
    if (item === null || typeof item !== "object") continue;
    const title = (item as { title?: unknown }).title;
    if (typeof title === "string" && title.trim() === RETRO_ISSUE_TITLE) {
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
 *   - No newly-filed issues → `"no candidates"`.
 *   - Otherwise → `"Retro complete. Filed N issue(s): #A, …"` with the
 *     numbers sorted ascending so the comment is deterministic. The retro
 *     files one issue by design, but the diff is reported as it is found
 *     rather than assumed.
 */
export function renderRetroSummary(newlyFiled: readonly number[]): string {
  if (newlyFiled.length === 0) return "no candidates";
  const sorted = [...newlyFiled].sort((a, b) => a - b);
  const list = sorted.map((n) => `#${n}`).join(", ");
  const noun = sorted.length === 1 ? "issue" : "issues";
  return `Retro complete. Filed ${sorted.length} ${noun}: ${list}`;
}

// ---------------------------------------------------------------------------
// Production Claude runner
// ---------------------------------------------------------------------------

/**
 * Default Claude runner. Loads `prompts/retro/vN.md`, substitutes the
 * placeholders, and invokes Claude with the same write-tool blocklist as
 * the sibling scan templates.
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

  const prompt = assembleRetroPrompt(promptResult.value, {
    suppressedIds: opts.suppressedIds,
    knownOpenFindingIds: opts.knownOpenFindingIds,
    openIssueTitles: opts.openIssueTitles,
  });

  const result = await runIdleTaskClaude({
    prompt,
    cwd: opts.workDir,
    phase: "retro",
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
      error: { kind: "timeout", message: "Claude retro scan timed out" },
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
 * Build the retro template using the supplied deps. Default deps wire
 * production behaviour; tests inject stubs.
 */
export function createRetroTemplate(
  deps: RetroTemplateDeps = {},
): IdleTaskTemplate {
  const ghCommandFn = deps.ghCommandFn ?? ((args) => defaultGhCommand(args));
  const loadPromptFn = deps.loadPromptFn ?? ((name) => defaultLoadPrompt(name));
  const ensureLabelFn = deps.ensureLabelFn ??
    ((repo) =>
      defaultEnsureLabelExists(
        repo,
        RETRO_LABEL,
        RETRO_LABEL_COLOUR,
        "Retro candidate — environment improvement from a finished run",
      ));
  const runScanFn = deps.runScanFn ??
    ((opts) => defaultRunScan(opts, loadPromptFn));

  async function buildIssueBody(_opts: IdleTaskBodyOptions): Promise<string> {
    // The wrapper body IS the prompt — fully substituted at file time so a
    // developer reading the issue sees concrete values rather than
    // `{{...}}` placeholders. The repo is not cloned yet, so both dedup
    // lists render as `(none)`; they are rebuilt from live issues at claim
    // time.
    const loaded = await loadPromptFn(PROMPT_NAME);
    if (!loaded.ok) {
      throw new Error(
        `retro: failed to load prompt template ${PROMPT_NAME}: ` +
          loaded.error.message,
      );
    }
    const attributionFooter = buildAttributionFooter({
      template: NAME,
      runId: Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown",
    });
    return assembleRetroPrompt(loaded.value, {
      suppressedIds: [],
      knownOpenFindingIds: [],
      attributionFooter,
    });
  }

  function buildIssueTitle(_repo: string): string {
    return RETRO_ISSUE_TITLE;
  }

  async function shouldFile(
    opts: IdleTaskShouldFileOptions,
  ): Promise<boolean> {
    // Refuse to pile on while a wrapper is still being triaged. The
    // generic backlog gate handles the open-findings count separately via
    // the `outputLabel` declaration below.
    if (await hasOpenRetroWrapper(opts.repo, ghCommandFn)) return false;
    return true;
  }

  async function runTask(opts: IdleTaskRunOptions): Promise<IdleTaskRunResult> {
    try {
      // 1. Ensure the `retro` label exists before any filing. It is not
      //    seeded anywhere else, so the first run must create it. A soft
      //    failure is non-fatal — the prompt also creates the label
      //    defensively before filing.
      await ensureLabelFn(opts.repo);

      // 2. Snapshot the repo's open retro issues before any filing happens
      //    this run.
      const before = await listOpenIssueNumbersByLabel(
        opts.repo,
        RETRO_LABEL,
        ghCommandFn,
      );

      // 3. Build the known-open list so Claude does not re-propose a
      //    candidate the repo already tracks. Repo-wide: each candidate
      //    carries its own `BP-` marker, and a relabelled issue still
      //    counts.
      const knownOpenFindingIds = await listKnownOpenFindingIds(
        opts.repo,
        RETRO_LABEL,
        ghCommandFn,
      );

      // Repo-wide open-issue titles — the semantic second line of dedup,
      // so a candidate already open under another label is not re-filed. A
      // gh failure returns an empty list, which renders `(none)` and
      // leaves the scan running.
      const openIssueTitles = await listAllOpenIssueTitles(
        opts.repo,
        ghCommandFn,
      );

      // 4. Invoke Claude. It files the surviving candidates as one issue
      //    via `gh issue create` directly — no JSON parsing here.
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
          summary: `retro failed: ${scanResult.error.kind} — ` +
            scanResult.error.message,
        };
      }

      // 5. Snapshot again and compute the newly-filed set.
      const after = await listOpenIssueNumbersByLabel(
        opts.repo,
        RETRO_LABEL,
        ghCommandFn,
      );
      const newlyFiled = diffNewlyFiled(before, after);

      return { ok: true, summary: renderRetroSummary(newlyFiled) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: `retro threw: ${message}` };
    }
  }

  return {
    name: NAME,
    description: DESCRIPTION,
    buildIssueTitle,
    buildIssueBody,
    shouldFile,
    runTask,
    matchesIdleTaskBody: (body) => RETRO_BODY_FINGERPRINT.test(body),
    skipMilestone: true,
    outputLabel: RETRO_LABEL,
    requiresStructuredOutput: true,
    cooldownHours: COOLDOWN_HOURS,
  };
}

/** Module-load registration so importing this file wires the template up. */
export const retroTemplate: IdleTaskTemplate = createRetroTemplate();

registerTemplate(retroTemplate);
