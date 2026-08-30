/**
 * Native gitleaks-drift pre-filer for the github-actions-audit template
 * (Issue #598, part of #566).
 *
 * The `gitleaks` workflow spec detects presence by pattern
 * (`["gitleaks/gitleaks-action", "gitleaks"]`), so `auditRepoWorkflows`
 * marks the workflow "covered" for any file that merely mentions gitleaks.
 * Presence is not currency: a copy pushed months ago with
 * `branches: ["*"]` and `gitleaks-action@v2` scores as fully covered while
 * scanning almost nothing. This scanner compares each per-repo copy against
 * the canonical shape the worker emits today and reports what has drifted.
 *
 * Four drift classes, each `severity:medium`, one finding per gitleaks
 * workflow file:
 *
 *   - `BP-GITLEAKS-BRANCH-<basename>` — the `pull_request.branches` filter
 *     matches no `milestone/<slug>` branch. A GitHub `*` never matches a
 *     `/`, so the common `["*"]` spelling silently skips every milestone
 *     PR (Issue #1300) — the dominant merge path.
 *   - `BP-GITLEAKS-ACTION-STALE-<basename>` — `gitleaks/gitleaks-action` is
 *     tag-pinned (`@v2`, `@v3`) or pinned to a SHA other than the one
 *     {@link pinnedAction} resolves today.
 *   - `BP-GITLEAKS-NO-FALLBACK-<basename>` — the workflow runs the licensed
 *     action with no open-source gitleaks CLI step. Dependabot PRs receive
 *     no Actions secrets, so the action exits `ErrLicense` and scans
 *     nothing (Issue #2981).
 *   - `BP-GITLEAKS-NO-PR-TRIGGER-<basename>` — no gitleaks workflow in the
 *     repo has a `pull_request` trigger at all: the files exist, the PRs
 *     are unscanned.
 *
 * The branch finding is dropped when `scanMilestoneBranchFilters` already
 * owns the same gap for the same workflow path (its
 * `BP-MILESTONE-FILTER-<basename>` id is open or was filed this run), so
 * one gap never files two issues.
 *
 * The scan reports only. Per the per-repo isolation rule (Issue #3239) the
 * YAML fix rides a normal per-repo worker PR; this scanner raises no PR and
 * touches no other repository.
 *
 * Pure aside from reading the already-parsed/raw {@link WorkflowFile} —
 * callers read the files via `readWorkflowFiles`. Never throws on malformed
 * input.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import { extractUsesValue } from "./action_pin_scanner.ts";
import {
  lineOfPullRequestFilter,
  milestoneFindingIdForPath,
  workflowIdSlug,
  workflowMilestoneCoverage,
} from "./milestone_branch_filter_scanner.ts";
import { pinnedAction } from "./pinned_actions.ts";
import {
  checkNamesFromWorkflow,
  requiredStatusCheckSection,
} from "./required_status_check_guidance.ts";
import {
  isFindingSuppressed,
  type WorkflowFile,
  type WorkflowFindingSeverity,
} from "./workflow_scan_common.ts";

/** Which drift class a {@link GitleaksDriftFinding} reports. */
export type GitleaksDriftKind =
  | "branch"
  | "action-stale"
  | "no-fallback"
  | "no-pr-trigger";

