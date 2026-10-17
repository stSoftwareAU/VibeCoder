/**
 * Wrong-repository duplicate resolution (Issue #3747, part of #3691).
 *
 * {@link resolveWrongRepoDuplicate} retires an issue X that was filed in the
 * wrong repository, in favour of the issue Y in the repository that owns the
 * work. Steps, in this order:
 *
 * 1. Read X and classify it. Refuse, changing nothing, when X is already
 *    closed, when X is a #2592 repo-scoped diagnostic, when the owner is
 *    `ambiguous` (the basis is returned), or when the classifier keeps X in
 *    its own repository.
 * 2. Check write access to both repositories before any write.
 * 3. Verify that Y exists and is open, or — with no Y given — file it
 *    through `fileRoutedIssue`, which reuses a same-titled issue already in
 *    the owner repository. A reused match that is not open (it may be an
 *    issue or PR closed in the last 30 days) is refused, changing nothing.
 * 4. Comment on Y, then on X, so each links to the other.
 * 5. Only then close X as `not planned`, with the routing reason.
 *
 * Re-runnable: each linking comment carries a marker, and a step whose
 * marker is already there is skipped. A dry run performs the reads and
 * permission checks and reports the planned steps with no write call.
 * Labels and assignees are never migrated; nothing is deleted.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Logger } from "../types.ts";
import { runGhCommand } from "./github.ts";
import {
  classifyIssueRouting,
  type IssueRoutingContext,
  type RoutingDecision,
} from "./issue_routing_classifier.ts";
import { fileRoutedIssue } from "./issue_routing_filing.ts";
import {
  type GhCommandFn,
  type IssueRoutingGithubDeps,
  requireWriteAccess,
} from "./issue_routing_github.ts";
import { defaultLogger } from "./logger.ts";
import {
  isRepoFastFailureIssue,
  isRepoFastFailureTallyIssue,
} from "./repo_fast_failure_issue.ts";
import { isValidRepoSlug } from "./repo_slug.ts";

/** An issue in a repository. */
export interface IssueRef {
  repo: string;
  number: number;
}

/** `owner/name#N` for an issue reference. */
export function formatIssueRef(ref: IssueRef): string {
  return `${ref.repo}#${ref.number}`;
}

