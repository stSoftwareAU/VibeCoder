/**
 * Clarification workflow for the Vibe Coder worker (Issue #107).
 *
 * Provides:
 *   - `countClarificationRounds` — pure helper to count posted rounds
 *   - `validateClarifyingQuestions` — sanity check on question text (Issue #190)
 *   - `postClarifyingQuestions` — post questions and mark the issue
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubClient, Result } from "../types.ts";
import { parseGhRawCommentsJson, runGhCommand } from "./github.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";
import { createLogger } from "./logger.ts";
import type { ClarificationOptions, LabelManagerDeps } from "./label_types.ts";
import { DEFAULT_LABEL_CONFIG } from "./label_types.ts";
import { addLabelToIssue, ensureLabelExists } from "./label_operations.ts";
import { buildDedupMarker, escalateToHuman } from "./needs_human_escalation.ts";
import { redactSecrets } from "./secret_redaction.ts";

/**
 * The "what to do next" text re-used as the `escalateToHuman` next step for
 * the clarification flow (Issue #2210). The posted comment already spells out
 * the full instructions; this keeps the helper's record consistent.
 */
const CLARIFICATION_NEXT_STEP =
  "Reply to this comment (or update the issue description) with the requested " +
  "information, then remove the `needs-human` label so the worker can continue. " +
  "To skip clarification, add the `documentation` label and remove `needs-human`.";

/**
 * Build a lightweight {@link GitHubClient} backed by a `ghCommandFn`
 * (Issue #2210). Only the methods used by `escalateToHuman` — `addLabel`,
 * `postComment`, and `getIssueComments` — talk to the CLI; the rest reject so
 * accidental use surfaces loudly. This lets the `ghCommandFn`-based
 * clarification flow route label application through the shared helper without
 * a full `createGitHubClient` (which is hard-wired to `runGhCommand`).
 */
