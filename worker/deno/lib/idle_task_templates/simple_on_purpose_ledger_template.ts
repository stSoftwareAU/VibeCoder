/**
 * SIMPLE-ON-PURPOSE ledger idle-task template (Issue #4027, group B).
 *
 * Per monitored repository, lists every `SIMPLE-ON-PURPOSE:` marker the
 * deterministic, network-free `simple_on_purpose_scanner.ts` finds, flags each
 * marker that carries no `upgrade when` clause, and posts or refreshes ONE
 * report issue under the fixed finding id
 * {@link SIMPLE_ON_PURPOSE_LEDGER_FINDING_ID}. No Claude invocation is
 * involved; the prompt at `prompts/simple_on_purpose_ledger/prompt.md` is used
 * only as the human-style wrapper body.
 *
 *   - **Report-only.** Never edits a file, never commits, never opens a pull
 *     request, and installs or fetches nothing at run time.
 *   - **One report per repository.** The open report is found by its finding
 *     id (fleet-authored only). It is edited in place when its content differs,
 *     left alone when identical, and created only when markers exist.
 *   - **Fail-loud.** A scanner failure surfaces as `ok: false` and files
 *     nothing, so an unreadable tree never reads as an empty ledger.
 *   - **Separate from the wrapper.** The report carries its own title, so the
 *     wrapper title veto ({@link SIMPLE_ON_PURPOSE_LEDGER_ISSUE_TITLE}) never
 *     blocks the report's refresh.
 *
 * Registration happens at module load — importing this file is the only thing
 * callers need to do.
 *
 * Australian English used throughout (behaviour, organisation, recognised).
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
import { findOpenIssueByFindingId } from "../idle_task_snapshot.ts";
import { ensureLabelExists as defaultEnsureLabelExists } from "../label_operations.ts";
import { repoCheckoutPath } from "../repo_checkout_path.ts";
import { RUN_ID_ENV_VAR } from "../run_id.ts";
import {
  appendIdleTaskAttribution,
  ATTRIBUTION_FOOTER_PREFIX,
  buildAttributionFooter,
} from "../idle_task_attribution.ts";
import {
  renderSimpleOnPurposeReport,
  scanSimpleOnPurpose as defaultScan,
  type SimpleOnPurposeLedger,
  type SimpleOnPurposeScanResult,
} from "../simple_on_purpose_scanner.ts";
import type { Result } from "../../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME = "simple-on-purpose-ledger";

const DESCRIPTION =
  "List every SIMPLE-ON-PURPOSE marker in the repository with its ceiling and " +
  "upgrade condition, flag markers missing an upgrade-when clause, and post " +
  "or refresh one report issue. Report-only — never edits a file.";

/** Label every SIMPLE-ON-PURPOSE report (and wrapper) carries. */
export const SIMPLE_ON_PURPOSE_LEDGER_LABEL = "simple-on-purpose-ledger";

/** Static wrapper title — dispatch matches against this string. */
export const SIMPLE_ON_PURPOSE_LEDGER_ISSUE_TITLE =
  "Run a SIMPLE-ON-PURPOSE ledger audit";

/** Colour for the `simple-on-purpose-ledger` label. */
export const SIMPLE_ON_PURPOSE_LEDGER_LABEL_COLOUR = "1D76DB";

/** Prompt template directory under `prompts/`. */
const PROMPT_NAME = "simple_on_purpose_ledger";

/** Once-per-week-per-repo cap (enforced by `idle_task_cooldown_gate.ts`). */
const COOLDOWN_HOURS = 168;

/**
 * Body fingerprint identifying the wrapper issue. Anchored to the prompt's H1
 * so it never matches the report body, whose H1 is `# SIMPLE-ON-PURPOSE ledger`.
 */
export const SIMPLE_ON_PURPOSE_LEDGER_BODY_FINGERPRINT =
  /^#+\s+SIMPLE-ON-PURPOSE Ledger Audit\b/m;

/**
 * Stable finding id for the one report a repository carries. The report is
 * keyed on this id, not on its title, because its title carries live counts.
 */
export const SIMPLE_ON_PURPOSE_LEDGER_FINDING_ID =
  "BP-SIMPLE-ON-PURPOSE-LEDGER";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Injectable dependencies for {@link createSimpleOnPurposeLedgerTemplate}. */
export interface SimpleOnPurposeLedgerTemplateDeps {
  /**
   * Author-verification inputs for the dedup look-up and the wrapper veto.
   * Omitted — every production caller — reads the configured fleet identity.
   */
  dedupAuthors?: AlertDedupAuthorOptions;
  /** gh CLI runner used for dedup, view, create, edit and the wrapper veto. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Prompt loader — defaults to `loadPrompt`. */
  loadPromptFn?: (
    name: string,
    promptsDir?: string,
  ) => Promise<Result<string>>;
  /** Ensure the `simple-on-purpose-ledger` label exists. Defaults to production. */
  ensureLabelFn?: (repo: string) => Promise<Result<void>>;
  /** Native scanner — defaults to `scanSimpleOnPurpose`. Tests inject a stub. */
  scanFn?: (repoPath: string) => Promise<SimpleOnPurposeScanResult>;
}

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