/** Parse `owner/name#N`; `null` when the text is not one. */
export function parseIssueRef(text: string): IssueRef | null {
  const match = /^([^#\s]+)#(\d{1,9})$/.exec(text.trim());
  if (!match || !isValidRepoSlug(match[1])) return null;
  const number = Number(match[2]);
  return number > 0 ? { repo: match[1]!, number } : null;
}

/** The step of a resolution that failed. */
export type ResolveDuplicateStep =
  | "read-wrong"
  | "classify"
  | "permission"
  | "verify-correct"
  | "create-correct"
  | "link-correct"
  | "link-wrong"
  | "close-wrong";

/** A failed step; X is left open. */
export class ResolveDuplicateError extends Error {
  readonly step: ResolveDuplicateStep;

  constructor(step: ResolveDuplicateStep, wrong: string, cause: unknown) {
    super(
      `Duplicate resolution failed at step "${step}"; ${wrong} is left open: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "ResolveDuplicateError";
    this.step = step;
  }
}

/** One step's outcome, in the order it ran. */
export interface ResolveStepRecord {
  step: ResolveDuplicateStep;
  status: "done" | "skipped" | "planned";
  detail: string;
}

/** The outcome of a resolution. */
export interface ResolveDuplicateResult {
  outcome: "resolved" | "would-resolve" | "refused";
  wrong_issue: string;
  /** The owning issue; `null` when refused before it was known, or not yet filed in a dry run. */
  correct_issue: string | null;
  /** The routing decision for X; `null` when refused before classifying. */
  decision: RoutingDecision | null;
  reason: string;
  steps: ResolveStepRecord[];
}

/** Options for {@link resolveWrongRepoDuplicate}. */
export interface ResolveDuplicateOptions extends IssueRoutingGithubDeps {
  wrong: IssueRef;
  /** The owning issue; filed when absent. */
  correct?: IssueRef;
  context: IssueRoutingContext;
  dryRun?: boolean;
  logger?: Logger;
}

/** Marker on the comment that links Y back to X. */
export function correctLinkMarker(wrong: IssueRef): string {
  return `<!-- route-issue-duplicate-of ${formatIssueRef(wrong)} -->`;
}

/** Marker on the comment that links X to Y. */
export function wrongLinkMarker(correct: IssueRef): string {
  return `<!-- route-issue-moved-to ${formatIssueRef(correct)} -->`;
}

interface IssueView {
  title: string;
  body: string;
  state: string;
  comments: string[];
}

function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Read an issue's title, body, state and comment bodies. */
async function viewIssue(gh: GhCommandFn, ref: IssueRef): Promise<IssueView> {
  const raw = await gh([
    "issue",
    "view",
    String(ref.number),
    "--repo",
    ref.repo,
    "--json",
    "title,body,state,comments",
  ]);
  const parsed: unknown = JSON.parse(raw);
  const o =
    (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
      string,
      unknown
    >;
  if (
    typeof o.title !== "string" || typeof o.state !== "string" ||
    !Array.isArray(o.comments)
  ) {
    throw new Error(
      `gh issue view ${formatIssueRef(ref)} returned an unexpected response`,
    );
  }
  return {
    title: o.title,
    body: typeof o.body === "string" ? o.body : "",
    state: o.state.toUpperCase(),
    comments: o.comments.map((c) =>
      typeof c === "object" && c !== null &&
        typeof (c as Record<string, unknown>).body === "string"
        ? (c as Record<string, string>).body!
        : ""
    ),
  };
}

/**
 * Retire `opts.wrong` in favour of the issue that owns the work. See the
 * module doc for the steps and refusals.
 *
 * @throws ResolveDuplicateError naming the failed step; X is never closed
 *   when a step before the close fails
 */
export async function resolveWrongRepoDuplicate(
  opts: ResolveDuplicateOptions,
): Promise<ResolveDuplicateResult> {
  const gh: GhCommandFn = opts.ghCommandFn ?? runGhCommand;
  const logger = opts.logger ?? defaultLogger;
  const deps: IssueRoutingGithubDeps = { ghCommandFn: gh, now: opts.now };
  const wrongText = formatIssueRef(opts.wrong);
  const steps: ResolveStepRecord[] = [];
  const step = async <T>(
    name: ResolveDuplicateStep,
    fn: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw new ResolveDuplicateError(name, wrongText, error);
    }
  };
  let decision: RoutingDecision | null = null;
  const refuse = (
    reason: string,
    correct: string | null = null,
  ): ResolveDuplicateResult => {
    logger.warn("route-issue refused to resolve a duplicate", {
      wrong: wrongText,
      reason,
    });
    return {
      outcome: "refused",
      wrong_issue: wrongText,
      correct_issue: correct,
      decision,
      reason,
      steps,
    };
  };

  // 1. Read and classify X.
  const wrong = await step("read-wrong", () => viewIssue(gh, opts.wrong));
  if (wrong.state === "CLOSED") {
    return refuse(`${wrongText} is already closed; nothing changed`);
  }
  if (
    isRepoFastFailureIssue(wrong.body, opts.wrong.repo) ||
    isRepoFastFailureTallyIssue(wrong.body, opts.wrong.repo)
  ) {
    return refuse(
      `${wrongText} is a repo-scoped diagnostic (#2592) and stays in ` +
        `${opts.wrong.repo}; nothing changed`,
    );
  }
  decision = await step("classify", async () =>
    classifyIssueRouting(
      { title: wrong.title, body: wrong.body },
      opts.wrong.repo,
      opts.context,
    ));
  if (decision.issue_kind === "diagnostic") {
    return refuse(
      `${wrongText} is a repo-scoped diagnostic (#2592): ${decision.reason}; nothing changed`,
    );
  }
  if (decision.issue_kind === "ambiguous") {
    return refuse(`${decision.reason}; nothing changed`);
  }
  const owner = decision.owner_repository;
  if (sameRepo(owner, opts.wrong.repo)) {
    return refuse(
      `the classifier keeps ${wrongText} in ${opts.wrong.repo} ` +
        `(${decision.reason}); it is not a wrong-repository issue, nothing changed`,
    );
  }
  if (opts.correct !== undefined && !sameRepo(opts.correct.repo, owner)) {
    return refuse(
      `the classifier routes ${wrongText} to ${owner}, not ` +
        `${opts.correct.repo} (${decision.reason}); nothing changed`,
      formatIssueRef(opts.correct),
    );
  }

  // 2. Permission on both repositories before any write.
  await step("permission", async () => {
    await requireWriteAccess(opts.wrong.repo, deps);
    await requireWriteAccess(owner, deps);
  });
  steps.push({
    step: "permission",
    status: "done",
    detail: `write access to ${opts.wrong.repo} and ${owner}`,
  });

  // 3. Verify or file Y.
  let correct: IssueRef | null = opts.correct ?? null;
  let correctComments: string[] = [];
  if (opts.correct !== undefined) {
    const view = await step(
      "verify-correct",
      () => viewIssue(gh, opts.correct!),
    );
    if (view.state !== "OPEN") {
      return refuse(
        `${formatIssueRef(opts.correct)} is not open; nothing changed`,
        formatIssueRef(opts.correct),
      );
    }
    correctComments = view.comments;
    steps.push({
      step: "verify-correct",
      status: "done",
      detail: `${formatIssueRef(opts.correct)} is open`,
    });
  } else {
    const filed = await step("create-correct", () =>
      fileRoutedIssue(
        {
          title: wrong.title,
          body:
            `${wrong.body}\n\nFirst filed in the wrong repository as ${wrongText}.`,
        },
        {
          targetRepo: opts.wrong.repo,
          context: opts.context,
          decision: decision!,
          dryRun: opts.dryRun,
          logger,
          ghCommandFn: gh,
          now: opts.now,
        },
      ));
    correct = filed.number === null
      ? null
      : { repo: filed.repository, number: filed.number };
    // A reused match is the lowest-numbered same-titled issue or PR, open or
    // closed within the duplicate window; closing X in favour of a closed Y
    // would leave the work tracked nowhere, so Y must be open here too.
    const reused = correct !== null &&
      (filed.action === "reused" || filed.action === "would-reuse");
    if (reused) {
      const view = await step("verify-correct", () => viewIssue(gh, correct!));
      if (view.state !== "OPEN") {
        return refuse(
          `${formatIssueRef(correct!)} has the same title in ${owner} but is ` +
            `not open, so ${wrongText} is not retired in its favour; nothing ` +
            `changed. Reopen it, or name the open owning issue with --correct`,
          formatIssueRef(correct!),
        );
      }
      correctComments = view.comments;
    }
    const target = correct === null ? owner : formatIssueRef(correct);
    steps.push({
      step: "create-correct",
      status: opts.dryRun ? "planned" : "done",
      detail: `${filed.action} ${target}`,
    });
  }
  const correctText = correct === null
    ? `the new issue in ${owner}`
    : formatIssueRef(correct);

  // 4–5. Link both sides, then close X last.
  const linkCorrectDone = correct !== null &&
    correctComments.some((c) => c.includes(correctLinkMarker(opts.wrong)));
  const linkWrongDone = correct !== null &&
    wrong.comments.some((c) => c.includes(wrongLinkMarker(correct!)));
  if (opts.dryRun) {
    steps.push(
      {
        step: "link-correct",
        status: linkCorrectDone ? "skipped" : "planned",
        detail: `comment on ${correctText} linking ${wrongText}`,
      },
      {
        step: "link-wrong",
        status: linkWrongDone ? "skipped" : "planned",
        detail: `comment on ${wrongText} linking ${correctText}`,
      },
      {
        step: "close-wrong",
        status: "planned",
        detail: `close ${wrongText} as not planned`,
      },
    );
    return {
      outcome: "would-resolve",
      wrong_issue: wrongText,
      correct_issue: correct === null ? null : correctText,
      decision,
      reason: `dry-run: would link ${wrongText} and ${correctText}, then ` +
        `close ${wrongText} (${decision.reason})`,
      steps,
    };
  }
  const y = correct!;

  if (linkCorrectDone) {
    steps.push({ step: "link-correct", status: "skipped", detail: "exists" });
  } else {
    await step("link-correct", () =>
      gh([
        "issue",
        "comment",
        String(y.number),
        "--repo",
        y.repo,
        "--body",
        `${correctLinkMarker(opts.wrong)}\nThe same work was filed in the ` +
        `wrong repository as ${wrongText}. This is the owning issue; ` +
        `${wrongText} is closed in its favour.`,
      ]));
    steps.push({
      step: "link-correct",
      status: "done",
      detail: `commented on ${correctText}`,
    });
  }
  if (linkWrongDone) {
    steps.push({ step: "link-wrong", status: "skipped", detail: "exists" });
  } else {
    await step("link-wrong", () =>
      gh([
        "issue",
        "comment",
        String(opts.wrong.number),
        "--repo",
        opts.wrong.repo,
        "--body",
        `${wrongLinkMarker(y)}\nThis work belongs in ${owner} and is ` +
        `tracked in ${correctText}. Labels and assignees were not migrated.`,
      ]));
    steps.push({
      step: "link-wrong",
      status: "done",
      detail: `commented on ${wrongText}`,
    });
  }
  await step("close-wrong", () =>
    gh([
      "issue",
      "close",
      String(opts.wrong.number),
      "--repo",
      opts.wrong.repo,
      "--reason",
      "not planned",
      "--comment",
      `Closing as the wrong-repository duplicate of ${correctText}. ` +
      `Routing: ${decision!.reason.replace(/\s+/g, " ")}`,
    ]));
  steps.push({
    step: "close-wrong",
    status: "done",
    detail: `closed ${wrongText}`,
  });
  logger.info("route-issue resolved a wrong-repository duplicate", {
    wrong: wrongText,
    correct: correctText,
  });
  return {
    outcome: "resolved",
    wrong_issue: wrongText,
    correct_issue: correctText,
    decision,
    reason:
      `closed ${wrongText} as the wrong-repository duplicate of ${correctText}`,
    steps,
  };
}
