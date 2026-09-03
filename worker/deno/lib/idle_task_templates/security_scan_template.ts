/**
 * Security-scan idle-task template (Issues #1960, #1965, #2077, #2097).
 *
 * Registers the first idle-task template. The wrapper is filed as a
 * human-style issue — title `Run a security scan`, body is the latest
 * `prompts/security_scan/vN.md` template with all four placeholders
 * substituted at file time. There is no hidden marker and no
 * parameters block; a person can paste the same prompt into a fresh
 * issue, apply the `idle-task` label, and the worker will run it
 * exactly as if the worker had filed it (dispatch matches by title —
 * see `idle_task_claim_handler.ts`).
 *
 * Issue #2097 rewrote `runTask` to an outcome-only contract: the
 * scanner prompt instructs Claude to file findings directly via `gh
 * issue create`, and the template verifies the outcome by snapshotting
 * the repo's open `security`-labelled issues before and after the scan
 * and diffing them. No JSON parsing, no Markdown summary, no calls
 * into `security_issue_filer.ts`.
 *
 * Registration happens at module load — importing this file is the
 * only thing callers need to do.
 */

import {
  type IdleTaskBodyOptions,
  type IdleTaskRunOptions,
  type IdleTaskRunResult,
  type IdleTaskShouldFileOptions,
  type IdleTaskTemplate,
  registerTemplate,
} from "../idle_task_template.ts";
import {
  buildSecurityScanPrompt,
  runSecurityScan as defaultRunSecurityScan,
  type ScanError,
  type ScanOk,
  type ScanOptions,
} from "../security_scanner.ts";
import { runGhCommand as defaultGhCommand } from "../github.ts";
import { loadPrompt as defaultLoadPrompt } from "../prompt_manager.ts";
import { RUN_ID_ENV_VAR } from "../run_id.ts";
import { buildAttributionFooter } from "../idle_task_attribution.ts";
import { buildPromptPreviewBody } from "../idle_task_body_preview.ts";
import {
  diffNewlyFiled,
  listAllOpenIssueTitles,
  listOpenIssueNumbersByLabel,
  parseGhJsonArray,
} from "../idle_task_snapshot.ts";
import {
  type EmitSarifOutcome,
  emitSecuritySarif,
} from "../security_sarif_emit.ts";
import { repoCheckoutPath } from "../repo_checkout_path.ts";
import type { Result } from "../../types.ts";

const NAME = "security-scan";

/**
 * Human-style issue title. The same string appears on every filed
 * wrapper, and the claim handler matches against it to dispatch a
 * claimed issue back to this template (Issue #2077).
 */
export const SECURITY_SCAN_ISSUE_TITLE = "Run a security scan";

/**
 * Body fingerprint that uniquely identifies a security-scan wrapper
 * (Issues #2087, #2118). The phrase is stable across prompt revisions
 * and unlikely to appear in a hand-typed issue unrelated to a scan.
 *
 * Issue #2118 anchored the match to a Markdown heading at the start of
 * a line. The original substring match treated *any* mention of the
 * phrase as a wrapper — meta-issues that quoted the phrase (e.g. while
 * describing this fingerprint) were misrouted through the idle-task
 * guard and refused. Anchoring to `^#+ ` keeps the prompt H1 detection
 * intact while rejecting prose mentions.
 */
export const SECURITY_SCAN_BODY_FINGERPRINT =
  /^#+\s+MythOS-style Security Audit\b/m;

const DESCRIPTION =
  "Run the MythOS-style four-phase security-in-depth audit against the " +
  "target repository and file evidence-backed findings as new issues.";

/** Prompt template directory under `prompts/`. */
const PROMPT_NAME = "security_scan";

function buildIssueTitle(_repo: string): string {
  return SECURITY_SCAN_ISSUE_TITLE;
}

/**
 * Injectable dependencies for {@link createSecurityScanTemplate}.
 *
 * Exposed so tests can drive `runTask` without invoking the real
 * Claude scanner or hitting GitHub.
 */
