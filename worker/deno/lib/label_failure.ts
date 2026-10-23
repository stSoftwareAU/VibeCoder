/**
 * Issue failure marking and handling for the Vibe Coder worker.
 *
 * Records worker failures on the issue with the `failed-once` label:
 *   - `checkIssueHasFailedOnce` — detect prior failure
 *   - `markIssueAsFailedOnce` — writes the failure record and the label
 *   - `handleIssueFailure` — unified handler
 *
 * Issue #4158: a failure is never terminal. An assigned issue is completed,
 * never parked (DESIGN-PRINCIPLES.md), so a repeat failure keeps
 * `failed-once`, writes its record and stays claimable once the escalating
 * cooldown ends. The worker never applies `failed`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGhCommand } from "./github.ts";
import {
  type ClarityStatus,
  detectFailureCategory,
  extractKeyErrorLines,
  formatZeroOutputDiagnostics,
  getFailureCategoryDisplay,
  getFailureDiagnosis,
  getFailureDiagnosisOneliner,
  isInfrastructureFailure,
} from "./failure_diagnosis.ts";
import type {
  FailureOptions,
  HandleFailureOptions,
  HandleFailureResult,
  LabelManagerDeps,
} from "./label_types.ts";
import { DEFAULT_LABEL_CONFIG } from "./label_types.ts";
import { addLabelToIssue, ensureLabelExists } from "./label_operations.ts";
import { redactSecrets } from "./secret_redaction.ts";
import {
  buildHostFaultMarker,
  buildHostFaultNote,
  detectHostFault,
  type HostFaultKind,
  QUALITY_GATE_SOURCE_NOTE,
} from "./host_fault.ts";

/**
 * Issue #3445: quality-gate output is repository-authored, so it is never a
 * host fault.
 */
function hostFaultFor(options: FailureOptions): HostFaultKind | null {
  return options.qualityGateOutput
    ? null
    : detectHostFault(options.failureMessage, options.category);
}

function qualityGateLine(options: FailureOptions): string {
  return options.qualityGateOutput ? `\n\n${QUALITY_GATE_SOURCE_NOTE}` : "";
}

/**
 * Check if an issue already has the failed-once label.
 */
export async function checkIssueHasFailedOnce(
  repo: string,
  issueNumber: number,
  failedOnceLabel: string = "failed-once",
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<boolean> {
  try {
    const output = await ghCommandFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "labels",
      "--jq",
      '[.labels[].name] | join(",")',
    ]);
    return output.includes(failedOnceLabel);
  } catch {
    return false;
  }
}

/**
 * Build the error section for a failure comment.
 *
 * Issue #733: Extract key error lines for prominent display.
 *
 * Issue #3425: The raw tail of Claude's stdout (captured on OOM/timeout) is
 * embedded verbatim in a public issue comment. Route it through the
 * `redactSecrets()` chokepoint first so a tokenised git remote URL, `GH_TOKEN`,
 * or `sk-ant-…` credential that landed in the tail is masked before it reaches
 * the public sink — mirroring `answer_sanitiser.ts`, `logger.ts`, and
 * `crash_notification.ts`.
 */
function buildErrorSection(rawFailureMessage: string): string {
  const failureMessage = redactSecrets(rawFailureMessage);
  const keyErrors = extractKeyErrorLines(failureMessage);

  if (keyErrors) {
    const quotedErrors = keyErrors
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return `### Error Output\n${quotedErrors}\n\n<details>\n<summary>Full output (click to expand)</summary>\n\n${failureMessage}\n</details>`;
  }

  return `### Error Output\n> No specific error lines detected — see full output below.\n\n<details>\n<summary>Full output (click to expand)</summary>\n\n${failureMessage}\n</details>`;
}

/**
 * Mark an issue as having failed once (first failure).
 *
 * This is called on the first failure. The issue will be retried once more
 * before being permanently marked as failed.
 */
