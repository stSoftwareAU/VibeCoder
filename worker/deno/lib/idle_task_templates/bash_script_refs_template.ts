/**
 * Bash script-reference idle-task template (Issue #3228, parent #3224 —
 * layer 2 of the bash compile-equivalent checks).
 *
 * Runs the native, deterministic missing-script reference scanner
 * (`bash_script_refs_scanner.ts`) against the target repository and files
 * one prevention-first finding issue per referenced script that does not
 * exist on disk. Unlike the LLM-driven scan templates (security-scan,
 * best-practices, …), the **core check is entirely native** — no Claude
 * invocation is involved. The latest prompt under `prompts/bash_script_refs/`
 * is used only as the human-style wrapper body (Issue #2077).
 *
 *   - **Issue-only — never a PR.** Each missing target is filed as its own
 *     `bash-missing-script` issue; the fix flows through the normal
 *     `work-on` pipeline after a human confirms intent.
 *   - **Prevention-first findings.** Every finding leads with the fix and a
 *     repo-local layer-2 CI-guard recommendation (à la FLEET
 *     `WorkerSourcePathsExist.ts` + `fleet_source_or_fail`), not with
 *     clean-up.
 *   - **Dedup per missing path.** The finding id is keyed on the missing
 *     path, and `fileFindingOnce` skips a target that already has an open
 *     issue — one missing helper never yields two open issues.
 *   - **Fail-loud.** A scanner walk/read failure surfaces as a loud
 *     `ok: false` summary on the wrapper issue — never a silent green.
 *   - **Weekly cadence.** `cooldownHours: 168` caps the scan to once per
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
import { loadPrompt as defaultLoadPrompt } from "../prompt_manager.ts";
import {
  diffNewlyFiled,
  fileFindingOnce,
  listOpenIssueNumbersByLabel,
  parseGhJsonArray,
} from "../idle_task_snapshot.ts";
import { ensureLabelExists as defaultEnsureLabelExists } from "../label_operations.ts";
import { RUN_ID_ENV_VAR } from "../run_id.ts";
import { buildAttributionFooter } from "../idle_task_attribution.ts";
import {
  type BashMissingScriptFinding,
  type BashScanResult,
  scanBashScriptRefs as defaultScan,
} from "../bash_script_refs_scanner.ts";
import { repoCheckoutPath } from "../repo_checkout_path.ts";
import type { Result } from "../../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME = "bash-script-refs";

const DESCRIPTION =
  "Statically resolve every bash source/./fleet_source_or_fail/bash reference " +
  "in the repository's shell scripts and file each reference whose target is " +
  "not a regular file. Issue-only — never opens a pull request.";

/** Label every filed missing-script finding carries. */
export const BASH_MISSING_SCRIPT_LABEL = "bash-missing-script";

/** Static wrapper title — dispatch matches against this string. */
export const BASH_SCRIPT_REFS_ISSUE_TITLE = "Run a bash script-reference scan";

/** Colour for the `bash-missing-script` label. */
export const BASH_MISSING_SCRIPT_LABEL_COLOUR = "B60205";

/** Prompt template directory under `prompts/`. */
const PROMPT_NAME = "bash_script_refs";

/** Once-per-week-per-repo cap (enforced by `idle_task_cooldown_gate.ts`). */
const COOLDOWN_HOURS = 168;

/**
 * Body fingerprint uniquely identifying a bash-script-refs wrapper.
 * Anchored to the prompt's H1 `# Bash Script-Reference Scan (v1)`.
 */
export const BASH_SCRIPT_REFS_BODY_FINGERPRINT =
  /^#+\s+Bash Script-Reference\b/m;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Injectable dependencies for {@link createBashScriptRefsTemplate}. */
export interface BashScriptRefsTemplateDeps {
  /** gh CLI runner used for snapshots, dedup, filing, and the wrapper veto. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Prompt loader — defaults to `loadPrompt`. */
  loadPromptFn?: (
    name: string,
    promptsDir?: string,
  ) => Promise<Result<string>>;
  /** Ensure the `bash-missing-script` label exists. Defaults to production. */
  ensureLabelFn?: (repo: string) => Promise<Result<void>>;
  /** Native scanner — defaults to `scanBashScriptRefs`. Tests inject a stub. */
  scanFn?: (workDir: string, repo: string) => Promise<BashScanResult>;
}

// ---------------------------------------------------------------------------
// Finding body (prevention-first)
// ---------------------------------------------------------------------------

