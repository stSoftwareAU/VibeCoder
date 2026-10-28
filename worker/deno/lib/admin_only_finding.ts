/**
 * Detect an issue that a worker structurally cannot resolve because its fix is
 * a repository-admin action (Issue #53).
 *
 * `repo_settings_scanner.ts` files `BP-REPO-*` findings — ruleset review not
 * required, secret scanning off, default token read-write, … — whose suggested
 * fix is always "Repository admin action — the worker cannot change repository
 * settings." When a human bulk-triages such a finding to `work-on`, the worker
 * claims it, runs an agent that (correctly) changes nothing, and the completion
 * phase fails "no commits ahead". Because the claim releases as `no_pr`, the
 * still-`work-on` issue goes straight back into the pool: a permanent, futile
 * loop burning agent minutes every cycle for an issue no worker can close.
 *
 * This is the detection used up front in `issue_worker.ts` — recognise the
 * finding from its body before cloning the repo or running Claude — and the
 * repair that follows it: the worker applies the setting itself through
 * `repo_settings_harden.ts` and closes the finding, or records the refusal on
 * the normal `failed-once` ladder when its token cannot (Issue #4298). It never
 * hands the finding to a human.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { escapeRegExp } from "./regexp_escape.ts";
import { REPO_ADMIN_ACTION } from "./repo_settings_scanner.ts";
import { classifyGitHubError, GitHubErrorCategory } from "./github_errors.ts";
import type {
  HardenRepoOutcome,
  HardenResult,
  HardenStep,
} from "./repo_settings_harden.ts";

/**
 * The `BP-REPO-*` finding-id marker every repo-settings finding body carries.
 * The single definition: the admin-only hand-off below and setup's close-out
 * of fixed findings (Issue #2629) both read it through
 * {@link parseRepoSettingsFindingId}.
 */
const REPO_SETTINGS_FINDING_MARKER =
  /<!--\s*finding-id:\s*(BP-REPO-[A-Z0-9-]+)\s*-->/i;

/**
 * Strip markdown that only *quotes* text rather than asserting it: inline
 * code spans, fenced code blocks and blockquotes. An issue that merely talks
 * about the scanner — e.g. "the scanner files `<!-- finding-id: ... -->` on
 * each finding" — quotes the marker or the admin-action prose inside one of
 * these constructs; a real scanner body carries the marker as a raw HTML
 * comment and the prose as plain text, so neither is removed (Issue #3295).
 *
 * Linear-time by construction: fences and blockquotes are recognised a line
 * at a time, and the inline-code-span strip below never scans past the next backtick.
 */
