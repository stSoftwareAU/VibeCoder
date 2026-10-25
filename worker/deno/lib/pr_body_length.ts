/**
 * Keep an issue-run pull request body inside GitHub's body limit (Issue #4359).
 *
 * Idle-task issue bodies are already clamped to
 * {@link GITHUB_ISSUE_BODY_MAX_CHARS}. The pull request body — the summary
 * file plus the worker's own sections — was not. GitHub rejects `gh pr create`
 * and `gh pr edit` with `Body is too long (maximum is 65536 characters)`, and
 * that rejection failed a run whose branch was already delivered.
 *
 * The worker does not cut first. It asks the agent once to rewrite the
 * summary so the body fits, keeping the blocks the gates read, condensing the
 * prose and linking the summary file on the branch. Completion then runs the
 * same checks on that rewrite and publishes it. A mechanical cut is only the
 * last resort, when the rewrite is still too long or the turn fails, and the
 * pull request is still raised.
 *
 * Australian English throughout (behaviour, summarised).
 */

import { GITHUB_ISSUE_BODY_MAX_CHARS } from "./idle_task_body_limit.ts";
import { hasClosingKeyword, WORKER_PR_MARKER_PREFIX } from "./pr_body.ts";
import {
  type IssueContext,
  type PhaseResult,
  type PhaseState,
  recordClaudeRunStats,
} from "./issue_worker_types.ts";
import type { WorkerDeps } from "./issue_worker_wiring.ts";
import { resolvePreFlightSpec } from "./git_push.ts";

/** Repo-relative path of the summary file a pull request body is built from. */
export function prSummaryFilePath(issueNumber: number): string {
  return `docs/archive/pr-summaries/pr-summary-${issueNumber}.md`;
}

/**
 * Visible notice that replaces prose a mechanical cut dropped. Greppable.
 * The summary file on the branch is linked so a reader can open the full text.
 */
export const PR_BODY_LENGTH_DEGRADATION_NOTE =
  "⚠️ **Pull request body shortened to fit GitHub's limit.**";

/**
 * Phase-failure reason used only to hand the run to the one summarise turn.
 * It is not the outcome of a run: the turn, or the mechanical cut, still
 * raises the pull request.
 */
export const PR_BODY_TOO_LONG_REASON =
  "Pull request body exceeds GitHub's 65536-character limit";

/** Characters kept back for the link the agent adds and for image URL expansion. */
const SUMMARY_BUDGET_RESERVE = 1024;

const FOOTER_MARK = "\n---\n\n🤖 Processed by:";

const GATE_HEADINGS = new Set([
  "## Acceptance Criteria",
  "## Standards Review",
  "## Reproduction",
]);

/** What the one summarise turn is asked to do. Worker-authored; no summary text. */
export interface PrBodyLengthBlock {
  prompt: string;
}

/** GitHub's `Body is too long (maximum is 65536 characters)` rejection. */
export function isGitHubBodyTooLongMessage(message: string): boolean {
  return message.includes("Body is too long");
}

/**
 * How long the summary itself may be so the assembled body stays inside the
 * limit. `assembledLength` is the body the worker is about to publish;
 * `summaryLength` is the summary file inside it.
 */
export function summaryCharacterBudget(
  assembledLength: number,
  summaryLength: number,
  maxChars: number = GITHUB_ISSUE_BODY_MAX_CHARS,
): number {
  const overhead = Math.max(0, assembledLength - summaryLength);
  return Math.max(0, maxChars - overhead - SUMMARY_BUDGET_RESERVE);
}

