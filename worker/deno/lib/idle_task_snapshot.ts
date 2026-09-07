/**
 * Shared GitHub-issue snapshot helpers for idle-task scan templates
 * (Issue #2408, sub-issue #2410).
 *
 * The five outcome-only scan templates (security-scan, best-practices,
 * test-audit, github-actions-audit, supply-chain-readiness) all verify a scan
 * the same way: snapshot the repo's open scan-labelled issues before the run,
 * snapshot again afterwards, and treat the difference as the newly-filed
 * findings. Four of them also build a known-open finding-id skip-list from the
 * `<!-- finding-id: … -->` body marker so Claude does not re-emit a finding the
 * repo already tracks.
 *
 * Before this module each template carried its own private, copy-pasted version
 * of those helpers (#2410). Centralising them means a sixth template consumes
 * the shared helpers instead of copy-pasting a sixth time, and the gh-failure /
 * malformed-JSON handling lives in exactly one place.
 *
 * Robustness (sub-issue #2411): a malformed `gh … --json` payload is no longer
 * silently swallowed — the parse error is logged with a label before the
 * defensive result is returned, so an operator can tell a genuinely-empty repo
 * apart from a transient gh hiccup that produced unparseable output. That
 * defensive result is `[]` for the dedup look-ups and `null` for the
 * before/after snapshot (see the next paragraph).
 *
 * Unknown ≠ empty (Issue #1105): the before/after snapshot
 * ({@link listOpenIssueNumbersByLabel}) returns `null` rather than an empty
 * set when its lookup fails, and {@link diffNewlyFiled} propagates that as a
 * `null` diff. A failed *after* lookup used to render `0 findings` and upload
 * no SARIF — indistinguishable from a clean scan — while a failed *before*
 * lookup inflated the newly-filed set to every open issue. Templates render
 * {@link NEWLY_FILED_UNKNOWN_SUMMARY} instead of claiming a count they do not
 * have; the run still completes rather than throwing.
 *
 * Scope (Issue #539): the before/after snapshot is still label-scoped — it
 * measures what one scan filed — but both `finding-id` look-ups are now
 * **repo-wide**. The marker is the dedup key and the label is not part of it,
 * so an open duplicate stays deduped after the issue is relabelled. Their
 * `logLabel` parameter names the calling scan in log lines only; it filters
 * nothing.
 *
 * Author verification (Issue #1243): the `<!-- finding-id: … -->` marker both
 * look-ups read lives in an issue **body**, which anyone with a GitHub account
 * can write on a public repository, and finding ids are deterministic per
 * scanner. A marker match therefore proves nothing on its own — only the issue
 * author is authenticated — so one planted issue used to suppress a real
 * finding across every scanner sharing these helpers, silently and for as long
 * as it stayed open. Both look-ups now route their matches through
 * {@link selectFleetAuthoredMatches}, the same control `host_escalation.ts`
 * and friends already apply to their body-marker searches. The fail direction
 * is towards filing: an unverifiable match is discarded, so a duplicate
 * finding is the worst case. A duplicate is noise a human closes; a suppressed
 * finding is one nobody hears about.
 *
 * Australian English used throughout (behaviour, organisation, authorised).
 */

import {
  ALERT_DEDUP_JSON_FIELDS,
  type AlertDedupAuthorOptions,
  type AlertDedupRow,
  selectFleetAuthoredMatches,
} from "./alert_dedup_authors.ts";
import {
  neutraliseHtmlComments,
  sanitiseDelimiterPatterns,
} from "./prompt_delimiter.ts";

/**
 * Parse a `gh … --json` payload into an array of entries.
 *
 * Returns `[]` when the payload is not valid JSON or is not an array. Unlike
 * the per-template copies this replaces, both failures are logged (not
 * swallowed) with `label` so they are visible in operator logs.
 *
 * Exported (Issue #2411) so scan templates that have not yet migrated their
 * before/after snapshot to {@link listOpenIssueNumbersByLabel} can still route
 * their own bare `JSON.parse` issue-list parses through one place — keeping the
 * defensive empty-return while making a swallowed parse failure visible.
 */
export function parseGhJsonArray(raw: string, label: string): unknown[] {
  return parseGhJsonArrayOrNull(raw, label) ?? [];
}