export interface SecurityScanTemplateDeps {
  runSecurityScanFn: (
    opts: ScanOptions,
  ) => Promise<Result<ScanOk, ScanError>>;
  /**
   * gh CLI runner used by the body builder, `shouldFile`, and the
   * before/after snapshot in `runTask`. Defaults to the production
   * retry wrapper; tests inject a stub so they never touch the network.
   */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /**
   * Prompt loader — defaults to `loadPrompt`. Tests inject a stub so
   * the file body is deterministic and so they avoid touching the
   * `prompts/` directory.
   */
  loadPromptFn?: (name: string) => Promise<Result<string>>;
  /**
   * SARIF emitter (Issue #3538). After the scan files its issues, this reads
   * them back, builds a SARIF 2.1.0 document, and uploads it to the target
   * repo's GitHub code scanning. SARIF is **additive** — it never fails the
   * wrapper task; its status is appended to the run summary. Defaults to the
   * production emitter wired to the template's gh runner; tests inject a stub.
   */
  emitSarifFn?: (
    opts: { repo: string; checkoutDir: string; newlyFiled: readonly number[] },
  ) => Promise<EmitSarifOutcome>;
}

/**
 * Return true when at least one open scanner-filed issue exists in
 * `repo`. Keys off the hidden `<!-- finding-id: SEC-… -->` body
 * marker every scanner-filed issue carries (Issue #2063).
 *
 * Any gh failure or malformed response is treated as "no findings" so
 * the gate does not block scanning on a transient lookup hiccup.
 */