/** A single gitleaks-drift finding for one workflow file. */
export interface GitleaksDriftFinding {
  /** Stable id `BP-GITLEAKS-<CLASS>-<workflow-basename>`. */
  findingId: string;
  /** Which drift class this finding reports. */
  kind: GitleaksDriftKind;
  /** Repo-relative workflow path, e.g. `.github/workflows/gitleaks.yml`. */
  workflowPath: string;
  /** Always `medium`, matching the milestone-branch-filter pre-filer. */
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

/** Options for {@link scanGitleaksDrift}. */
export interface ScanGitleaksDriftOptions {
  /** Stable ids suppressed by prior triage — skip these findings. */
  suppressedIds?: Iterable<string>;
  /** Stable ids already open as findings — skip these findings. */
  knownOpenFindingIds?: Iterable<string>;
}

const MEDIUM_EMOJI = "🟠";

/** The glob that closes the milestone branch gap. */
const MILESTONE_GLOB = "milestone/*";

/**
 * The upstream action coordinate this scanner tracks. Exported so the
 * observed-coverage scanner (Issue #601) decides "runs gitleaks" by the same
 * rule this one does.
 */
export const GITLEAKS_ACTION = "gitleaks/gitleaks-action";

/** A full 40-character lower-case hex commit SHA. */
const SHA_PIN = /^[0-9a-f]{40}$/;

/**
 * The SHA `pinnedAction()` resolves for the gitleaks action today — the
 * definition of "current" every per-repo copy is compared against.
 *
 * Resolved at module load: a missing pin is a defect, and `pinnedAction`
 * throws loudly rather than letting the scanner silently treat every copy
 * as current.
 */
const CURRENT_ACTION_SHA = (() => {
  const rendered = pinnedAction(GITLEAKS_ACTION);
  const sha = rendered.slice(GITLEAKS_ACTION.length + 1).split(/\s/)[0] ?? "";
  if (!SHA_PIN.test(sha)) {
    throw new Error(
      `pinnedAction("${GITLEAKS_ACTION}") did not resolve to a 40-character ` +
        `commit SHA (got "${sha}") — the gitleaks-drift scanner cannot ` +
        `decide currency without one (Issue #598).`,
    );
  }
  return sha;
})();

/**
 * An invocation of the open-source gitleaks CLI inside a `run:` script.
 *
 * Matches `gitleaks detect …`, `./gitleaks git …` and `bin/gitleaks …`,
 * but not the download coordinates the canonical fallback also mentions
 * (`.../gitleaks/gitleaks/releases/...`, `gitleaks_${VERSION}_linux_x64`),
 * because those are followed by `/` or `_` rather than whitespace.
 *
 * Exported so the observed-coverage scanner (Issue #601) recognises a CLI
 * scan by the same rule.
 */
export const CLI_INVOCATION =
  /(?:^|[\s;&|(`])(?:\.{0,2}\/[\w./-]*)?gitleaks(?=\s|$)/m;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A step's `uses:` ref and `run:` script, as strings. */
interface StepText {
  uses: string;
  run: string;
}

/** Collect every `jobs.<job>.steps[]` entry's `uses:`/`run:` text. */
function collectSteps(parsed: unknown): StepText[] {
  if (!isRecord(parsed)) return [];
  const jobs = parsed["jobs"];
  if (!isRecord(jobs)) return [];
  const out: StepText[] = [];
  for (const job of Object.values(jobs)) {
    if (!isRecord(job)) continue;
    const steps = job["steps"];
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (!isRecord(step)) continue;
      out.push({
        uses: typeof step["uses"] === "string" ? step["uses"] : "",
        run: typeof step["run"] === "string" ? step["run"] : "",
      });
    }
  }
  return out;
}

/** Does this `uses:` value reference `gitleaks/gitleaks-action`? */
export function usesGitleaksAction(value: string): boolean {
  const coordinate = value.trim().split("@")[0] ?? "";
  return coordinate === GITLEAKS_ACTION;
}

/**
 * A gitleaks workflow: one that actually runs gitleaks, either via the
 * upstream action or via the open-source CLI. A file that only mentions
 * gitleaks in its name or comments is not one — that conflation is the
 * defect this scanner exists to close.
 */
interface GitleaksWorkflow {
  file: WorkflowFile;
  /** Uses the licensed `gitleaks/gitleaks-action`. */
  usesAction: boolean;
  /** Runs the open-source gitleaks CLI in a `run:` step. */
  usesCli: boolean;
}

/** Classify one file, returning `null` when it does not run gitleaks. */
function asGitleaksWorkflow(file: WorkflowFile): GitleaksWorkflow | null {
  if (file.kind !== "workflow") return null;
  if (!isRecord(file.parsed)) return null;
  const steps = collectSteps(file.parsed);
  const usesAction = steps.some((s) => usesGitleaksAction(s.uses));
  const usesCli = steps.some((s) => CLI_INVOCATION.test(s.run));
  if (!usesAction && !usesCli) return null;
  return { file, usesAction, usesCli };
}

/** Every `gitleaks-action` call-site in a file: line number and ref. */
function actionCallSites(rawText: string): { line: number; ref: string }[] {
  const sites: { line: number; ref: string }[] = [];
  const lines = rawText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const value = extractUsesValue(lines[i] as string);
    if (value === null || !usesGitleaksAction(value)) continue;
    const at = value.indexOf("@");
    sites.push({ line: i + 1, ref: at < 0 ? "" : value.slice(at + 1) });
  }
  return sites;
}

/** Best-effort: 1-based line of the top-level `on:` key. */
function lineOfOnKey(rawText: string): number {
  const lines = rawText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^on\s*:/.test(lines[i] as string)) return i + 1;
  }
  return 1;
}

/** A finding body before the per-file fields are attached. */
type PartialFinding = Omit<
  GitleaksDriftFinding,
  "workflowPath" | "file" | "severity"
>;

/**
 * Scan every gitleaks workflow in the repo and return one
 * {@link GitleaksDriftFinding} per drift class found.
 *
 * Behaviour:
 *   - Only `kind === "workflow"` files that genuinely run gitleaks (via
 *     the action or the CLI) are scanned; comments and file names alone
 *     never qualify.
 *   - Unparseable workflows yield no finding and never throw.
 *   - `BP-GITLEAKS-NO-PR-TRIGGER-*` is emitted only when **no** gitleaks
 *     workflow in the repo has a `pull_request` trigger — a nightly
 *     scheduled copy beside a PR-gating one is not drift.
 *   - The branch finding is dropped when the milestone-branch-filter
 *     scanner already owns the same gap for the same path (its
 *     `BP-MILESTONE-FILTER-<basename>` id is suppressed or known-open).
 *   - A finding suppressed by an in-source `best-practice-ignore:
 *     BP-GITLEAKS-…` marker near its cited line is dropped, as is one
 *     whose id appears in `suppressedIds` or `knownOpenFindingIds`.
 *
 * Findings are returned sorted by stable id for deterministic output.
 */
export function scanGitleaksDrift(
  files: readonly WorkflowFile[],
  opts: ScanGitleaksDriftOptions = {},
): GitleaksDriftFinding[] {
  const suppressed = new Set(opts.suppressedIds ?? []);
  const knownOpen = new Set(opts.knownOpenFindingIds ?? []);

  const workflows: GitleaksWorkflow[] = [];
  for (const file of files) {
    const workflow = asGitleaksWorkflow(file);
    if (workflow !== null) workflows.push(workflow);
  }

  // A repo gates PRs when any of its gitleaks workflows has a
  // `pull_request` trigger — covered or gapped, the trigger is there.
  const anyPrTrigger = workflows.some(
    (w) => workflowMilestoneCoverage(w.file.parsed) !== "none",
  );

  const findings: GitleaksDriftFinding[] = [];
  const emit = (file: WorkflowFile, finding: PartialFinding) => {
    if (suppressed.has(finding.findingId)) return;
    if (knownOpen.has(finding.findingId)) return;
    if (
      isFindingSuppressed(
        file.rawText,
        finding.lines,
        finding.findingId,
        file.path,
      )
    ) {
      return;
    }
    findings.push({
      ...finding,
      // Currency is only half the gap: a corrected copy still blocks nothing
      // until its check is required by the rulesets gating merges, so every
      // finding carries that human action too (Issue #600). The check names
      // come from the scanned file itself, so the guidance quotes what this
      // repo's workflow actually reports.
      suggestedFix: `${finding.suggestedFix}\n\n${
        requiredStatusCheckSection(
          checkNamesFromWorkflow(file.rawText, file.path),
        )
      }`,
      workflowPath: file.path,
      file: file.path,
      severity: "medium",
    });
  };

  for (const workflow of workflows) {
    const { file } = workflow;
    const slug = workflowIdSlug(file.path);
    const coverage = workflowMilestoneCoverage(file.parsed);

    if (coverage === "gap") {
      // Do not double-file: the milestone pre-filer emits its own finding
      // for this same file whenever it classifies as a high-confidence
      // test workflow — which a gitleaks copy does.
      const milestoneId = milestoneFindingIdForPath(file.path);
      if (!knownOpen.has(milestoneId) && !suppressed.has(milestoneId)) {
        emit(file, branchFinding(file, slug));
      }
    } else if (coverage === "none" && !anyPrTrigger) {
      emit(file, noPrTriggerFinding(file, slug));
    }

    const staleSites = actionCallSites(file.rawText)
      .filter((site) => site.ref !== CURRENT_ACTION_SHA);
    if (staleSites.length > 0) {
      emit(file, staleActionFinding(file, slug, staleSites));
    }

    if (workflow.usesAction && !workflow.usesCli) {
      emit(file, noFallbackFinding(file, slug));
    }
  }

  findings.sort((a, b) => a.findingId.localeCompare(b.findingId));
  return findings;
}

// ---------------------------------------------------------------------------
// Finding bodies
// ---------------------------------------------------------------------------

function branchFinding(file: WorkflowFile, slug: string): PartialFinding {
  const line = lineOfPullRequestFilter(file.rawText.split("\n"));
  return {
    findingId: `BP-GITLEAKS-BRANCH-${slug}`,
    kind: "branch",
    title: `${MEDIUM_EMOJI} Gitleaks skips milestone PRs (\`${file.path}\`)`,
    lines: line,
    whyItMatters:
      "This repo's gitleaks copy has drifted: its `pull_request` branch " +
      "filter matches no `milestone/<slug>` branch, so secret scanning " +
      "never runs on milestone sub-issue PRs — the dominant merge path. A " +
      'GitHub branch filter `*` never matches a `/`, so the common `["*"]` ' +
      'spelling reads as "every branch" while silently skipping all of ' +
      "them. The workflow audit still counts the file as present, which is " +
      "exactly how a stale copy passes while scanning almost nothing.",
    suggestedFix: `Add \`${MILESTONE_GLOB}\` to this workflow's ` +
      "`pull_request.branches` filter so gitleaks runs on milestone PRs " +
      "too:\n\n```yaml\non:\n  pull_request:\n    branches: [Develop, main, " +
      `${MILESTONE_GLOB}]\n\`\`\`\n\nMilestone branch names are ` +
      "`milestone/<slug>` with no nested slashes, so the single-level glob " +
      "is sufficient.",
    evidence: `\`${file.path}\`:${line} — \`pull_request.branches\` matches ` +
      "no `milestone/<slug>` branch",
  };
}

function noPrTriggerFinding(file: WorkflowFile, slug: string): PartialFinding {
  const line = lineOfOnKey(file.rawText);
  return {
    findingId: `BP-GITLEAKS-NO-PR-TRIGGER-${slug}`,
    kind: "no-pr-trigger",
    title: `${MEDIUM_EMOJI} Gitleaks never runs on pull requests ` +
      `(\`${file.path}\`)`,
    lines: line,
    whyItMatters: "This is the repo's only gitleaks workflow and it has no " +
      "`pull_request` trigger, so no pull request is ever scanned for " +
      "secrets: a leaked credential is caught by the next scheduled run at " +
      "the earliest, after it has already been merged and pushed. The " +
      "workflow audit counts the file as present, so the gap is invisible " +
      "from the coverage report alone.",
    suggestedFix: "Add a `pull_request` trigger covering the branches PRs " +
      "actually target:\n\n```yaml\non:\n  pull_request:\n    branches: " +
      `[Develop, main, ${MILESTONE_GLOB}]\n\`\`\`\n\nKeep any existing ` +
      "`schedule:` trigger — the two are complementary, catching secrets " +
      "before merge and in history respectively.",
    evidence: `\`${file.path}\`:${line} — \`on:\` declares no ` +
      "`pull_request` trigger, and no other gitleaks workflow in this repo " +
      "does either",
  };
}

function staleActionFinding(
  file: WorkflowFile,
  slug: string,
  sites: readonly { line: number; ref: string }[],
): PartialFinding {
  const first = sites[0] as { line: number; ref: string };
  const refs = sites
    .map((s) => `\`${file.path}\`:${s.line} — \`${GITLEAKS_ACTION}@${s.ref}\``)
    .join("\n");
  return {
    findingId: `BP-GITLEAKS-ACTION-STALE-${slug}`,
    kind: "action-stale",
    title: `${MEDIUM_EMOJI} Gitleaks action pin is stale ` +
      `(\`${file.path}\`)`,
    lines: first.line,
    whyItMatters:
      "This copy pins `gitleaks/gitleaks-action` to a ref that is not the " +
      "one the worker emits today. A tag pin (`@v2`, `@v3`) is mutable, so " +
      "whoever hijacks the upstream tag executes code with every secret " +
      "this job can read; an out-of-date SHA is immutable but frozen, " +
      "missing the detection and licence-handling fixes since it was cut. " +
      "Either way the file passes the presence check while the scan it " +
      "runs has drifted from the canonical one.",
    suggestedFix: "Re-pin the action to the SHA this worker currently " +
      `resolves:\n\n\`\`\`yaml\n      - uses: ${GITLEAKS_ACTION}@` +
      `${CURRENT_ACTION_SHA}\n\`\`\`\n\nKeep the trailing version comment ` +
      "in step with the SHA so a future bump is reviewable, and honour the " +
      "24-hour supply-chain quarantine when adopting a newer release.",
    evidence: `Expected \`${CURRENT_ACTION_SHA}\`; found:\n\n${refs}`,
  };
}

function noFallbackFinding(file: WorkflowFile, slug: string): PartialFinding {
  const sites = actionCallSites(file.rawText);
  const line = sites.length > 0 ? (sites[0] as { line: number }).line : 1;
  return {
    findingId: `BP-GITLEAKS-NO-FALLBACK-${slug}`,
    kind: "no-fallback",
    title: `${MEDIUM_EMOJI} Gitleaks has no licence-less fallback ` +
      `(\`${file.path}\`)`,
    lines: line,
    whyItMatters:
      "This workflow scans only via `gitleaks/gitleaks-action`, which " +
      "needs an organisation licence (`GITLEAKS_LICENSE`) on org-owned " +
      "repos. Dependabot-authored PRs receive no Actions secrets, so the " +
      "licence is empty for them and the action exits with `ErrLicense` " +
      "before scanning anything (Issue #2981) — the job is green and the " +
      "diff is unscanned, which is worse than no gate at all because it " +
      "reads as covered.",
    suggestedFix: "Add the free, open-source gitleaks CLI as a " +
      "licence-less fallback, gated on the licence being absent:\n\n" +
      "```yaml\n      - name: Gitleaks (licensed action)\n" +
      "        if: env.GITLEAKS_LICENSE != ''\n" +
      `        uses: ${GITLEAKS_ACTION}@${CURRENT_ACTION_SHA}\n` +
      "      - name: Gitleaks (open-source CLI fallback)\n" +
      "        if: env.GITLEAKS_LICENSE == ''\n        run: |\n" +
      "          ./gitleaks git --redact --no-banner --exit-code 1 \\\n" +
      '            --log-opts="${BASE_SHA}..${HEAD_SHA}" .\n```\n\n' +
      "Download the CLI by pinned version and verify it against its " +
      "published SHA-256 checksum, as the canonical template does. Expose " +
      "`GITLEAKS_LICENSE` at job level so the step-level `if:` can branch " +
      "on it — the `secrets` context is unavailable in `if:`.",
    evidence: `\`${file.path}\`:${line} — \`${GITLEAKS_ACTION}\` is the only ` +
      "scanner in this workflow; no `run:` step invokes the gitleaks CLI",
  };
}
