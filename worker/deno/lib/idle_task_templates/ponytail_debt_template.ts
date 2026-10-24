/**
 * SIMPLE-ON-PURPOSE debt ledger (Issue #4027).
 *
 * Per monitored repository, lists every `// SIMPLE-ON-PURPOSE:` marker with
 * its path, line, ceiling and `upgrade when` condition, and flags a marker
 * that has no upgrade condition. The deterministic
 * `simple_on_purpose_scanner.ts` drives the check. Nothing is fetched at run
 * time, and the prompt at `prompts/ponytail_debt/prompt.md` is only the
 * human-style wrapper body.
 *
 *   - **Report only.** One ledger issue is posted, or the open ledger is
 *     refreshed in place. No commit, no pull request, no file edit.
 *   - **Fail-loud.** A scanner error replaces the report. An unreadable tree
 *     is never published as an empty ledger.
 *
 * Registration happens at module load — importing this file wires the
 * template up.
 *
 * Australian English spelling used throughout (behaviour, organisation).
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
import { ensureLabelExists as defaultEnsureLabelExists } from "../label_operations.ts";
import { repoCheckoutPath } from "../repo_checkout_path.ts";
import { RUN_ID_ENV_VAR } from "../run_id.ts";
import { buildAttributionFooter } from "../idle_task_attribution.ts";
import { GITHUB_ISSUE_BODY_MAX_CHARS } from "../idle_task_body_limit.ts";
import {
  scanSimpleOnPurposeMarkers as defaultScan,
  type SimpleOnPurposeMarker,
} from "../simple_on_purpose_scanner.ts";
import type { Result } from "../../types.ts";

const NAME = "ponytail-debt";

const DESCRIPTION =
  "List every SIMPLE-ON-PURPOSE marker with its path, line, ceiling and " +
  "upgrade condition, and flag a marker that has no upgrade when. " +
  "Report-only — one ledger issue, never a commit or a pull request.";

/** Label on the standing ledger issue. */
export const PONYTAIL_DEBT_LABEL = "ponytail-debt";

/** Wrapper title — dispatch matches this string. */
export const PONYTAIL_DEBT_ISSUE_TITLE = "Report the SIMPLE-ON-PURPOSE debt";

/** Title of the one ledger issue a repository carries. */
export const PONYTAIL_DEBT_REPORT_TITLE = "SIMPLE-ON-PURPOSE debt ledger";

/** Colour for the `ponytail-debt` label. */
export const PONYTAIL_DEBT_LABEL_COLOUR = "0e8a16";

/** Hidden marker so a refreshed body stays recognisable as the ledger. */
export const PONYTAIL_DEBT_LEDGER_MARKER = "<!-- simple-on-purpose-ledger -->";

const PROMPT_NAME = "ponytail_debt";

const COOLDOWN_HOURS = 168;

/** Body fingerprint. Anchored to the prompt's H1. */
export const PONYTAIL_DEBT_BODY_FINGERPRINT =
  /^#+\s+SIMPLE-ON-PURPOSE debt ledger\b/m;

const CALLER = "worker/deno/lib/idle_task_templates/ponytail_debt_template.ts";

/** How many open title matches are read before refusing to guess. */
const REPORT_LIST_LIMIT = 20;

/** Injectable dependencies for {@link createPonytailDebtTemplate}. */
export interface PonytailDebtTemplateDeps {
  /** Author-verification inputs for the wrapper dedup search. */
  dedupAuthors?: AlertDedupAuthorOptions;
  /** gh CLI runner. Tests inject a stub. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Prompt loader — defaults to `loadPrompt`. */
  loadPromptFn?: (
    name: string,
    promptsDir?: string,
  ) => Promise<Result<string>>;
  /** Ensure the `ponytail-debt` label exists. */
  ensureLabelFn?: (repo: string) => Promise<Result<void>>;
  /** Native scanner. Tests inject a stub. */
  scanFn?: (repoPath: string) => Promise<Result<SimpleOnPurposeMarker[]>>;
}

/**
 * Render one ledger issue body. Pure — no I/O.
 *
 * Every marker is one bullet with `path:line`, its ceiling and its upgrade
 * condition. A missing upgrade condition, and a marker that does not parse,
 * are flagged in that bullet.
 */
