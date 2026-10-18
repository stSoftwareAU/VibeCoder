/**
 * Census model of the claim scan's label-author gate (Issue #3571).
 *
 * The claim scan refuses an issue whose priority label (`top-priority` /
 * `work-on` / `low-priority`) was last added by an author it does not trust
 * (`label-author-not-allowed`). The idle-decision census counted such an
 * issue as claimable, so a backlog the scan would never hand out raised a
 * false `inversion_signal` and filed an idle-task about work that was
 * already refused.
 *
 * This helper precomputes the set of those issues for the census, which is
 * synchronous and so cannot read the timeline itself. It does not restate the
 * trust rule: every verdict comes from {@link wasLabelAddedByAllowedAuthor},
 * the owner of the scan's gate, so the census and the scan cannot disagree.
 *
 * An issue is in the returned set when it carries at least one priority label
 * and every priority label it carries was added by an untrusted author. An
 * issue carrying no priority label is not in the set (there is no gate to
 * model). If a timeline read throws, the issue is treated as trusted: the
 * census is advisory and must not over-count refusals, so the error is logged
 * loudly and the issue is left out of the set.
 *
 * Australian English spelling throughout (behaviour, honour).
 */

import { LABEL_DEFAULTS } from "./config_defaults.ts";
import { wasLabelAddedByAllowedAuthor } from "./issue_query.ts";
import type { TimelineCache } from "./timeline_cache.ts";

/**
 * Return the numbers of the issues whose every carried priority label was
 * added by an author the claim scan's label-author gate does not trust.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issues - The repo's open issues with their label names
 * @param allowedAuthors - The trusted-author list the claim scan uses for `repo`
 * @param ghFn - The gh command function, forwarded to the timeline reads
 * @param cache - Optional timeline cache, forwarded to the timeline reads
 * @param fleetWorkerLogins - Fleet worker logins, excluded from trust (Issue #3416)
 * @param log - Sink for the warning raised when a timeline read throws
 * @returns The issue numbers the census must count as `claim_refused`
 */
export async function censusUntrustedLabelIssues(
  repo: string,
  issues: ReadonlyArray<{ number: number; labels: readonly string[] }>,
  allowedAuthors: string[],
  ghFn: (args: string[]) => Promise<string>,
  cache: TimelineCache | undefined,
  fleetWorkerLogins: string[],
  log: (msg: string) => void = (msg) => console.warn(msg),
): Promise<Set<number>> {
  const priorityLabels = [
    LABEL_DEFAULTS.topPriorityLabel,
    LABEL_DEFAULTS.workOnLabel,
    LABEL_DEFAULTS.lowPriorityLabel,
  ];
  const untrusted = new Set<number>();
  for (const issue of issues) {
    const carried = priorityLabels.filter((label) =>
      issue.labels.includes(label)
    );
    if (carried.length === 0) continue;

    let trusted = false;
    try {
      for (const label of carried) {
        const added = await wasLabelAddedByAllowedAuthor(
          repo,
          issue.number,
          label,
          allowedAuthors,
          ghFn,
          cache,
          fleetWorkerLogins,
        );
        if (added) {
          trusted = true;
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[idle-census] WARNING: could not read the label-author gate for ` +
          `${repo}#${issue.number} (${message}); treating the issue as ` +
          `trusted so the census does not over-count refusals`,
      );
      continue;
    }
    if (!trusted) untrusted.add(issue.number);
  }
  return untrusted;
}
