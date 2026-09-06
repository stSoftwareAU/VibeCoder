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
 * Issue #1124 cleared the last six scanned sites and the four consumers. Issue
 * #1216 then found six live instances of the class that the scanner's two
 * recognised shapes cannot see, fixed four of them, and recorded the two whose
 * fail direction is a design decision in
 * {@link MARKER_DEDUP_AUTHOR_UNVERIFIED_CONSUMERS} below. The scanner and the
 * cap test keep the *scanned* set clean; the consumer list is where a site the
 * scanner cannot classify is recorded so the count stays visible.
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
  // `alert_dedup_authors.ts`'s own title constant (`number,title,author`).
  // Two title field lists exist because #1100 and #1101 landed in parallel
  // and each named one; both request `author`, which is all this
  // classification turns on. Omitting it here left every site #1100 fixed
  // still reading as unverified debt — a manifest that overstates the debt
  // invites someone to "fix" code that is already correct.
  "ALERT_DEDUP_TITLE_JSON_FIELDS",
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
 *   - `lib/idle_task_activity.ts` — label scoping covers the wrapper listing,
 *     and its `CLAIM_LOCK` comment read now carries `.user.login` and filters
 *     every match through `selectFleetAuthoredComments` (Issue #1249,
 *     finding 1). The earlier justification — that the read "takes only
 *     GitHub's own `created_at`, never the marker's payload" — was the wrong
 *     test: the marker's *presence* was itself the liveness signal, so a
 *     forged comment suppressed the escalation without its payload ever being
 *     read. A projection is safe only when neither the payload nor the match
 *     drives a decision.
 *   - `lib/milestone_ruleset_check.ts` (`fetchMilestonePrCheckNames`) — reads
 *     GitHub-generated check names off a `base:milestone` PR search; no marker
 *     is matched, and the result is reported, never used to suppress work.
 *
 * Conflicts on this list resolve as the **union of removals** — a fix landing
 * elsewhere takes its entry with it, and a branch that still sees the unfixed
 * code must not restore it.
 *
 * **The list is empty (Issue #1124).** Every scanned lookup in the tree now
 * asks GitHub who wrote the match. An empty manifest is not a dead file: the
 * cap test's forward direction is what keeps it empty, and this is where the
 * next unfixed site would be recorded if one were introduced deliberately.
 * Adding an entry is a decision to ship the defect, so it needs the same
 * justification the entries above once carried — what a planted marker there
 * would do, and why it cannot be fixed now.
 */
export const MARKER_DEDUP_AUTHOR_UNVERIFIED_FILES: readonly string[] = [];

/**
 * Files whose dedup decision is made from rows another module fetched, so no
 * `gh` invocation in them can be classified.
 *
 * The scanner sees call sites, not data flow, so these cannot be capped by
 * it. They are recorded so a reader of the manifest is not left believing the
 * scanned set is the whole of the class.
 *
 * **This list has no staleness gate, and cannot have one.** The cap test fails
 * in both directions for {@link MARKER_DEDUP_AUTHOR_UNVERIFIED_FILES} because
 * the scanner can re-classify those sites; it cannot classify these, which is
 * why they are here. The cap test therefore checks only that each entry names
 * a real file and that the list is sorted and duplicate-free — a fixed entry
 * has to be deleted by whoever fixes it. Stated here rather than left to be
 * discovered (Issue #1216).
 *
 * Issue #1216 re-populated it: see the two entries below, and #1249 for the
 * wider blind spot they belong to. The scanner recognises a `--search`
 * expression matching `in:title` / `in:body`, and a `gh api …/comments --jq`
 * that both selects on `.body` and projects it back. A module that pages raw
 * REST comments with no `--jq` at all (`issue_comment_pages.ts`), projects
 * without a `select(.body` (`run_failure_issue.ts`), reads `--jq .[].body`
 * across all authors (`milestone_children_gate.ts`, #1249) or matches
 * client-side over a plain `gh issue list` (`idle_task_snapshot.ts`, #1243 —
 * fixed there, and still invisible to the scanner, which is why its entry had
 * to be deleted by hand) is invisible to it. Both lists were empty while six
 * live instances of the class sat in the tree, which is what #1216 found and
 * fixed.
 *
 * Cleared by Issue #1124 — what each of the original entries needed, and where
 * the control now lives:
 *
 *   - `lib/pr_issue_linking.ts` and `lib/pr_linkage.ts` — both decide from
 *     the rows `issue_query.ts`'s `fetchPRsForIssueByTitle` returns. That
 *     query now asks for `author` **and** `isCrossRepository`, and drops
 *     every fork-headed row before returning: pushing a branch into the
 *     target repository needs write access there, so a same-repository head
 *     is evidence and a fork head is a claim anybody can make. The row that
 *     survives was opened by a repository writer, which is the same trust
 *     boundary the label-scoped listings below rely on — and it is the right
 *     one here, because a human maintainer's PR for an issue legitimately
 *     means "already in hand" while a fleet-only filter would have the
 *     worker duplicate it. `pr_issue_linking.ts`'s uncached fallback,
 *     which the scanner cannot see because it matches titles client-side,
 *     applies the same head check.
 *   - `lib/stale_workflow_detector.ts` (`hasExistingStaleComment`) — now
 *     filters the marker-carrying comments through
 *     `selectFleetAuthoredComments` before the match counts, failing towards
 *     posting the diagnostic.
 *   - `lib/failure_detection_resume.ts` — `readRecordedAttempts` already
 *     verified its attempt markers through `selectFleetAuthoredComments`
 *     (failing towards retrying); the entry outlived the fix.
 */
export const MARKER_DEDUP_AUTHOR_UNVERIFIED_CONSUMERS: readonly string[] = [
  // Issue #1216, SEC-1216-06 (#1247). Both read marker text out of the raw
  // comment array `issue_comment_pages.fetchIssueCommentPages` returns, which
  // carries every author. `parseConflictAttempts` counts
  // `CONFLICT_FAILED_MARKER` comments and hands the tally to
  // `hasExhaustedConflictAttempts` → `abandonRestart`, so two planted comments
  // make the worker CLOSE the PR; `restartMarkerPrNumbers` and
  // `summariseFailedAttempts` read the restart and attempt markers off the
  // originating issue and the PR thread.
  //
  // Recorded rather than fixed with the rest of the class because the fail
  // direction is not the usual one: the restart marker suppresses a
  // *destructive* action, so discarding an unverifiable match relaxes the
  // "one restart per originating issue" bound instead of tightening it. That
  // bound has to be re-expressed against something authenticated before the
  // author check can land, which is a design decision, not a filter.
  "lib/conflict_abandon_restart.ts",
  // Issue #1216, SEC-1216-06 (#1247).
  "lib/pr_merge_conflict_scan.ts",
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