/**
 * Parse a `gh … --json` payload, distinguishing *unknown* from *empty*.
 *
 * Returns `null` — never `[]` — when the payload is unparseable or is not an
 * array, so a caller that must not conflate "the lookup failed" with "the repo
 * has nothing" can tell the two apart (Issue #1105). The parse failure is
 * logged with `label` exactly as {@link parseGhJsonArray} logs it.
 */
function parseGhJsonArrayOrNull(raw: string, label: string): unknown[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[idle-task-snapshot] ${label}: failed to parse gh JSON payload: ${message}`,
    );
    return null;
  }
  if (!Array.isArray(parsed)) {
    console.error(
      `[idle-task-snapshot] ${label}: gh JSON payload was not an array`,
    );
    return null;
  }
  return parsed;
}

/**
 * Summary text rendered when the newly-filed diff could not be computed
 * (Issue #1105).
 *
 * Every scan template renders this instead of its "no findings" line when
 * {@link diffNewlyFiled} returns `null`, so a snapshot lookup that failed is
 * never reported as a scan that found nothing.
 */
export const NEWLY_FILED_UNKNOWN_SUMMARY =
  "Newly-filed count unavailable — an open-issue snapshot lookup failed, so " +
  "this run cannot report how many findings it filed. Findings filed by this " +
  "run are still open as issues; only the count is unknown.";

/**
 * Return the set of open issue numbers carrying `label` in `repo`, or `null`
 * when the lookup could not be performed.
 *
 * Used as the before/after snapshot for the newly-filed diff. A gh failure or
 * malformed payload returns `null` — **not** an empty set — so the run still
 * finishes without throwing while the caller can tell "no open issues" apart
 * from "the lookup failed" (Issue #1105). Conflating the two rendered a failed
 * *after* snapshot as `0 findings` with no SARIF upload, indistinguishable
 * from a genuinely clean scan; a failed *before* snapshot inflated the
 * newly-filed set to every open issue. Both failures are logged.
 */
export async function listOpenIssueNumbersByLabel(
  repo: string,
  label: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<Set<number> | null> {
  const out = new Set<number>();
  let raw: string;
  try {
    raw = await ghCommandFn([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--label",
      label,
      "--json",
      "number",
      "--limit",
      "200",
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[idle-task-snapshot] list ${label} numbers: ${repo}: gh lookup ` +
        `failed: ${message} — the newly-filed count for this run is unknown.`,
    );
    return null;
  }
  const entries = parseGhJsonArrayOrNull(raw, `list ${label} numbers`);
  if (entries === null) return null;
  for (const item of entries) {
    if (item === null || typeof item !== "object") continue;
    const n = (item as { number?: unknown }).number;
    if (typeof n === "number" && Number.isFinite(n)) out.add(n);
  }
  return out;
}

/** An open issue reduced to the two fields the dedup skip-list needs. */
export interface OpenIssueTitle {
  /** The issue number. */
  number: number;
  /** The raw, unsanitised issue title as GitHub returned it. */
  title: string;
}

/** Default ceiling on the repo-wide open-issue title list. */
const DEFAULT_OPEN_ISSUE_TITLE_LIMIT = 300;

/**
 * Return every open issue in `repo` as `{ number, title }`, regardless of
 * label, author or filing template (Issue #535).
 *
 * The sibling dedup helpers all filter by a single label, so a finding already
 * open under a *different* idle task's label is invisible to them — which is
 * how the `github-actions-audit` scan re-filed a CODEOWNERS finding that had
 * been open for three days under `needs-human` alone. This helper is the
 * missing primitive: the unfiltered view of what the repo already has open, for
 * a caller to hand the model as a semantic-duplicate skip-list. It therefore
 * issues **no** `--label` argument by design.
 *
 * Robustness matches the rest of the module: a gh failure or malformed payload
 * returns `[]` so a transient lookup hiccup never aborts a scan, and the parse
 * failure is logged rather than swallowed.
 *
 * The list is bounded by `opts.limit` (default 300). Hitting that bound is
 * logged loudly, because a truncated skip-list reads to the model exactly like
 * "no duplicate found" — a silent truncation would re-open the very bug this
 * helper exists to close. Callers get the raw titles; rendering (and the
 * sanitisation a prompt needs) is {@link renderOpenIssueTitles}.
 */
