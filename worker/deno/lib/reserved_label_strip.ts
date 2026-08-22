/**
 * Post-creation reserved-label strip helper (Issue #2822).
 *
 * Claude-driven `gh issue create` calls (planning sub-issues, escape-hatch
 * follow-ups) build their own args, so the worker never gets to filter the
 * labels *before* creation. The only deterministic guard for those paths is to
 * strip reserved labels from the issues the run just created, *after* the fact —
 * the worked example being a worker-generated planning sub-issue that kept a
 * `top-priority` label (private-repo-17#1384).
 *
 * This is the post-creation sibling of `filterReservedLabelsWithWarning`
 * (creation-time, in `github.ts`). Both read the one `RESERVED_LABELS` constant
 * (`config_defaults.ts`) so the set stays in sync automatically — no second copy
 * of the list (DRY).
 *
 * Modelled on `applyDegradedModelLabel()` (`planning_degraded_label.ts`): every
 * operation is **non-throwing** (try / log per label), so a read or remove
 * failure on one issue is recorded and the loop continues to the next.
 * `idle-task`, `degraded-model`, and other descriptive labels are not in
 * `RESERVED_LABELS`, so they are left untouched.
 *
 * **Failures are reported, not swallowed (Issue #3708, SEC-3fb85d0e61ca).**
 * Every removal failure used to end at a `warn` and the function returned
 * `void`, so a caller could not tell whether the only deterministic guard for
 * model-created issues had actually applied — a reserved label left in place
 * looked exactly like a clean run. The helper now returns a
 * `Result<ReservedLabelStripSummary, ReservedLabelStripError>`: still
 * non-throwing and still best-effort per label, but a run with any failure
 * comes back `ok: false` carrying the summary, so the caller can retry or fail
 * loud.
 *
 * **Cross-repo targets are allowlisted (Issue #3662).** The planning path feeds
 * refs parsed out of *model output*, so an injected
 * `https://github.com/victim/repo/issues/N` could otherwise turn this helper
 * into a label-removal primitive against any repo the fleet token can write —
 * un-parking a `needs-human` issue or de-queueing human-granted `work-on` work.
 * Every ref must therefore name `currentRepo` or a repo on the monitored-repo
 * allowlist; anything else is logged and skipped *before* any mutation. This
 * mirrors the escape-hatch mitigation already in place under Issue #3074
 * (`escape_hatch_label_strip.ts`) and denies by default when the allowlist is
 * absent.
 *
 * **A ref that does not exist is validated, not retried (Issue #210).** The
 * ref is model-authored, so the *number* can simply be wrong as well as the
 * repo. The label read that precedes every mutation is that validation: when
 * GitHub definitively reports the issue as absent
 * (`isDefinitiveNotFound`, `github_not_found.ts`), the ref is recorded as
 * `unresolved` after one WARNING rather than as a failure — a retry cannot
 * conjure the issue, and the ERROR it ended in reported a fault that could
 * not exist.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubClient, Logger, Result } from "../types.ts";
import { isReservedLabel } from "./config_defaults.ts";
import { isDefinitiveNotFound } from "./github_not_found.ts";

/**
 * A single issue to scrub, identified by its repository and number.
 *
 * Issue #3575: the scrub must reach cross-repo sub-issues (a planning run that
 * filed sub-issues in a repository other than the parent's), so the target is
 * carried as an explicit `(repo, number)` pair rather than a bare number under
 * one shared repo.
 */
export interface IssueRef {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Issue number. */
  number: number;
}

/** A reserved label that was successfully removed. */
export interface StrippedLabel {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Issue the label was removed from. */
  issueNumber: number;
  /** The reserved label that was removed. */
  label: string;
}

/** A step of the strip that did not complete (Issue #3708). */
export interface StripFailure {
  /** Repository in "owner/repo" format, when the ref parsed. */
  repo?: string;
  /** Issue number, when the ref parsed. */
  issueNumber?: number;
  /** The label being removed, for a `remove` failure. */
  label?: string;
  /** Which step failed. */
  stage: "parse" | "read" | "remove";
  /** Failure message, for the caller's loud log. */
  error: string;
}