export function ghClientFromCommandFn(
  ghCommandFn: (args: string[]) => Promise<string>,
): GitHubClient {
  const notSupported = (op: string) => (): Promise<never> =>
    Promise.reject(new Error(`ghClientFromCommandFn: ${op} is not supported`));
  return {
    getIssue: notSupported("getIssue"),
    async getIssueComments(repo, issueNumber) {
      // Issue #3709: bounded pagination replaces unbounded `--paginate`.
      const raw = await fetchIssueCommentPages(repo, issueNumber, ghCommandFn);
      return parseGhRawCommentsJson(raw);
    },
    async addLabel(repo, issueNumber, label) {
      // Issue #13: route through `addLabelToIssue` rather than reaching for
      // the CLI directly, so the worker label allowlist guard
      // (`assertWorkerCanApplyLabel`) covers this call site too. It keeps
      // the same REST-POST-with-CLI-fallback behaviour (Issue #976) and
      // returns a `Result`, so a refusal or a failed mutation is rethrown
      // here to preserve the throwing `GitHubClient.addLabel` contract.
      const result = await addLabelToIssue(repo, issueNumber, label, {
        ghCommandFn,
      });
      if (!result.ok) throw result.error;
    },
    removeLabel: () => Promise.resolve(),
    async postComment(repo, issueNumber, body) {
      await ghCommandFn([
        "issue",
        "comment",
        String(issueNumber),
        "--repo",
        repo,
        "--body",
        body,
      ]);
      return undefined;
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

/**
 * Count how many "Clarification Needed" comments have been posted.
 *
 * Pure function — no side effects.
 */
export function countClarificationRounds(issueComments: string): number {
  const matches = issueComments.match(/## Clarification Needed/g);
  return matches?.length ?? 0;
}

/**
 * Validate that clarifying questions contain actual questions.
 *
 * Returns ok:true if valid, ok:false with reason if invalid.
 *
 * Issue #190 — Prevent empty "Questions" sections in comments.
 */
export function validateClarifyingQuestions(
  questions: string,
): Result<void> {
  const trimmed = questions.replace(/\s/g, "");
  if (!trimmed) {
    return {
      ok: false,
      error: new Error("Clarifying questions are empty or whitespace-only"),
    };
  }
  if (!questions.includes("?")) {
    return {
      ok: false,
      error: new Error(
        "Clarifying questions contain no question marks — likely not actual questions",
      ),
    };
  }
  return { ok: true, value: undefined };
}

/**
 * Post clarifying questions to an issue and mark it as needing clarification.
 */
export async function postClarifyingQuestions(
  options: ClarificationOptions,
  deps: LabelManagerDeps = {},
): Promise<Result<void>> {
  const ghCommandFn = deps.ghCommandFn ?? runGhCommand;
  const labels = options.labels ?? DEFAULT_LABEL_CONFIG;

  // Validate questions (Issue #190)
  const validation = validateClarifyingQuestions(options.clarifyingQuestions);
  if (!validation.ok) {
    return validation;
  }

  // Redact secrets before the model's raw output leaves the process (Issue
  // #3226, mirroring #3202): `clarifyingQuestions` is the clarity phase's
  // verbatim Claude output, posted to a public issue comment. The `claude`
  // child retains ANTHROPIC_API_KEY / GH_TOKEN in its environment and has an
  // unrestricted Bash tool, so a prompt-injected or steered run that emits a
  // secret into its questions output must be masked before it is posted.
  const safeQuestions = redactSecrets(options.clarifyingQuestions);

  let commentBody = `## Clarification Needed

Before proceeding with this issue, I need some additional information to ensure the implementation meets your expectations.

### Questions
${safeQuestions}

### What happens next?
- This issue has been marked with the \`${labels.needsHumanLabel}\` label
- The worker will **skip this issue** until you respond

### To continue after responding
1. Reply to this comment or update the issue description with the requested information
2. **Remove the \`${labels.needsHumanLabel}\` label** to signal that you've responded

### To skip clarification and proceed anyway
If you want the worker to proceed without answering these questions, add the \`documentation\` label and remove the \`${labels.needsHumanLabel}\` label. Alternatively, the worker will automatically proceed after the maximum clarification rounds.`;

  // Append worker identity footer (Issue #436)
  if (options.workerFooter) {
    commentBody += options.workerFooter;
  }

  // Append the escalation dedup marker (Issue #2210) so the shared
  // `escalateToHuman` helper recognises this comment and adds the label
  // without posting a duplicate.
  const dedupKey = `clarification-${options.issueNumber}`;
  commentBody += `\n\n${buildDedupMarker(dedupKey)}`;

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
    return {
      ok: false,
      error: new Error("Failed to post clarifying questions comment"),
    };
  }

  // Route the `needs-human` label application through the shared helper
  // (Issue #2210). The `dedupKey` matches the marker appended above, so the
  // helper recognises the just-posted clarification comment and adds the
  // label without duplicating it. Label-add is non-fatal — the comment is the
  // primary signal (Issue #978).
  const ghClient = deps.ghClient ?? ghClientFromCommandFn(ghCommandFn);
  const logger = deps.logger ?? createLogger();
  await escalateToHuman({
    ghClient,
    repo: options.repo,
    target: { kind: "issue", number: options.issueNumber },
    needsHumanLabel: labels.needsHumanLabel,
    heading: "Clarification Needed",
    reason:
      "The worker needs more information before it can implement this issue.",
    nextStep: CLARIFICATION_NEXT_STEP,
    dedupKey,
    ensureLabelColour: "fbca04",
    ensureLabelDescription: "Worker has escalated this issue to a human",
    githubUser: options.githubUser,
    deps: {
      github: {
        ensureLabelExists: (repo, name, colour, description) =>
          ensureLabelExists(repo, name, colour, description, deps),
      },
    },
    logger,
  });

  // Unassign
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