export async function listAllOpenIssueTitles(
  repo: string,
  ghCommandFn: (args: string[]) => Promise<string>,
  opts: { limit?: number } = {},
): Promise<OpenIssueTitle[]> {
  const requested = opts.limit;
  const limit = typeof requested === "number" && Number.isFinite(requested) &&
      requested > 0
    ? Math.floor(requested)
    : DEFAULT_OPEN_ISSUE_TITLE_LIMIT;

  let raw: string;
  try {
    raw = await ghCommandFn([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      "number,title",
      "--limit",
      String(limit),
    ]);
  } catch {
    return [];
  }

  const entries = parseGhJsonArray(raw, `list all open issue titles ${repo}`);
  const issues: OpenIssueTitle[] = [];
  for (const item of entries) {
    if (item === null || typeof item !== "object") continue;
    const n = (item as { number?: unknown }).number;
    const title = (item as { title?: unknown }).title;
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    if (typeof title !== "string") continue;
    issues.push({ number: n, title });
  }

  if (entries.length >= limit) {
    console.error(
      `[idle-task-snapshot] listAllOpenIssueTitles: ${repo}: open-issue list ` +
        `hit the ${limit}-issue limit — the dedup skip-list is TRUNCATED and ` +
        `duplicates beyond it will not be seen. Raise the limit for this repo.`,
    );
  }
  return issues;
}

/** Longest title rendered into a prompt line before it is elided. */
const MAX_TITLE_CHARS = 160;

/**
 * Render one untrusted issue title safe to sit inside a prompt block.
 *
 * Titles are attacker-influenceable GitHub text, so they are scrubbed exactly
 * as any other untrusted excerpt: delimiter-shaped patterns and trust
 * vocabulary via {@link sanitiseDelimiterPatterns}, HTML comments via
 * {@link neutraliseHtmlComments} (so no forged `<!-- finding-id: … -->` marker
 * can form), then every control/line-break character collapsed to a space so a
 * title can never span more than its own line. Capped last, with an ellipsis so
 * the elision is visible. A title scrubbed to nothing renders `(untitled)` —
 * a visible placeholder, never a silently blank line.
 */
function renderTitle(title: string, maxChars: number): string {
  const scrubbed = neutraliseHtmlComments(sanitiseDelimiterPatterns(title))
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    // Every remaining angle bracket goes fullwidth (Issue #1249, finding 9).
    // The prompts fence this list between *single*-angle, static, guessable
    // tags (`<open_issue_titles>` … `</open_issue_titles>`), and
    // `sanitiseDelimiterPatterns` only neutralises runs of two or more, so a
    // title containing `</open_issue_titles>` closed the block and everything
    // after it read as prompt structure. A title has no structural use for a
    // bracket, so rewriting both to their inert fullwidth forms costs nothing
    // and no single-angle tag can be forged.
    .replace(/</g, "＜")
    .replace(/>/g, "＞")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (scrubbed.length === 0) return "(untitled)";
  return scrubbed.length > maxChars
    ? `${scrubbed.slice(0, maxChars).trimEnd()}…`
    : scrubbed;
}

/**
 * Render the open-issue list as one `#<number> — <title>` line per issue.
 *
 * Pure formatter for the prompt-side skip-list. An empty list renders the
 * `(none)` sentinel — the same convention `{{SUPPRESSED_IDS}}` and
 * `{{KNOWN_OPEN_FINDING_IDS}}` already use — so a wrapper still reads naturally
 * standalone. `opts.maxTitleChars` overrides the per-title cap (default 160).
 */
export function renderOpenIssueTitles(
  issues: readonly OpenIssueTitle[],
  opts: { maxTitleChars?: number } = {},
): string {
  if (issues.length === 0) return "(none)";
  const requested = opts.maxTitleChars;
  const maxChars =
    typeof requested === "number" && Number.isFinite(requested) &&
      requested > 0
      ? Math.floor(requested)
      : MAX_TITLE_CHARS;
  return issues
    .map((issue) => `#${issue.number} — ${renderTitle(issue.title, maxChars)}`)
    .join("\n");
}

