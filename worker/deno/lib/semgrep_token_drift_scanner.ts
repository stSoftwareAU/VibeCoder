/**
 * Native semgrep-token drift pre-filer for the github-actions-audit template
 * (Issue #4341).
 *
 * The `semgrep` workflow spec detects presence by pattern
 * (`["semgrep/semgrep-action", "semgrep"]`), so a per-repo copy pushed from
 * the old template stays "covered" and is never compared with today's
 * template. That old template passed `SEMGREP_APP_TOKEN` to
 * `semgrep ci --config p/default`; `semgrep ci` exits fatally when a token is
 * combined with an explicit `--config`, so the check fails on every pull
 * request as soon as the repo owner sets the secret.
 *
 * One drift class, `severity:medium`, one finding per workflow file:
 *
 *   - `BP-SEMGREP-TOKEN-CONFIG-<basename>` — a step runs `semgrep ci` with
 *     `--config` while `SEMGREP_APP_TOKEN` is in scope through the step's,
 *     the job's or the workflow's `env:`.
 *
 * The scan reports only. Per the per-repo isolation rule (Issue #3239) the
 * YAML fix rides a normal per-repo worker PR.
 *
 * Pure aside from reading the already-parsed {@link WorkflowFile}. Never
 * throws on malformed input.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import { workflowIdSlug } from "./milestone_branch_filter_scanner.ts";
import {
  isFindingSuppressed,
  type WorkflowFile,
  type WorkflowFindingSeverity,
} from "./workflow_scan_common.ts";

/** The secret `semgrep ci` refuses to combine with `--config`. */
export const SEMGREP_APP_TOKEN = "SEMGREP_APP_TOKEN";

/** A single semgrep-token drift finding for one workflow file. */
export interface SemgrepTokenDriftFinding {
  /** Stable id `BP-SEMGREP-TOKEN-CONFIG-<workflow-basename>`. */
  findingId: string;
  /** Repo-relative workflow path. */
  workflowPath: string;
  /** Always `medium`, matching the other drift pre-filers. */
  severity: WorkflowFindingSeverity;
  /** Issue title (carries the severity emoji prefix). */
  title: string;
  /** File the finding is raised against (the workflow path). */
  file: string;
  /** Best-effort 1-based line the finding cites. */
  lines: number;
  /** `## Why this matters` rationale. */
  whyItMatters: string;
  /** `## Suggested fix` guidance. */
  suggestedFix: string;
  /** `## Evidence` block. */
  evidence: string;
}

/** Options for {@link scanSemgrepTokenDrift}. */
export interface ScanSemgrepTokenDriftOptions {
  /** Stable ids suppressed by prior triage — skip these findings. */
  suppressedIds?: Iterable<string>;
  /** Stable ids already open as findings — skip these findings. */
  knownOpenFindingIds?: Iterable<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const hasToken = (env: unknown): boolean =>
  isRecord(env) && SEMGREP_APP_TOKEN in env;

/** Does this `run:` script call `semgrep ci` with an explicit `--config`? */
function runsConfiguredSemgrepCi(run: unknown): boolean {
  return typeof run === "string" && /\bsemgrep\s+ci\b/.test(run) &&
    /--config\b/.test(run);
}

/** Does any step run `semgrep ci --config` with the token in scope? */
function passesTokenWithConfig(parsed: unknown): boolean {
  if (!isRecord(parsed) || !isRecord(parsed["jobs"])) return false;
  for (const job of Object.values(parsed["jobs"])) {
    if (!isRecord(job) || !Array.isArray(job["steps"])) continue;
    for (const step of job["steps"]) {
      if (!isRecord(step) || !runsConfiguredSemgrepCi(step["run"])) continue;
      if (
        hasToken(step["env"]) || hasToken(job["env"]) ||
        hasToken(parsed["env"])
      ) {
        return true;
      }
    }
  }
  return false;
}

/** 1-based line of the first `SEMGREP_APP_TOKEN` mention, else 1. */
function lineOfToken(rawText: string): number {
  const lines = rawText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] as string).includes(SEMGREP_APP_TOKEN)) return i + 1;
  }
  return 1;
}

/**
 * Scan every workflow in the repo and return one
 * {@link SemgrepTokenDriftFinding} per file that passes `SEMGREP_APP_TOKEN`
 * to a `semgrep ci --config` step.
 *
 * Only `kind === "workflow"` files are scanned; unparseable workflows yield
 * no finding. A finding suppressed by an in-source `best-practice-ignore:
 * BP-SEMGREP-…` marker, or whose id is in `suppressedIds` or
 * `knownOpenFindingIds`, is dropped. Findings are sorted by stable id.
 */
export function scanSemgrepTokenDrift(
  files: readonly WorkflowFile[],
  opts: ScanSemgrepTokenDriftOptions = {},
): SemgrepTokenDriftFinding[] {
  const suppressed = new Set(opts.suppressedIds ?? []);
  const knownOpen = new Set(opts.knownOpenFindingIds ?? []);
  const findings: SemgrepTokenDriftFinding[] = [];

  for (const file of files) {
    if (file.kind !== "workflow") continue;
    if (!passesTokenWithConfig(file.parsed)) continue;
    const findingId = `BP-SEMGREP-TOKEN-CONFIG-${workflowIdSlug(file.path)}`;
    if (suppressed.has(findingId) || knownOpen.has(findingId)) continue;
    const line = lineOfToken(file.rawText);
    if (isFindingSuppressed(file, line, findingId)) continue;
    findings.push({
      findingId,
      workflowPath: file.path,
      file: file.path,
      severity: "medium",
      title: `🟠 Semgrep passes ${SEMGREP_APP_TOKEN} with \`--config\` ` +
        `(\`${file.path}\`)`,
      lines: line,
      whyItMatters:
        "This workflow runs `semgrep ci` with an explicit `--config` while " +
        `\`${SEMGREP_APP_TOKEN}\` is in scope. \`semgrep ci\` exits fatally ` +
        "when a token is combined with `--config`, so the check fails on " +
        "every pull request once the repo owner sets the secret. The " +
        "workflow audit still counts the file as present, because the " +
        "presence check never compares it with the current template " +
        "(Issue #4341).",
      suggestedFix: `Remove \`${SEMGREP_APP_TOKEN}\` from the workflow's ` +
        "`env:` (step, job and top level), and any `workflow_call` secret " +
        "declaration or `environment:` that existed only to gate it, so the " +
        "step is a plain scan:\n\n```yaml\n      - run: semgrep ci " +
        "--config p/default\n```",
      evidence:
        `\`${file.path}\`:${line} — \`${SEMGREP_APP_TOKEN}\` is in scope ` +
        "for a `semgrep ci --config` step",
    });
  }

  findings.sort((a, b) => a.findingId.localeCompare(b.findingId));
  return findings;
}
