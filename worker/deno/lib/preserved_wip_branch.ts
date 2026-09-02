/**
 * Naming the preserved branch in the claim-release comment (Issue #770).
 *
 * A release comment used to say work was preserved but never *where*: the
 * only way to find the parked work was to `ls-remote` and pattern-match on
 * `issue-<N>-*`, which is what `git_issue_branch_resume.ts` does internally
 * and what a human — or a non-Claude worker — had to reinvent. The comment is
 * the one artefact visible from any host, any provider and to a person, so it
 * carries the branch name and, once a handover file exists on that branch
 * (Issue #769), a link to it.
 *
 * The branch named here is always the branch the push actually targeted
 * (`PhaseState.branchName`, which setup rewrites to the resumed branch on a
 * re-claim) — never a name derived from the current issue title. Retitling an
 * issue between claims already orphaned work once (#211); a comment naming a
 * branch that does not exist would repeat that mistake with more confidence.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Repo-relative path of the handover file an interrupted run leaves on the
 * issue branch (Issue #769). Defined here because #770 advertises the file
 * and #769 writes it — one constant, so the advertisement cannot point at a
 * path nothing writes.
 *
 * NOT the `.vibe/handover/…` the sketch in #769 suggested: `.vibe` is a
 * hidden path, so the enforced `.gitignore` (`.*`) never stages it and
 * `classifyStagedPath` rejects it outright — a handover written there could
 * never reach the branch, and force-adding it would fail the pre-commit gate
 * and take the WIP commit down with it. `preserved_wip_branch_test.ts` pins
 * that this path stays committable.
 */
export function handoverFilePath(issueNumber: number): string {
  return `docs/handover/issue-${issueNumber}.md`;
}

/** Where an interrupted run's work actually is. */
export interface PreservedWip {
  /** Branch the preservation push targeted. */
  branch: string;
  /** Handover file committed on that branch (Issue #769), when one was. */
  handoverPath?: string;
  /** Browsable link to that file, when the repository slug was known. */
  handoverUrl?: string;
}

/** `https://github.com/<repo>/blob/<branch>/<path>` for a committed file. */
export function handoverFileUrl(
  repo: string,
  branch: string,
  path: string,
): string {
  return `https://github.com/${repo}/blob/${branch}/${path}`;
}

/**
 * The handover clause, or `""` when no handover file was written.
 *
 * Degrading to `""` is the point (Issue #770): every preservation path must
 * read correctly before #769 lands, and none may emit a broken link.
 */
export function describeHandoverFile(preserved: PreservedWip): string {
  const { handoverPath, handoverUrl } = preserved;
  if (!handoverPath) return "";
  const target = handoverUrl
    ? `[${handoverPath}](${handoverUrl})`
    : `\`${handoverPath}\``;
  return ` Handover: ${target}.`;
}

/**
 * One line naming the preserved branch and what a reader should do with it.
 *
 * Deliberately says nothing about *why* the run stopped: the caller's reason
 * already does, and a scheduled release must never acquire timeout wording.
 */
export function describePreservedBranch(preserved: PreservedWip): string {
  return `branch \`${preserved.branch}\` holds the work in progress; the ` +
    `next claim resumes from it.${describeHandoverFile(preserved)}`;
}
