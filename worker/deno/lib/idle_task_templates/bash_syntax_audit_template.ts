/**
 * Bash syntax-audit idle-task template (Issue #3238, parent #3223 —
 * template #11).
 *
 * Per monitored repository, verifies the repo's **own CI** blocks any pull
 * request whose scripts fail a basic-validity gate, and files one issue-only
 * finding per missing gate. Two deterministic, native detectors drive the
 * core checks (no Claude invocation is involved):
 *
 *   1. the bash `bash -n` + `shellcheck` gate detector
 *      (`bash_ci_gate_scanner.ts` — sibling sub-issue #3236), and
 *   2. the native language-validity detector (`language_validity_gate.ts` —
 *      sibling sub-issue #3237) for each other main language.
 *
 * The prompt at `prompts/bash_syntax_audit/prompt.md` is used only as the
 * human-style wrapper body (Issue #2077). Modelled on
 * `bash_script_refs_template.ts` (native, issue-only) and
 * `github_actions_audit_template.ts` (single-scope, weekly cadence,
 * snapshot-diff outcome, label-ensure up front).
 *
 *   - **Issue-only — never a PR.** Each missing gate is filed as its own
 *     `bash-syntax-audit` issue; the fix (each repo commits its own gate)
 *     rides a normal `work-on` pipeline PR later. Repositories are
 *     **absolutely isolated** — the audit only verifies presence and raises
 *     an issue; no shared cross-repo Action.
 *   - **Prevention-first, fail-loud.** A gate whose status is *unknown* (no
 *     workflows loaded, unparseable workflow) never yields a false "missing"
 *     finding; a detector that cannot run surfaces as a loud `ok: false`
 *     summary, never a silent green.
 *   - **Stable prefix ids + dedup.** Each fixed gate class carries a stable
 *     `BP-`-prefixed id (`BP-BASH-SYNTAX-GATE`, `BP-BASH-SHELLCHECK-GATE`,
 *     `BP-VALIDITY-GATE-<language>`), and `fileFindingOnce` skips a gate that
 *     already has an open issue — one missing gate never yields two open
 *     issues.
 *   - **In-code suppression.** The shared `best-practice-ignore: BP-…`
 *     grammar (a `#` comment in a `.github/workflows/*` file) suppresses a
 *     gate id on future runs.
 *   - **Weekly cadence.** `cooldownHours: 168` caps the audit to once per
 *     week per repo (enforced by `idle_task_cooldown_gate.ts`).
 *
 * Registration happens at module load — importing this file is the only
 * thing callers need to do.
 *
 * Australian English used throughout (behaviour, organisation, authorised).
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
  fileFindingOnce,
  listOpenIssueNumbersByLabel,
  NEWLY_FILED_UNKNOWN_SUMMARY,
} from "../idle_task_snapshot.ts";
import { ensureLabelExists as defaultEnsureLabelExists } from "../label_operations.ts";
import { repoCheckoutPath } from "../repo_checkout_path.ts";
import { RUN_ID_ENV_VAR } from "../run_id.ts";
import { buildAttributionFooter } from "../idle_task_attribution.ts";
import {
  type BashCiGateResult,
  checkBashCiGates as defaultCheckBashCiGates,
} from "../bash_ci_gate_scanner.ts";
import {
  checkLanguageValidityGates as defaultCheckLanguageValidityGates,
  type LanguageValidityResult,
} from "../language_validity_gate.ts";
import {
  detectRepoLanguages as defaultDetectRepoLanguages,
  type RepoLanguages,
} from "../language_detector.ts";
import { readWorkflowFiles as defaultReadWorkflowFiles } from "../workflow_scan_common.ts";
import {
  filterByFamily,
  findSuppressions,
  renderSuppressionSummary,
} from "../suppression_comments.ts";
import type { Result } from "../../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME = "bash-syntax-audit";

const DESCRIPTION =
  "Verify the repository's own CI blocks invalid bash (`bash -n` + " +
  "`shellcheck`) and runs a native basic-validity check for every other main " +
  "language, filing one issue per missing gate. Issue-only — never opens a " +
  "pull request.";

/** Label every filed bash-syntax-audit finding (and wrapper) carries. */
export const BASH_SYNTAX_AUDIT_LABEL = "bash-syntax-audit";

/** Static wrapper title — dispatch matches against this string. */
export const BASH_SYNTAX_AUDIT_ISSUE_TITLE = "Run a bash syntax audit";

