/**
 * Question clarification detection and handling (Issue #665, #914, #2031).
 *
 * When Claude answers a question, it may determine the question is too
 * broad or ambiguous. In that case it outputs a response starting with
 * "## Clarification Needed". This module detects that marker and provides
 * functions to extract the body and post the clarification request.
 *
 * Clarification is NOT counted as a failure — it is a valid response that
 * helps the user provide more context for a better answer.
 *
 * Issue #2031: the post-clarification handoff signal is `needs-human`
 * (replacing the retired `needs-clarification` label). The user re-adds
 * the `question` label to retry once they have provided the requested
 * information.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import { runGhOrThrow } from "./gh_spawn.ts";

/** The marker that identifies a clarification request. */
const CLARIFICATION_MARKER = "## Clarification Needed";

/**
 * Options for posting a clarification request.
 */
export interface PostClarificationOptions {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Issue number. */
  issueNumber: number;
  /** Worker's GitHub username. */
  githubUser: string;
  /** The clarification body text (without the header). */
  clarificationBody: string;
  /** Label used for questions (default: "question"). */
  questionLabel?: string;
  /** Label for needs-human handoff (default: "needs-human") (Issue #2031). */
  needsHumanLabel?: string;
  /** Optional worker identity footer text. */
  workerFooter?: string;
  /** Optional logger. */
  logger?: Logger;
  /** Injectable gh command function for testability. */
  ghCommandFn?: (args: string[]) => Promise<string>;
}

/**
 * Run a gh CLI command.
 */
async function runGhCommand(args: string[]): Promise<string> {
  return await runGhOrThrow(args);
}

/**
 * Detect whether Claude's output is a clarification request.
 *
 * Checks whether the output starts with "## Clarification Needed" after
 * stripping leading whitespace/blank lines. Only detects the marker at
 * the start of output — if it appears mid-output, the response is treated
 * as a normal answer.
 *
 * @param claudeOutput - The output from Claude
 * @returns true if the output is a clarification request
 */
export function detectQuestionClarificationRequest(
  claudeOutput: string,
): boolean {
  if (!claudeOutput) {
    return false;
  }

  // Strip leading blank lines and whitespace, check first non-blank line
  const lines = claudeOutput.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    return trimmed.startsWith(CLARIFICATION_MARKER);
  }

  return false;
}

/**
 * Extract the body text from a clarification request.
 *
 * Strips the "## Clarification Needed" header and any leading blank lines,
 * returning only the body content.
 *
 * @param claudeOutput - The full clarification output from Claude
 * @returns The body text without the header
 */
export function extractClarificationBody(claudeOutput: string): string {
  const lines = claudeOutput.split("\n");

  // Skip leading blank lines
  let startIdx = 0;
  while (
    startIdx < lines.length && (lines[startIdx] ?? "").trim().length === 0
  ) {
    startIdx++;
  }

  // Skip the header line
  if (startIdx < lines.length) {
    startIdx++;
  }

  // Skip blank lines after header
  while (
    startIdx < lines.length && (lines[startIdx] ?? "").trim().length === 0
  ) {
    startIdx++;
  }

  return lines.slice(startIdx).join("\n");
}

/**
 * Post a clarification request comment and manage labels.
 *
 * Posts the clarification body as a comment, removes the question label,
 * adds the needs-human label (Issue #2031), and unassigns the worker.
 * This is NOT treated as a failure — no failed-once/failed progression
 * occurs.
 *
 * @param options - Options for posting the clarification
 * @returns Result with true on success, error on failure
 */
export async function postQuestionClarification(
  options: PostClarificationOptions,
): Promise<Result<boolean>> {
  const {
    repo,
    issueNumber,
    githubUser,
    clarificationBody,
    questionLabel = "question",
    needsHumanLabel = "needs-human",
    workerFooter,
    logger,
    ghCommandFn = runGhCommand,
  } = options;

  logger?.info(
    `Posting clarification request for question on issue #${issueNumber} (Issue #665)`,
  );

  // Build the comment body
  let commentBody =
    `## Clarification Needed\n\nBefore answering this question, some additional information would help provide a more useful response.\n\n${clarificationBody}\n\n---\n\n*Once you have provided the requested information, add the \`${questionLabel}\` label again to get an updated answer.*`;

  if (workerFooter) {
    commentBody += workerFooter;
  }

  // Post the comment
  try {
    await ghCommandFn([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repo,
      "--body",
      commentBody,
    ]);
  } catch (error: unknown) {
    logger?.warn(
      `Failed to post clarification comment on issue #${issueNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      ok: false,
      error: new Error(
        `Failed to post clarification comment: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }

  // Remove the question label
  logger?.info(
    `Removing '${questionLabel}' label from issue #${issueNumber} after clarification request`,
  );
  try {
    await ghCommandFn([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--remove-label",
      questionLabel,
    ]);
  } catch {
    // Non-critical — continue
  }

  // Add needs-human label (Issue #2031: replaces retired needs-clarification)
  // Issue #976: Use REST API with CLI fallback for label operations
  try {
    await ghCommandFn([
      "api",
      "-X",
      "POST",
      `repos/${repo}/issues/${issueNumber}/labels`,
      "-f",
      `labels[]=${needsHumanLabel}`,
    ]);
  } catch {
    // REST API failed — fall back to CLI
    try {
      await ghCommandFn([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--add-label",
        needsHumanLabel,
      ]);
    } catch (error: unknown) {
      logger?.warn(
        `Failed to add '${needsHumanLabel}' label to issue #${issueNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        ok: false,
        error: new Error(
          `Failed to add needs-human label: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      };
    }
  }

  // Unassign the worker — ball is in the user's court
  try {
    await ghCommandFn([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--remove-assignee",
      githubUser,
    ]);
  } catch {
    // Non-critical — continue
  }

  logger?.info(
    `Clarification request posted for question on issue #${issueNumber} (Issue #665)`,
  );
  return { ok: true, value: true };
}