/** The one-turn brief. It names the file, the limit and the blocks to keep. */
export function buildPrBodyLengthPrompt(input: {
  issueNumber: number;
  assembledLength: number;
  summaryLength: number;
  maxChars?: number;
}): string {
  const maxChars = input.maxChars ?? GITHUB_ISSUE_BODY_MAX_CHARS;
  const summaryPath = prSummaryFilePath(input.issueNumber);
  const budget = summaryCharacterBudget(
    input.assembledLength,
    input.summaryLength,
    maxChars,
  );
  return [
    `The pull request body is ${input.assembledLength} characters.`,
    `GitHub rejects a pull request body over ${maxChars} characters,`,
    "so this pull request cannot be opened until the summary is shorter.",
    "",
    `Rewrite \`${summaryPath}\` so the assembled pull request body fits.`,
    "The worker appends its own sections, footer and markers after the summary.",
    `Keep the summary at or under ${budget} characters.`,
    "",
    "Do this:",
    '- Keep the worker-owned blocks the gates read: the `## Acceptance Criteria` closure, including `<!-- vibe-spec-review inputs="diff+issue-body" -->`, the `## Standards Review`, including `<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->`, and `## Reproduction` when the summary has one.',
    "- Condense the prose. Drop repeated evidence, long logs and quoted command output.",
    `- Link the full summary file on the branch: \`${summaryPath}\`.`,
    "- Do not change code. Leave the rewritten summary in that file.",
    "",
    "The worker will run the same checks on the rewritten summary and then open or update the pull request. Do not run `gh pr create` or `gh pr edit` yourself.",
  ].join("\n");
}

export type PrBodyLengthAssessment =
  | { action: "ok" }
  | { action: "ask"; prompt: string }
  | { action: "degrade"; body: string };

/**
 * Decide what to do with a body that may be over the limit.
 *
 * Under the limit, publish it. Over the limit and not yet asked, ask the
 * agent — do not cut. Over the limit after that one turn, cut.
 */
export function assessPrBodyLength(input: {
  body: string;
  summaryLength: number;
  issueNumber: number;
  retryAttempted: boolean;
  maxChars?: number;
}): PrBodyLengthAssessment {
  const maxChars = input.maxChars ?? GITHUB_ISSUE_BODY_MAX_CHARS;
  if (input.body.length <= maxChars) return { action: "ok" };
  if (!input.retryAttempted) {
    return {
      action: "ask",
      prompt: buildPrBodyLengthPrompt({
        issueNumber: input.issueNumber,
        assembledLength: input.body.length,
        summaryLength: input.summaryLength,
        maxChars,
      }),
    };
  }
  return {
    action: "degrade",
    body: degradePrBodyToGitHubLimit(input.body, {
      summaryPath: prSummaryFilePath(input.issueNumber),
      issueNumber: input.issueNumber,
      maxChars,
    }).body,
  };
}

export interface DegradedPrBody {
  body: string;
  degraded: boolean;
  originalLength: number;
}

/**
 * Last-resort cut. Keeps the worker footer and markers, the gate sections
 * (`## Acceptance Criteria`, `## Standards Review`, `## Reproduction`) and a
 * link to the summary file. The result is never over the limit.
 *
 * Throws on a non-positive `maxChars` — an impossible budget is a bug.
 */