/**
 * Return the issue numbers present in `after` but not in `before` — the
 * findings filed during a scan run — sorted ascending so callers render a
 * deterministic summary.
 *
 * Returns `null` when **either** snapshot is unknown (Issue #1105). The two
 * ends fail in opposite directions — an unknown `after` would diff to nothing
 * and report a clean scan, an unknown `before` would diff to every open issue
 * and over-report — so neither is turned into a number the run does not have.
 * Callers render {@link NEWLY_FILED_UNKNOWN_SUMMARY} instead of a count.
 */
export function diffNewlyFiled(
  before: ReadonlySet<number> | null,
  after: ReadonlySet<number> | null,
): number[] | null {
  if (before === null || after === null) return null;
  const newlyFiled: number[] = [];
  for (const n of after) {
    if (!before.has(n)) newlyFiled.push(n);
  }
  newlyFiled.sort((a, b) => a - b);
  return newlyFiled;
}

/**
 * Ceiling on the repo-wide open-issue body list both finding-id look-ups read.
 *
 * Lower than {@link DEFAULT_OPEN_ISSUE_TITLE_LIMIT} on purpose: these queries
 * fetch whole issue **bodies**, which are an order of magnitude heavier than
 * titles, and the query is now repo-wide rather than label-narrowed. Hitting
 * the bound is logged loudly rather than silently truncating dedup coverage.
 */
const OPEN_ISSUE_BODY_LIMIT = 200;

/**
 * Hardcoded finding-id marker pattern — no dynamic `RegExp`, no ReDoS risk.
 * Shared safely by both look-ups: `String.prototype.matchAll` iterates over an
 * internal clone, so the `g` flag carries no `lastIndex` state between calls.
 * Prefix filtering is done with `startsWith()`, never by building a regex.
 */
const FINDING_ID_RE = /<!--\s*finding-id:\s*([A-Za-z0-9-]+)\s*-->/gi;

/** An open issue reduced to the fields the finding-id look-ups need. */
interface OpenIssueBody extends AlertDedupRow {
  number: number;
  body: string;
}

/**
 * Author-verification inputs for the two finding-id look-ups (Issue #1243).
 *
 * Extends {@link AlertDedupAuthorOptions}, so a caller states the fleet with
 * `fleetAuthors` (tests) or omits it and gets the configured fleet identity —
 * `service_accounts` ∪ `fleet_pr_authors` ∪ this host's `GITHUB_USER` — which
 * is what every production caller does.
 */
export interface FindingIdDedupOptions extends AlertDedupAuthorOptions {
  /** Sink for the author-verification log lines. Defaults to `console.error`. */
  log?: (message: string) => void;
}

/**
 * What an unverifiable finding-id match costs, in this site's own words.
 *
 * `selectFleetAuthoredMatches` completes "so …" with this sentence when the
 * fleet author set cannot be resolved, so the log states the consequence
 * rather than leaving it to be inferred.
 */
const FINDING_ID_UNVERIFIED_OUTCOME =
  "no match counts as an already-filed finding and the finding is filed. A " +
  "duplicate finding is noise a human closes; a suppressed one is a finding " +
  "nobody hears about";

/** Project the `author` object `gh issue list --json author` returns. */
function rowAuthor(value: unknown): { login?: string | null } | null {
  if (value === null || typeof value !== "object") return null;
  const login = (value as { login?: unknown }).login;
  return typeof login === "string" ? { login } : null;
}

/**
 * Fetch every open **fleet-authored** issue in `repo` as `{ number, body }`,
 * regardless of label (Issue #539, Issue #1243).
 *
 * Both finding-id look-ups below used to add `--label`, so a finding whose
 * issue had been relabelled — triaged into `needs-human`, say — was invisible
 * to the dedup guard and got re-filed (NEAT-AI-Rebase #37). The marker is the
 * key; the label is not part of it, so no `--label` argument is issued.
 *
 * The query asks for `author` ({@link ALERT_DEDUP_JSON_FIELDS}) and every row
 * is filtered through {@link selectFleetAuthoredMatches} before a caller sees
 * it, because the body is attacker-writable and the author is not (Issue
 * #1243). Rows outside the fleet — and every row when the fleet author set
 * cannot be resolved — are discarded and the discard is logged, so the finding
 * is filed rather than silently suppressed.
 *
 * A gh failure or malformed payload yields `[]`, which each caller turns into
 * its own safe empty result. Hitting {@link OPEN_ISSUE_BODY_LIMIT} is logged
 * loudly with `logLabel`, because a truncated list is indistinguishable from
 * "no duplicate exists" and would re-open the duplicate-filing bug.
 */
