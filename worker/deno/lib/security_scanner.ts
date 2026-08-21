/**
 * Four-phase security scan executor (Issues #1940, #2097).
 *
 * Drives Claude through the MythOS-style four-phase audit defined in
 * `prompts/security_scan/vN.md`. As of v5 (Issue #2097) the contract is
 * **outcome-only**: Claude files one GitHub issue per surviving finding
 * via `gh issue create` and emits no JSON block and no Markdown summary.
 * The executor verifies success by diffing the repo's open
 * `security`-labelled issues before and after the run — that snapshot
 * diff lives in `idle_task_templates/security_scan_template.ts`.
 *
 * Responsibilities (in order):
 *   1. Load the latest `security_scan` prompt template via the existing
 *      prompt-version resolver.
 *   2. Substitute the placeholders documented in the template
 *      (`{{SUPPRESSED_IDS}}`, `{{KNOWN_OPEN_FINDING_IDS}}`,
 *      `{{ATTRIBUTION_FOOTER}}`, and `{{LLM_GATE}}`). The repo name was
 *      dropped in v6 (Issue #2135) and the language-hint placeholder was
 *      dropped in v8 (Issue #2159) — both are now derived by Claude at
 *      scan time from the working directory. The `{{LLM_GATE}}` block
 *      (v18, Issue #3014) carries the worker's deterministic LLM-usage
 *      verdict that gates the OWASP GenAI / LLM Top 10 taxonomy.
 *   3. Invoke Claude through `runClaudeWithRetry` with the standard
 *      timeout/rate-limit handling. Write/Edit/MultiEdit/NotebookEdit and
 *      plan-mode tools are explicitly disallowed; Bash remains allowed so
 *      Claude can call `gh issue create` to file findings.
 *
 * Non-responsibilities:
 *   - Does NOT parse JSON. The v5 prompt forbids a JSON block.
 *   - Does NOT file GitHub issues — Claude itself does that via `gh`.
 *   - Does NOT compute the diff of newly-filed issues — that is the
 *     template's job (`idle_task_templates/security_scan_template.ts`).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Result } from "../types.ts";
import {
  type ClaudeRunResult,
  type RetryOptions,
  type RunClaudeOptions,
  runClaudeWithRetry,
} from "./claude_runner.ts";
import { runIdleTaskClaude } from "./idle_task_claude_budget.ts";
import { loadPrompt } from "./prompt_manager.ts";
import { buildAttributionFooter } from "./idle_task_attribution.ts";
import { getRunId } from "./run_id.ts";
import {
  detectLlmUsageForRepo,
  type LlmUsageVerdict,
} from "./llm_usage_detection.ts";
import type { ModelTier } from "./token_usage.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options accepted by `runSecurityScan`. */
export interface ScanOptions {
  /** `owner/repo` of the repository being scanned. */
  repo: string;
  /** Working directory passed through to the Claude runner as `cwd`. */
  workDir: string;
  /** Stable IDs of findings with an existing open GitHub issue. */
  knownOpenFindingIds: string[];
  /** Stable IDs that have been suppressed via prior triage or in-source. */
  suppressedIds: string[];
  /**
   * Hard timeout (seconds) for the Claude scan. Falls back to the shared
   * idle-task budget (`IDLE_TASK_TIMEOUT_SECONDS`, 1h) when omitted — never
   * to the 4h `runClaudeWithTimeout` library default (Issue #3657).
   */
  timeoutSeconds?: number;
  /**
   * Silence watchdog (seconds) for the Claude scan. Falls back to
   * `IDLE_TASK_NO_OUTPUT_TIMEOUT_SECONDS` (10 min) when omitted, so a wedged
   * scan that emits nothing is killed promptly (Issue #3657).
   */
  noOutputTimeout?: number;
  /**
   * Model tier the wrapper was filed for (Issue #4010). Passed straight
   * through as `RunClaudeOptions.model`, so the scan runs on the tier the
   * cadence bias intended and the run-stats cost is attributed to it. Omitted
   * — the case for every unstamped wrapper — leaves `model` unset and the
   * phase default applies exactly as before.
   */
  model?: ModelTier;
}

/** Discriminator for the failure modes of `runSecurityScan`. */
export type ScanErrorKind = "prompt" | "claude" | "timeout";

/** Structured error returned when the scan cannot complete. */
export interface ScanError {
  kind: ScanErrorKind;
  message: string;
  /** Whatever raw output Claude managed to emit before failing. */
  partialOutput?: string;
}

/** Successful scan outcome. */
export interface ScanOk {
  ok: true;
}

