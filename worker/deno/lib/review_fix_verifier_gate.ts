/**
 * Review-fix verifier gate (Issue #3784).
 *
 * A review-fix round answers a change-requesting fleet review by pushing a
 * fix. Until now nothing checked that round before it reported back: the
 * next fleet review was the only check, and the prose rules against
 * claiming a finding fixed (#3086, #3114, #3348) are self-assessed by the
 * same agent that made the fix. This gate closes that gap. It runs the
 * pre-PR verifier — the fleet reviewer's brief — on the round's head, with
 * the change-requesting review's findings filled into `PREVIOUS_FINDINGS`,
 * so the reviewer must give a verdict on each earlier finding. The code, not
 * the model, owes that verdict: a finding marked `partly` or `not fixed`, or
 * left without a verdict, is a blocking finding (`pre_pr_verifier.ts`).
 *
 * A blocking result gets one recovery turn on the PR checkout, then the
 * verifier runs once more on the new head. Whatever still blocks after that
 * is written into `.pr_response_message`, so the round does not report those
 * findings as resolved. A re-check that cannot run is reported as such, never
 * read as recovered.
 *
 * ```mermaid
 * flowchart TD
 *     A["Review-fix round's head<br/>(change-requesting review)"] --> B{"Review carries fleet<br/>findings?"}
 *     B -- no --> S["skipped"]
 *     B -- yes --> C["Read PR, linked issue,<br/>PR summary from gh and disk"]
 *     C --> D{"Verifier checked<br/>the head?"}
 *     D -- no --> N["not_checked —<br/>reply says so"]
 *     D -- yes --> E{"Blocked?<br/>(earlier finding unresolved)"}
 *     E -- no --> K["clean"]
 *     E -- yes --> R["One recovery turn<br/>(full tools)"]
 *     R --> F["Re-read PR files and summary,<br/>verifier re-run on the new head"]
 *     F --> G{"Result?"}
 *     G -- not blocked --> H["recovered"]
 *     G -- blocked --> I["reported —<br/>reply lists findings"]
 *     G -- not checked --> J["reported with first review —<br/>reply says re-check did not run"]
 * ```
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import {
  isPrSummaryPath,
  parseChangeRequestFindingEntries,
} from "./change_request_quotes.ts";
import { issueNumberFromBranch } from "./issue_branch_candidates.ts";
import { prResponseMessagePath } from "./pr_branch_preparation.ts";
import {
  prePrVerifierBlocked,
  type PrePrVerifierInput,
  type PrePrVerifierResult,
  renderVerifierFindingBullets,
  type ReviewFinding,
  type ReviewReply,
} from "./pre_pr_verifier.ts";

/** Input to {@link runReviewFixVerifierGate}. */
export interface ReviewFixVerifierGateInput {
  repo: string;
  prNumber: number;
  branchName: string;
  repoPath: string;
  /** The change-requesting review body this round answers. */
  changeRequest: string;
  timeoutSeconds: number;
  killAfterSeconds?: number;
  model?: string;
  maxRetries?: number;
}

/** The gate's seams, injected for testability. */
export interface ReviewFixVerifierGateDeps {
  /** Runs gh; throws on failure. */
  runGh: (args: string[]) => Promise<string>;
  /** One pre-PR verifier run (Issue #3784 round `review-fix`). */
  runVerifier: (input: PrePrVerifierInput) => Promise<PrePrVerifierResult>;
  /** One full-tools agent turn on the PR checkout. */
  runRecovery: (
    prompt: string,
  ) => Promise<{ ok: true } | { ok: false; error: Error }>;
  logger: Logger;
}

/** What the gate did. */
export type ReviewFixVerifierGateOutcome =
  | { status: "skipped"; reason: string }
  | { status: "clean"; recoveryRan: false }
  | { status: "recovered"; recoveryRan: true }
  | { status: "reported"; recoveryRan: boolean; review: ReviewReply }
  | { status: "not_checked"; reason: string; recoveryRan: boolean };