export function renderPonytailDebtBody(
  markers: readonly SimpleOnPurposeMarker[],
  footer: string,
): string {
  const lines: string[] = [
    PONYTAIL_DEBT_LEDGER_MARKER,
    "",
    "# SIMPLE-ON-PURPOSE debt ledger",
    "",
    "Every `// SIMPLE-ON-PURPOSE:` marker in this repository, with its " +
    "ceiling and the condition that lifts it. A marker with no `upgrade " +
    "when` clause is flagged. This report changes no file, makes no " +
    "commit and opens no pull request.",
    "",
  ];

  if (markers.length === 0) {
    lines.push("No markers.", "");
  } else {
    for (const marker of markers) {
      lines.push(renderMarkerBullet(marker));
    }
    lines.push("");
  }

  const flagged = markers.filter((marker) => marker.flag !== "ok").length;
  lines.push(
    `${markers.length} markers, ${flagged} flagged.`,
    "",
    footer,
  );
  return lines.join("\n");
}

function renderMarkerBullet(marker: SimpleOnPurposeMarker): string {
  const where = `\`${marker.path}:${marker.line}\``;
  if (marker.flag === "malformed") {
    const detail =
      marker.ceiling.length === 0 && marker.upgradeWhen.length === 0
        ? ""
        : ` — ceiling: ${marker.ceiling} — upgrade when: ${marker.upgradeWhen}`;
    return `- ${where} — **flagged: malformed**${detail}`;
  }
  if (marker.flag === "missing-upgrade-when") {
    return `- ${where} — ceiling: ${marker.ceiling} — **flagged: missing upgrade when**`;
  }
  return `- ${where} — ceiling: ${marker.ceiling} — upgrade when: ${marker.upgradeWhen}`;
}

/** Close-comment on the wrapper. Names the ledger issue, never a commit. */
export function renderPonytailDebtSummary(
  action: "posted" | "refreshed",
  issueNumber: number,
  markers: readonly SimpleOnPurposeMarker[],
): string {
  const flagged = markers.filter((marker) => marker.flag !== "ok").length;
  const verb = action === "posted" ? "Posted" : "Refreshed";
  const issue = action === "posted" ? `as #${issueNumber}` : `#${issueNumber}`;
  return `${verb} the SIMPLE-ON-PURPOSE debt ledger ${issue}. ` +
    `${markers.length} markers, ${flagged} flagged.`;
}

interface ListedIssue {
  number: number;
  title: string;
}