/**
 * Render the prevention-first body for a single missing-script finding.
 *
 * Leads with the fix and a repo-local CI-guard recommendation, then lists
 * every reference site and the paths tried. Exported so tests can assert on
 * the exact wording. Pure — no I/O.
 */
export function renderMissingScriptBody(
  finding: BashMissingScriptFinding,
  footer: string,
): string {
  const sites = finding.references
    .map((r) => `- \`${r.sourceFile}\`:${r.line} — \`${r.rawRef}\``)
    .join("\n");
  const tried = finding.candidatesTried
    .map((c) => `- \`${c}\``)
    .join("\n");

  const lines: string[] = [
    `<!-- finding-id: ${finding.findingId} -->`,
    "",
    `**Missing script:** \`${finding.missingPath}\``,
    `**Severity:** high`,
    "",
    "A bash `source` / `.` / `bash` reference resolves to a file that does " +
    "not exist on disk. `bash -n` cannot catch this — the target is only " +
    "resolved at *first execution*, so the script fails at runtime with " +
    "exit 127. A silently-reconciled exit 127 is exactly the failure class " +
    "that took down FLEET's Discovery loop for weeks.",
    "",
    "## Fix (do this first)",
    "",
    "1. Determine the intent of the reference and apply the right fix:",
    "   - **Wrong path** → correct it to the helper's real location.",
    "   - **Helper deleted by mistake** → restore the helper.",
    "   - **Dead reference** → delete the stale `source`/`bash` line.",
    "",
    "## Prevent recurrence (repo-local layer-2 CI guard)",
    "",
    "Wire a repo-local static guard so this regression class cannot recur — " +
    "for example a dispatcher-scoped test that asserts every sourced path " +
    "exists (à la FLEET `test/unit/worker/WorkerSourcePathsExist.ts`), backed " +
    "by a fail-loud `source`-or-die wrapper at runtime (à la FLEET " +
    "`worker/shared/stage_fail_marker.sh` → `fleet_source_or_fail`).",
    "",
    "## Referenced from",
    "",
    sites,
    "",
    "## Paths tried (none exist)",
    "",
    tried,
    "",
    footer,
  ];
  return lines.join("\n");
}

