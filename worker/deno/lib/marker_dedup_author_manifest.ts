/**
 * Dedup lookups that trust a marker without checking who wrote it.
 *
 * A worker module decides whether to act by asking GitHub whether a marker is
 * already present — a constant title, a `<!-- … -->` body tag, a `CLAIM_LOCK:`
 * comment prefix. On a public repository the title, the body and the comment
 * are all text an unprivileged account may write; the **author** is the only
 * part of a match GitHub authenticates. A lookup that reads the marker and not
 * the author therefore concludes "already handled" on evidence anybody can
 * manufacture, and the module goes quiet. Every instance of the defect fails
 * towards silence, which is the direction nobody notices.
 *
 * Two fixes have been made against it — `alert_dedup_authors.ts` for the five
 * escalation modules' `in:body` searches, `idle_task_wrapper_dedup.ts` for the
 * idle-task wrappers' `in:title` searches — and the second fix found eighteen
 * copies of the first fix's bug. Copy-paste is how the class spreads, and
 * nothing in the build stopped it: no type, no lint rule and no runtime seam
 * can observe "every dedup call site in the tree". So the invariant is
 * enforced as what it actually is — a property of the source text — by
 * {@link findMarkerDedupCallSites} plus `tests/marker_dedup_author_cap_test.ts`.
 *
 * {@link MARKER_DEDUP_AUTHOR_UNVERIFIED_FILES} is the shrink-only manifest of
 * what has not been fixed yet, in the shape of
 * {@link file://./parallel_unsafe_test_manifest.ts}'s
 * `PROCESS_STATE_MUTATOR_TEST_FILES` (Issue #944): the list is not its own
 * classification — the scanner is — and the cap test fails in **both**
 * directions, so a fixed site cannot linger here and a new violation cannot
 * quietly join the tree.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

/**
 * `--json` field-list constants that are known to include `author`.
 *
 * A call site that passes one of these instead of a string literal is
 * verified — the constant is the fix, not a way round it. The cap test asserts
 * each named constant really does carry `author`, so renaming a constant into
 * this list buys nothing.
 */
export const AUTHOR_BEARING_JSON_FIELD_CONSTANTS: readonly string[] = [
  "ALERT_DEDUP_JSON_FIELDS",
  "TITLE_MARKER_DEDUP_JSON_FIELDS",
];

/** How a call site reads the marker. */
export type MarkerDedupKind =
  /** `gh issue list` / `gh pr list` / `gh search` with `in:title` or `in:body`. */
  | "search"
  /** `gh api …/comments --jq` that reads a marker comment's body back. */
  | "comment";

/** One marker-driven dedup lookup found in the source tree. */
export interface MarkerDedupCallSite {
  /** Path relative to `worker/deno`, e.g. `lib/shared_cooldown.ts`. */
  file: string;
  /** 1-based line of the invocation's opening bracket. */
  line: number;
  /** Which read shape matched. */
  kind: MarkerDedupKind;
  /** Whether the invocation asks GitHub who wrote the match. */
  authorVerified: boolean;
}

/**
 * Files holding a marker dedup lookup that does not verify the author.
 *
 * Paths are relative to `worker/deno`, the directory the gate runs from — the
 * same convention as `PROCESS_STATE_MUTATOR_TEST_FILES`.
 *
 * This list may **shrink, never grow**. To remove a file, route its lookup
 * through `idle_task_wrapper_dedup.ts` (title markers) or
 * `alert_dedup_authors.ts` (body and comment markers) so the match is filtered
 * by `isFleetAuthor` against the fleet identity — `service_accounts` ∪
 * `fleet_pr_authors` ∪ `GITHUB_USER`, never `config.allowedAuthors`, which is
 * a human permission list answering a different question (Issue #1064), and
 * never `--author @me`, which breaks cross-host convergence because fleet
 * hosts authenticate as different accounts. An unresolvable fleet set must
 * raise, never suppress.
 *
 * Sites deliberately absent, because they are already guarded and must not be
 * added:
 *
 *   - `lib/security_tree_sweep.ts` — its open-issue lookup is `--label`
 *     scoped, and applying a label needs triage permission on the repository,
 *     so the candidate set is not attacker-supplied to begin with.
 *   - `lib/idle_task_activity.ts` — same label scoping for the wrapper
 *     listing, and the comment read takes only GitHub's own `created_at`
 *     timestamp, never the marker's payload.
 *   - `lib/milestone_ruleset_check.ts` (`fetchMilestonePrCheckNames`) — reads
 *     GitHub-generated check names off a `base:milestone` PR search; no marker
 *     is matched, and the result is reported, never used to suppress work.
 *
 * Several entries below are being fixed under a separate change; they are
 * recorded here as known-remaining rather than left invisible. Conflicts on
 * this list resolve as the **union of removals** — a fix landing elsewhere
 * takes its entry with it, and a branch that still sees the unfixed code must
 * not restore it.
 */