async function listOpenIssueBodies(
  repo: string,
  logLabel: string,
  ghCommandFn: (args: string[]) => Promise<string>,
  opts: FindingIdDedupOptions,
): Promise<OpenIssueBody[]> {
  let raw: string;
  try {
    raw = await ghCommandFn([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      ALERT_DEDUP_JSON_FIELDS,
      "--limit",
      String(OPEN_ISSUE_BODY_LIMIT),
    ]);
  } catch {
    return [];
  }

  const entries = parseGhJsonArray(raw, logLabel);
  const issues: OpenIssueBody[] = [];
  for (const item of entries) {
    if (item === null || typeof item !== "object") continue;
    const n = (item as { number?: unknown }).number;
    const body = (item as { body?: unknown }).body;
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    if (typeof body !== "string") continue;
    issues.push({
      number: n,
      body,
      author: rowAuthor((item as { author?: unknown }).author),
    });
  }

  if (entries.length >= OPEN_ISSUE_BODY_LIMIT) {
    console.error(
      `[idle-task-snapshot] ${logLabel}: ${repo}: open-issue list hit the ` +
        `${OPEN_ISSUE_BODY_LIMIT}-issue limit — finding-id dedup is ` +
        `TRUNCATED and duplicates beyond it will not be seen. Raise the ` +
        `limit for this repo.`,
    );
  }

  return await selectFleetAuthoredMatches(
    issues,
    logLabel,
    opts,
    opts.log ?? ((message: string) => console.error(message)),
    FINDING_ID_UNVERIFIED_OUTCOME,
  );
}

/**
 * Return the known-open finding ids in `repo`, read from the
 * `<!-- finding-id: <idPrefix>… -->` body marker every filed finding carries.
 *
 * Repo-wide since Issue #539: every **open** issue is inspected regardless of
 * label, so an already-tracked finding stays deduped after its issue is
 * relabelled. `logLabel` names the calling scan in log lines only — it is
 * **not** a result filter.
 *
 * Four templates share the `BP-` id prefix (best-practices, test-audit,
 * github-actions-audit, supply-chain-readiness — the per-template
 * discriminator keeps the hashes distinct), so `idPrefix` defaults to `"BP-"`.
 * That prefix now does load-bearing work: the repo-wide payload also carries
 * other scans' ids (`SEC-…`, `SWEEP-…`), and only ids matching `idPrefix`
 * belong in this scan's skip-list.
 *
 * Only ids a **fleet account** wrote count (Issue #1243): the skip-list is fed
 * to the scanning agent as `{{KNOWN_OPEN_FINDING_IDS}}`, so an id read out of
 * an outsider's issue body would stand a real finding down. `opts` states the
 * fleet in tests; production callers omit it and get the configured identity.
 *
 * A gh failure or malformed payload returns an empty array — the worst case is
 * Claude re-files a finding, which the snapshot diff still catches.
 */
export async function listKnownOpenFindingIds(
  repo: string,
  logLabel: string,
  ghCommandFn: (args: string[]) => Promise<string>,
  idPrefix = "BP-",
  opts: FindingIdDedupOptions = {},
): Promise<string[]> {
  const issues = await listOpenIssueBodies(
    repo,
    `list ${logLabel} finding ids`,
    ghCommandFn,
    opts,
  );
  const ids: string[] = [];
  for (const issue of issues) {
    for (const m of issue.body.matchAll(FINDING_ID_RE)) {
      const id = m[1];
      if (id && id.startsWith(idPrefix)) ids.push(id);
    }
  }
  return ids;
}

