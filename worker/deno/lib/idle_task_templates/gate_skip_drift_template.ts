/**
 * Gate-skip drift idle-task template (Issue #1597, follow-up from #1574).
 *
 * Per monitored repository, compares the repo's **local quality gate** with
 * its **own CI** and files one issue when the gate skips a tool that CI
 * installs and runs — the drift that let NEAT-AI-core PR 597 pass its local
 * gate and fail in CI. The deterministic, network-free
 * `gate_skip_drift_scanner.ts` drives the whole check; no Claude invocation
 * is involved, and the prompt at `prompts/gate_skip_drift/prompt.md` is used
 * only as the human-style wrapper body (Issue #2077).
 *
 *   - **Issue-only — never a PR.** The fix (bake the tool into the image, or
 *     make the gate fail loud) rides the normal `work-on` pipeline after a
 *     human confirms intent. Repositories stay **absolutely isolated**.
 *   - **One finding per repository.** The issue names every drifting tool
 *     with both lines — where the gate skips it and where CI enforces it —
 *     under the fixed id {@link GATE_SKIP_DRIFT_FINDING_ID}, so a repository
 *     never accumulates two open drift issues.
 *   - **Fail-loud.** A scanner read/parse failure surfaces as a loud
 *     `ok: false` summary on the wrapper issue — never a silent green.
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
import { guardedLabelArgs } from "../guarded_issue_labels.ts";
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
import { renderSuppressionSummary } from "../suppression_comments.ts";
import { repoCheckoutPath } from "../repo_checkout_path.ts";
import { RUN_ID_ENV_VAR } from "../run_id.ts";
import { buildAttributionFooter } from "../idle_task_attribution.ts";
import {
  type GateSkipDrift,
  type GateSkipDriftResult,
  scanGateSkipDrift as defaultScan,
} from "../gate_skip_drift_scanner.ts";
import type { Result } from "../../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME = "gate-skip-drift";

const DESCRIPTION =
  "Compare the repository's quality.sh with its own CI and file one issue " +
  "naming every tool the gate skips with a warning while CI installs and " +
  "runs it. Issue-only — never opens a pull request.";

/** Label every filed gate-skip-drift finding (and wrapper) carries. */
export const GATE_SKIP_DRIFT_LABEL = "gate-skip-drift";

/** Static wrapper title — dispatch matches against this string. */
export const GATE_SKIP_DRIFT_ISSUE_TITLE = "Run a gate-skip drift audit";

/** Colour for the `gate-skip-drift` label. */
export const GATE_SKIP_DRIFT_LABEL_COLOUR = "B60205";

/** Prompt template directory under `prompts/`. */
const PROMPT_NAME = "gate_skip_drift";

/** Once-per-week-per-repo cap (enforced by `idle_task_cooldown_gate.ts`). */
const COOLDOWN_HOURS = 168;

/**
 * Body fingerprint uniquely identifying a gate-skip-drift wrapper.
 * Anchored to the prompt's H1 `# Gate-Skip Drift Audit`.
 */
export const GATE_SKIP_DRIFT_BODY_FINGERPRINT =
  /^#+\s+Gate-Skip Drift Audit\b/m;

/**
 * Stable finding id for the one drift issue a repository carries. The
 * per-tool `BP-GATE-SKIP-<TOOL>` ids the scanner emits are the *waiver*
 * keys; this is the dedup key for the filed issue.
 */
export const GATE_SKIP_DRIFT_FINDING_ID = "BP-GATE-SKIP-DRIFT";

/** Severity attached to the finding — a drifting gate costs a whole PR cycle. */
const SEVERITY = "high";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Injectable dependencies for {@link createGateSkipDriftTemplate}. */
export interface GateSkipDriftTemplateDeps {
  /**
   * Author-verification inputs for the wrapper dedup search
   * ({@link hasFleetAuthoredOpenIssueTitled}). Omitted — every production
   * caller — reads the configured fleet identity.
   */
  dedupAuthors?: AlertDedupAuthorOptions;
  /** gh CLI runner used for snapshots, dedup, filing, and the wrapper veto. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Prompt loader — defaults to `loadPrompt`. */
  loadPromptFn?: (
    name: string,
    promptsDir?: string,
  ) => Promise<Result<string>>;
  /** Ensure the `gate-skip-drift` label exists. Defaults to production. */
  ensureLabelFn?: (repo: string) => Promise<Result<void>>;
  /** Native scanner — defaults to `scanGateSkipDrift`. Tests inject a stub. */
  scanFn?: (repoPath: string, repo: string) => Promise<GateSkipDriftResult>;
}

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

/** Issue title naming the drifting tools, e.g. `` `bats`, `codespell` ``. */
export function renderGateSkipDriftTitle(
  drifts: readonly GateSkipDrift[],
): string {
  const tools = drifts.map((d) => `\`${d.tool}\``).join(", ");
  return `🔴 Local gate skips ${tools} — this repo's CI enforces ${
    drifts.length === 1 ? "it" : "them"
  }`;
}