/** The reply section's heading (Issue #3784). */
const REPLY_HEADING = "### Review-fix verifier (Issue #3784)";

/** A PR's base ref: a plausible git ref, never a flag or an absolute path. */
const BASE_REF_PATTERN = /^[A-Za-z0-9._\/-]{1,200}$/;

/** What the gate reads from `gh pr view`. */
interface PrDetails {
  baseRef: string;
  title: string;
  body: string;
  files: string[];
}

/** Whether `ref` is a plausible base ref (no traversal, no option-like value). */
function isWellFormedBaseRef(ref: string): boolean {
  return BASE_REF_PATTERN.test(ref) && !ref.includes("..") &&
    !ref.startsWith("-") && !ref.startsWith("/");
}

/** The message of a thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Collapse text to one line for the reply. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Parse `gh pr view --json baseRefName,title,body,files` (Issue #3784).
 *
 * Throws on a reply that is not a JSON object, a base ref that is not
 * well-formed, or a `files` value that is not an array. Each file is the
 * `path` of an element of that array.
 */
function parsePrDetails(raw: string): PrDetails {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("the PR reply is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const baseRef = record.baseRefName;
  if (typeof baseRef !== "string" || !isWellFormedBaseRef(baseRef)) {
    throw new Error(
      `the PR's base ref ('${String(baseRef)}') is not well-formed`,
    );
  }
  if (!Array.isArray(record.files)) {
    throw new Error("the PR reply's files value is not an array");
  }
  const files = record.files.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const path = (entry as Record<string, unknown>).path;
    return typeof path === "string" ? [path] : [];
  });
  return {
    baseRef,
    title: typeof record.title === "string" ? record.title : "",
    body: typeof record.body === "string" ? record.body : "",
    files,
  };
}

/**
 * Render the recovery turn's prompt (full tools, one shot; Issue #3784).
 *
 * The bullets name each finding the verifier still blocks on. The numbered
 * procedure makes the agent reproduce each one, fix it, and then correct
 * `.pr_response_message` so no finding the verifier marks partly or not
 * fixed is claimed resolved.
 */
export function buildReviewFixRecoveryPrompt(
  prNumber: number,
  review: ReviewReply,
): string {
  const lines: string[] = [];
  lines.push("## Review-fix verifier findings (Issue #3784)");
  lines.push("");
  lines.push(
    "The worker ran the fleet reviewer's brief on PR #" +
      `${prNumber}'s head after this review-fix round, with the earlier ` +
      "review's findings, and it found these blocking problems:",
  );
  lines.push("");
  lines.push(...renderVerifierFindingBullets(review));
  lines.push("");
  lines.push("Do exactly this, and nothing else:");
  lines.push("");
  lines.push("1. Reproduce each finding at the head.");
  lines.push(
    "2. Fix each part in the code, its tests, or the summary or doc text.",
  );
  lines.push("3. Run the tests that cover the change.");
  lines.push("4. Commit and push to the PR branch.");
  lines.push(
    "5. Update `.pr_response_message` so it does not claim any finding the " +
      "verifier marks partly or not fixed is resolved. If you have evidence " +
      "a finding is wrong, say so there, naming the finding and the evidence.",
  );
  return lines.join("\n");
}

/** What the reply section reports: a residual, or a round that was not checked. */
export type ReviewFixResidual =
  | { kind: "reported"; review: ReviewReply; recheckNote?: string }
  | { kind: "not_checked"; reason: string };

/**
 * Render the reply section for `.pr_response_message` (Issue #3784).
 *
 * Contains no HTML comment — the reply chokepoint neutralises those, so none
 * is written here in the first place.
 */