function parseIssueList(raw: string): ListedIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`issue list was not JSON: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("issue list was not a JSON array");
  }
  const issues: ListedIssue[] = [];
  for (const row of parsed) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as { number?: unknown; title?: unknown };
    if (typeof record.number !== "number" || typeof record.title !== "string") {
      continue;
    }
    issues.push({ number: record.number, title: record.title });
  }
  return issues;
}

function issueNumberFromCreate(raw: string): number | null {
  const match = raw.trim().match(/\/issues\/(\d+)\s*$/);
  if (!match?.[1]) return null;
  const number = parseInt(match[1], 10);
  return Number.isFinite(number) ? number : null;
}

/** Build the ponytail-debt template using the supplied deps. */
export function createPonytailDebtTemplate(
  deps: PonytailDebtTemplateDeps = {},
): IdleTaskTemplate {
  const ghCommandFn = deps.ghCommandFn ?? ((args) => defaultGhCommand(args));
  const dedupAuthors = deps.dedupAuthors ?? {};
  const loadPromptFn = deps.loadPromptFn ??
    ((name, promptsDir) => defaultLoadPrompt(name, promptsDir));
  const ensureLabelFn = deps.ensureLabelFn ??
    ((repo) =>
      defaultEnsureLabelExists(
        repo,
        PONYTAIL_DEBT_LABEL,
        PONYTAIL_DEBT_LABEL_COLOUR,
        "Ledger of SIMPLE-ON-PURPOSE markers",
      ));
  const scanFn = deps.scanFn ?? ((repoPath) => defaultScan(repoPath));

  async function buildIssueBody(opts: IdleTaskBodyOptions): Promise<string> {
    const loaded = await loadPromptFn(PROMPT_NAME, idleTaskPromptsDir(opts));
    if (!loaded.ok) {
      throw new Error(
        `ponytail-debt: failed to load prompt template ${PROMPT_NAME}: ` +
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
    return PONYTAIL_DEBT_ISSUE_TITLE;
  }

  async function shouldFile(
    opts: IdleTaskShouldFileOptions,
  ): Promise<boolean> {
    return !await hasFleetAuthoredOpenIssueTitled({
      repo: opts.repo,
      title: PONYTAIL_DEBT_ISSUE_TITLE,
      context: "ponytail-debt wrapper",
      ghCommand: ghCommandFn,
      ...dedupAuthors,
    });
  }

  async function runTask(opts: IdleTaskRunOptions): Promise<IdleTaskRunResult> {
    try {
      const repoPath = repoCheckoutPath(opts.workDir, opts.repo);
      const scanned = await scanFn(repoPath);
      if (!scanned.ok) {
        return {
          ok: false,
          summary: `Scanner error: ${scanned.error.message}`,
        };
      }

      const footer = buildAttributionFooter({
        template: NAME,
        runId: Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown",
      });
      const body = renderPonytailDebtBody(scanned.value, footer);
      if (body.length > GITHUB_ISSUE_BODY_MAX_CHARS) {
        return {
          ok: false,
          summary: `Scanner error: ledger body is ${body.length} characters, ` +
            `over the ${GITHUB_ISSUE_BODY_MAX_CHARS}-character issue limit.`,
        };
      }

      const label = await ensureLabelFn(opts.repo);
      if (!label.ok) {
        return {
          ok: false,
          summary: `Scanner error: ${label.error.message}`,
        };
      }

      const listed = parseIssueList(
        await ghCommandFn([
          "issue",
          "list",
          "--repo",
          opts.repo,
          "--state",
          "open",
          "--search",
          `${PONYTAIL_DEBT_REPORT_TITLE} in:title`,
          "--json",
          "number,title",
          "--limit",
          String(REPORT_LIST_LIMIT),
        ]),
      );
      if (listed.length >= REPORT_LIST_LIMIT) {
        return {
          ok: false,
          summary: `Scanner error: open-issue search hit the ` +
            `${REPORT_LIST_LIMIT}-issue limit, so the ledger was not posted ` +
            `a second time.`,
        };
      }

      const existing = listed
        .filter((issue) => issue.title === PONYTAIL_DEBT_REPORT_TITLE)
        .sort((a, b) => a.number - b.number)[0];

      if (existing === undefined) {
        const created = await ghCommandFn([
          "issue",
          "create",
          "--repo",
          opts.repo,
          "--title",
          PONYTAIL_DEBT_REPORT_TITLE,
          "--body",
          body,
          ...guardedLabelArgs([PONYTAIL_DEBT_LABEL], CALLER),
        ]);
        const number = issueNumberFromCreate(created);
        if (number === null) {
          return {
            ok: false,
            summary: "Scanner error: the ledger issue was created but its " +
              "number could not be read.",
          };
        }
        return {
          ok: true,
          summary: renderPonytailDebtSummary("posted", number, scanned.value),
        };
      }

      await ghCommandFn([
        "issue",
        "edit",
        String(existing.number),
        "--repo",
        opts.repo,
        "--body",
        body,
      ]);
      return {
        ok: true,
        summary: renderPonytailDebtSummary(
          "refreshed",
          existing.number,
          scanned.value,
        ),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: `ponytail-debt threw: ${message}` };
    }
  }

  return {
    name: NAME,
    description: DESCRIPTION,
    buildIssueTitle,
    buildIssueBody,
    shouldFile,
    runTask,
    matchesIdleTaskBody: (body) => PONYTAIL_DEBT_BODY_FINGERPRINT.test(body),
    skipMilestone: true,
    outputLabel: PONYTAIL_DEBT_LABEL,
    requiresStructuredOutput: true,
    cooldownHours: COOLDOWN_HOURS,
  };
}

/** Module-load registration so importing this file wires the template up. */
export const ponytailDebtTemplate: IdleTaskTemplate =
  createPonytailDebtTemplate();

registerTemplate(ponytailDebtTemplate);