async function hasOpenSecurityFindings(
  repo: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<boolean> {
  const raw = await ghCommandFn([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--search",
    "SEC- in:body",
    "--json",
    "number,body",
    "--limit",
    "30",
  ]);
  const finder = /<!--\s*finding-id:\s*SEC-[A-Za-z0-9]+\s*-->/i;
  for (const item of parseGhJsonArray(raw, "find SEC marker")) {
    if (item === null || typeof item !== "object") continue;
    const body = (item as { body?: unknown }).body;
    if (typeof body === "string" && finder.test(body)) return true;
  }
  return false;
}

/**
 * Return true when an open wrapper issue titled exactly
 * `Run a security scan` already exists in `repo` (Issue #2077). A
 * gh failure is treated as "no open wrapper" — matching the
 * `hasOpenSecurityFindings` behaviour, the gate must not stall
 * scanning on a transient hiccup.
 */
async function hasOpenSecurityScanWrapper(
  repo: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<boolean> {
  const raw = await ghCommandFn([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--search",
    `"${SECURITY_SCAN_ISSUE_TITLE}" in:title`,
    "--json",
    "number,title",
    "--limit",
    "10",
  ]);
  for (const item of parseGhJsonArray(raw, "find security wrapper")) {
    if (item === null || typeof item !== "object") continue;
    const title = (item as { title?: unknown }).title;
    if (
      typeof title === "string" && title.trim() === SECURITY_SCAN_ISSUE_TITLE
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Render the close-comment summary for the wrapper idle-task issue
 * (Issue #2097).
 *
 * - No newly-filed issues → `"0 findings."` (the executor's audit
 *   trail says "nothing landed this run").
 * - One or more newly-filed issues → `"Security scan complete. Filed
 *   N issues: #A, #B, …"` with the issue numbers sorted ascending so
 *   the comment is deterministic.
 *
 * Exported so tests can assert on the exact wording.
 */
export function renderRunSummary(newlyFiled: readonly number[]): string {
  if (newlyFiled.length === 0) return "0 findings.";
  const sorted = [...newlyFiled].sort((a, b) => a - b);
  const list = sorted.map((n) => `#${n}`).join(", ");
  return `Security scan complete. Filed ${sorted.length} issues: ${list}`;
}

/**
 * Build the security-scan template using the supplied deps.
 *
 * The default deps wire the production scanner + gh runner + prompt
 * loader; tests inject stubs.
 */
export function createSecurityScanTemplate(
  deps: SecurityScanTemplateDeps = {
    runSecurityScanFn: (opts) => defaultRunSecurityScan(opts),
    ghCommandFn: (args) => defaultGhCommand(args),
    loadPromptFn: (name) => defaultLoadPrompt(name),
  },
): IdleTaskTemplate {
  const ghCommandFn = deps.ghCommandFn ?? ((args) => defaultGhCommand(args));
  const loadPromptFn = deps.loadPromptFn ?? ((name) => defaultLoadPrompt(name));
  const emitSarifFn = deps.emitSarifFn ??
    ((opts) => emitSecuritySarif(opts, { ghListFn: ghCommandFn }));

  async function buildIssueBody(_opts: IdleTaskBodyOptions): Promise<string> {
    // Issue #2077: the wrapper body IS the prompt — fully substituted
    // at file time so a developer reading the issue sees concrete
    // values rather than `{{...}}` placeholders.
    //
    // Issue #2135 (v6): `_opts.repo` is no longer used for substitution —
    // v6 of the prompt dropped `{{REPO_FULL_NAME}}` because the worker's
    // cwd already points at the cloned repo.
    const loaded = await loadPromptFn(PROMPT_NAME);
    if (!loaded.ok) {
      throw new Error(
        `security-scan: failed to load prompt template ${PROMPT_NAME}: ${loaded.error.message}`,
      );
    }
    const attributionFooter = buildAttributionFooter({
      template: NAME,
      runId: Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown",
    });
    const prompt = buildSecurityScanPrompt(loaded.value, {
      suppressedIds: [],
      knownOpenFindingIds: [],
      attributionFooter,
    });
    // Issue #3863: the v30 prompt builds a ~101k body, well over GitHub's
    // 65,536-character issue-body ceiling. Rather than file a copy with its
    // middle clamped away, condense to a summary plus a permalink pinned to
    // the seeding commit.
    return await buildPromptPreviewBody(prompt, {
      promptName: PROMPT_NAME,
      scope: DESCRIPTION,
    });
  }

  async function shouldFile(
    opts: IdleTaskShouldFileOptions,
  ): Promise<boolean> {
    if (await hasOpenSecurityFindings(opts.repo, ghCommandFn)) return false;
    if (await hasOpenSecurityScanWrapper(opts.repo, ghCommandFn)) return false;
    return true;
  }

  async function runTask(opts: IdleTaskRunOptions): Promise<IdleTaskRunResult> {
    try {
      // 1. Snapshot the repo's open `security`-labelled issues before
      //    the scan runs.
      const before = await listOpenIssueNumbersByLabel(
        opts.repo,
        "security",
        ghCommandFn,
      );

      // 2. Repo-wide open-issue titles (Issue #537) — the semantic second
      //    line of dedup, so a finding already open under another label is
      //    not re-filed. A gh failure returns an empty list, which renders
      //    `(none)` and leaves the scan running.
      const openIssueTitles = await listAllOpenIssueTitles(
        opts.repo,
        ghCommandFn,
      );

      // 3. Run the scanner. Claude itself files findings via
      //    `gh issue create` — we never see a JSON block or summary.
      //    Issue #4010: honour the tier the wrapper was filed for; an
      //    unstamped wrapper leaves `model` unset and the phase default
      //    applies exactly as before.
      const scanResult = await deps.runSecurityScanFn({
        repo: opts.repo,
        workDir: opts.workDir,
        knownOpenFindingIds: [],
        openIssueTitles,
        suppressedIds: [],
        ...(opts.modelTier !== undefined ? { model: opts.modelTier } : {}),
      });
      if (!scanResult.ok) {
        return {
          ok: false,
          summary:
            `security-scan failed: ${scanResult.error.kind} — ${scanResult.error.message}`,
        };
      }

      // 4. Snapshot again and compute the newly-filed set.
      const after = await listOpenIssueNumbersByLabel(
        opts.repo,
        "security",
        ghCommandFn,
      );
      const newlyFiled = diffNewlyFiled(before, after);

      // 5. Additive SARIF emission (Issue #3538). Upload the just-filed
      //    findings to GitHub code scanning so they dedup against tool
      //    alerts and share the code-scanning triage UI. This never fails
      //    the wrapper task — its status is appended to the summary.
      const sarif = await emitSarifFn({
        repo: opts.repo,
        checkoutDir: repoCheckoutPath(opts.workDir, opts.repo),
        newlyFiled,
      });

      return {
        ok: true,
        summary: `${renderRunSummary(newlyFiled)} ${sarif.summary}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `security-scan threw: ${message}`,
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
    matchesIdleTaskBody: (body) => SECURITY_SCAN_BODY_FINGERPRINT.test(body),
    skipMilestone: true,
    outputLabel: "security",
    // Issue #2098 — security-scan files findings as issues; a narrative
    // "Partial Answer" comment on the wrapper is meaningless to the user.
    requiresStructuredOutput: true,
  };
}

export const securityScanTemplate: IdleTaskTemplate =
  createSecurityScanTemplate();

registerTemplate(securityScanTemplate);
