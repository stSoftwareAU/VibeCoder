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
 *
 * **Both `shouldFile` gates are author-verified.** They ask GitHub whether
 * an open `finding-id: SEC-…` issue exists and whether an open wrapper
 * titled `Run a security scan` exists, and answering "yes" stands the
 * scanner down for that repository. A body and a title are both text
 * anyone who can open an issue may write, so on an unverified match one
 * planted issue disables security scanning for a repo indefinitely. Every
 * match is checked against the fleet identity
 * (`lib/alert_dedup_authors.ts`) before it may defer a scan.
 *
 * **The fail direction is "scan".** An unresolvable fleet, a `gh` failure,
 * a malformed payload — every one of them leaves the gates open and the
 * scan runs, loudly logged. A security control that reports clean when it
 * could not run is worse than one that runs twice: the duplicate costs a
 * scan, the false clean costs the finding.
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
import {
  ALERT_DEDUP_JSON_FIELDS,
  ALERT_DEDUP_TITLE_JSON_FIELDS,
  type AlertDedupAuthorOptions,
  type AlertDedupRow,
  type AlertIssueAuthor,
  selectFleetAuthoredMatches,
} from "../alert_dedup_authors.ts";
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
export interface SecurityScanTemplateDeps extends AlertDedupAuthorOptions {
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
  loadPromptFn?: (
    name: string,
    promptsDir?: string,
  ) => Promise<Result<string>>;
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
  /**
   * Sink for the gate diagnostics — a lookup that could not run, and a
   * marker match discarded for want of a fleet author. Defaults to
   * `console.warn`; nothing here is ever swallowed.
   */
  log?: (message: string) => void;
}

/** One gate match, carrying the author that makes it verifiable. */
interface GateMatch extends AlertDedupRow {
  title?: string;
}

/** Read the `author` object off a `gh issue list --json` row. */
function rowAuthor(value: unknown): AlertIssueAuthor | null {
  return value !== null && typeof value === "object"
    ? value as AlertIssueAuthor
    : null;
}

/** The consequence every gate in this file states when it cannot verify. */
const SCAN_ANYWAY =
  "the scan goes ahead — a security control that cannot establish who " +
  "wrote a marker must never report clean";

/**
 * Return true when at least one open **fleet-filed** finding exists in
 * `repo`. Keys off the hidden `<!-- finding-id: SEC-… -->` body marker
 * every scanner-filed issue carries (Issue #2063), and off the issue
 * author, which is the only part of an issue an outsider cannot forge.
 *
 * A gh failure, a malformed response or an unresolvable fleet all yield
 * `false` — the scan runs — and every one of them is logged. Reporting
 * "no findings" quietly on a lookup that never happened is the failure
 * this gate exists to avoid.
 */
async function hasOpenSecurityFindings(
  repo: string,
  ghCommandFn: (args: string[]) => Promise<string>,
  opts: AlertDedupAuthorOptions,
  log: (message: string) => void,
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
      "SEC- in:body",
      "--json",
      ALERT_DEDUP_JSON_FIELDS,
      "--limit",
      "30",
    ]);
  } catch (err) {
    log(
      `[security-scan] ${repo}: the open-findings lookup failed (` +
        `${err instanceof Error ? err.message : String(err)}) — ` +
        `${SCAN_ANYWAY}.`,
    );
    return false;
  }
  const finder = /<!--\s*finding-id:\s*SEC-[A-Za-z0-9]+\s*-->/i;
  const matches: GateMatch[] = [];
  for (const item of parseGhJsonArray(raw, "find SEC marker")) {
    if (item === null || typeof item !== "object") continue;
    const row = item as { number?: unknown; body?: unknown; author?: unknown };
    if (typeof row.body === "string" && finder.test(row.body)) {
      matches.push({
        number: typeof row.number === "number" ? row.number : 0,
        body: row.body,
        author: rowAuthor(row.author),
      });
    }
  }
  const verified = await selectFleetAuthoredMatches(
    matches,
    `security-scan findings ${repo}`,
    opts,
    log,
    SCAN_ANYWAY,
  );
  return verified.length > 0;
}

/**
 * Return true when an open **fleet-filed** wrapper issue titled exactly
 * `Run a security scan` already exists in `repo` (Issue #2077).
 *
 * A title is chosen by whoever opens the issue, so the title alone cannot
 * stand the scanner down; the author must be a fleet account. As above,
 * anything unverifiable leaves the gate open and the scan runs.
 */
async function hasOpenSecurityScanWrapper(
  repo: string,
  ghCommandFn: (args: string[]) => Promise<string>,
  opts: AlertDedupAuthorOptions,
  log: (message: string) => void,
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
      `"${SECURITY_SCAN_ISSUE_TITLE}" in:title`,
      "--json",
      ALERT_DEDUP_TITLE_JSON_FIELDS,
      "--limit",
      "10",
    ]);
  } catch (err) {
    log(
      `[security-scan] ${repo}: the open-wrapper lookup failed (` +
        `${err instanceof Error ? err.message : String(err)}) — ` +
        `${SCAN_ANYWAY}.`,
    );
    return false;
  }
  const matches: GateMatch[] = [];
  for (const item of parseGhJsonArray(raw, "find security wrapper")) {
    if (item === null || typeof item !== "object") continue;
    const row = item as { number?: unknown; title?: unknown; author?: unknown };
    if (
      typeof row.title === "string" &&
      row.title.trim() === SECURITY_SCAN_ISSUE_TITLE
    ) {
      matches.push({
        number: typeof row.number === "number" ? row.number : 0,
        title: row.title,
        author: rowAuthor(row.author),
      });
    }
  }
  const verified = await selectFleetAuthoredMatches(
    matches,
    `security-scan wrapper ${repo}`,
    opts,
    log,
    SCAN_ANYWAY,
  );
  return verified.length > 0;
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
    loadPromptFn: (name, promptsDir) => defaultLoadPrompt(name, promptsDir),
  },
): IdleTaskTemplate {
  const ghCommandFn = deps.ghCommandFn ?? ((args) => defaultGhCommand(args));
  const loadPromptFn = deps.loadPromptFn ??
    ((name, promptsDir) => defaultLoadPrompt(name, promptsDir));
  const emitSarifFn = deps.emitSarifFn ??
    ((opts) => emitSecuritySarif(opts, { ghListFn: ghCommandFn }));
  const log = deps.log ?? ((message: string) => console.warn(message));

  async function buildIssueBody(opts: IdleTaskBodyOptions): Promise<string> {
    // Issue #2077: the wrapper body IS the prompt — fully substituted
    // at file time so a developer reading the issue sees concrete
    // values rather than `{{...}}` placeholders.
    //
    // Issue #2135 (v6): `opts.repo` is no longer used for substitution —
    // v6 of the prompt dropped `{{REPO_FULL_NAME}}` because the worker's
    // cwd already points at the cloned repo.
    const loaded = await loadPromptFn(PROMPT_NAME, idleTaskPromptsDir(opts));
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
      rootDir: opts.rootDir,
    });
  }

  async function shouldFile(
    opts: IdleTaskShouldFileOptions,
  ): Promise<boolean> {
    if (await hasOpenSecurityFindings(opts.repo, ghCommandFn, deps, log)) {
      return false;
    }
    if (await hasOpenSecurityScanWrapper(opts.repo, ghCommandFn, deps, log)) {
      return false;
    }
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