/** What a strip actually did (Issue #3708). */
export interface ReservedLabelStripSummary {
  /** Labels removed. */
  stripped: StrippedLabel[];
  /** Refs deliberately skipped by the destination allowlist — not failures. */
  skipped: IssueRef[];
  /**
   * Refs GitHub reports do not exist (Issue #210) — the model named an issue
   * number that is not in the repo. Not failures: there is no issue to carry
   * a reserved label, so retrying cannot help. The caller states them so the
   * agent's mistake is visible off this host's log.
   */
  unresolved: IssueRef[];
  /** Steps that did not complete, so the guard may not have applied. */
  failures: StripFailure[];
}

/** An empty (nothing-to-do) summary. */
export function emptyStripSummary(): ReservedLabelStripSummary {
  return { stripped: [], skipped: [], unresolved: [], failures: [] };
}

/**
 * Error returned (never thrown) when a strip could not be completed.
 *
 * Carries the whole {@link ReservedLabelStripSummary} so the caller can log
 * exactly which labels are still in place and retry just as easily as it can
 * escalate.
 */
export class ReservedLabelStripError extends Error {
  /** What the strip managed to do before / around the failures. */
  readonly summary: ReservedLabelStripSummary;

  constructor(summary: ReservedLabelStripSummary) {
    const detail = summary.failures
      .map((f) =>
        `${f.stage}${f.repo ? ` ${f.repo}#${f.issueNumber}` : ""}${
          f.label ? ` (${f.label})` : ""
        }: ${f.error}`
      )
      .join("; ");
    super(
      `Reserved-label strip did not complete: ${summary.failures.length} ` +
        `failure(s) — ${detail}`,
    );
    this.name = "ReservedLabelStripError";
    this.summary = summary;
  }
}

/**
 * Wrap a summary as a `Result`: `ok` when nothing failed, an error carrying the
 * summary otherwise.
 */
export function stripResult(
  summary: ReservedLabelStripSummary,
): Result<ReservedLabelStripSummary, ReservedLabelStripError> {
  return summary.failures.length === 0
    ? { ok: true, value: summary }
    : { ok: false, error: new ReservedLabelStripError(summary) };
}

/**
 * Strip every `RESERVED_LABELS` member found on each target issue, via the
 * existing `removeLabel` primitive, emitting one WARNING per stripped label.
 *
 * For each (de-duplicated) `(repo, number)` ref: read its current labels and,
 * for any label in `RESERVED_LABELS`, remove it. Reserved labels are the
 * workflow labels the worker must never self-apply; descriptive labels such as
 * `idle-task` and `degraded-model` are absent from the set and survive.
 *
 * Non-throwing: a `getIssue`/`removeLabel` failure on one issue (or one label)
 * is logged via `logger.warn` and the loop continues to the next. Issue #3708:
 * those failures are also collected and returned as `ok: false` so the caller
 * can retry or fail loud rather than mistake a partial strip for a clean one.
 *
 * Refs are de-duplicated case-insensitively on `repo` (GitHub treats repo and
 * label names case-insensitively) so the same issue listed twice is scrubbed
 * once.
 *
 * Issue #3662: a ref naming a repo that is neither `currentRepo` nor on
 * `allowedRepos` is logged and skipped before any mutation, so a model-supplied
 * (untrusted) cross-repo ref cannot select an arbitrary GitHub issue.
 *
 * @param args.refs - Issue refs to scrub (de-duplicated internally)
 * @param args.currentRepo - Repository in "owner/repo" form the run is working
 *                           on; always permitted
 * @param args.allowedRepos - Optional monitored-repo allowlist. A cross-repo
 *                            ref is only scrubbed when its repo is a member.
 *                            When omitted, only `currentRepo` is permitted —
 *                            the secure default.
 * @param args.ghClient - GitHub client providing `getIssue` + `removeLabel`
 * @param args.logger - Logger for the per-stripped-label WARNING and per-step errors
 * @returns What was stripped / skipped, or an error carrying that summary when
 *          any step failed (Issue #3708)
 */
export async function stripReservedLabelsFromIssueRefs(args: {
  refs: IssueRef[];
  currentRepo: string;
  allowedRepos?: string[];
  ghClient: Pick<GitHubClient, "getIssue" | "removeLabel">;
  logger: Logger;
}): Promise<Result<ReservedLabelStripSummary, ReservedLabelStripError>> {
  const { refs, currentRepo, allowedRepos, ghClient, logger } = args;
  const summary = emptyStripSummary();

  // Issue #3662: build the permitted-destination set once. Repo names are
  // compared case-insensitively (GitHub treats them so) and blanks are dropped
  // so a misconfigured empty entry can never match a ref.
  const permitted = new Set(
    [currentRepo, ...(allowedRepos ?? [])]
      .map((r) => (r ?? "").trim().toLowerCase())
      .filter((r) => r !== ""),
  );

  // De-duplicate so an issue listed twice (in either repo casing) is scrubbed
  // once.
  const seen = new Set<string>();
  const targets: IssueRef[] = [];
  for (const ref of refs) {
    const key = `${ref.repo.toLowerCase()}#${ref.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!permitted.has(ref.repo.trim().toLowerCase())) {
      logger.warn(
        "Skipping reserved-label strip: target repo is not the current repo " +
          "or on the monitored-repo allowlist (non-fatal)",
        { repo: ref.repo, issueNumber: ref.number, currentRepo },
      );
      summary.skipped.push(ref);
      continue;
    }
    targets.push(ref);
  }

  for (const { repo, number: issueNumber } of targets) {
    let reserved: string[];
    try {
      const issue = await ghClient.getIssue(repo, issueNumber);
      // Issue #3088: case-insensitive match so a non-lower-case canonical
      // reserved label (e.g. `Planning`) is still stripped.
      reserved = issue.labels.filter((label) => isReservedLabel(label));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // Issue #210: the read is also the validation — it happens before any
      // mutation, so a ref GitHub definitively reports as absent is answered
      // here. That is the model naming an issue that does not exist (a
      // NEAT-AI-Lamarck hand-off named `#3952`, a number from another repo's
      // series); nothing carries a reserved label, so retrying it and then
      // erroring reported a fault that cannot exist. One WARNING, recorded as
      // unresolved, and on to the next ref.
      if (isDefinitiveNotFound(error)) {
        logger.warn(
          "Skipping reserved-label strip: the issue does not exist in this " +
            "repo — the reference names an issue that was never filed " +
            "(Issue #210)",
          { repo, issueNumber, error },
        );
        summary.unresolved.push({ repo, number: issueNumber });
        continue;
      }
      logger.warn(
        "Failed to read labels while stripping reserved labels",
        { repo, issueNumber, error },
      );
      summary.failures.push({ repo, issueNumber, stage: "read", error });
      continue;
    }

    for (const label of reserved) {
      try {
        await ghClient.removeLabel(repo, issueNumber, label);
        logger.warn("Stripped reserved label from worker-created issue", {
          repo,
          issueNumber,
          label,
        });
        summary.stripped.push({ repo, issueNumber, label });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.warn(
          "Failed to strip reserved label",
          { repo, issueNumber, label, error },
        );
        summary.failures.push({
          repo,
          issueNumber,
          label,
          stage: "remove",
          error,
        });
      }
    }
  }

  return stripResult(summary);
}