/** Report title. It carries live counts, so the finding id is the dedup key. */
export function renderSimpleOnPurposeLedgerTitle(
  ledger: SimpleOnPurposeLedger,
): string {
  const total = ledger.markers.length;
  const flagged = ledger.missingUpgradeWhen.length;
  const markers = `${total} marker${total === 1 ? "" : "s"}`;
  return flagged === 0
    ? `SIMPLE-ON-PURPOSE ledger: ${markers}`
    : `SIMPLE-ON-PURPOSE ledger: ${markers}, ${flagged} missing upgrade when`;
}

/**
 * The report content, without the attribution footer. This is what the
 * refresh compares, so the per-run footer never makes an identical report
 * look changed. Pure — no I/O.
 */
export function renderSimpleOnPurposeLedgerContent(
  ledger: SimpleOnPurposeLedger,
): string {
  return `<!-- finding-id: ${SIMPLE_ON_PURPOSE_LEDGER_FINDING_ID} -->\n\n${
    renderSimpleOnPurposeReport(ledger).trimEnd()
  }`;
}

/**
 * The comparable part of an existing report body: everything before the
 * attribution footer line, with trailing whitespace dropped. A body with no
 * footer is compared whole, so a hand-edited report reads as changed.
 */
export function simpleOnPurposeLedgerContentOf(body: string): string {
  const lines = body.split("\n");
  const footerAt = lines.findIndex((line) =>
    line.trimStart().startsWith(ATTRIBUTION_FOOTER_PREFIX)
  );
  const kept = footerAt < 0 ? lines : lines.slice(0, footerAt);
  return kept.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// Report reader and writer
// ---------------------------------------------------------------------------

/** The title and body of an existing open report. */
interface ViewedReport {
  title: string;
  body: string;
}

/** Parse `gh issue view --json title,body`, or `null` when malformed. */
function parseViewedReport(raw: string): ViewedReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const { title, body } = parsed as { title?: unknown; body?: unknown };
  if (typeof title !== "string" || typeof body !== "string") return null;
  return { title, body };
}

// ---------------------------------------------------------------------------
// Template factory
// ---------------------------------------------------------------------------