export const MARKER_DEDUP_AUTHOR_UNVERIFIED_FILES: readonly string[] = [
  // `PR_COMMENT_CLAIM:` comment markers arbitrate which host owns a PR
  // comment; a planted claim hands the PR to nobody.
  "lib/claim_pr_comment.ts",
  // `in:title` search for the wrapper title dispatched as real work — an
  // escalation that is silently already "in flight" is never escalated.
  "lib/escalate_as_work.ts",
  // Same `in:title` shape for the per-host escalation issue.
  "lib/host_escalation.ts",
  // Reconciles filed wrappers by `in:title`; a planted title reads as a
  // wrapper the fleet filed and suppresses the backfill.
  "lib/idle_task_backfill.ts",
  // Security-scan wrapper dedup — the eighteenth copy of the template
  // defect, owned by a concurrent change.
  "lib/idle_task_templates/security_scan_template.ts",
  // `fetchPRsForIssueByTitle` searches `in:title (#N)` without `author`, and
  // its consumers `pr_issue_linking.ts` and `pr_linkage.ts` inherit the gap.
  "lib/issue_query.ts",
  // `BRANCH_UPDATE_LOCK` comment markers gate PR branch updates; a planted
  // lock stalls the update indefinitely.
  "lib/pr_branch_lock.ts",
  // `in:body` tag search decides which workflow issues are stale enough to
  // purge — the marker also drives a destructive action.
  "lib/purge_stale_workflow_issues.ts",
  // `in:body` refresh marker; a planted marker stops references ever being
  // refreshed for the repository.
  "lib/references_refresh.ts",
  // `--jq` projects the comment body without `user.login`, so a planted
  // cooldown comment suppresses work on any issue for the cooldown window.
  "lib/shared_cooldown.ts",
  // `in:body` marker for the best-practices relabel pass.
  "setup/best_practices_relabel.ts",
  // `in:title` search for the best-practices sync issue.
  "setup/best_practices_sync.ts",
  // `in:body` dedup tag on the collaborator-invitation precheck issue.
  "setup/collaborator_precheck.ts",
  // `in:body` tag search deciding whether the workflow sync issue exists.
  "setup/workflow_sync.ts",
];

/**
 * Files whose dedup decision is made from rows another module fetched, so no
 * `gh` invocation in them can be classified.
 *
 * The scanner sees call sites, not data flow, so these cannot be capped by it.
 * They are recorded so a reader of the manifest is not left believing the
 * scanned set is the whole of the class.
 *
 *   - `lib/pr_issue_linking.ts` and `lib/pr_linkage.ts` — both decide from
 *     the rows `issue_query.ts`'s `fetchPRsForIssueByTitle` returns, which
 *     carry no `author`. Adding `author` to that one query unblocks both.
 *   - `lib/stale_workflow_detector.ts` (`hasExistingStaleComment`) and
 *     `lib/failure_detection_resume.ts` — pure predicates over comment arrays
 *     that carry a body and no author.
 */
export const MARKER_DEDUP_AUTHOR_UNVERIFIED_CONSUMERS: readonly string[] = [
  "lib/failure_detection_resume.ts",
  "lib/pr_issue_linking.ts",
  "lib/pr_linkage.ts",
  "lib/stale_workflow_detector.ts",
];

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

/** Longest argument array worth inspecting; anything larger is not a gh call. */
const MAX_INVOCATION_CHARS = 4000;

/**
 * Split a bracketed array literal into its top-level argument texts.
 *
 * Quotes, template literals and nested brackets are respected so a comma
 * inside `` `"${title}" in:title` `` does not split an argument in two.
 */
function splitArguments(arrayLiteral: string): string[] {
  const inner = arrayLiteral.slice(1, -1);
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (ch === "\\") {
        current += inner[++i] ?? "";
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/** The argument immediately after `flag`, or null when the flag is absent. */
function argumentAfter(args: string[], flag: string): string | null {
  const index = args.findIndex((a) => a === `"${flag}"` || a === `'${flag}'`);
  if (index < 0 || index + 1 >= args.length) return null;
  return args[index + 1] ?? null;
}

/** Bare identifiers can hold the interesting text; resolve one `const`. */
function resolveIdentifier(source: string, argument: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(argument)) return argument;
  // `argument` is rejected above unless it is a bare JavaScript identifier,
  // so only `[A-Za-z_$][\w$]*` reaches the pattern: no metacharacter, no
  // alternation, and nothing an author of scanned source can inject. The
  // one quantified group is lazy and anchored by `;`. Same reasoning as
  // `compileRenameRule` in export_redact.ts.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const declaration = new RegExp(
    `\\b(?:const|let|var)\\s+${argument}\\b[^=]*=\\s*([\\s\\S]*?);`,
  ).exec(source);
  return declaration ? `${argument} ${declaration[1]}` : argument;
}

