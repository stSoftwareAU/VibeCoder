/**
 * Work-on issue content integrity verification (Issue #1341).
 *
 * Provides TOCTOU protection for the work-on workflow: confirms that
 * the issue title and body have not been modified after a trusted
 * author approved the work-on label. Trusted modifications proceed
 * with a refreshed snapshot; untrusted modifications block processing,
 * add the needs-human label and post a security comment. Approval
 * labels are never removed (Issue #3964): `needs-human` already stops
 * the worker, so stripping `work-on` only turns a review flag into a
 * de-scheduling event that demands manual re-approval.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { WorkerConfig } from "../types.ts";
import type { FilterableIssue } from "./issue_filter.ts";
import type {
  IssueFinderDiagnostics,
  SkipReason,
} from "./issue_finder_logger.ts";
import {
  captureContentSnapshot,
  type ContentApprovalDeps,
  isAuthorTrusted,
  verifyContentUnchanged,
} from "./content_approval_tracker.ts";
import { resolveContentApprovalStateDir } from "./content_approval_state_dir.ts";
import { getLabelLastAddInfo } from "./issue_query.ts";
import {
  type IssueEditActor,
  resolveLastIssueEditor,
} from "./issue_edit_actor.ts";
import type { TimelineCache } from "./timeline_cache.ts";
import { escalateToHuman } from "./needs_human_escalation.ts";
import {
  getLabelColour,
  getLabelDescription,
} from "../setup/label_definitions.ts";
import { createGhEscalationClient } from "./gh_escalation_client.ts";
import { defaultLogger } from "./logger.ts";
import { assertNever } from "./assert_never.ts";

/**
 * Fetch the current issue title and body via the gh CLI.
 *
 * Issue #2534: this sits on the per-issue work-on scan loop. Both the
 * `gh issue view` call and the `JSON.parse` of its output can fail
 * (network / rate-limit / non-zero exit / malformed JSON). Returning a
 * `Result` lets the caller skip the single offending issue instead of
 * letting a thrown error escape and abort the whole scan (a poison-issue
 * failure mode).
 */
async function fetchIssueTitleAndBody(
  repo: string,
  issueNumber: number,
  ghFn: (args: string[]) => Promise<string>,
): Promise<
  | { ok: true; value: { title: string; body: string } }
  | { ok: false; error: Error }