/** Colour for the `bash-syntax-audit` label. */
export const BASH_SYNTAX_AUDIT_LABEL_COLOUR = "B60205";

/** Prompt template directory under `prompts/`. */
const PROMPT_NAME = "bash_syntax_audit";

/** Once-per-week-per-repo cap (enforced by `idle_task_cooldown_gate.ts`). */
const COOLDOWN_HOURS = 168;

/**
 * Body fingerprint uniquely identifying a bash-syntax-audit wrapper.
 * Anchored to the prompt's H1 `# Bash Syntax Audit (v1)`.
 */
export const BASH_SYNTAX_AUDIT_BODY_FINGERPRINT = /^#+\s+Bash Syntax Audit\b/m;

/** Stable finding id for a missing `bash -n` / `sh -n` syntax gate. */
export const BASH_SYNTAX_GATE_FINDING_ID = "BP-BASH-SYNTAX-GATE";

/** Stable finding id for a missing `shellcheck` lint gate. */
export const BASH_SHELLCHECK_GATE_FINDING_ID = "BP-BASH-SHELLCHECK-GATE";

/** Stable finding id for a language missing its native validity gate. */
export function validityGateFindingId(language: string): string {
  return `BP-VALIDITY-GATE-${language}`;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Severity attached to a gate finding. */
export type GateSeverity = "high" | "medium";

/** A single missing-gate finding, pre-render. */
export interface GateFinding {
  /** Stable `BP-`-prefixed finding id (dedup + suppression key). */
  findingId: string;
  /** Severity — attached as exactly one `severity:<level>` label. */
  severity: GateSeverity;
  /** Issue title (carries the severity emoji prefix). */
  title: string;
  /** One-paragraph explanation suitable for the issue body. */
  details: string;
  /** Concrete suggested CI invocation to add. */
  suggestedFix: string;
}

/** Injectable dependencies for {@link createBashSyntaxAuditTemplate}. */
export interface BashSyntaxAuditTemplateDeps {
  /**
   * Author-verification inputs for the wrapper dedup search
   * ({@link hasFleetAuthoredOpenIssueTitled}). Omitted — every
   * production caller — reads the configured fleet identity.
   */
  dedupAuthors?: AlertDedupAuthorOptions;
  /** gh CLI runner used for snapshots, dedup, filing, and the wrapper veto. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Prompt loader — defaults to `loadPrompt`. */
  loadPromptFn?: (
    name: string,
    promptsDir?: string,
  ) => Promise<Result<string>>;
  /** Ensure the `bash-syntax-audit` label exists. Defaults to production. */
  ensureLabelFn?: (repo: string) => Promise<Result<void>>;
  /**
   * Bash CI-gate detector — defaults to `checkBashCiGates`. Tests inject a
   * stub returning a fixed {@link BashCiGateResult} (or throwing to exercise
   * the fail-loud path).
   */
  checkBashCiGatesFn?: (workDir: string) => Promise<BashCiGateResult>;
  /**
   * Repo language detector — defaults to `detectRepoLanguages`. Tests inject
   * a stub returning a fixed {@link RepoLanguages}.
   */
  detectLanguagesFn?: (repo: string) => Promise<Result<RepoLanguages, string>>;
  /**
   * Language-validity detector — defaults to `checkLanguageValidityGates`.
   * Tests inject a stub returning fixed {@link LanguageValidityResult}s.
   */
  checkLanguageValidityGatesFn?: (
    workDir: string,
    langs: RepoLanguages,
  ) => Promise<LanguageValidityResult[]>;
  /**
   * In-code suppression-id collector — defaults to a `.github/workflows/*`
   * scan for the `best-practice-ignore: BP-…` grammar. Tests inject a stub.
   */
  collectSuppressedIdsFn?: (workDir: string) => Promise<Set<string>>;
}

// ---------------------------------------------------------------------------
// Finding assembly (pure)
// ---------------------------------------------------------------------------

/**
 * Derive the bash-gate findings from a {@link BashCiGateResult}.
 *
 * Only a *definite* `"missing"` status yields a finding — an `"unknown"`
 * gate (no workflows loaded, unparseable workflow) or a non-applicable repo
 * (no bash scripts) yields none, so the audit never files a false positive.
 * Pure — no I/O.
 */
export function bashGateFindings(result: BashCiGateResult): GateFinding[] {
  if (!result.applicable) return [];
  const findings: GateFinding[] = [];
  if (result.gates.syntax === "missing") {
    findings.push({
      findingId: BASH_SYNTAX_GATE_FINDING_ID,
      severity: "high",
      title: "🔴 Missing CI `bash -n` syntax gate",
      details: result.details,
      suggestedFix:
        "Add a CI step that runs `bash -n` (or `sh -n`) over every bash " +
        "script on pull requests so a syntax error fails the build. A " +
        "committed gate script the workflow invokes (e.g. " +
        "`quality/bash_syntax.sh`, `./quality.sh`) counts as the gate.",
    });
  }
  if (result.gates.shellcheck === "missing") {
    findings.push({
      findingId: BASH_SHELLCHECK_GATE_FINDING_ID,
      severity: "medium",
      title: "🟠 Missing CI `shellcheck` gate",
      details: result.details,
      suggestedFix:
        "Add a CI step that runs `shellcheck` over the repo's bash scripts. " +
        "Block on error-severity findings at rollout; tighten warnings later.",
    });
  }
  return findings;
}

/**
 * Derive the language-validity findings from the per-language detector
 * results. A gate is a finding only when it is confirmed missing
 * (`present === false` AND at least one workflow was loaded) — the
 * `workflowsLoaded === false` fail-safe (#2881) is honoured so a
 * zero-workflow scan glitch never files a false `severity:high` finding.
 * Pure — no I/O.
 */
export function languageGateFindings(
  results: readonly LanguageValidityResult[],
): GateFinding[] {
  const findings: GateFinding[] = [];
  for (const res of results) {
    if (res.present) continue;
    if (res.workflowsLoaded === false) continue;
    findings.push({
      findingId: validityGateFindingId(res.language),
      severity: "high",
      title: `🔴 Missing CI validity gate for \`${res.language}\``,
      details: res.details,
      // The detector's `details` already names a concrete suggested
      // invocation, so no additional fix line is needed.
      suggestedFix: "See the suggested invocation above.",
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Finding body / title (pure)
// ---------------------------------------------------------------------------

/**
 * Render the issue body for a single missing-gate finding. Leads with the
 * finding-id marker and severity, then the detector's explanation, then the
 * concrete suggested fix, then the attribution footer. Exported so tests can
 * assert on the exact wording. Pure — no I/O.
 */
export function renderGateFindingBody(
  finding: GateFinding,
  footer: string,
): string {
  const lines: string[] = [
    `<!-- finding-id: ${finding.findingId} -->`,
    "",
    `**Missing gate:** ${finding.title.replace(/^\S+\s+/, "")}`,
    `**Severity:** ${finding.severity}`,
    "",
    finding.details,
    "",
    "## Suggested fix",
    "",
    finding.suggestedFix,
    "",
    "Each repository commits its own gate — there is no shared cross-repo " +
    "Action. This audit only verifies the gate is present; the fix rides a " +
    "normal `work-on` pipeline pull request.",
    "",
    footer,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Summary builder (pure)
// ---------------------------------------------------------------------------

/**
 * Render the close-comment summary for the wrapper idle-task issue.
 *
 *   - No newly-filed issues and no detector errors → `"no findings"`.
 *   - One or more newly-filed → `"Bash syntax audit complete. Filed N
 *     issues: #A, #B, …"` with numbers sorted ascending.
 *   - A detector error is appended on a trailing sentence and forces the
 *     wrapper result to `ok: false` (fail-loud — never a silent green).
 *   - Any in-source suppression marker seen during the run is listed on a
 *     trailing sentence (Issue #3712) so an active waiver is visible in
 *     the scan report, not only in the source it silences.
 *
 * Exported so tests can assert on the exact wording.
 */
export function renderBashSyntaxAuditSummary(
  newlyFiled: readonly number[] | null,
  detectorErrors: readonly string[] = [],
  suppressionReport: string = renderSuppressionSummary(),
): string {
  const parts: string[] = [];
  if (newlyFiled === null) {
    parts.push(NEWLY_FILED_UNKNOWN_SUMMARY);
  } else if (newlyFiled.length === 0) {
    parts.push("no findings");
  } else {
    const sorted = [...newlyFiled].sort((a, b) => a - b);
    const list = sorted.map((n) => `#${n}`).join(", ");
    parts.push(
      `Bash syntax audit complete. Filed ${sorted.length} issues: ${list}`,
    );
  }
  if (detectorErrors.length > 0) {
    parts.push(`Detector errors: ${detectorErrors.join("; ")}.`);
  }
  if (suppressionReport.length > 0) {
    parts.push(suppressionReport);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Default suppression collector
// ---------------------------------------------------------------------------

/**
 * Default in-code suppression-id collector. Reads the repo's workflow files
 * (where a gate suppression naturally lives, as a `#` YAML comment) and
 * returns the de-duplicated `best-practices`-family finding ids. Best-effort:
 * a read failure contributes nothing so the audit is never blocked.
 */
async function defaultCollectSuppressedIds(
  workDir: string,
  readWorkflowFilesFn: (
    workDir: string,
  ) => Promise<{ rawText: string; path?: string }[]>,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let files: { rawText: string; path?: string }[];
  try {
    files = await readWorkflowFilesFn(workDir);
  } catch {
    return ids;
  }
  for (const file of files) {
    // YAML comments are `#`-style — treat the file as `sh` for the
    // hash-comment marker forms. Issue #3941: only markers that pass the
    // governance policy suppress — the parser computes the verdict, and
    // discarding it here handed ungoverned waivers to the prompt while the
    // run report claimed they were rejected.
    for (
      const rec of filterByFamily(
        findSuppressions(
          file.rawText,
          "sh",
          file.path ? { file: file.path } : {},
        ),
        "best-practices",
      )
    ) {
      if (rec.valid) ids.add(rec.id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Finding filer
// ---------------------------------------------------------------------------

/** File a single gate finding, returning its number or `null`. */
async function fileGateFinding(
  repo: string,
  finding: GateFinding,
  footer: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<{ number: number; findingId: string } | null> {
  const body = renderGateFindingBody(finding, footer);
  const args: string[] = [
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    finding.title,
    "--body",
    body,
    "--label",
    BASH_SYNTAX_AUDIT_LABEL,
    "--label",
    `severity:${finding.severity}`,
  ];
  let raw: string;
  try {
    raw = await ghCommandFn(args);
  } catch {
    return null;
  }
  const m = raw.trim().match(/\/issues\/(\d+)\s*$/);
  if (!m || !m[1]) return null;
  const number = parseInt(m[1], 10);
  if (!Number.isFinite(number)) return null;
  return { number, findingId: finding.findingId };
}

// ---------------------------------------------------------------------------
// Template factory
// ---------------------------------------------------------------------------

/** Build the bash-syntax-audit template using the supplied deps. */
export function createBashSyntaxAuditTemplate(
  deps: BashSyntaxAuditTemplateDeps = {},
): IdleTaskTemplate {
  const ghCommandFn = deps.ghCommandFn ?? ((args) => defaultGhCommand(args));
  const dedupAuthors = deps.dedupAuthors ?? {};
  const loadPromptFn = deps.loadPromptFn ??
    ((name, promptsDir) => defaultLoadPrompt(name, promptsDir));
  const ensureLabelFn = deps.ensureLabelFn ??
    ((repo) =>
      defaultEnsureLabelExists(
        repo,
        BASH_SYNTAX_AUDIT_LABEL,
        BASH_SYNTAX_AUDIT_LABEL_COLOUR,
        "A basic-validity CI gate is missing (bash -n / shellcheck / native)",
      ));
  const checkBashCiGatesFn = deps.checkBashCiGatesFn ??
    ((workDir) => defaultCheckBashCiGates(workDir));
  const detectLanguagesFn = deps.detectLanguagesFn ??
    ((repo) => defaultDetectRepoLanguages(repo));
  const checkLanguageValidityGatesFn = deps.checkLanguageValidityGatesFn ??
    ((workDir, langs) => defaultCheckLanguageValidityGates(workDir, langs));
  const collectSuppressedIdsFn = deps.collectSuppressedIdsFn ??
    ((workDir) =>
      defaultCollectSuppressedIds(workDir, defaultReadWorkflowFiles));

  async function buildIssueBody(opts: IdleTaskBodyOptions): Promise<string> {
    // Issue #2077: the wrapper body IS the prompt, fully substituted at
    // file time so a developer reading the issue sees concrete values.
    const loaded = await loadPromptFn(PROMPT_NAME, idleTaskPromptsDir(opts));
    if (!loaded.ok) {
      throw new Error(
        `bash-syntax-audit: failed to load prompt template ${PROMPT_NAME}: ` +
          loaded.error.message,
      );
    }
    const footer = buildAttributionFooter({
      template: NAME,
      runId: Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown",
    });
    return loaded.value.replaceAll("{{ATTRIBUTION_FOOTER}}", footer);
  }

  function buildIssueTitle(_repo: string): string {
    return BASH_SYNTAX_AUDIT_ISSUE_TITLE;
  }

  async function shouldFile(
    opts: IdleTaskShouldFileOptions,
  ): Promise<boolean> {
    // Refuse to pile on while a wrapper is still being triaged.
    if (
      await hasFleetAuthoredOpenIssueTitled({
        repo: opts.repo,
        title: BASH_SYNTAX_AUDIT_ISSUE_TITLE,
        context: "bash-syntax-audit wrapper",
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
      // 1. Ensure the `bash-syntax-audit` label exists before any filing.
      await ensureLabelFn(opts.repo);

      // Issue #3292: `opts.workDir` is the PARENT directory holding every
      // repo clone side by side; `setupRepo` checks each repo out at
      // `${workDir}/${repoName}`. The native detectors below walk the repo
      // tree (scripts, `.github/workflows`), so they must be pointed at the
      // repo's own checkout (the #2880 pattern) — passing the parent read
      // the wrong tree and silently detected nothing.
      const repoPath = repoCheckoutPath(opts.workDir, opts.repo);

      // 2. Snapshot open findings before the audit.
      const before = await listOpenIssueNumbersByLabel(
        opts.repo,
        BASH_SYNTAX_AUDIT_LABEL,
        ghCommandFn,
      );

      // 3. Gather in-code suppression ids (best-effort).
      let suppressedIds: Set<string>;
      try {
        suppressedIds = await collectSuppressedIdsFn(repoPath);
      } catch {
        suppressedIds = new Set<string>();
      }

      // 4. Run the two native detectors. Each is guarded independently so a
      //    failure in one still files the other's findings; any error is
      //    recorded and forces a loud `ok: false` outcome (never a silent
      //    green).
      const findings: GateFinding[] = [];
      const detectorErrors: string[] = [];

      try {
        const bashResult = await checkBashCiGatesFn(repoPath);
        findings.push(...bashGateFindings(bashResult));
      } catch (err) {
        detectorErrors.push(
          `bash CI-gate detector failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      try {
        const langsResult = await detectLanguagesFn(opts.repo);
        if (langsResult.ok) {
          const results = await checkLanguageValidityGatesFn(
            repoPath,
            langsResult.value,
          );
          findings.push(...languageGateFindings(results));
        } else {
          detectorErrors.push(
            `language detection failed: ${langsResult.error}`,
          );
        }
      } catch (err) {
        detectorErrors.push(
          `language-validity detector failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // 5. File each surviving finding once (dedup per gate id), skipping any
      //    id suppressed in-code.
      const footer = buildAttributionFooter({
        template: NAME,
        runId: Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown",
      });
      for (const finding of findings) {
        if (suppressedIds.has(finding.findingId)) continue;
        await fileFindingOnce({
          repo: opts.repo,
          logLabel: BASH_SYNTAX_AUDIT_LABEL,
          findingId: finding.findingId,
          ghCommandFn,
          dedupAuthors,
          fileFn: () =>
            fileGateFinding(opts.repo, finding, footer, ghCommandFn),
        });
      }

      // 6. Snapshot again and compute the newly-filed set.
      const after = await listOpenIssueNumbersByLabel(
        opts.repo,
        BASH_SYNTAX_AUDIT_LABEL,
        ghCommandFn,
      );
      const newlyFiled = diffNewlyFiled(before, after);

      // Fail-loud: a detector that could not run makes the audit incomplete,
      // so the wrapper result is a loud failure even though any findings it
      // did produce were still filed.
      return {
        ok: detectorErrors.length === 0,
        summary: renderBashSyntaxAuditSummary(newlyFiled, detectorErrors),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: `bash-syntax-audit threw: ${message}` };
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
      BASH_SYNTAX_AUDIT_BODY_FINGERPRINT.test(body),
    skipMilestone: true,
    outputLabel: BASH_SYNTAX_AUDIT_LABEL,
    requiresStructuredOutput: true,
    cooldownHours: COOLDOWN_HOURS,
  };
}

/** Module-load registration so importing this file wires the template up. */
export const bashSyntaxAuditTemplate: IdleTaskTemplate =
  createBashSyntaxAuditTemplate();

registerTemplate(bashSyntaxAuditTemplate);