/**
 * Return the number of an **open** issue in `repo` carrying the
 * `<!-- finding-id: <findingId> -->` body marker, or `null` when none exists.
 *
 * This is the pre-file dedup look-up (Issue #2882): the pre-filers call
 * `gh issue create` directly, so without it the same `finding-id` could yield
 * two open issues (observed for `BP-LINTER-typescript` — private-repo-14#2990/#2991).
 *
 * The look-up is repo-wide since Issue #539 — the finding id is the key, and
 * the label is not part of it. A label-scoped query missed an open duplicate
 * the moment the issue was relabelled or triaged into `needs-human`, which is
 * exactly how NEAT-AI-Rebase #37 was re-filed. `logLabel` names the calling
 * scan in log lines only; it does **not** filter results.
 *
 * Dedup is against **open** issues only: a finding whose prior issue was
 * **closed** (fixed) may legitimately re-file if it recurs, so a closed match
 * is intentionally ignored. A gh failure or malformed payload returns `null`
 * (treated as "no existing issue") so a transient lookup hiccup never aborts a
 * scan — the worst case is the pre-existing duplicate this guard normally
 * prevents.
 *
 * Only a **fleet-authored** issue can suppress a filing (Issue #1243). The
 * marker sits in a body anyone may write and the ids are deterministic, so an
 * unverified match let one planted issue silence a real finding for as long as
 * it stayed open; an unverifiable match is now discarded and the finding is
 * filed. `opts` states the fleet in tests; production callers omit it.
 */
export async function findOpenIssueByFindingId(
  repo: string,
  logLabel: string,
  findingId: string,
  ghCommandFn: (args: string[]) => Promise<string>,
  opts: FindingIdDedupOptions = {},
): Promise<number | null> {
  const issues = await listOpenIssueBodies(
    repo,
    `find ${logLabel} ${findingId}`,
    ghCommandFn,
    opts,
  );
  for (const issue of issues) {
    for (const m of issue.body.matchAll(FINDING_ID_RE)) {
      if (m[1] === findingId) return issue.number;
    }
  }
  return null;
}

/** Result of a {@link fileFindingOnce} call. */
export interface FileFindingOnceResult {
  /** The issue number — newly filed, or the pre-existing open issue. */
  number: number;
  /** The finding id the call was keyed on. */
  findingId: string;
  /** `true` when an open issue with this id already existed (no new file). */
  skipped: boolean;
}

/**
 * Shared pre-file dedup wrapper (Issue #2882) for the idle-task pre-filers.
 *
 * Looks up an existing **open** issue carrying `findingId` first; when one
 * exists it returns that issue's number with `skipped: true` and never calls
 * `fileFn`, so one `finding-id` never yields two open issues. Otherwise it
 * invokes `fileFn` (the template's real `gh issue create` path) and returns the
 * freshly-filed issue with `skipped: false`.
 *
 * Closed prior issues are not matched (open-only look-up), so a genuinely
 * recurring finding whose previous issue was fixed/closed re-files normally.
 * The look-up is repo-wide (Issue #539): `logLabel` is carried for log lines
 * only and filters nothing, so a duplicate wearing a different label is still
 * found.
 *
 * Only a **fleet-authored** open issue skips the filing (Issue #1243) — see
 * {@link findOpenIssueByFindingId}. An outsider's issue carrying the marker no
 * longer suppresses the finding.
 *
 * Returns `null` only when no open duplicate existed **and** `fileFn` returned
 * `null` (a gh create failure) — the caller logs and continues, matching the
 * existing pre-filer contract. This is a best-effort look-up-then-file: it
 * closes the routine duplicate window, not a distributed lock.
 */
export async function fileFindingOnce(
  params: {
    repo: string;
    /** The calling scan's label — used in log lines only, never as a filter. */
    logLabel: string;
    findingId: string;
    ghCommandFn: (args: string[]) => Promise<string>;
    /** Author-verification inputs for the dedup look-up (Issue #1243). */
    dedupAuthors?: FindingIdDedupOptions;
    fileFn: () => Promise<{ number: number; findingId: string } | null>;
  },
): Promise<FileFindingOnceResult | null> {
  const existing = await findOpenIssueByFindingId(
    params.repo,
    params.logLabel,
    params.findingId,
    params.ghCommandFn,
    params.dedupAuthors ?? {},
  );
  if (existing !== null) {
    return { number: existing, findingId: params.findingId, skipped: true };
  }
  const filed = await params.fileFn();
  if (filed === null) return null;
  return { number: filed.number, findingId: filed.findingId, skipped: false };
}
