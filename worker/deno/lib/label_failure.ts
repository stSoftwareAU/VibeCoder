/**
 * Issue failure marking and handling for the Vibe Coder worker.
 *
 * Handles the failed-once → failed progression when worker attempts fail:
 *   - `checkIssueHasFailedOnce` — detect prior failure
 *   - `markIssueAsFailedOnce` — first-failure path
 *   - `markIssueAsFailed` — second-failure (permanent) path
 *   - `handleIssueFailure` — unified handler with infrastructure self-healing
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
 * Count how many infrastructure failure comments exist on an issue.
 *
 * Counts comments containing "Automated Processing Failed" to determine how many
 * times the worker has already attempted this issue.
 *
 * Issue #387 — Self-healing for transient infrastructure failures.
 */
async function countInfraRetries(
  repo: string,
  issueNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<number> {
  try {
    const output = await ghCommandFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "comments",
      "--jq",
      '[.comments[] | select(.body | test("Automated Processing Failed"))] | length',
    ]);
    return parseInt(output.trim(), 10) || 0;
  } catch {
    return 0;
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
  const failureCategory = detectFailureCategory(options.failureMessage);
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

  let commentBody = `## Automated Processing Failed (First Attempt)

**Category:** \`${categoryDisplay}\`

The automated worker was unable to complete this issue on the first attempt.

${errorSection}

### What this means
${diagnosisOneliner}${diagSection}

### What happens next?
- This issue has been marked with the \`${labels.failedOnceLabel}\` label
- The worker will **automatically retry** this issue on the next scan
- If it fails again, the issue will be marked as \`${labels.failedLabel}\` and require manual intervention

### To prevent automatic retry
If you want to work on this manually, remove the \`${labels.failedOnceLabel}\` label and assign yourself.`;

  // Append worker identity footer (Issue #436)
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
 * Mark an issue as permanently failed (second failure).
 */
export async function markIssueAsFailed(
  options: FailureOptions,
  deps: LabelManagerDeps = {},
): Promise<Result<void>> {
  const ghCommandFn = deps.ghCommandFn ?? runGhCommand;
  const labels = options.labels ?? DEFAULT_LABEL_CONFIG;
  const clarityStatus: ClarityStatus = options.clarityStatus ?? "not_assessed";
  const diagnosticContext = options.diagnosticContext ?? "";

  // Context-aware failure diagnosis (Issue #398, #400)
  const failureCategory = detectFailureCategory(options.failureMessage);
  const categoryDisplay = getFailureCategoryDisplay(failureCategory);
  const diagnosisText = getFailureDiagnosis(
    failureCategory,
    clarityStatus,
    diagnosticContext,
  );

  const errorSection = buildErrorSection(options.failureMessage);

  let commentBody =
    `## Automated Processing Failed (Second Attempt - Permanently Failed)

**Category:** \`${categoryDisplay}\`

The automated worker has failed to complete this issue twice and will not retry automatically.

${errorSection}

### What happened?
- This issue failed on the first attempt and was marked with \`${labels.failedOnceLabel}\`
- The worker retried and failed again on the second attempt
- The issue has been marked with the \`${labels.failedLabel}\` label to prevent repeated attempts
- Manual intervention is required

### Why this likely failed
${diagnosisText}

### To retry this issue
1. Investigate and address the underlying problem (check the error output above)
2. Consider simplifying or breaking down the issue into smaller tasks
3. Remove the \`${labels.failedLabel}\` label from this issue
4. The worker will pick it up again on the next scan`;

  // Append worker identity footer (Issue #436)
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
  } catch {
    // Best-effort
  }

  // Remove the failed-once label if present
  try {
    await ghCommandFn([
      "issue",
      "edit",
      String(options.issueNumber),
      "--repo",
      options.repo,
      "--remove-label",
      labels.failedOnceLabel,
    ]);
  } catch {
    // Best-effort
  }

  // Ensure the failed label exists (Issue #44)
  // Issue #368: colour + description come from the canonical label table.
  await ensureLabelExists(
    options.repo,
    labels.failedLabel,
    undefined,
    undefined,
    deps,
  );

  // Issue #976: Use REST API with CLI fallback for label operations
  // Issue #978: Label-add is non-fatal — the comment is the primary signal
  const failedLabelResult = await addLabelToIssue(
    options.repo,
    options.issueNumber,
    labels.failedLabel,
    deps,
  );
  if (!failedLabelResult.ok) {
    console.warn(
      `[label_manager] Warning: Failed to add '${labels.failedLabel}' label to issue #${options.issueNumber} in ${options.repo} — continuing workflow (Issue #978)`,
    );
  }

  // Remove the assignee
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
 * Unified failure handler for push/PR/Claude failures.
 *
 * Checks if this is the first or second failure and calls the appropriate
 * marking function. Handles infrastructure self-healing logic.
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
  const maxInfraRetries = options.maxInfraRetries ?? 5;

  const failureCategory = detectFailureCategory(options.failureMessage);
  const isInfra = isInfrastructureFailure(failureCategory);

  const hasFailedOnce = await checkIssueHasFailedOnce(
    options.repo,
    options.issueNumber,
    labels.failedOnceLabel,
    ghCommandFn,
  );

  if (hasFailedOnce) {
    // Issue #387: Self-healing for infrastructure failures
    if (isInfra) {
      const infraRetryCount = await countInfraRetries(
        options.repo,
        options.issueNumber,
        ghCommandFn,
      );

      // Enrich diagnostic context with retry count
      let enrichedContext = options.diagnosticContext ?? "";
      if (enrichedContext) {
        enrichedContext =
          `${enrichedContext};retry_count=${infraRetryCount};max_retries=${maxInfraRetries}`;
      }

      if (infraRetryCount >= maxInfraRetries) {
        await markIssueAsFailed(
          { ...options, diagnosticContext: enrichedContext },
          deps,
        );
        return {
          ok: true,
          value: {
            markedAsFailed: true,
            markedAsFailedOnce: false,
            failureCategory,
            isInfrastructure: true,
          },
        };
      }

      // Keep as failed-once for retry
      await markIssueAsFailedOnce(
        { ...options, diagnosticContext: enrichedContext },
        deps,
      );
      return {
        ok: true,
        value: {
          markedAsFailed: false,
          markedAsFailedOnce: true,
          failureCategory,
          isInfrastructure: true,
        },
      };
    }

    // Second failure — permanent
    await markIssueAsFailed(options, deps);
    return {
      ok: true,
      value: {
        markedAsFailed: true,
        markedAsFailedOnce: false,
        failureCategory,
        isInfrastructure: false,
      },
    };
  }

  // First failure
  await markIssueAsFailedOnce(options, deps);
  return {
    ok: true,
    value: {
      markedAsFailed: false,
      markedAsFailedOnce: true,
      failureCategory,
      isInfrastructure: isInfra,
    },
  };
}
