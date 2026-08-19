/**
 * Partial answer posting on timeout (Issue #661, #913).
 *
 * When Claude times out while answering a question (exit code 124 or 137),
 * any output produced before the timeout is posted as a partial answer
 * rather than being discarded. This gives the user useful content even when
 * the full answer could not be completed.
 *
 * Migrated from worker/shared/partial_answer.sh.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import { sanitiseAnswerOutput } from "./answer_sanitiser.ts";
import { runGhOrThrow } from "./gh_spawn.ts";

/** Options for posting a partial answer. */
export interface PartialAnswerOptions {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Issue number. */
  issueNumber: number;
  /** Worker's GitHub username. */
  githubUser: string;
  /** The partial output from Claude. */
  claudeOutput: string;
  /** Label used for questions (default: "question"). */
  questionLabel?: string;
  /** Optional worker identity footer text. */
  workerFooter?: string;
  /** Optional logger. */
  logger?: Logger;
  /** Injectable gh command function for testability. */
  ghCommandFn?: (args: string[]) => Promise<string>;
}

/**
 * Run a gh CLI command.
 *
 * @param args - Arguments to pass to gh
 * @returns Output from the command
 */
async function runGhCommand(args: string[]): Promise<string> {
  return await runGhOrThrow(args);
}

/**
 * Build the partial answer comment body with disclaimer header.
 *
 * @param sanitisedOutput - The sanitised Claude output
 * @param questionLabel - Label used for questions
 * @param workerFooter - Optional worker identity footer
 * @returns The formatted comment body
 */
export function buildPartialAnswerBody(
  sanitisedOutput: string,
  questionLabel: string,
  workerFooter?: string,
): string {
  let body =
    `## Partial Answer (Timed Out)\n\nThe worker ran out of time while preparing a full answer. Here is what was generated before the timeout:\n\n---\n\n${sanitisedOutput}\n\n---\n\n*This partial answer was generated automatically by the Vibe Coder. The response may be incomplete. Add the \`${questionLabel}\` label again to request a more complete answer, or consider simplifying/splitting the question.*`;

  if (workerFooter) {
    body += workerFooter;
  }

  return body;
}

/**
 * Post a partial answer from a timed-out question.
 *
 * Sanitises the partial output and posts it as a comment with a clear
 * disclaimer header. Keeps the question label so the user can see the
 * question was not fully answered (Issue #672). Does NOT add the answered
 * label (since the answer is incomplete) and does NOT add a failed-once
 * label (since the user received useful content).
 *
 * @param options - Options for posting the partial answer
 * @returns Result with true if posted successfully, false if output was
 *          empty or only meta-commentary
 */
export async function postPartialAnswer(
  options: PartialAnswerOptions,
): Promise<Result<boolean>> {
  const {
    repo,
    issueNumber,
    claudeOutput,
    questionLabel = "question",
    workerFooter,
    logger,
    ghCommandFn = runGhCommand,
  } = options;

  // Empty output — nothing to post
  if (!claudeOutput) {
    logger?.info(
      `No partial output to post for question #${issueNumber} (Issue #661)`,
    );
    return { ok: true, value: false };
  }

  // Sanitise the output to remove meta-commentary (Issue #332)
  const sanitisedOutput = sanitiseAnswerOutput(claudeOutput);

  // If sanitisation left nothing, fall back to failure handling
  if (!sanitisedOutput) {
    logger?.info(
      `Partial output was only meta-commentary for question #${issueNumber} (Issue #661)`,
    );
    return { ok: true, value: false };
  }

  // Build the partial answer comment
  const commentBody = buildPartialAnswerBody(
    sanitisedOutput,
    questionLabel,
    workerFooter,
  );

  // Post the partial answer
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
      `Failed to post partial answer comment on issue #${issueNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ok: true, value: false };
  }

  // Issue #672: Keep the question label — the answer was incomplete
  logger?.info(
    `Keeping '${questionLabel}' label on issue #${issueNumber} — partial answer posted (Issue #672)`,
  );
  logger?.info(
    `Posted partial answer for timed-out question #${issueNumber} (Issue #661)`,
  );

  return { ok: true, value: true };
}