/** Build the simple-on-purpose-ledger template using the supplied deps. */
export function createSimpleOnPurposeLedgerTemplate(
  deps: SimpleOnPurposeLedgerTemplateDeps = {},
): IdleTaskTemplate {
  const ghCommandFn = deps.ghCommandFn ?? ((args) => defaultGhCommand(args));
  const dedupAuthors = deps.dedupAuthors ?? {};
  const loadPromptFn = deps.loadPromptFn ??
    ((name, promptsDir) => defaultLoadPrompt(name, promptsDir));
  const ensureLabelFn = deps.ensureLabelFn ??
    ((repo) =>
      defaultEnsureLabelExists(
        repo,
        SIMPLE_ON_PURPOSE_LEDGER_LABEL,
        SIMPLE_ON_PURPOSE_LEDGER_LABEL_COLOUR,
        "A SIMPLE-ON-PURPOSE marker lists a known limit of deliberately simple code",
      ));
  const scanFn = deps.scanFn ?? ((repoPath) => defaultScan({ repoPath }));

  function runId(): string {
    return Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown";
  }

  /** Create the report issue, returning its number or `null`. */
  async function createReport(
    repo: string,
    title: string,
    body: string,
  ): Promise<number | null> {
    const args: string[] = [
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      title,
      "--body",
      body,
      ...guardedLabelArgs(
        [SIMPLE_ON_PURPOSE_LEDGER_LABEL],
        "worker/deno/lib/idle_task_templates/simple_on_purpose_ledger_template.ts",
      ),
    ];
    const raw = await ghCommandFn(args);
    const m = raw.trim().match(/\/issues\/(\d+)\s*$/);
    if (!m || !m[1]) return null;
    const number = parseInt(m[1], 10);
    return Number.isFinite(number) ? number : null;
  }

  /** Read the title and body of an open report by number. */
  async function viewReport(
    repo: string,
    number: number,
  ): Promise<ViewedReport | null> {
    const raw = await ghCommandFn([
      "issue",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "title,body",
    ]);
    return parseViewedReport(raw);
  }

  async function buildIssueBody(opts: IdleTaskBodyOptions): Promise<string> {
    // The wrapper body IS the prompt, fully substituted at file time so a
    // developer reading the issue sees concrete values.
    const loaded = await loadPromptFn(PROMPT_NAME, idleTaskPromptsDir(opts));
    if (!loaded.ok) {
      throw new Error(
        `simple-on-purpose-ledger: failed to load prompt template ${PROMPT_NAME}: ` +
          loaded.error.message,
      );
    }
    return loaded.value.replaceAll(
      "{{ATTRIBUTION_FOOTER}}",
      buildAttributionFooter({ template: NAME, runId: runId() }),
    );
  }

  function buildIssueTitle(_repo: string): string {
    return SIMPLE_ON_PURPOSE_LEDGER_ISSUE_TITLE;
  }

  async function shouldFile(
    opts: IdleTaskShouldFileOptions,
  ): Promise<boolean> {
    // Refuse to pile on while a wrapper is still being triaged.
    return !await hasFleetAuthoredOpenIssueTitled({
      repo: opts.repo,
      title: SIMPLE_ON_PURPOSE_LEDGER_ISSUE_TITLE,
      context: "simple-on-purpose-ledger wrapper",
      ghCommand: ghCommandFn,
      ...dedupAuthors,
    });
  }

  async function runTask(opts: IdleTaskRunOptions): Promise<IdleTaskRunResult> {
    try {
      // 1. Ensure the label exists before any filing.
      await ensureLabelFn(opts.repo);

      // Issue #3292: `opts.workDir` is the PARENT directory holding every
      // repo clone side by side, so the scanner must be pointed at the
      // repo's own checkout.
      const repoPath = repoCheckoutPath(opts.workDir, opts.repo);

      // 2. Scan. A failure is loud and files nothing.
      const scan = await scanFn(repoPath);
      if (!scan.ok) {
        return {
          ok: false,
          summary:
            `simple-on-purpose-ledger: scanner error: ${scan.error}. Nothing filed.`,
        };
      }
      const ledger = scan.value;
      const title = renderSimpleOnPurposeLedgerTitle(ledger);
      const content = renderSimpleOnPurposeLedgerContent(ledger);
      const counts =
        `${ledger.markers.length} marker(s), ${ledger.missingUpgradeWhen.length} missing an upgrade when clause`;

      // 3. Find the open report by its finding id (fleet-authored only).
      const existing = await findOpenIssueByFindingId(
        opts.repo,
        NAME,
        SIMPLE_ON_PURPOSE_LEDGER_FINDING_ID,
        ghCommandFn,
        dedupAuthors,
      );

      // 4a. No open report: file one only when markers exist.
      if (existing === null) {
        if (ledger.markers.length === 0) {
          return {
            ok: true,
            summary:
              "simple-on-purpose-ledger: 0 markers and no open report; nothing filed.",
          };
        }
        const body = appendIdleTaskAttribution(content, {
          template: NAME,
          runId: runId(),
        });
        const number = await createReport(opts.repo, title, body);
        if (number === null) {
          return {
            ok: false,
            summary:
              `simple-on-purpose-ledger: ${counts}, but the report issue could not be filed.`,
          };
        }
        return {
          ok: true,
          summary:
            `simple-on-purpose-ledger: ${counts}. Filed report #${number}.`,
        };
      }

      // 4b. An open report exists: refresh it only when its content differs.
      const current = await viewReport(opts.repo, existing);
      if (current === null) {
        return {
          ok: false,
          summary:
            `simple-on-purpose-ledger: could not read open report #${existing}; not refreshed.`,
        };
      }
      if (
        simpleOnPurposeLedgerContentOf(current.body) === content &&
        current.title === title
      ) {
        return {
          ok: true,
          summary:
            `simple-on-purpose-ledger: ${counts}. Report #${existing} unchanged.`,
        };
      }
      const body = appendIdleTaskAttribution(content, {
        template: NAME,
        runId: runId(),
      });
      await ghCommandFn([
        "issue",
        "edit",
        String(existing),
        "--repo",
        opts.repo,
        "--title",
        title,
        "--body",
        body,
      ]);
      return {
        ok: true,
        summary:
          `simple-on-purpose-ledger: ${counts}. Refreshed report #${existing}.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `simple-on-purpose-ledger threw: ${message}`,
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
      SIMPLE_ON_PURPOSE_LEDGER_BODY_FINGERPRINT.test(body),
    skipMilestone: true,
    outputLabel: SIMPLE_ON_PURPOSE_LEDGER_LABEL,
    requiresStructuredOutput: true,
    cooldownHours: COOLDOWN_HOURS,
  };
}

/** Module-load registration so importing this file wires the template up. */
export const simpleOnPurposeLedgerTemplate: IdleTaskTemplate =
  createSimpleOnPurposeLedgerTemplate();

registerTemplate(simpleOnPurposeLedgerTemplate);