/** Issue title for a missing-script finding. */
export function renderMissingScriptTitle(
  finding: BashMissingScriptFinding,
): string {
  return `Bash: missing sourced/called script \`${finding.missingPath}\``;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

/**
 * Render the close-comment summary for the wrapper idle-task issue.
 *
 *   - No newly-filed issues → `"no findings"`.
 *   - One or more → `"Bash script-reference scan complete. Filed N issues:
 *     #A, #B, …"` with numbers sorted ascending.
 *
 * Exported so tests can assert on the exact wording.
 */
export function renderBashScriptRefsSummary(
  newlyFiled: readonly number[],
): string {
  if (newlyFiled.length === 0) return "no findings";
  const sorted = [...newlyFiled].sort((a, b) => a - b);
  const list = sorted.map((n) => `#${n}`).join(", ");
  return `Bash script-reference scan complete. Filed ${sorted.length} ` +
    `issues: ${list}`;
}

// ---------------------------------------------------------------------------
// gh snapshot helper
// ---------------------------------------------------------------------------

/** True when an open wrapper titled exactly {@link BASH_SCRIPT_REFS_ISSUE_TITLE} exists. */
async function hasOpenWrapper(
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
      `"${BASH_SCRIPT_REFS_ISSUE_TITLE}" in:title`,
      "--json",
      "number,title",
      "--limit",
      "10",
    ]);
  } catch {
    return false;
  }
  for (const item of parseGhJsonArray(raw, "find bash-script-refs wrapper")) {
    if (item === null || typeof item !== "object") continue;
    const title = (item as { title?: unknown }).title;
    if (
      typeof title === "string" &&
      title.trim() === BASH_SCRIPT_REFS_ISSUE_TITLE
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Finding filer
// ---------------------------------------------------------------------------

/** File a single missing-script finding, returning its number or `null`. */
async function fileMissingScriptFinding(
  repo: string,
  finding: BashMissingScriptFinding,
  footer: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<{ number: number; findingId: string } | null> {
  const body = renderMissingScriptBody(finding, footer);
  const args: string[] = [
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    renderMissingScriptTitle(finding),
    "--body",
    body,
    "--label",
    BASH_MISSING_SCRIPT_LABEL,
    "--label",
    "severity:high",
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

/** Build the bash-script-refs template using the supplied deps. */
export function createBashScriptRefsTemplate(
  deps: BashScriptRefsTemplateDeps = {},
): IdleTaskTemplate {
  const ghCommandFn = deps.ghCommandFn ?? ((args) => defaultGhCommand(args));
  const loadPromptFn = deps.loadPromptFn ??
    ((name, promptsDir) => defaultLoadPrompt(name, promptsDir));
  const ensureLabelFn = deps.ensureLabelFn ??
    ((repo) =>
      defaultEnsureLabelExists(
        repo,
        BASH_MISSING_SCRIPT_LABEL,
        BASH_MISSING_SCRIPT_LABEL_COLOUR,
        "A sourced/called bash script is missing on disk",
      ));
  const scanFn = deps.scanFn ?? ((workDir, repo) => defaultScan(workDir, repo));

  async function buildIssueBody(opts: IdleTaskBodyOptions): Promise<string> {
    // Issue #2077: the wrapper body IS the prompt, fully substituted at
    // file time so a developer reading the issue sees concrete values.
    const loaded = await loadPromptFn(PROMPT_NAME, idleTaskPromptsDir(opts));
    if (!loaded.ok) {
      throw new Error(
        `bash-script-refs: failed to load prompt template ${PROMPT_NAME}: ` +
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
    return BASH_SCRIPT_REFS_ISSUE_TITLE;
  }

  async function shouldFile(
    opts: IdleTaskShouldFileOptions,
  ): Promise<boolean> {
    // Refuse to pile on while a wrapper is still being triaged.
    if (await hasOpenWrapper(opts.repo, ghCommandFn)) return false;
    return true;
  }

  async function runTask(opts: IdleTaskRunOptions): Promise<IdleTaskRunResult> {
    try {
      // 1. Ensure the `bash-missing-script` label exists before any filing.
      await ensureLabelFn(opts.repo);

      // 2. Snapshot open findings before the scan.
      const before = await listOpenIssueNumbersByLabel(
        opts.repo,
        BASH_MISSING_SCRIPT_LABEL,
        ghCommandFn,
      );

      // 3. Run the native scanner against the repo's own checkout. Issue
      //    #3292: `opts.workDir` is the PARENT directory holding every
      //    repo clone side by side — `setupRepo` checks each repo out at
      //    `${workDir}/${repoName}`. Passing the parent swept sibling
      //    checkouts (private-repo-14, VibeCoder, …) and filed cross-repo false
      //    positives against the target repo. Derive the checkout path
      //    (the established #2880 pattern). Fail-loud: a walk/read failure
      //    is surfaced as a loud summary, never reconciled as "no findings".
      const scan = await scanFn(
        repoCheckoutPath(opts.workDir, opts.repo),
        opts.repo,
      );
      if (!scan.ok) {
        return {
          ok: false,
          summary: `bash-script-refs scan failed (${scan.error.kind}): ` +
            scan.error.message,
        };
      }

      // 4. File each missing-script finding once (dedup per missing path).
      const footer = buildAttributionFooter({
        template: NAME,
        runId: Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown",
      });
      for (const finding of scan.value.findings) {
        await fileFindingOnce({
          repo: opts.repo,
          logLabel: BASH_MISSING_SCRIPT_LABEL,
          findingId: finding.findingId,
          ghCommandFn,
          fileFn: () =>
            fileMissingScriptFinding(opts.repo, finding, footer, ghCommandFn),
        });
      }

      // 5. Snapshot again and compute the newly-filed set.
      const after = await listOpenIssueNumbersByLabel(
        opts.repo,
        BASH_MISSING_SCRIPT_LABEL,
        ghCommandFn,
      );
      const newlyFiled = diffNewlyFiled(before, after);

      return { ok: true, summary: renderBashScriptRefsSummary(newlyFiled) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: `bash-script-refs threw: ${message}` };
    }
  }

  return {
    name: NAME,
    description: DESCRIPTION,
    buildIssueTitle,
    buildIssueBody,
    shouldFile,
    runTask,
    matchesIdleTaskBody: (body) => BASH_SCRIPT_REFS_BODY_FINGERPRINT.test(body),
    skipMilestone: true,
    outputLabel: BASH_MISSING_SCRIPT_LABEL,
    requiresStructuredOutput: true,
    cooldownHours: COOLDOWN_HOURS,
  };
}

/** Module-load registration so importing this file wires the template up. */
export const bashScriptRefsTemplate: IdleTaskTemplate =
  createBashScriptRefsTemplate();

registerTemplate(bashScriptRefsTemplate);