export function formatReviewFixResidual(residual: ReviewFixResidual): string {
  const lines: string[] = [REPLY_HEADING, ""];
  if (residual.kind === "not_checked") {
    lines.push(
      "The worker's review-fix verifier could not check this round " +
        `(${flatten(residual.reason)}), so no earlier finding is confirmed ` +
        "fixed by it.",
    );
    return lines.join("\n");
  }

  lines.push(
    "The worker re-ran the fleet reviewer's brief on this round's head, " +
      "with the earlier review's findings. These are still unresolved after " +
      "its one recovery attempt, so this round does not resolve them:",
  );
  lines.push("");
  for (const bullet of renderVerifierFindingBullets(residual.review)) {
    lines.push(flatten(bullet));
  }
  if (residual.recheckNote) {
    lines.push("");
    lines.push(
      `The re-check after that recovery attempt could not run ` +
        `(${flatten(residual.recheckNote)}), so these findings are the ` +
        "first check's, not a re-check's.",
    );
  }
  return lines.join("\n");
}

/**
 * Append a section to `.pr_response_message`, keeping any existing text
 * first; the lead sentence is written only when there is no existing text
 * (the drift check's append semantics, Issue #3143).
 */
async function appendReviewFixSection(
  repoPath: string,
  section: string,
  lead: string,
): Promise<void> {
  const path = prResponseMessagePath(repoPath);
  let existing: string | undefined;
  try {
    existing = await Deno.readTextFile(path);
  } catch {
    existing = undefined;
  }
  const text = existing !== undefined
    ? `${existing}\n\n${section}`
    : `${lead}\n\n${section}`;
  await Deno.writeTextFile(path, text);
}

/** Log the per-finding verdicts of a checked review (Issue #3784). */
function logVerdicts(
  input: ReviewFixVerifierGateInput,
  deps: ReviewFixVerifierGateDeps,
  previous: readonly ReviewFinding[],
  review: ReviewReply,
): void {
  const earlier = review.earlierFindings ?? [];
  const verdicts: Record<string, string> = {};
  previous.forEach((_, i) => {
    const index = i + 1;
    const verdict = earlier.find((e) => e.index === index);
    verdicts[String(index)] = verdict?.verdict ?? "none";
  });
  deps.logger.info("Review-fix verifier verdicts (Issue #3784)", {
    repo: input.repo,
    prNumber: input.prNumber,
    verdicts,
  });
}

/**
 * Record a round the verifier could not check: the reply says so, and the
 * outcome is `not_checked` (Issue #3784).
 */
async function notChecked(
  input: ReviewFixVerifierGateInput,
  deps: ReviewFixVerifierGateDeps,
  reason: string,
  recoveryRan: boolean,
): Promise<ReviewFixVerifierGateOutcome> {
  deps.logger.warn(
    "Review-fix verifier did not check this round (Issue #3784)",
    {
      repo: input.repo,
      prNumber: input.prNumber,
      reason,
    },
  );
  try {
    await appendReviewFixSection(
      input.repoPath,
      formatReviewFixResidual({ kind: "not_checked", reason }),
      "I've pushed a fix for this feedback. The worker's review-fix verifier " +
        "could not check it — see below.",
    );
  } catch (err) {
    deps.logger.error(
      "Review-fix verifier could not write its reply section (Issue #3784)",
      { repo: input.repo, prNumber: input.prNumber, error: errorMessage(err) },
    );
  }
  return { status: "not_checked", reason, recoveryRan };
}

/** Record a round the verifier still blocks, and return it as `reported`. */
async function reported(
  input: ReviewFixVerifierGateInput,
  deps: ReviewFixVerifierGateDeps,
  review: ReviewReply,
  recoveryRan: boolean,
  recheckNote?: string,
): Promise<ReviewFixVerifierGateOutcome> {
  deps.logger.warn(
    "Review-fix verifier reported unresolved findings (Issue #3784)",
    { repo: input.repo, prNumber: input.prNumber, recoveryRan },
  );
  try {
    await appendReviewFixSection(
      input.repoPath,
      formatReviewFixResidual({
        kind: "reported",
        review,
        ...(recheckNote !== undefined ? { recheckNote } : {}),
      }),
      "I've pushed a fix for this feedback, but the worker's review-fix " +
        "verifier found earlier findings it does not resolve — see below.",
    );
  } catch (err) {
    deps.logger.error(
      "Review-fix verifier could not write its reply section (Issue #3784)",
      { repo: input.repo, prNumber: input.prNumber, error: errorMessage(err) },
    );
  }
  return { status: "reported", recoveryRan, review };
}