export function degradePrBodyToGitHubLimit(
  body: string,
  opts: { summaryPath: string; issueNumber?: number; maxChars?: number },
): DegradedPrBody {
  const maxChars = opts.maxChars ?? GITHUB_ISSUE_BODY_MAX_CHARS;
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    throw new Error(
      `degradePrBodyToGitHubLimit: maxChars must be a positive number, got ${maxChars}`,
    );
  }
  const originalLength = body.length;
  if (originalLength <= maxChars) {
    return { body, degraded: false, originalLength };
  }

  const hadClose = opts.issueNumber !== undefined &&
    hasClosingKeyword(body, opts.issueNumber);
  const { prose, sections, tail } = splitForDegrade(body);
  let keptSections = sections;
  let keptNotice = buildDegradationNotice(
    opts.summaryPath,
    originalLength,
    maxChars,
  );
  let keptTail = tail;

  const render = (head: string): string =>
    [head, keptNotice, keptSections, keptTail].filter((part) => part.length > 0)
      .join("\n\n");

  if (render("").length > maxChars) {
    keptSections = shrinkGateSections(sections);
  }
  if (render("").length > maxChars) keptSections = "";
  if (render("").length > maxChars) {
    keptNotice = `Full summary: [\`${opts.summaryPath}\`](${opts.summaryPath})`;
  }
  if (render("").length > maxChars) {
    const room = Math.max(0, maxChars - keptNotice.length - 2);
    keptTail = room > 0
      ? keptTail.slice(Math.max(0, keptTail.length - room))
      : "";
    keptSections = "";
  }

  const closeLine = hadClose && opts.issueNumber !== undefined
    ? `\n\nCloses #${opts.issueNumber}`
    : "";
  const separator = render("").length > 0 ? 2 : 0;
  const budget = Math.max(
    0,
    maxChars - render("").length - separator - closeLine.length,
  );
  let head = budget > 0 ? cutOnLineBoundary(prose, budget) : "";
  let rendered = render(head);
  if (rendered.length + closeLine.length > maxChars && head.length > 0) {
    const overflow = rendered.length + closeLine.length - maxChars;
    head = cutOnLineBoundary(head, Math.max(0, head.length - overflow));
    rendered = render(head);
  }
  if (
    closeLine.length > 0 && opts.issueNumber !== undefined &&
    !hasClosingKeyword(rendered, opts.issueNumber) &&
    rendered.length + closeLine.length <= maxChars
  ) {
    rendered += closeLine;
  }
  if (rendered.length > maxChars) {
    // The fixed tail (notice, gate sections, worker markers) is what must
    // survive. Drop the prose head before touching it.
    rendered = render("");
    if (
      closeLine.length > 0 && opts.issueNumber !== undefined &&
      !hasClosingKeyword(rendered, opts.issueNumber) &&
      rendered.length + closeLine.length <= maxChars
    ) {
      rendered += closeLine;
    }
  }
  if (rendered.length > maxChars) rendered = rendered.slice(0, maxChars);
  return { body: rendered, degraded: true, originalLength };
}

function buildDegradationNotice(
  summaryPath: string,
  originalLength: number,
  maxChars: number,
): string {
  return [
    `> ${PR_BODY_LENGTH_DEGRADATION_NOTE}`,
    `> ${originalLength} characters would not fit in GitHub's ${maxChars}-character pull request body.`,
    `> Full summary on this branch: [\`${summaryPath}\`](${summaryPath})`,
  ].join("\n");
}

function splitForDegrade(
  body: string,
): { prose: string; sections: string; tail: string } {
  const footerAt = body.lastIndexOf(FOOTER_MARK);
  let before: string;
  let tail: string;
  if (footerAt >= 0) {
    before = body.slice(0, footerAt);
    tail = body.slice(footerAt);
  } else {
    const markerAt = body.lastIndexOf(WORKER_PR_MARKER_PREFIX);
    if (markerAt >= 0) {
      const lineStart = body.lastIndexOf("\n", markerAt) + 1;
      before = body.slice(0, lineStart);
      tail = body.slice(lineStart);
    } else {
      before = body;
      tail = "";
    }
  }
  const { prose, sections } = splitProseAndSections(before);
  return { prose, sections, tail };
}

function isHeading2(line: string): boolean {
  return line.startsWith("## ");
}

function splitProseAndSections(
  before: string,
): { prose: string; sections: string } {
  const lines = before.split("\n");
  const prose: string[] = [];
  const sections: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!GATE_HEADINGS.has(line.trim())) {
      prose.push(line);
      index++;
      continue;
    }
    const section = [line];
    index++;
    while (index < lines.length && !isHeading2(lines[index]!)) {
      section.push(lines[index]!);
      index++;
    }
    sections.push(section.join("\n").trimEnd());
  }
  return {
    prose: prose.join("\n").trim(),
    sections: sections.join("\n\n").trim(),
  };
}

function shrinkGateSections(sections: string): string {
  if (sections.length === 0) return "";
  return sections.split("\n").filter((line) =>
    isHeading2(line) || line.includes("vibe-spec-review") ||
    line.includes("vibe-standards-review")
  ).join("\n");
}