function stripQuotedMarkdown(body: string): string {
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];
  let fenceChar: string | null = null;
  let fenceLen = 0;

  for (const line of lines) {
    if (fenceChar !== null) {
      const closer = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      const closerRun = closer?.[1];
      if (
        closerRun && closerRun.charAt(0) === fenceChar &&
        closerRun.length >= fenceLen
      ) {
        fenceChar = null;
        fenceLen = 0;
      }
      continue; // drop every line while inside the fence, including closer
    }

    const opener = line.match(/^ {0,3}(`{3,}|~{3,})/);
    const openerRun = opener?.[1];
    if (openerRun) {
      fenceChar = openerRun.charAt(0);
      fenceLen = openerRun.length;
      continue; // drop the opening fence line itself
    }

    if (/^ {0,3}>/.test(line)) {
      continue; // drop blockquote lines
    }

    // `[^`]*` cannot cross a backtick, so each attempt scans no further than
    // the next backtick and the strip stays linear-time (Issue #3295); the
    // lookarounds pair whole backtick runs, as CommonMark does.
    // SIMPLE-ON-PURPOSE: code spans are matched within one line — upgrade when a scanner-quoting issue wraps the marker across lines inside one span.
    kept.push(
      line.replace(/(?<!`)(`+)(?!`)[^`]*\1(?!`)/g, ""),
    );
  }

  return kept.join("\n");
}

/**
 * The `BP-REPO-*` finding id an issue body's marker names (upper-cased, e.g.
 * `BP-REPO-DEFAULT-TOKEN-WRITE`), or `null` when the body carries no such
 * marker. Any other finding family — `BP-WORKER-*`, `BP-LINTER-*`, `SEC-*` —
 * is `null`: only repo-settings findings are parsed here. A marker quoted
 * only in a code span, code fence or blockquote is ignored, so setup's
 * close-out of fixed findings (Issue #2629) never closes an issue that
 * merely quotes a finding id (Issue #3295).
 */
export function parseRepoSettingsFindingId(issueBody: string): string | null {
  if (!issueBody) return null;
  const match = REPO_SETTINGS_FINDING_MARKER.exec(
    stripQuotedMarkdown(issueBody),
  );
  return match?.[1] ? match[1].toUpperCase() : null;
}

/**
 * The scanner's full suggested-fix sentence, lead-in included — a second,
 * independent signal in case the structural marker is ever absent (e.g. a body
 * a human re-typed). Derived from `REPO_ADMIN_ACTION` so the two cannot drift;
 * whitespace runs tolerate line wraps. A fragment quoted in prose or plain
 * quotes no longer counts (Issue #3360).
 */
const REPO_ADMIN_ACTION_PROSE = new RegExp(
  escapeRegExp(REPO_ADMIN_ACTION).replace(/ +/g, "\\s+"),
  "i",
);

/**
 * `BP-REPO-*` ids whose fix is ordinary repo work (committing a file), so the
 * worker can resolve them with a normal PR (Issue #3266). A finding in this
 * set is admin-only only when its body also carries the scanner's full
 * admin-action sentence.
 */
export const WORKER_FIXABLE_REPO_FINDINGS: ReadonlySet<string> = new Set([
  "BP-REPO-SECURITY-POLICY-MISSING",
]);

/**
 * True when the issue body identifies a repository-admin finding the worker
 * cannot action (a `BP-REPO-*` finding, or the scanner's full admin-action
 * sentence).
 * Either signal only counts when it appears as real body text: quoted inside
 * a code span, code fence or blockquote, it is ignored (Issue #3295). A
 * worker-fixable finding id (`WORKER_FIXABLE_REPO_FINDINGS`) is not admin-only
 * on its marker alone; the full admin-action sentence still makes it so.
 */
export function isAdminOnlyRepoSettingsIssue(issueBody: string): boolean {
  if (!issueBody) return false;
  const findingId = parseRepoSettingsFindingId(issueBody);
  const markerIsAdminOnly = findingId !== null &&
    !WORKER_FIXABLE_REPO_FINDINGS.has(findingId);
  return markerIsAdminOnly ||
    REPO_ADMIN_ACTION_PROSE.test(stripQuotedMarkdown(issueBody));
}

/**
 * The hardening step kind that fixes each `BP-REPO-*` finding the scanner
 * files. A finding id absent from this map has no automatic fix: setup never
 * closes it (Issue #2629), and the issue lane cannot apply it (Issue #4298).
 */
export const FINDING_STEP_KIND: Readonly<Record<string, HardenStep["kind"]>> = {
  "BP-REPO-DEFAULT-TOKEN-WRITE": "workflow-token",
  "BP-REPO-ACTIONS-MAY-APPROVE-PRS": "workflow-token",
  "BP-REPO-ACTIONS-ALLOW-ALL": "actions-allow-list",
  "BP-REPO-ACTIONS-ALLOW-LIST-INCOMPLETE": "actions-allow-list",
  "BP-REPO-SHA-PIN-NOT-ENFORCED": "sha-pinning-required",
  "BP-REPO-RULESET-NO-REVIEW": "default-branch-approval",
  "BP-REPO-SECRET-SCANNING-OFF": "secret-scanning",
  "BP-REPO-PUSH-PROTECTION-OFF": "secret-scanning",
  "BP-REPO-PVR-OFF": "private-vulnerability-reporting",
};

/**
 * A repository-admin finding with no automatic fix mapped (Issue #4442).
 *
 * A worker defect: the finding is missing from `FINDING_STEP_KIND`, so the run
 * stays a `worker-crash`.
 */
export class NoAutomaticFixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoAutomaticFixError";
  }
}

/**
 * A repository-admin setting the repository or the worker's token refused
 * (Issue #4442): every result that kept the setting from applying is a
 * {@link isRepoRefusal} refusal. Only this error is classed `repo-config`;
 * any other failure stays a `worker-crash`.
 */
export class RepoAdminRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoAdminRefusalError";
  }
}

/**
 * Whether one result that kept the setting from applying is a repository or
 * token refusal rather than a worker fault (Issue #4442).
 *
 * A refusal is a deliberate skip (the plan held the step, a dependency did not
 * apply, or the owner's own setup), a 403 or 404 from GitHub, an organisation
 * ruleset or a role the repository cannot lower. Everything else is the
 * worker's to fix and stays a `worker-crash`: `hardenRepo`'s catch-all for an
 * exception in its own planning code, a 422 for a body the worker built, a 5xx,
 * a rate limit or a local fault such as a temp-file write.
 */
export function isRepoRefusal(result: HardenResult): boolean {
  if (result.status === "skipped") return true;
  if (result.status !== "failed") return false;
  if (result.refusal !== undefined) return true;
  const category = classifyGitHubError(result.detail ?? "").category;
  return category === GitHubErrorCategory.Permission ||
    category === GitHubErrorCategory.NotFound;
}

/**
 * Apply the setting a repository-admin finding asks for (Issue #4298).
 *
 * Only the finding's own steps are run, so fixing one finding never rewrites
 * an unrelated setting. Success — every step applied, or none needed because
 * the setting already holds — returns the applied steps for the closing
 * comment. Anything else is an error naming what was refused, for the caller
 * to record on the normal `failed-once` ladder: a token without admin rights,
 * an unreadable surface, or a finding with no automatic fix. The no-fix error
 * is a {@link NoAutomaticFixError} (a worker defect, Issue #4442). A failure
 * whose every refused result is a {@link isRepoRefusal} refusal is a
 * {@link RepoAdminRefusalError}; any other failure, such as a fault in the
 * hardener itself, is a plain `Error` and stays a worker defect (Issue #4442).
 *
 * @param harden - Runs `hardenRepo` with `apply` for the given step kinds.
 */
export async function repairAdminOnlyFinding(
  repo: string,
  issueBody: string,
  harden: (
    repo: string,
    kinds: readonly HardenStep["kind"][],
  ) => Promise<HardenRepoOutcome>,
): Promise<Result<string>> {
  const findingId = parseRepoSettingsFindingId(issueBody);
  const kind = findingId ? FINDING_STEP_KIND[findingId] : undefined;
  if (!kind) {
    return {
      ok: false,
      error: new NoAutomaticFixError(
        `no automatic fix is mapped for ${
          findingId ?? "this repository-admin finding"
        } — add it to FINDING_STEP_KIND in admin_only_finding.ts`,
      ),
    };
  }
  const kinds = [kind];
  const outcome = await harden(repo, kinds);
  // A failure on any surface means the plan may have been built blind, so
  // "nothing to do" cannot be trusted; a skip of the finding's own step means
  // the setting was not written.
  const refused = outcome.results.filter((r) =>
    r.status === "failed" ||
    (r.status === "skipped" && kinds.includes(r.step.kind))
  );
  if (refused.length > 0) {
    const message = `could not apply ${findingId}: ` +
      refused.map((r) =>
        `${r.step.kind}: ${r.step.title}${r.detail ? ` — ${r.detail}` : ""}`
      ).join("; ");
    return {
      ok: false,
      error: refused.every(isRepoRefusal)
        ? new RepoAdminRefusalError(message)
        : new Error(message),
    };
  }
  const applied = outcome.results.filter((r) => kinds.includes(r.step.kind));
  return {
    ok: true,
    value: applied.length === 0
      ? `The setting ${findingId} reports already holds — nothing to change.`
      : applied.map((r) => `- [${r.status}] ${r.step.title}`).join("\n"),
  };
}