/**
 * Strip reserved labels from a set of issue numbers all in the same `repo`.
 *
 * Thin wrapper over {@link stripReservedLabelsFromIssueRefs} preserving the
 * original single-repo signature (Issue #2822). Callers that need cross-repo
 * coverage should build `IssueRef`s and call the refs variant directly
 * (Issue #3575) — and must pass their own `currentRepo`/`allowedRepos` so the
 * destination guard (Issue #3662) applies.
 *
 * Every ref here is the caller-named `repo`, so that repo *is* the current repo
 * for the guard's purposes. Callers resolving a repo from untrusted input (e.g.
 * `escape_hatch_label_strip.ts`) validate it against the monitored-repo
 * allowlist before calling.
 *
 * @param args.repo - Repository in "owner/repo" format
 * @param args.issueNumbers - Issue numbers to scrub (de-duplicated internally)
 * @param args.ghClient - GitHub client providing `getIssue` + `removeLabel`
 * @param args.logger - Logger for the per-stripped-label WARNING and per-step errors
 * @returns The same `Result` as {@link stripReservedLabelsFromIssueRefs}
 */
export function stripReservedLabelsFromIssues(args: {
  repo: string;
  issueNumbers: number[];
  ghClient: Pick<GitHubClient, "getIssue" | "removeLabel">;
  logger: Logger;
}): Promise<Result<ReservedLabelStripSummary, ReservedLabelStripError>> {
  return stripReservedLabelsFromIssueRefs({
    refs: args.issueNumbers.map((number) => ({ repo: args.repo, number })),
    currentRepo: args.repo,
    ghClient: args.ghClient,
    logger: args.logger,
  });
}