/** Every balanced `[...]` literal in `source`, with its 1-based line. */
function arrayLiterals(source: string): { text: string; line: number }[] {
  const found: { text: string; line: number }[] = [];
  let line = 1;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") line++;
    if (source[i] !== "[") continue;
    let depth = 0;
    let end = i;
    for (; end < source.length; end++) {
      if (source[end] === "[") depth++;
      else if (source[end] === "]" && --depth === 0) break;
    }
    if (end >= source.length) continue;
    const text = source.slice(i, end + 1);
    if (text.length <= MAX_INVOCATION_CHARS) found.push({ text, line });
  }
  return found;
}

/** True when `text` names a `--json` list that carries the author. */
function jsonFieldsCarryAuthor(text: string): boolean {
  if (/\bauthor\b/.test(text)) return true;
  return AUTHOR_BEARING_JSON_FIELD_CONSTANTS.some((name) =>
    text.includes(name)
  );
}

/** True when a `--jq` programme keeps the commenter's identity. */
function jqKeepsAuthor(jq: string): boolean {
  return /\buser\b|\bauthor\b|\blogin\b/.test(jq);
}

/**
 * Find every marker-driven dedup lookup in one source file.
 *
 * Two shapes are recognised, because both read text an unprivileged account
 * can write and both decide whether the worker acts:
 *
 *   1. **`search`** — `gh issue list` / `gh pr list` / `gh search issues|prs`
 *      whose `--search` expression matches a marker `in:title` or `in:body`.
 *      Verified when the `--json` field list carries `author` (literally, or
 *      through one of {@link AUTHOR_BEARING_JSON_FIELD_CONSTANTS}) and no
 *      `--jq` in the same invocation projects it away again.
 *   2. **`comment`** — `gh api …/comments --jq` that both selects comments on
 *      their `.body` matching a marker **and** keeps `.body` in what it
 *      returns, i.e. the module reads the marker's payload back and acts on
 *      it. Verified when the projection also keeps the commenter. A
 *      projection that takes only GitHub's own metadata — an id to delete,
 *      a `created_at` to compare — trusts no attacker-written content and is
 *      not a site.
 *
 * Deliberately a text scan: see the module comment and the cap test's header.
 *
 * @param source - The file's contents.
 * @param file - Path relative to `worker/deno`, used in the returned sites.
 * @returns Every recognised lookup, verified or not.
 */
export function findMarkerDedupCallSites(
  source: string,
  file: string,
): MarkerDedupCallSite[] {
  const sites: MarkerDedupCallSite[] = [];
  for (const { text, line } of arrayLiterals(source)) {
    const args = splitArguments(text);
    // Some callers spell the binary as the first element (`["gh", "issue",
    // "list", …]`) and some hand `gh` only its arguments; both are the same
    // invocation.
    const verb = args[0] === '"gh"' ? args.slice(1) : args;
    if (verb.length < 2) continue;
    const head = verb.slice(0, 2).join(" ");

    const isListOrSearch = /"(?:issue|pr)" "list"/.test(head) ||
      /"search" "(?:issues|prs)"/.test(head);
    const isCommentRead = verb[0] === '"api"' &&
      verb.some((a) => /comments/.test(a));

    if (isListOrSearch) {
      const search = argumentAfter(verb, "--search");
      if (search === null) continue;
      if (!/in:title|in:body/.test(resolveIdentifier(source, search))) continue;
      const json = argumentAfter(verb, "--json") ?? "";
      const jq = argumentAfter(verb, "--jq");
      const verified = jsonFieldsCarryAuthor(resolveIdentifier(source, json)) &&
        (jq === null || jqKeepsAuthor(jq));
      sites.push({ file, line, kind: "search", authorVerified: verified });
      continue;
    }

    if (isCommentRead) {
      const jq = argumentAfter(verb, "--jq");
      if (jq === null) continue;
      if (!/select\(\s*\.body/.test(jq)) continue;
      if (!/\bbody\s*:\s*\.body\b/.test(jq)) continue;
      sites.push({
        file,
        line,
        kind: "comment",
        authorVerified: jqKeepsAuthor(jq),
      });
    }
  }
  return sites;
}