/**
 * Render the issue body: the finding-id marker, then one block per drifting
 * tool citing both lines, then the two fixes. Exported so tests can assert
 * on the exact wording. Pure — no I/O.
 */
export function renderGateSkipDriftBody(
  gateScriptPath: string,
  drifts: readonly GateSkipDrift[],
  footer: string,
): string {
  const lines: string[] = [
    `<!-- finding-id: ${GATE_SKIP_DRIFT_FINDING_ID} -->`,
    "",
    `**Severity:** ${SEVERITY}`,
    "",
    "This repository's local quality gate skips a tool that its own CI " +
    "installs and runs, so the Vibe Coder's gate goes green inside the " +
    "container and the pull request fails in CI instead — the NEAT-AI-core " +
    "PR 597 failure.",
    "",
  ];

  for (const drift of drifts) {
    lines.push(
      `## \`${drift.tool}\` — waiver id \`${drift.findingId}\``,
      "",
      `- **Skipped locally** — \`${gateScriptPath}:${drift.skip.skipLine}\`` +
        `: \`${drift.skip.skipText}\``,
      `- **Enforced in CI** — \`${drift.enforcement.file}:${drift.enforcement.line}\`` +
        `: \`${drift.enforcement.text}\``,
    );
    if (drift.enforcement.installText !== null) {
      lines.push(
        `- **Installed by CI** — \`${drift.enforcement.file}:${drift.enforcement.installLine}\`` +
          `: \`${drift.enforcement.installText}\``,
      );
    }
    lines.push("");
  }

  lines.push(
    "## Suggested fix",
    "",
    "Either **bake the tool into the image** — add it to " +
      "`container/tools.json` as a toolchain whose `repos` list names this " +
      "repository, so the gate runs it locally — or **make the gate fail " +
      "loud** instead of printing a warning and continuing. A gate that " +
      "skips silently reports a pass it did not earn.",
    "",
    "Each repository owns its own gate — there is no shared cross-repo " +
      "Action. This audit only reports the drift; the fix rides a normal " +
      "`work-on` pipeline pull request.",
    "",
    footer,
  );

  return lines.join("\n");
}

/**
 * Render the close-comment summary for the wrapper idle-task issue.
 *
 *   - No newly-filed issues and no scanner error → `"no findings"`.
 *   - One or more newly-filed → `"Gate-skip drift audit complete. Filed N
 *     issues: #A, #B, …"` with numbers sorted ascending.
 *   - A scanner error **replaces** the count — an audit that could not
 *     complete never reads as `"no findings"` — and forces `ok: false`.
 *   - Any suppression marker seen during the run is listed on a trailing
 *     sentence, so an active waiver and a rejected one are both visible in
 *     the report rather than only in the source they silence.
 */
