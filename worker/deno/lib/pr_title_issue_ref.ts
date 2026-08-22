/**
 * Deciding which issue a PR title refers to (Issues #106, #319).
 *
 * A leaf module on purpose: `pr_issue_linking.ts` imports from
 * `issue_query.ts`, so the two matchers below cannot live in the former and
 * be used by the latter without a cycle. Both callers import from here.
 *
 * Two rules, deliberately different in strictness:
 *
 *  - {@link prTitleMatchesIssue} — the canonical delimited form the fleet's
 *    own PR titles carry. Used where a *positive* identification is needed.
 *  - {@link prTitleReferencesIssue} — the delimited form, or a bare `#N` that
 *    is neither another repository's issue nor a pull-request number. Used by
 *    the duplicate-PR guard, which would rather over-match a human's
 *    unconventional title than let a second PR be opened.
 *
 * Neither builds a `RegExp` from the issue number: interpolating an external
 * value into a pattern is a ReDoS risk, and `issue_query.ts` carries
 * `unsafe-regex` sweep findings on the code this replaced.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Return true if a PR title contains a reference to the given issue number.
 * Matches worker title conventions in both paren and bracket delimiter styles:
 * "(#N)", "(Issue #N)", "(issue #N)", "[#N]", "[Issue #N]", "[issue #N]"
 * (Issue #106: PR GRQ-validation#844 was titled "[#836] …", which the
 * paren-only match missed, so the existing-PR backstop failed to recognise a
 * completed run).
 *
 * Uses string-includes rather than a dynamic RegExp to avoid any ReDoS risk
 * from interpolating external values into a regular expression. The closing
 * delimiter also rejects digit-prefix variants for free (`[#142]` ⊉ `[#42]`).
 */
export function prTitleMatchesIssue(
  title: string,
  issueNumber: number,
): boolean {
  const n = String(Math.trunc(issueNumber));
  return title.includes(`(#${n})`) ||
    title.includes(`(Issue #${n})`) ||
    title.includes(`(issue #${n})`) ||
    title.includes(`[#${n}]`) ||
    title.includes(`[Issue #${n}]`) ||
    title.includes(`[issue #${n}]`);
}

/**
 * Whether the character before a `#N` makes it a reference to *another*
 * repository's issue — `NEAT-AI-Lamarck#187`, `owner/repo#187` (Issue #319).
 *
 * GitHub's cross-repository syntax puts the repo immediately before the hash
 * with no space, so the character touching `#` is the last character of a
 * repository name: a letter, digit, `-`, `_` or `.`.
 *
 * `/` is deliberately **not** in that set. A repo name never ends with a
 * slash — `owner/repo#187` ends in `o` — whereas `#178/#184` uses one to
 * separate two references to *this* repo's issues, and treating that as a
 * qualifier would silently stop the second one blocking a duplicate PR.
 */
function isRepoQualifiedReference(before: string): boolean {
  const ch = before.at(-1);
  if (ch === undefined) return false;
  return /[A-Za-z0-9._-]/.test(ch);
}

/**
 * Whether a `#N` is introduced as a **pull request** rather than an issue —
 * "stservice's open PR #188", "pull #188" (Issue #319).
 */
function isPullRequestQualifiedReference(before: string): boolean {
  const tail = before.toLowerCase().trimEnd();
  return tail.endsWith("pr") || tail.endsWith("pull") ||
    tail.endsWith("pull request");
}

/**
 * Whether `title` refers to *this repository's* issue `issueNumber`
 * (Issue #319).
 *
 * The canonical delimited form always counts. A bare `#N` counts too — so a
 * non-conventional human title still blocks a duplicate PR — but only where
 * it is neither repo-qualified nor introduced as a pull request.
 *
 * The case this exists for: PR #212, titled "…stservice's open PR #188 did
 * not block VibeCoderST claiming NEAT-AI-Lamarck#187 … (Issue #209)", is a PR
 * for issue #209 alone. The previous bare-`#N` test read it as a PR for
 * #178, #184, #187, #188 *and* #209, and because a merged PR blocks
 * permanently (Issue #3151), stranded four issues for good.
 */
export function prTitleReferencesIssue(
  title: string,
  issueNumber: number,
): boolean {
  if (prTitleMatchesIssue(title, issueNumber)) return true;

  const needle = `#${String(Math.trunc(issueNumber))}`;
  for (
    let i = title.indexOf(needle);
    i !== -1;
    i = title.indexOf(needle, i + 1)
  ) {
    // `#42` must not match inside `#421`.
    const after = title[i + needle.length];
    if (after !== undefined && after >= "0" && after <= "9") continue;
    const before = title.slice(0, i);
    if (isRepoQualifiedReference(before)) continue;
    if (isPullRequestQualifiedReference(before)) continue;
    return true;
  }
  return false;
}