/**
 * Read the PR's linked issue (Issue #3784). A branch that names no issue, or
 * a failed read, falls back to the PR's own title and body.
 */
async function linkedIssue(
  input: ReviewFixVerifierGateInput,
  deps: ReviewFixVerifierGateDeps,
  pr: PrDetails,
): Promise<{ issueNumber: number; issueTitle: string; issueBody: string }> {
  const fallback = {
    issueNumber: input.prNumber,
    issueTitle: pr.title,
    issueBody: pr.body,
  };
  const issueNumber = issueNumberFromBranch(input.branchName);
  if (issueNumber === null) {
    deps.logger.info(
      "Review-fix verifier: the branch names no issue — using the PR's title and body (Issue #3784)",
      { repo: input.repo, prNumber: input.prNumber },
    );
    return fallback;
  }
  try {
    const raw = await deps.runGh([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      input.repo,
      "--json",
      "title,body",
    ]);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      issueNumber,
      issueTitle: typeof parsed.title === "string" ? parsed.title : "",
      issueBody: typeof parsed.body === "string" ? parsed.body : "",
    };
  } catch (err) {
    deps.logger.warn(
      "Review-fix verifier: could not read the linked issue — using the PR's title and body (Issue #3784)",
      {
        repo: input.repo,
        prNumber: input.prNumber,
        issueNumber,
        error: errorMessage(err),
      },
    );
    return fallback;
  }
}

/** The head-dependent verifier fields: the PR's files and its summary text. */
type RoundHeadFields = Pick<
  PrePrVerifierInput,
  "baseRef" | "summaryPath" | "summaryContent" | "changedFiles"
>;

/**
 * Read the PR's base, files and summary text (Issue #3784). Run before the
 * first check and again before the re-check, so a recovery turn's summary
 * edit is what the re-check reads.
 */
async function readRoundHead(
  input: ReviewFixVerifierGateInput,
  deps: ReviewFixVerifierGateDeps,
): Promise<
  | { ok: true; pr: PrDetails; fields: RoundHeadFields }
  | { ok: false; reason: string }
> {
  let pr: PrDetails;
  try {
    pr = parsePrDetails(
      await deps.runGh([
        "pr",
        "view",
        String(input.prNumber),
        "--repo",
        input.repo,
        "--json",
        "baseRefName,title,body,files",
      ]),
    );
  } catch (err) {
    return {
      ok: false,
      reason: `could not read PR #${input.prNumber}: ${errorMessage(err)}`,
    };
  }

  const summaryPath = pr.files.find((path) => isPrSummaryPath(path));
  if (summaryPath === undefined) {
    return {
      ok: false,
      reason:
        "the PR carries no PR summary file, so the verifier has no PR body to read",
    };
  }
  let summaryContent: string;
  try {
    summaryContent = await Deno.readTextFile(
      `${input.repoPath}/${summaryPath}`,
    );
  } catch (err) {
    return {
      ok: false,
      reason: `could not read the PR summary ${summaryPath}: ${
        errorMessage(err)
      }`,
    };
  }
  return {
    ok: true,
    pr,
    fields: {
      baseRef: `origin/${pr.baseRef}`,
      summaryPath,
      summaryContent,
      changedFiles: pr.files,
    },
  };
}