export function renderGateSkipDriftSummary(
  newlyFiled: readonly number[] | null,
  scannerError: string | null = null,
  suppressionReport: string = renderSuppressionSummary(),
): string {
  const parts: string[] = [];
  if (scannerError !== null) {
    // Deliberately no count: "no findings" beside an error is the silent
    // green this scan exists to prevent.
  } else if (newlyFiled === null) {
    parts.push(NEWLY_FILED_UNKNOWN_SUMMARY);
  } else if (newlyFiled.length === 0) {
    parts.push("no findings");
  } else {
    const sorted = [...newlyFiled].sort((a, b) => a - b);
    parts.push(
      `Gate-skip drift audit complete. Filed ${sorted.length} issues: ${
        sorted.map((n) => `#${n}`).join(", ")
      }`,
    );
  }
  if (scannerError !== null) parts.push(`Scanner error: ${scannerError}.`);
  if (suppressionReport.length > 0) parts.push(suppressionReport);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Finding filer
// ---------------------------------------------------------------------------

/** File the drift finding, returning its number or `null`. */
async function fileDriftFinding(
  repo: string,
  gateScriptPath: string,
  drifts: readonly GateSkipDrift[],
  footer: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<{ number: number; findingId: string } | null> {
  const args: string[] = [
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    renderGateSkipDriftTitle(drifts),
    "--body",
    renderGateSkipDriftBody(gateScriptPath, drifts, footer),
    ...guardedLabelArgs(
      [GATE_SKIP_DRIFT_LABEL, `severity:${SEVERITY}`],
      "worker/deno/lib/idle_task_templates/gate_skip_drift_template.ts",
    ),
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
  return { number, findingId: GATE_SKIP_DRIFT_FINDING_ID };
}

// ---------------------------------------------------------------------------
// Template factory
// ---------------------------------------------------------------------------

/** Build the gate-skip-drift template using the supplied deps. */
export function createGateSkipDriftTemplate(
  deps: GateSkipDriftTemplateDeps = {},
): IdleTaskTemplate {
  const ghCommandFn = deps.ghCommandFn ?? ((args) => defaultGhCommand(args));
  const dedupAuthors = deps.dedupAuthors ?? {};
  const loadPromptFn = deps.loadPromptFn ??
    ((name, promptsDir) => defaultLoadPrompt(name, promptsDir));
  const ensureLabelFn = deps.ensureLabelFn ??
    ((repo) =>
      defaultEnsureLabelExists(
        repo,
        GATE_SKIP_DRIFT_LABEL,
        GATE_SKIP_DRIFT_LABEL_COLOUR,
        "The local quality gate skips a tool this repo's CI enforces",
      ));
  const scanFn = deps.scanFn ??
    ((repoPath, repo) => defaultScan({ repoPath, repo }));

  async function buildIssueBody(opts: IdleTaskBodyOptions): Promise<string> {
    // Issue #2077: the wrapper body IS the prompt, fully substituted at file
    // time so a developer reading the issue sees concrete values.
    const loaded = await loadPromptFn(PROMPT_NAME, idleTaskPromptsDir(opts));
    if (!loaded.ok) {
      throw new Error(
        `gate-skip-drift: failed to load prompt template ${PROMPT_NAME}: ` +
          loaded.error.message,
      );
    }
    return loaded.value.replaceAll(
      "{{ATTRIBUTION_FOOTER}}",
      buildAttributionFooter({
        template: NAME,
        runId: Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown",
      }),
    );
  }

  function buildIssueTitle(_repo: string): string {
    return GATE_SKIP_DRIFT_ISSUE_TITLE;
  }

  async function shouldFile(
    opts: IdleTaskShouldFileOptions,
  ): Promise<boolean> {
    // Refuse to pile on while a wrapper is still being triaged.
    return !await hasFleetAuthoredOpenIssueTitled({
      repo: opts.repo,
      title: GATE_SKIP_DRIFT_ISSUE_TITLE,
      context: "gate-skip-drift wrapper",
      ghCommand: ghCommandFn,
      ...dedupAuthors,
    });
  }

  async function runTask(opts: IdleTaskRunOptions): Promise<IdleTaskRunResult> {
    try {
      // 1. Ensure the `gate-skip-drift` label exists before any filing.
      await ensureLabelFn(opts.repo);

      // Issue #3292: `opts.workDir` is the PARENT directory holding every
      // repo clone side by side, so the scanner must be pointed at the
      // repo's own checkout.
      const repoPath = repoCheckoutPath(opts.workDir, opts.repo);

      // 2. Snapshot open findings before the audit.
      const before = await listOpenIssueNumbersByLabel(
        opts.repo,
        GATE_SKIP_DRIFT_LABEL,
        ghCommandFn,
      );

      // 3. Run the native scanner. A failure is loud, never a silent green.
      const result = await scanFn(repoPath, opts.repo);
      if (!result.ok) {
        return {
          ok: false,
          summary: renderGateSkipDriftSummary([], result.error.message),
        };
      }

      // 4. File the repository's drift once (dedup on the fixed finding id).
      const { drifts, gateScriptPath } = result.value;
      if (drifts.length > 0 && gateScriptPath !== null) {
        const footer = buildAttributionFooter({
          template: NAME,
          runId: Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown",
        });
        await fileFindingOnce({
          repo: opts.repo,
          logLabel: GATE_SKIP_DRIFT_LABEL,
          findingId: GATE_SKIP_DRIFT_FINDING_ID,
          ghCommandFn,
          dedupAuthors,
          fileFn: () =>
            fileDriftFinding(
              opts.repo,
              gateScriptPath,
              drifts,
              footer,
              ghCommandFn,
            ),
        });
      }

      // 5. Snapshot again and compute the newly-filed set.
      const after = await listOpenIssueNumbersByLabel(
        opts.repo,
        GATE_SKIP_DRIFT_LABEL,
        ghCommandFn,
      );
      return {
        ok: true,
        summary: renderGateSkipDriftSummary(diffNewlyFiled(before, after)),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: `gate-skip-drift threw: ${message}` };
    }
  }

  return {
    name: NAME,
    description: DESCRIPTION,
    buildIssueTitle,
    buildIssueBody,
    shouldFile,
    runTask,
    matchesIdleTaskBody: (body) => GATE_SKIP_DRIFT_BODY_FINGERPRINT.test(body),
    skipMilestone: true,
    outputLabel: GATE_SKIP_DRIFT_LABEL,
    requiresStructuredOutput: true,
    cooldownHours: COOLDOWN_HOURS,
  };
}

/** Module-load registration so importing this file wires the template up. */
export const gateSkipDriftTemplate: IdleTaskTemplate =
  createGateSkipDriftTemplate();

registerTemplate(gateSkipDriftTemplate);
