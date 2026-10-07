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
 * This is the pure detection used by the up-front hand-off in `issue_worker.ts`
 * — recognise the finding from its body and hand it to a human before cloning
 * the repo or running Claude.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

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
 * The prose the scanner puts at the head of every suggested fix — a second,
 * independent signal in case the structural marker is ever absent (e.g. a body
 * a human re-typed).
 */
const REPO_ADMIN_ACTION_PROSE = /the worker cannot change repository settings/i;

/**
 * True when the issue body identifies a repository-admin finding the worker
 * cannot action (a `BP-REPO-*` finding, or the scanner's admin-action prose).
 * Either signal only counts when it appears as real body text: quoted inside
 * a code span, code fence or blockquote, it is ignored (Issue #3295).
 */
export function isAdminOnlyRepoSettingsIssue(issueBody: string): boolean {
  if (!issueBody) return false;
  return parseRepoSettingsFindingId(issueBody) !== null ||
    REPO_ADMIN_ACTION_PROSE.test(stripQuotedMarkdown(issueBody));
}