/** The gate's body, run inside {@link runReviewFixVerifierGate}'s guard. */
async function runGate(
  input: ReviewFixVerifierGateInput,
  deps: ReviewFixVerifierGateDeps,
  state: { recoveryRan: boolean },
): Promise<ReviewFixVerifierGateOutcome> {
  const { repo, prNumber, repoPath } = input;

  const previous: ReviewFinding[] = parseChangeRequestFindingEntries(
    input.changeRequest,
  );
  if (previous.length === 0) {
    const reason =
      "the change request carries no findings in the fleet review format";
    deps.logger.info(`Review-fix verifier skipped — ${reason} (Issue #3784)`, {
      repo,
      prNumber,
    });
    return { status: "skipped", reason };
  }

  const head = await readRoundHead(input, deps);
  if (!head.ok) {
    return notChecked(input, deps, head.reason, state.recoveryRan);
  }
  const issue = await linkedIssue(input, deps, head.pr);

  const verifierInput: PrePrVerifierInput = {
    repo,
    issueNumber: issue.issueNumber,
    issueTitle: issue.issueTitle,
    issueBody: issue.issueBody,
    repoPath,
    ...head.fields,
    timeoutSeconds: input.timeoutSeconds,
    killAfterSeconds: input.killAfterSeconds,
    model: input.model,
    maxRetries: input.maxRetries,
    logger: deps.logger,
    round: { kind: "review-fix", prNumber, previousFindings: previous },
  };

  const first = await deps.runVerifier(verifierInput);
  if (first.status === "not_checked") {
    return notChecked(
      input,
      deps,
      `verifier not checked: ${first.reason}`,
      state.recoveryRan,
    );
  }
  logVerdicts(input, deps, previous, first.review);
  if (!prePrVerifierBlocked(first)) {
    return { status: "clean", recoveryRan: false };
  }

  // One recovery turn, then the verifier once more on the new head.
  deps.logger.warn(
    "Review-fix verifier blocked this round — running one recovery turn (Issue #3784)",
    { repo, prNumber },
  );
  const recovery = await deps.runRecovery(
    buildReviewFixRecoveryPrompt(prNumber, first.review),
  );
  state.recoveryRan = recovery.ok;
  if (!recovery.ok) {
    deps.logger.error(
      "Review-fix verifier recovery turn could not be launched (Issue #3784)",
      { repo, prNumber, error: recovery.error.message },
    );
  }

  // The recovery turn may have edited the PR summary or pushed new files, so
  // the re-check reads them afresh rather than reusing the first read.
  const recheckHead = await readRoundHead(input, deps);
  const second: PrePrVerifierResult = recheckHead.ok
    ? await deps.runVerifier({ ...verifierInput, ...recheckHead.fields })
    : { status: "not_checked", reason: recheckHead.reason };
  if (second.status === "not_checked") {
    deps.logger.warn(
      "Review-fix verifier re-check could not run (Issue #3784)",
      {
        repo,
        prNumber,
        reason: second.reason,
      },
    );
    return reported(
      input,
      deps,
      first.review,
      state.recoveryRan,
      second.reason,
    );
  }
  logVerdicts(input, deps, previous, second.review);
  if (!prePrVerifierBlocked(second)) {
    // Without a recovery turn that ran, nothing was recovered: the re-check
    // alone passes, which is a clean verdict rather than a recovery.
    return state.recoveryRan
      ? { status: "recovered", recoveryRan: true }
      : { status: "clean", recoveryRan: false };
  }
  return reported(input, deps, second.review, state.recoveryRan);
}

/**
 * Run the review-fix verifier gate on a review-fix round's head (Issue
 * #3784).
 *
 * Called by `pr_feedback_processor.ts` once the round's head is complete —
 * after the agent's own commit-and-push — and before the reply is written.
 * Never throws: an unexpected failure becomes `not_checked`, recorded in the
 * reply.
 */
export async function runReviewFixVerifierGate(
  input: ReviewFixVerifierGateInput,
  deps: ReviewFixVerifierGateDeps,
): Promise<ReviewFixVerifierGateOutcome> {
  const state = { recoveryRan: false };
  try {
    return await runGate(input, deps, state);
  } catch (err) {
    const message = errorMessage(err);
    deps.logger.error(
      "Review-fix verifier gate failed unexpectedly (Issue #3784)",
      { repo: input.repo, prNumber: input.prNumber, error: message },
    );
    return await notChecked(
      input,
      deps,
      `the gate failed unexpectedly: ${message}`,
      state.recoveryRan,
    );
  }
}