/** Injectable dependencies for testing. */
export interface ScannerDeps {
  /** Load a prompt template by name (defaults to the latest version). */
  loadPromptFn: (name: string) => Promise<Result<string>>;
  /** Run Claude with retry/timeout handling. */
  runClaudeFn: (
    opts: RunClaudeOptions,
    retry?: RetryOptions,
  ) => Promise<Result<ClaudeRunResult>>;
  /**
   * Decide whether the scanned repo is LLM-using, applying the always-on
   * allowlist floor. Injectable so unit tests can drive the gate without
   * walking a real clone. Defaults to {@link detectLlmUsageForRepo}.
   */
  detectLlmUsageFn?: (
    repo: string,
    repoRoot: string,
  ) => Promise<LlmUsageVerdict>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Tools the security-scan Claude session must NEVER call.
 *
 * The audit is strictly read-only with respect to the codebase — any
 * Write/Edit/NotebookEdit invocation would violate the hard constraints
 * in the prompt. Bash remains allowed so Claude can call `gh issue
 * create` to file findings (Issue #2097). Plan mode is disabled to
 * match the rest of the worker.
 *
 * Exported so tests can assert the runner was invoked with this exact
 * set, and so downstream callers can extend it consistently.
 */
export const SECURITY_SCAN_DISALLOWED_TOOLS: readonly string[] = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "EnterPlanMode",
  "ExitPlanMode",
];

/** Name of the prompt template directory under `prompts/`. */
const PROMPT_NAME = "security_scan";

// ---------------------------------------------------------------------------
// Default deps
// ---------------------------------------------------------------------------

/** Production dependencies wired to the real prompt loader and runner. */
export function createDefaultDeps(): ScannerDeps {
  return {
    loadPromptFn: (name) => loadPrompt(name),
    runClaudeFn: (opts, retry) => runClaudeWithRetry(opts, retry),
    detectLlmUsageFn: (repo, repoRoot) => detectLlmUsageForRepo(repo, repoRoot),
  };
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * Substitute the two security-scan placeholders into a template.
 *
 * Empty inputs are replaced with the `(none)` sentinel so the rendered
 * prompt always reads naturally — `{{SUPPRESSED_IDS}}` and
 * `{{KNOWN_OPEN_FINDING_IDS}}` both default to `"(none)"` when empty.
 *
 * Issue #2138: v6 substituted empty ID lists as the empty string. When
 * the placeholders were wrapped in inline backticks (e.g. "appears in
 * `{{SUPPRESSED_IDS}}` or `{{KNOWN_OPEN_FINDING_IDS}}`") the result
 * rendered as "appears in `` or ``" — broken English. The `(none)`
 * sentinel keeps the wrapper issue readable both as a standalone
 * document and inline in Markdown.
 *
 * Populated lists still substitute as a newline-joined block so dedup
 * against prior findings continues to work.
 *
 * Issue #2135 (v6): the `{{REPO_FULL_NAME}}` placeholder was retired —
 * the worker already knows the target repo via `opts.repo` and the
 * executor's cwd points at the cloned repo, so `gh issue create`
 * operates on the right one without explicit substitution.
 *
 * Issue #2159 (v8): the `{{LANGUAGE_HINTS}}` placeholder was retired —
 * Claude detects the dominant languages at scan time as step zero of
 * the Phase 1 inventory, so the worker no longer needs to substitute a
 * languages list at file time.
 *
 * Pure function — no I/O.
 */
export function buildSecurityScanPrompt(
  template: string,
  opts: Pick<ScanOptions, "suppressedIds" | "knownOpenFindingIds"> & {
    attributionFooter?: string;
    /** Rendered LLM-usage gate verdict (see {@link buildLlmGateText}). */
    llmGate?: string;
  },
): string {
  const suppressed = opts.suppressedIds.length > 0
    ? opts.suppressedIds.join("\n")
    : "(none)";
  const known = opts.knownOpenFindingIds.length > 0
    ? opts.knownOpenFindingIds.join("\n")
    : "(none)";
  const footer = opts.attributionFooter ?? "";
  const llmGate = opts.llmGate ?? "";

  return template
    .replaceAll("{{SUPPRESSED_IDS}}", suppressed)
    .replaceAll("{{KNOWN_OPEN_FINDING_IDS}}", known)
    .replaceAll("{{ATTRIBUTION_FOOTER}}", footer)
    .replaceAll("{{LLM_GATE}}", llmGate);
}

/**
 * Render the deterministic LLM-usage verdict into the authoritative gate
 * block the prompt's `{{LLM_GATE}}` placeholder carries.
 *
 * A `YES` verdict instructs Claude to apply the OWASP GenAI / LLM Top 10
 * taxonomy and lists the matched signals so findings can cite them; a `NO`
 * verdict instructs Claude to skip the entire LLM section (precision-first;
 * skip on absence). Pure function — no I/O.
 */
export function buildLlmGateText(verdict: LlmUsageVerdict): string {
  if (verdict.isLlmUsing) {
    const signals = verdict.signals.length > 0
      ? verdict.signals.map((s) => `- ${s.pattern} (${s.evidence})`).join("\n")
      : "- (no individual signal recorded)";
    return [
      "**LLM-usage verdict (computed by the worker): LLM-using = YES.**",
      "Apply the OWASP GenAI / LLM Top 10 (2025) taxonomy in Phase 2.",
      "Matched signal(s):",
      signals,
    ].join("\n");
  }
  return [
    "**LLM-usage verdict (computed by the worker): LLM-using = NO.**",
    "No primary or secondary LLM integration signal was found and this repo",
    "is not on the always-on allowlist. Skip the entire OWASP GenAI / LLM",
    "Top 10 (2025) taxonomy — file no LLM findings (precision-first; skip on",
    "absence).",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the four-phase security scan against `opts.repo`.
 *
 * The Claude session is invoked with write/edit tools explicitly
 * disabled — see `SECURITY_SCAN_DISALLOWED_TOOLS`. Bash remains
 * allowed so Claude can call `gh issue create` to file findings. The
 * scan is bounded by the same wall-clock limit as a normal issue run;
 * on timeout the function returns `Result.err({ kind: "timeout" })`
 * with the partial output captured up to that point.
 *
 * Success means Claude exited cleanly — the caller verifies the
 * outcome by diffing the repo's open `security`-labelled issues
 * before and after the run.
 */
export async function runSecurityScan(
  opts: ScanOptions,
  deps: ScannerDeps = createDefaultDeps(),
): Promise<Result<ScanOk, ScanError>> {
  // 1. Load the latest version of the prompt template.
  const promptResult = await deps.loadPromptFn(PROMPT_NAME);
  if (!promptResult.ok) {
    return {
      ok: false,
      error: { kind: "prompt", message: promptResult.error.message },
    };
  }

  // 2. Decide the authoritative LLM-usage verdict (Issue #3014). The
  //    deterministic detector gates the prompt's OWASP GenAI / LLM Top 10
  //    section: VibeCoder always via the allowlist floor, any repo with a
  //    primary/secondary signal, otherwise skip. A detection failure is
  //    treated as "not LLM-using" (skip on absence) and never aborts the
  //    scan.
  const detect = deps.detectLlmUsageFn ?? detectLlmUsageForRepo;
  let llmVerdict: LlmUsageVerdict;
  try {
    llmVerdict = await detect(opts.repo, opts.workDir);
  } catch {
    llmVerdict = { isLlmUsing: false, signals: [] };
  }

  // 3. Substitute placeholders, including the attribution footer
  //    (Issue #2439) so each finding Claude files carries the same
  //    template + run-id traceability as the wrapper, and the LLM-usage
  //    gate (Issue #3014).
  const prompt = buildSecurityScanPrompt(promptResult.value, {
    suppressedIds: opts.suppressedIds,
    knownOpenFindingIds: opts.knownOpenFindingIds,
    attributionFooter: buildAttributionFooter({
      template: "security-scan",
      runId: getRunId(),
    }),
    llmGate: buildLlmGateText(llmVerdict),
  });

  // 4. Invoke Claude — no write/edit tools, Bash allowed for gh. Both bounds
  //    are always set (Issue #3657): an omitted timeout takes the shared
  //    idle-task budget rather than the 4h library default, and the silence
  //    watchdog is never left disabled.
  const runOpts: RunClaudeOptions = {
    prompt,
    cwd: opts.workDir,
    phase: "security_scan",
    disallowedTools: [...SECURITY_SCAN_DISALLOWED_TOOLS],
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.timeoutSeconds !== undefined
      ? { timeoutSeconds: opts.timeoutSeconds }
      : {}),
    ...(opts.noOutputTimeout !== undefined
      ? { noOutputTimeout: opts.noOutputTimeout }
      : {}),
  };
  // Issue #186: through the shared entry point rather than
  // `withIdleTaskBudget` + a bare call, so the scan also picks up the cycle
  // deadline bound, the worker logger (hence `[agent-progress]` lines), and
  // the no-retry rule a deadline-bound run needs.
  const runResult = await runIdleTaskClaude(
    runOpts,
    undefined,
    deps.runClaudeFn,
  );
  if (!runResult.ok) {
    return {
      ok: false,
      error: { kind: "claude", message: runResult.error.message },
    };
  }

  const { exitCode, output, timedOut } = runResult.value;
  if (timedOut) {
    return {
      ok: false,
      error: {
        kind: "timeout",
        message: "Claude security scan timed out",
        partialOutput: output,
      },
    };
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      error: {
        kind: "claude",
        message: `Claude exited with code ${exitCode}`,
        partialOutput: output,
      },
    };
  }

  return { ok: true, value: { ok: true } };
}