export async function markIssueAsFailedOnce(
  options: FailureOptions,
  deps: LabelManagerDeps = {},
): Promise<Result<void>> {
  const ghCommandFn = deps.ghCommandFn ?? runGhCommand;
  const labels = options.labels ?? DEFAULT_LABEL_CONFIG;
  const clarityStatus: ClarityStatus = options.clarityStatus ?? "not_assessed";
  const diagnosticContext = options.diagnosticContext ?? "";

  // Context-aware failure diagnosis (Issue #398, #400)
  const failureCategory = options.category ??
    detectFailureCategory(options.failureMessage);
  const categoryDisplay = getFailureCategoryDisplay(failureCategory);
  const diagnosisOneliner = getFailureDiagnosisOneliner(
    failureCategory,
    clarityStatus,
  );

  // Issue #533: For zero_output, include diagnostic context
  let diagnosticSummary = "";
  if (failureCategory === "zero_output" && diagnosticContext) {
    diagnosticSummary = formatZeroOutputDiagnostics(diagnosticContext);
  }

  const errorSection = buildErrorSection(options.failureMessage);

  let diagSection = "";
  if (diagnosticSummary) {
    diagSection = `\n\n### Diagnostic Context\n${diagnosticSummary}`;
  }

  // Issue #2890: a failure caused by the worker host itself (a corrupt
  // clone, a full disk, a container image that would not build) is not a
  // fault of this issue, so it is called out so a later sweep can release
  // the label once the host is healthy again. Quality-gate output is the
  // repository's own, so it is never one (Issue #3445).
  const hostFault = hostFaultFor(options);
  const hostFaultLine = hostFault ? `\n\n${buildHostFaultNote(hostFault)}` : "";

  const attempt = options.repeat ? "Repeat Attempt" : "First Attempt";
  const opening = options.repeat
    ? "The automated worker failed to complete this issue again."
    : "The automated worker was unable to complete this issue on the first attempt.";

  let commentBody = `## Automated Processing Failed (${attempt})

**Category:** \`${categoryDisplay}\`${hostFaultLine}${qualityGateLine(options)}

${opening}

${errorSection}

### What this means
${diagnosisOneliner}${diagSection}

### What happens next?
- This issue carries the \`${labels.failedOnceLabel}\` label as the record of its failures
- The worker will **automatically retry** this issue once its cooldown ends (2 h, rising to 24 h after repeated failures)
- The issue is never parked: an assigned issue is completed, and a failure to finish it is the Vibe Coder's to fix (Issue #4158)

### To prevent automatic retry
If you want to work on this manually, remove the \`${labels.failedOnceLabel}\` label and assign yourself.`;

  // Append worker identity footer (Issue #436)
  if (options.workerFooter) {
    commentBody += options.workerFooter;
  }

  // Issue #2890: the marker must be the very last line of the comment body,
  // after the optional worker footer, so the later sweep can find it without
  // parsing the whole comment.
  if (hostFault) {
    commentBody += `\n\n${buildHostFaultMarker(hostFault)}`;
  }

  try {
    await ghCommandFn([
      "issue",
      "comment",
      String(options.issueNumber),
      "--repo",
      options.repo,
      "--body",
      commentBody,
    ]);
  } catch {
    // Best-effort
  }

  // Ensure the failed-once label exists before adding it (Issue #44)
  await ensureLabelExists(
    options.repo,
    labels.failedOnceLabel,
    "fbca04",
    "Issue failed once - will be retried",
    deps,
  );

  // Issue #976: Use REST API with CLI fallback for label operations
  // Issue #978: Label-add is non-fatal — the comment is the primary signal
  const labelResult = await addLabelToIssue(
    options.repo,
    options.issueNumber,
    labels.failedOnceLabel,
    deps,
  );
  if (!labelResult.ok) {
    console.warn(
      `[label_manager] Warning: Failed to add '${labels.failedOnceLabel}' label to issue #${options.issueNumber} in ${options.repo} — continuing workflow (Issue #978)`,
    );
  }

  // Remove the assignee so it can be picked up again
  try {
    await ghCommandFn([
      "issue",
      "edit",
      String(options.issueNumber),
      "--repo",
      options.repo,
      "--remove-assignee",
      options.githubUser,
    ]);
  } catch {
    // Best-effort
  }

  return { ok: true, value: undefined };
}

/**
 * Record a repository-configuration refusal without labelling the issue
 * (Issue #2220).
 *
 * The repository refused the milestone branch, which it will refuse
 * identically for every sibling issue, so nothing about this issue failed and
 * nothing about it should be marked. The comment is still written — a run
 * that ended with no PR must say why — but it applies no label and removes
 * no assignee beyond the caller's own release, leaving the issue claimable
 * the moment the repository is fixed.
 */