function cutOnLineBoundary(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (text.length <= budget) return text;
  const hard = text.slice(0, budget);
  const lastNewline = hard.lastIndexOf("\n");
  return lastNewline > 0 ? hard.slice(0, lastNewline) : hard;
}

/**
 * One summarise turn, then one completion re-run (Issue #4359).
 *
 * The attempted flag is set before the agent runs, so a throw or a re-entry
 * cannot ask twice. A turn that fails still re-runs completion, which then
 * shortens the body and raises the pull request.
 */
export async function recoverFromPrBodyLength(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
  rerunCompletion: () => Promise<PhaseResult>,
): Promise<PhaseResult> {
  const logger = deps.logger;
  const { repo, issueNumber, config } = ctx;
  const block = state.prBodyLengthBlock;
  state.prBodyLengthRetryAttempted = true;
  delete state.prBodyLengthBlock;

  if (!block) {
    logger.error(
      "No pull-request body length block to act on — failing as reported (Issue #4359)",
      { repo, issueNumber },
    );
    return {
      category: "unknown",
      status: "failure",
      reason: PR_BODY_TOO_LONG_REASON,
    };
  }

  logger.warn(
    "Pull request body is over GitHub's limit — asking the agent once to " +
      "rewrite the summary (Issue #4359)",
    { repo, issueNumber },
  );

  let retryResult;
  try {
    retryResult = await deps.claude.runClaudeWithRetry(
      {
        prompt: block.prompt,
        phase: "issue",
        repo,
        issueNumber,
        timeoutSeconds: config.claudeTimeout,
        killAfterSeconds: config.claudeKillAfter,
        model: config.claudeModel || undefined,
        cwd: state.repoPath,
        logger,
      },
      { maxRetries: config.maxRateLimitRetries },
    );
  } catch (err) {
    logger.error(
      "Pull request body summarise turn failed — the pull request is still " +
        `raised with a shortened body if the rewrite does not fit (Issue #4359): ${
          err instanceof Error ? err.message : String(err)
        }`,
      { repo, issueNumber },
    );
    return await rerunCompletion();
  }

  if (
    !retryResult.ok || retryResult.value.timedOut === true ||
    retryResult.value.exitCode !== 0
  ) {
    const detail = !retryResult.ok
      ? retryResult.error.message
      : retryResult.value.timedOut === true
      ? `timed out after ${config.claudeTimeout}s`
      : `exited with code ${retryResult.value.exitCode}`;
    logger.error(
      "Pull request body summarise turn failed — the pull request is still " +
        `raised with a shortened body if the rewrite does not fit (Issue #4359): ${detail}`,
      { repo, issueNumber },
    );
    return await rerunCompletion();
  }

  recordClaudeRunStats(state, retryResult.value);
  await commitRewrittenSummary(ctx, state, deps);
  return await rerunCompletion();
}

async function commitRewrittenSummary(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<void> {
  const { repo, issueNumber, config } = ctx;
  const logger = deps.logger;
  const reconcile = await deps.git.reconcileHeadToBranch(state.branchName, {
    cwd: state.repoPath,
  });
  if (!reconcile.ok) {
    logger.error(
      `Could not put HEAD back on '${state.branchName}' to commit the ` +
        `shortened summary — the re-run still reads the working tree: ${reconcile.error.message}`,
      { repo, issueNumber },
    );
    return;
  }
  const commit = await deps.git.commitAndPushPending(
    state.branchName,
    `docs: shorten PR summary for #${issueNumber}\n\n` +
      "In-run pull-request body limit recovery (Issue #4359).",
    { cwd: state.repoPath },
    false,
    resolvePreFlightSpec(config.repoConfig, repo),
  );
  if (!commit.ok) {
    logger.error(
      `Could not commit the shortened summary on '${state.branchName}' — ` +
        `the re-run still reads the working tree: ${commit.error.message}`,
      { repo, issueNumber },
    );
    return;
  }
  logger.info("Shortened PR summary committed before completion re-runs", {
    repo,
    issueNumber,
    committedNewChanges: commit.value.committedNewChanges,
  });
}