> {
  try {
    const output = await ghFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "title,body",
    ]);
    const parsed = JSON.parse(output) as { title?: string; body?: string };
    return {
      ok: true,
      value: {
        title: parsed.title ?? "",
        body: parsed.body ?? "",
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * Adapter that creates an `ensureLabelExists` Result-returning function
 * around a raw `ghFn`. Passed to `escalateToHuman` so the label-create call
 * is routed through the same injectable gh CLI as the rest of this module
 * (preserves test injection for the content-integrity helper).
 *
 * Issue #368: the colour and description fall back to the canonical label
 * table rather than to this call site's own literals.
 */
function ensureLabelExistsViaGhFn(
  ghFn: (args: string[]) => Promise<string>,
) {
  return async (
    repo: string,
    labelName: string,
    colour?: string,
    description?: string,
  ): Promise<{ ok: true; value: void } | { ok: false; error: Error }> => {
    const colourArg = colour ?? getLabelColour(labelName);
    const descriptionArg = description ?? getLabelDescription(labelName);
    try {
      await ghFn([
        "api",
        "-X",
        "POST",
        `repos/${repo}/labels`,
        "-f",
        `name=${labelName}`,
        "-f",
        `color=${colourArg}`,
        "-f",
        `description=${descriptionArg}`,
      ]);
      return { ok: true, value: undefined as unknown as void };
    } catch {
      // Label may already exist — fall through to CLI fallback.
    }
    try {
      await ghFn([
        "label",
        "create",
        labelName,
        "--repo",
        repo,
        "--color",
        colourArg,
        "--description",
        descriptionArg,
      ]);
      return { ok: true, value: undefined as unknown as void };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  };
}

/**
 * Why the shared gate refused to let content through (Issue #3876).
 *
 * Mirrors the `logIssueSkipped` reason recorded on each blocking branch, so a
 * caller (the pickup path) can name the actual fault instead of reporting
 * every block as a content modification.
 */
export type ContentIntegrityBlockReason =
  | "content-store-unconfigured"
  | "no-approval-snapshot"
  | "content-snapshot-persist-failed"
  | "content-editor-unresolved"
  | "content-modified-after-approval"
  | "content-check-error";

/** Verdict of the shared content-integrity decision (Issue #3876). */
export type ContentIntegrityVerdict =
  | { verdict: "proceed" }
  | { verdict: "blocked"; reason: ContentIntegrityBlockReason };

const PROCEED: ContentIntegrityVerdict = { verdict: "proceed" };

function blockedBy(
  reason: ContentIntegrityBlockReason,
): ContentIntegrityVerdict {
  return { verdict: "blocked", reason };
}

/**
 * Persist an approval baseline, blocking when the write fails (Issue #3868).
 *
 * Every re-baseline is what makes the *next* verification meaningful, so a
 * failed persist is not a cosmetic loss: the gate would return `proceed` while
 * the store still holds a baseline that no longer matches anything, or none at
 * all. The `Result` was previously discarded at all three capture sites, so a
 * full disk was reported as a successful approval refresh (fail-loud, #3234).
 *
 * @returns "proceed" once the baseline is on disk, "blocked" when it is not
 */
async function captureBaselineOrBlock(args: {
  stateDir: string;
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  author: string;
  contentDeps?: ContentApprovalDeps;
  diag?: IssueFinderDiagnostics;
}): Promise<ContentIntegrityVerdict> {
  const captured = await captureContentSnapshot(
    args.stateDir,
    args.repo,
    args.issueNumber,
    args.title,
    args.body,
    args.author,
    args.contentDeps,
  );
  if (captured.ok) return PROCEED;

  console.error(
    `[SECURITY] [CONTENT_SNAPSHOT_PERSIST_FAILED] Could not persist the ` +
      `approval baseline for ${args.repo}#${args.issueNumber}: ` +
      `${captured.error.message} — BLOCKED`,
  );
  args.diag?.logIssueSkipped(
    args.repo,
    args.issueNumber,
    "content-snapshot-persist-failed",
  );
  return blockedBy("content-snapshot-persist-failed");
}

/**
 * Rewrite a verified baseline under the current hash encoding (Issue #3963).
 *
 * Unlike {@link captureBaselineOrBlock}, a failed write here does not block:
 * the verification itself already succeeded under the stored encoding, so the
 * content in hand is the approved content. The stale digest simply stays on
 * disk and re-verifies the same way on the next scan. Blocking instead would
 * turn a worker-side migration into exactly the mass de-scheduling this issue
 * exists to prevent — but the failure is still logged loudly, never swallowed.
 */
async function reBaselineAfterEncodingChange(args: {
  stateDir: string;
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  author: string;
  storedEncoding: string;
  contentDeps?: ContentApprovalDeps;
}): Promise<ContentIntegrityVerdict> {
  const captured = await captureContentSnapshot(
    args.stateDir,
    args.repo,
    args.issueNumber,
    args.title,
    args.body,
    args.author,
    args.contentDeps,
  );
  if (!captured.ok) {
    console.error(
      `[SECURITY] [CONTENT_ENCODING_REBASELINE_FAILED] Could not rewrite the ` +
        `approval baseline for ${args.repo}#${args.issueNumber} under the ` +
        `current hash encoding: ${captured.error.message} — proceeding, ` +
        `since the content verified unchanged under the stored encoding ` +
        `${args.storedEncoding}; the next scan will retry the migration`,
    );
  }
  return PROCEED;
}

/**
 * Render an edit history for the audit log (Issue #3879).
 *
 * The gate logs every editor it judged, not just the one it names in the
 * escalation, so a post-incident audit of worker logs can tell a genuinely
 * trusted history apart from a history that merely *ended* with a trusted
 * actor.
 */
function describeEditors(editors: IssueEditActor[]): string {
  if (editors.length === 0) return "<no recorded edit>";
  return editors
    .map((e) => `${e.login || "<unattributed>"}@${e.editedAt}(${e.source})`)
    .join(", ");
}

/**
 * Name the editors that failed the trust check, for the escalation comment.
 *
 * An empty list means the content diverged with no edit GitHub attributes to
 * anyone, which reads the same way to a human as an edit whose actor GitHub
 * dropped: unattributable, therefore untrusted.
 */
function buildUntrustedEditorPhrase(untrusted: IssueEditActor[]): string {
  const logins = [
    ...new Set(untrusted.map((e) => e.login).filter((login) => login !== "")),
  ];
  const unattributed = untrusted.length === 0 ||
    untrusted.some((e) => e.login === "");

  const parts: string[] = [];
  if (logins.length > 0) {
    parts.push(
      `${logins.map((login) => `\`${login}\``).join(", ")} ` +
        `(not on the trusted-author list)`,
    );
  }
  if (unattributed) {
    parts.push("an actor GitHub does not attribute (no recorded editor)");
  }
  return parts.join(" and ");
}

/**
 * Content that is about to be verified, plus the collaborators needed to
 * act on the verdict (Issue #3647).
 *
 * `currentTitle` / `currentBody` are the exact bytes under consideration —
 * at scan time the collector's own fetch, at pickup time the very strings
 * that will be interpolated into the Claude prompt.
 */
export interface ContentIntegrityDecisionInput {
  repo: string;
  issueNumber: number;
  /** Issue author, recorded when a fresh snapshot is captured. */
  issueAuthor: string;
  /** Title being verified — the bytes that reach the model. */
  currentTitle: string;
  /** Body being verified — the bytes that reach the model. */
  currentBody: string;
  config: WorkerConfig;
  ghFn: (args: string[]) => Promise<string>;
  /** Approval label removed and named in the escalation when blocking. */
  approvalLabel: string;
  /**
   * Whether a missing snapshot should be captured.
   *
   * True at scan time (the collector establishes the approval baseline);
   * false at pickup time, where a snapshot is an approval-time artefact
   * and capturing one would bless whatever content is in hand.
   */
  captureWhenMissing: boolean;
  diag?: IssueFinderDiagnostics;
  contentDeps?: ContentApprovalDeps;
  timelineCache?: TimelineCache;
}

/**
 * Decide whether the supplied title/body may be processed (Issue #3647).
 *
 * Shared by the scan-time collectors and the pickup-time re-verification so
 * both apply identical semantics:
 *
 * - No snapshot: captures one and proceeds (scan time), or blocks without
 *   capturing (pickup time, Issue #3876).
 * - Unchanged: proceeds.
 * - Unchanged, but the digest verified under a superseded or unstamped hash
 *   encoding (Issue #3963): logs `[CONTENT_HASH_ENCODING_MIGRATED]`, rewrites
 *   the baseline under the current encoding, and proceeds. A failed rewrite is
 *   logged but does not block — the content was verified unchanged.
 * - Changed, but a trusted author re-applied the approval label after both the
 *   snapshot and the edit (Issue #3868), or *every* actor who edited since the
 *   snapshot is trusted (Issues #3715, #3879): refreshes the snapshot and
 *   proceeds.
 * - Changed, and any actor who edited since the snapshot is untrusted or
 *   unattributable: adds `needs-human`, escalates, and blocks — whoever
 *   edited last (Issue #3879). The approval label is left in place (Issue
 *   #3964): `needs-human` already stops the worker, and the operator clears
 *   it after review without re-approving from scratch. A later trusted edit,
 *   of the same field or another, is **not** a re-approval: the only way to
 *   bless an untrusted edit is an explicit approval-label re-add by a trusted
 *   author that post-dates it.
 * - Changed, but the editor lookup succeeds with **zero edits since the
 *   snapshot** (Issue #3964): GitHub records every rename and body edit, so
 *   the content provably did not change and the mismatch is self-inflicted
 *   (encoding change, store corruption, capture bug). Logs the
 *   `[SNAPSHOT_SELF_MISMATCH]` marker, re-baselines from the
 *   verified-unchanged live content, and proceeds without mutating the issue.
 * - Changed, but the editor cannot be resolved: blocks without mutating the
 *   issue, so a transient lookup failure cannot mutate labels.
 * - Changed, and the refreshed baseline could not be persisted: blocks rather
 *   than proceeding on a baseline that was never written (Issue #3868).
 *
 * @returns a verdict of "proceed", or "blocked" with the reason it blocked
 */
export async function resolveContentIntegrity(
  input: ContentIntegrityDecisionInput,
): Promise<ContentIntegrityVerdict> {
  const {
    repo,
    issueNumber,
    issueAuthor,
    currentTitle,
    currentBody,
    config,
    ghFn,
    approvalLabel,
    captureWhenMissing,
    diag,
    contentDeps,
    timelineCache,
  } = input;

  // Issue #3717: the baseline is kept outside `workDir`, so `nukeWorkDir()`
  // or an agent-driven `rm` in the work tree cannot silently disarm the gate.
  const stateDir = resolveContentApprovalStateDir(config.workDir);

  // Issue #3874: an unset, whitespace-only or `/` workDir resolves to no store
  // at all. Without this guard the read short-circuited to an empty state and
  // every issue verified as `no_snapshot` → proceed, which is indistinguishable
  // from a legitimate first encounter. Fail closed, and on a marker of its own
  // so the misconfiguration is greppable rather than inferable.
  if (!stateDir) {
    console.error(
      `[SECURITY] [CONTENT_STORE_UNCONFIGURED] No content-approval store ` +
        `resolves from workDir "${config.workDir}", so the approval baseline ` +
        `for ${repo}#${issueNumber} cannot be read or written — BLOCKED. ` +
        `Set the worker's workDir to an absolute path.`,
    );
    diag?.logIssueSkipped(repo, issueNumber, "content-store-unconfigured");
    return blockedBy("content-store-unconfigured");
  }

  const verification = await verifyContentUnchanged(
    stateDir,
    repo,
    issueNumber,
    currentTitle,
    currentBody,
    contentDeps,
  );

  switch (verification.status) {
    case "unchanged":
      // Issue #3963: the digest verified, but under a superseded (or
      // unstamped) encoding. The content is provably the approved content, so
      // the only work left is rewriting the baseline under the current
      // encoding — never a block, and never a label change.
      if (verification.staleEncoding) {
        console.warn(
          `[SECURITY] [CONTENT_HASH_ENCODING_MIGRATED] Approval baseline for ` +
            `${repo}#${issueNumber} verified under the stored encoding ` +
            `${verification.staleEncoding} — content unchanged, ` +
            `re-baselining under the current encoding`,
        );
        return await reBaselineAfterEncodingChange({
          stateDir,
          repo,
          issueNumber,
          title: currentTitle,
          body: currentBody,
          author: issueAuthor,
          storedEncoding: verification.staleEncoding,
          contentDeps,
        });
      }
      return PROCEED;

    case "no_snapshot":
      if (captureWhenMissing) {
        // Scan time: legacy issue or first encounter — establish the approval
        // baseline and proceed with a warning.
        console.warn(
          `[SECURITY] [NO_CONTENT_SNAPSHOT] No approval snapshot for ` +
            `${repo}#${issueNumber} — capturing now`,
        );
        return await captureBaselineOrBlock({
          stateDir,
          repo,
          issueNumber,
          title: currentTitle,
          body: currentBody,
          author: issueAuthor,
          contentDeps,
          diag,
        });
      }

      // Issue #3876 (SEC-cc0eb4f8fad8): at pickup (`captureWhenMissing:
      // false`) this branch captured nothing *and* verified nothing, so a
      // missing baseline was an unconditional pass on the very check that
      // exists to catch content edited between approval and prompt build.
      // Capturing here is still wrong — minting a snapshot would bless
      // content no trusted author approved — but so is proceeding: the state
      // is unverifiable, exactly like the `error` branch below, so fail
      // closed the same way. Every collector captures a baseline at scan
      // time, so a store that lost one self-heals on the next scan rather
      // than wedging the issue.
      console.error(
        `[SECURITY] [NO_CONTENT_SNAPSHOT] No approval snapshot for ` +
          `${repo}#${issueNumber} at pickup — the content bound for the ` +
          `prompt cannot be verified against an approval — BLOCKED`,
      );
      diag?.logIssueSkipped(repo, issueNumber, "no-approval-snapshot");
      return blockedBy("no-approval-snapshot");

    case "changed": {
      // Issue #3715 (SEC-e9204c7fa81b): re-baselining must turn on whoever
      // *made the edit*, not the author recorded when the snapshot was
      // captured. Any collaborator can edit a trusted author's issue, so
      // trusting `verification.issueAuthor` handed the editor the author's
      // trust and took the "proceed and re-baseline" branch.
      //
      // Issue #3868 (SEC-3a0823989944): the lookup now runs *before* the
      // re-approval branch below, which used to return `proceed` without ever
      // consulting the editor. An unresolved editor therefore blocks every
      // path out of `changed`, including re-approval — fail closed, and the
      // next scan re-evaluates.
      const editorLookup = await resolveLastIssueEditor(
        repo,
        issueNumber,
        ghFn,
      );

      if (!editorLookup.ok) {
        // Fail closed: an unresolved editor cannot be trusted, and the
        // failure may be transient, so no label is stripped and no
        // escalation is raised — the next scan re-evaluates.
        console.error(
          `[SECURITY] [CONTENT_EDITOR_UNRESOLVED] Could not resolve who edited ` +
            `${repo}#${issueNumber}: ${editorLookup.error.message} — BLOCKED`,
        );
        diag?.logIssueSkipped(repo, issueNumber, "content-editor-unresolved");
        return blockedBy("content-editor-unresolved");
      }

      // Issue #3879 (SEC-91c772025359): the lookup used to collapse the whole
      // edit history to a single newest actor, so an untrusted body edit
      // followed by *any* later trusted edit — a maintainer fixing a typo in
      // the title is enough, and is an ordinary thing for a maintainer to do —
      // reported only the trusted actor and blessed the untrusted body. The
      // question this gate asks is "has anyone untrusted touched this since the
      // approval?", which is a property of the set, not of its maximum.
      const editor = editorLookup.actor;
      const editorLogin = editor?.login ?? "";

      // Edits that post-date the baseline are the ones that could have produced
      // the current content.
      const sinceSnapshot = editorLookup.actors.filter(
        (e) => e.editedAt >= verification.capturedAt,
      );

      // Issue #3964: GitHub records every title rename and every body edit.
      // When the lookup succeeds and records nothing since the snapshot, the
      // content provably did not change, so the mismatch can only be
      // self-inflicted — an encoding change, store corruption, or a
      // capture-side bug (the #3963 hash migration is the canonical case).
      // The previous whole-history fallback judged the phantom editor as
      // unattributable/untrusted and de-scheduled the issue fleet-wide,
      // punishing the operator for a worker defect. Log loudly (this is a
      // worker bug worth surfacing), refresh the baseline from the
      // verified-unchanged live content, and proceed without touching labels
      // or commenting.
      if (sinceSnapshot.length === 0) {
        console.error(
          `[SECURITY] [SNAPSHOT_SELF_MISMATCH] Snapshot hash for ` +
            `${repo}#${issueNumber} mismatches but GitHub records no edit ` +
            `since the snapshot (recorded history: ` +
            `[${describeEditors(editorLookup.actors)}]) — the content is ` +
            `provably unchanged, so this is a worker-side snapshot defect. ` +
            `Re-baselining and proceeding.`,
        );
        return await captureBaselineOrBlock({
          stateDir,
          repo,
          issueNumber,
          title: currentTitle,
          body: currentBody,
          author: issueAuthor,
          contentDeps,
          diag,
        });
      }

      const judged = sinceSnapshot;
      const untrustedEditors = judged.filter(
        (e) => !e.login || !isAuthorTrusted(e.login, config.allowedAuthors),
      );

      // Issue #1561: If a trusted author re-added the work-on label AFTER
      // the snapshot was captured, treat that as a fresh approval — the
      // approver explicitly re-approved the current content, so refresh the
      // snapshot and proceed rather than raising a false "Issue Modified
      // After Approval" alarm.
      //
      // Issue #3868: an approval can only bless content it could have seen,
      // so it must post-date the *edit* as well as the snapshot. Comparing
      // against `capturedAt` alone was durable rather than racy — `capturedAt`
      // is refreshed only by a capture, so one trusted label-add that
      // post-dated the stored snapshot (a `low-priority` → `work-on`
      // promotion, a requeue, or the re-approval this module's own escalation
      // asks for) auto-blessed every later untrusted edit indefinitely.
      const labelInfo = await getLabelLastAddInfo(
        repo,
        issueNumber,
        approvalLabel,
        ghFn,
        timelineCache,
      );
      const approvalPostDatesSnapshot = labelInfo !== null &&
        labelInfo.addedAt > verification.capturedAt;
      // No edit record at all means there is no edit the approval could
      // post-date; a recorded edit must not be newer than the approval.
      const approvalPostDatesEdit = editor === null ||
        (labelInfo !== null && labelInfo.addedAt >= editor.editedAt);
      const adderTrusted = labelInfo !== null &&
        isAuthorTrusted(labelInfo.addedBy, config.allowedAuthors);

      if (approvalPostDatesSnapshot && adderTrusted) {
        if (approvalPostDatesEdit) {
          console.warn(
            `[SECURITY] [ISSUE_REAPPROVED_AFTER_MODIFICATION] Trusted author ` +
              `${labelInfo?.addedBy} re-added ${approvalLabel} on ` +
              `${repo}#${issueNumber} after prior snapshot — refreshing snapshot`,
          );
          return await captureBaselineOrBlock({
            stateDir,
            repo,
            issueNumber,
            title: currentTitle,
            body: currentBody,
            author: issueAuthor,
            contentDeps,
            diag,
          });
        }
        // Greppable marker for the case this gate exists to catch: the
        // approval is genuine but stale, so the edit falls through to the
        // editor-trust check below rather than riding the approval.
        console.warn(
          `[SECURITY] [REAPPROVAL_PREDATES_EDIT] ${approvalLabel} on ` +
            `${repo}#${issueNumber} was last added at ${labelInfo?.addedAt}, ` +
            `before the most recent edit at ${editor?.editedAt} — the ` +
            `approval cannot bless content the approver never saw`,
        );
      }

      if (untrustedEditors.length === 0) {
        // Every editor in the window is trusted — warn but proceed, recapturing
        // the snapshot against the newest editor's identity so the next
        // verification compares like with like.
        console.warn(
          `[SECURITY] [ISSUE_MODIFIED_AFTER_APPROVAL] Trusted editors ` +
            `[${
              describeEditors(judged)
            }] modified ${repo}#${issueNumber} — proceeding`,
        );
        return await captureBaselineOrBlock({
          stateDir,
          repo,
          issueNumber,
          title: currentTitle,
          body: currentBody,
          author: editorLogin,
          contentDeps,
          diag,
        });
      }

      // At least one untrusted (or unattributable) editor in the window —
      // block processing, regardless of who edited last.
      const editorPhrase = buildUntrustedEditorPhrase(untrustedEditors);

      console.error(
        `[SECURITY] [ISSUE_MODIFIED_AFTER_APPROVAL] Untrusted editors ` +
          `[${describeEditors(untrustedEditors)}] modified ` +
          `${repo}#${issueNumber} after work-on approval — ` +
          `BLOCKED (all editors judged: [${describeEditors(judged)}])`,
      );

      // Issue #3964: the approval label is deliberately left in place.
      // `needs-human` already stops the worker from proceeding, so removing
      // `work-on` only converted a review flag into a de-scheduling event
      // that required a trusted author to re-approve from scratch.
      //
      // Issue #2211: route both the `needs-human` label add and the
      // explanation comment through the shared `escalateToHuman` helper so
      // they land atomically through a single chokepoint. The previous
      // free-form `buildContentModifiedComment` body is split into the
      // helper's `**Why:**` / `**Next step:**` lines; the helper renders
      // the standard heading and the `🤖 Processed by:` footer.
      await escalateToHuman({
        ghClient: createGhEscalationClient(ghFn),
        repo,
        target: { kind: "issue", number: issueNumber },
        needsHumanLabel: config.needsHumanLabel,
        heading: "Issue Modified After Approval",
        reason:
          `The issue's title or body was modified after a trusted author ` +
          `applied \`${approvalLabel}\`, and at least one edit since that ` +
          `approval came from ${editorPhrase}. ` +
          `For security, \`${config.needsHumanLabel}\` has been added and ` +
          `automated processing is blocked until a human reviews the ` +
          `change. The \`${approvalLabel}\` label has been left in place.`,
        nextStep:
          `A trusted author should review the updated content. If it is ` +
          `acceptable, remove \`${config.needsHumanLabel}\` — ` +
          `\`${approvalLabel}\` was not removed, so no re-approval is ` +
          `needed. If it is not acceptable, revert the change (or remove ` +
          `\`${approvalLabel}\`) before removing ` +
          `\`${config.needsHumanLabel}\`.`,
        deps: {
          github: {
            ensureLabelExists: ensureLabelExistsViaGhFn(ghFn),
          },
        },
        logger: defaultLogger,
      });

      diag?.logIssueSkipped(
        repo,
        issueNumber,
        "content-modified-after-approval",
      );
      return blockedBy("content-modified-after-approval");
    }

    case "error":
      // Issue #3649 (SEC-51c8ba073ef9): this branch claimed to "fail safe"
      // but returned "proceed", blessing content it had just failed to
      // verify. The TOCTOU guard is only worth having if it fails closed —
      // matching the sibling fetch-error branch in
      // `verifyWorkOnContentIntegrity`. No snapshot is captured here: doing
      // so would launder an unusable baseline into a fresh approval of
      // whatever content is in hand.
      console.error(
        `[SECURITY] [CONTENT_CHECK_ERROR] Verification failed for ${repo}#${issueNumber}: ` +
          `${verification.message} — BLOCKED`,
      );
      diag?.logIssueSkipped(repo, issueNumber, "content-check-error");
      return blockedBy("content-check-error");

    default:
      // Exhaustiveness guard (Issue #2568). Adding a `ContentVerificationResult`
      // variant without a case above is a compile error here, replacing the
      // previous reliance on `noImplicitReturns` for partial protection.
      return assertNever(verification);
  }
}

/**
 * The scan-time content-integrity outcome, carrying the gate that refused
 * (Issue #524).
 *
 * `reason` is a {@link SkipReason} rather than a
 * {@link ContentIntegrityBlockReason} because the fetch-failure branch below
 * refuses under `fetch-error`, which is not a content-integrity verdict. The
 * caller needs the gate that actually refused, so the wider type is the honest
 * one: it is what decides whether the issue still serialises its repo.
 */
export type WorkOnContentIntegrityOutcome =
  | { verdict: "proceed" }
  | { verdict: "blocked"; reason: SkipReason };

/**
 * Verify work-on issue content integrity at scan time, reporting *which* gate
 * refused (Issues #1341, #524).
 *
 * Fetches the current title/body itself, then applies the shared decision in
 * `resolveContentIntegrity`. Note that the verified content is *not* what the
 * prompt later consumes — the pickup path re-verifies the bytes it actually
 * sends (Issue #3647, `pickup_content_integrity.ts`).
 *
 * Issue #1724: An optional `labelName` parameter lets the low-priority
 * collector reuse this same TOCTOU check against a different approval
 * label. Defaults to `config.workOnLabel` so existing callers are
 * unaffected.
 *
 * @returns "proceed" to continue processing, or "blocked" with the refusing
 *   gate's skip reason.
 */
export async function verifyWorkOnContentIntegrityDetailed(
  repo: string,
  issue: FilterableIssue,
  config: WorkerConfig,
  ghFn: (args: string[]) => Promise<string>,
  diag?: IssueFinderDiagnostics,
  contentDeps?: ContentApprovalDeps,
  timelineCache?: TimelineCache,
  labelName?: string,
): Promise<WorkOnContentIntegrityOutcome> {
  const fetched = await fetchIssueTitleAndBody(repo, issue.number, ghFn);
  if (!fetched.ok) {
    // Issue #2534: a gh failure or malformed JSON for a single issue must not
    // abort the surrounding per-issue scan loop. Fail safe by skipping just
    // this issue so the scan continues with the next candidate.
    console.warn(
      `[SECURITY] [CONTENT_FETCH_ERROR] Could not fetch title/body for ` +
        `${repo}#${issue.number}: ${fetched.error.message} — skipping`,
    );
    diag?.logIssueSkipped(repo, issue.number, "fetch-error");
    return { verdict: "blocked", reason: "fetch-error" };
  }

  const decision = await resolveContentIntegrity({
    repo,
    issueNumber: issue.number,
    issueAuthor: issue.author,
    currentTitle: fetched.value.title,
    currentBody: fetched.value.body,
    config,
    ghFn,
    approvalLabel: labelName ?? config.workOnLabel,
    captureWhenMissing: true,
    diag,
    contentDeps,
    timelineCache,
  });
  return decision;
}

/**
 * Verify work-on issue content integrity at scan time (Issue #1341).
 *
 * Verdict-only wrapper over {@link verifyWorkOnContentIntegrityDetailed} for
 * callers that do not act on the reason.
 *
 * @returns "proceed" to continue processing, "blocked" to skip
 */
export async function verifyWorkOnContentIntegrity(
  repo: string,
  issue: FilterableIssue,
  config: WorkerConfig,
  ghFn: (args: string[]) => Promise<string>,
  diag?: IssueFinderDiagnostics,
  contentDeps?: ContentApprovalDeps,
  timelineCache?: TimelineCache,
  labelName?: string,
): Promise<"proceed" | "blocked"> {
  const outcome = await verifyWorkOnContentIntegrityDetailed(
    repo,
    issue,
    config,
    ghFn,
    diag,
    contentDeps,
    timelineCache,
    labelName,
  );
  return outcome.verdict;
}