async function recordRepoConfigRefusal(
  options: FailureOptions,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<void> {
  const failureCategory = options.category ??
    detectFailureCategory(options.failureMessage);
  const categoryDisplay = getFailureCategoryDisplay(failureCategory);
  const errorSection = buildErrorSection(options.failureMessage);
  const diagnosisText = getFailureDiagnosis(
    failureCategory,
    options.clarityStatus ?? "not_assessed",
    options.diagnosticContext ?? "",
  );

  let commentBody = `## Automated Processing Paused (Repository Configuration)

**Category:** \`${categoryDisplay}\`

${errorSection}

### Why this issue is NOT labelled
${diagnosisText}

### What happens next?
- No \`${
    options.labels?.failedOnceLabel ?? DEFAULT_LABEL_CONFIG.failedOnceLabel
  }\` or \`${
    options.labels?.failedLabel ?? DEFAULT_LABEL_CONFIG.failedLabel
  }\` label was applied — this issue is still claimable
- Fix the repository configuration named above; the next scan picks this issue up with no further human action`;

  if (options.workerFooter) {
    commentBody += options.workerFooter;
  }

  try {
    await ghCommandFn([
      "issue",
      "comment",
      String(options.issueNumber),
      "--repo",
      options.repo,
      "--body",
      commentBody,
    ]);
  } catch (err) {
    // The absent label is the substantive outcome, so a failed comment must
    // not turn a non-fault into one — but it is said out loud rather than
    // swallowed, because an issue with no record reads as untouched.
    console.warn(
      `[label_manager] Warning: could not record the repository-configuration ` +
        `refusal on issue #${options.issueNumber} in ${options.repo}: ` +
        `${err instanceof Error ? err.message : String(err)} (Issue #2220)`,
    );
  }
}

/**
 * Unified failure handler for push/PR/Claude failures.
 *
 * Records the failure on the issue with `failed-once`, as a repeat when the
 * label is already there. Never terminal (Issue #4158): the issue stays
 * claimable, and the cooldown alone paces the next attempt.
 *
 * NOTE: This does NOT handle git branch cleanup — the caller is responsible
 * for that (git checkout, branch deletion, etc.).
 */
export async function handleIssueFailure(
  options: HandleFailureOptions,
  deps: LabelManagerDeps = {},
): Promise<Result<HandleFailureResult>> {
  const ghCommandFn = deps.ghCommandFn ?? runGhCommand;
  const labels = options.labels ?? DEFAULT_LABEL_CONFIG;

  const failureCategory = options.category ??
    detectFailureCategory(options.failureMessage);

  // A scheduled release never enters the ladder (Issue #424, parent #397).
  // The cycle ended, or the supervisor's hard cap was reached, with the WIP
  // committed and pushed — the attempt did not fail, it handed over. Marking
  // it `failed-once` pollutes the failure record for a scheduled handover,
  // and a second one would permanently `failed` an issue nothing is wrong
  // with. The claim-release comment carries the scheduled-release wording,
  // so the outcome is still recorded — just not as a fault.
  //
  // A token lacking the `workflow` scope is the same: a gap in this host's
  // credential, not in the issue (Issue #2689). Another host's token may
  // push it, so label nothing and leave it claimable. Laddering it parked
  // GRQ#4939 with `failed-once` and `needs-human` over one host's token.
  if (
    failureCategory === "scheduled_release" || failureCategory === "token_scope"
  ) {
    return {
      ok: true,
      value: {
        markedAsFailedOnce: false,
        failureCategory,
        isInfrastructure: false,
      },
    };
  }

  // A damaged host shared clone never enters the ladder either (Issue
  // #2884). Broken refs or a corrupt object store on the host's shared clone
  // meet every issue claimed on this host identically, so this is defence in
  // depth: `clone_corrupt` is already non-infrastructure per
  // `isInfrastructureFailure` and already in the ladder's transient class,
  // but a caller reaching this function directly must still never label the
  // issue `failed-once`/`failed` for a fault that is the host's, not the
  // issue's.
  if (failureCategory === "clone_corrupt") {
    return {
      ok: true,
      value: {
        markedAsFailedOnce: false,
        failureCategory,
        isInfrastructure: false,
      },
    };
  }

  // A repository-level milestone-branch refusal never enters the ladder
  // either (Issue #2220). The repository refused the branch — a ruleset, a
  // protection, or a permission the fleet account lacks — and it refuses it
  // identically for every sibling issue in the milestone. Labelling this
  // issue records a repository setting against work that never ran: sixteen
  // GRQ-FX-validation sub-issues took `failed-once`, six went on to
  // `failed`, and a human had to strip every one by hand after the ruleset
  // was repaired. Comment once, label nothing, leave it claimable.
  if (failureCategory === "repo_config") {
    await recordRepoConfigRefusal(options, ghCommandFn);
    return {
      ok: true,
      value: {
        markedAsFailedOnce: false,
        failureCategory,
        isInfrastructure: false,
      },
    };
  }

  const isInfra = isInfrastructureFailure(failureCategory);

  // Issue #4158: a repeat failure is recorded as one and nothing more. It
  // keeps `failed-once` and stays claimable once the escalating cooldown
  // ends; parking it behind `failed` would hand an assigned issue back.
  const repeat = await checkIssueHasFailedOnce(
    options.repo,
    options.issueNumber,
    labels.failedOnceLabel,
    ghCommandFn,
  );

  await markIssueAsFailedOnce({ ...options, repeat }, deps);
  return {
    ok: true,
    value: {
      markedAsFailedOnce: true,
      failureCategory,
      isInfrastructure: isInfra,
    },
  };
}
