/**
 * Clarification workflow for the Vibe Coder worker (Issue #107).
 *
 * Provides:
 *   - `countClarificationRounds` — counts the rounds the fleet itself posted
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
import {
  type AlertDedupAuthorOptions,
  selectFleetAuthoredComments,
} from "./alert_dedup_authors.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
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
 * The heading every clarification comment opens with.
 *
 * Kept as a constant so the counter and the two posters cannot drift apart.
 */
export const CLARIFICATION_HEADING = "## Clarification Needed";

/**
 * The `escalateToHuman` dedup key for the clarification round on one issue.
 *
 * Both posters (`postClarifyingQuestions` here, and the clarity-assessment
 * phase) build the same key so the shared escalation helper recognises the
 * comment they just posted; the round counter looks for the marker that key
 * produces. One helper, so a rename cannot leave the counter looking for a
 * marker nobody writes any more.
 */
export function clarificationDedupKey(issueNumber: number): string {
  return `clarification-${issueNumber}`;
}

/**
 * The two fields the round counter needs from a comment.
 *
 * Deliberately a structural shape rather than a new comment type: both
 * `issue_data.ts`'s `IssueComment` and `types.ts`'s `GitHubComment` already
 * satisfy it, so no caller has to reshape what it already holds.
 */
export interface ClarificationRoundComment {
  /** The commenter's login — the only authenticated part of a match. */
  author?: string | null;
  /** The comment body. */
  body: string;
}

/**
 * Count the clarification rounds **the fleet itself** has posted.
 *
 * The round limit exists to stop the worker asking forever, and reaching it
 * retires the clarity gate: no more clarifying questions, no `needs-human`,
 * no escalation of an over-complex issue to planning. It used to be counted
 * by substring-matching the `## Clarification Needed` heading across the
 * concatenated comment blob that is handed to the model — text any commenter
 * on a public repository may write, and counted by occurrence, so one comment
 * could carry a whole limit's worth. Nothing consulted who wrote it.
 *
 * That is the marker-dedup-without-author-verification class recorded in
 * {@link file://./marker_dedup_author_manifest.ts}, and it fails in the usual
 * direction: towards silence, with the human-in-the-loop check switched off.
 *
 * So a round is counted only when it is **evidence**: a comment carrying the
 * clarification heading or this issue's escalation marker, written by a fleet
 * account. Two sources of authorship, in the same order
 * `escalateToHuman` uses them:
 *
 *   1. `githubUser` — this worker's own login, which is worker configuration
 *      rather than anything a comment can influence, so a comment it wrote is
 *      evidence without reading a config; and
 *   2. the shared fleet identity, through `selectFleetAuthoredComments`, so
 *      rounds posted by a sibling host still count and there is no second
 *      notion of "the fleet" in the worker.
 *
 * **Fail direction: towards keeping the gate on.** A comment that cannot be
 * attributed — an unresolvable fleet set, an author GitHub did not supply —
 * is not counted, so the worker keeps asking rather than waving an unclear
 * issue through to the coding agent. Answering the questions, or the
 * `documentation` label, still moves such an issue on.
 *
 * Counted per comment, not per occurrence: a comment is one round however
 * many times it repeats the heading.
 *
 * @param comments - The issue's comments, with their authors.
 * @param opts - Issue number, this worker's login, and author-check inputs.
 * @returns How many rounds the fleet has posted.
 */
export async function countClarificationRounds(
  comments: readonly ClarificationRoundComment[],
  opts: {
    /** The issue the rounds belong to — keys the escalation marker. */
    issueNumber: number;
    /** Repository, for the log line only. */
    repo?: string;
    /** This worker's own login (`GITHUB_USER`), when known. */
    githubUser?: string;
    /** Fleet identity inputs; tests state the fleet instead of a config. */
    dedupAuthors?: AlertDedupAuthorOptions;
    /** Sink for the author-verification diagnostics. */
    log?: (message: string) => void;
  },
): Promise<number> {
  const log = opts.log ?? ((message: string) => console.warn(message));
  const marker = buildDedupMarker(clarificationDedupKey(opts.issueNumber));
  const candidates = comments.filter((comment) =>
    typeof comment.body === "string" &&
    (comment.body.includes(marker) ||
      comment.body.includes(CLARIFICATION_HEADING))
  );
  if (candidates.length === 0) return 0;

  const own = opts.githubUser
    ? candidates.filter((c) => isFleetAuthor(c.author, [opts.githubUser!]))
    : [];
  const rest = candidates.filter((c) => !own.includes(c));
  const verified = await selectFleetAuthoredComments(
    rest,
    `clarification round count on ${opts.repo ?? "issue"}#${opts.issueNumber}`,
    opts.dedupAuthors ?? {},
    log,
    "the round is not counted and the clarity gate stays on — a heading " +
      "anyone can write must not disable a human-in-the-loop check",
  );
  return own.length + verified.length;
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

  let commentBody = `${CLARIFICATION_HEADING}

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
  const dedupKey = clarificationDedupKey(options.issueNumber);
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
