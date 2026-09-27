/**
 * The fleet-wide bound on workflow-scope refusals (Issue #2689).
 *
 * A `token-scope` refusal is the host's gap, not the issue's, so it releases
 * the issue with no label for a host whose token can push it. Each refusing
 * install remembers the issue and stops claiming it
 * (`recordWorkflowScopeRefusal`). What that cannot end is a fleet where no
 * online host has the scope: every host without it would try once, and a
 * host whose token is refused by GitHub despite a `granted` or `unknown`
 * verdict could try again after its memory lapses. That wait never clears by
 * itself, so it must end.
 *
 * The evidence is durable and already on the issue: the canonical release
 * comment's attempt tally (Issue #4327) records each release's category. At
 * {@link TOKEN_SCOPE_FLEET_BOUND} consecutive `token-scope` releases the
 * fleet posts ONE comment naming the missing scope and the fix, carrying
 * {@link TOKEN_SCOPE_PARKED_MARKER}. From then on a host whose token is not
 * known to have the scope does not claim the issue at all, while a host
 * whose verdict is `granted` still does — so granting the scope on any host
 * lifts the park with no human relabelling. No label is applied and nobody
 * is paged: this is a parked capability, not a failure.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { fetchIssueData } from "./issue_data.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import {
  parseAttemptBlock,
  parseReleaseAttemptFromBody,
  type ReleaseAttempt,
} from "./heartbeat_storage.ts";
import { getFailureCategoryDisplay } from "./failure_diagnosis.ts";
import {
  WORKFLOW_SCOPE_REMEDIATION,
  WORKFLOWS_DIR,
  type WorkflowScopeState,
} from "./workflow_scope.ts";

/**
 * Consecutive `token-scope` releases that park the issue. Three: one host's
 * refusal is a capability gap another host may fill; three in a row with no
 * capable host taking it in between is a fleet that cannot push it.
 */
export const TOKEN_SCOPE_FLEET_BOUND = 3;

/** Marks the one parked comment, so it is posted once and honoured. */
export const TOKEN_SCOPE_PARKED_MARKER = "<!-- vibe-token-scope-parked -->";

/** A comment on the issue, as `gh issue view --json comments` gives it. */
export interface FleetComment {
  author: string;
  body: string;
}

/** The tally text a `token-scope` release renders: `no PR (`token-scope`, …`. */
function isTokenScopeAttempt(attempt: ReleaseAttempt): boolean {
  return attempt.text.startsWith(
    `no PR (\`${getFailureCategoryDisplay("token_scope")}\``,
  );
}

/**
 * Consecutive `token-scope` releases at the end of the issue's attempt tally.
 *
 * The tally lives on the canonical release comment and is the only record
 * that survives a host change; the fullest one on the thread is read. A
 * thread with one release carries no tally block, so its release line is
 * read instead. Hosts are not counted: the tally names the per-launch
 * container hostname, which changes every hour.
 *
 * @param bodies - Fleet-authored comment bodies on the issue
 * @returns How many releases in a row, newest last, were `token-scope`
 */
export function countConsecutiveTokenScopeReleases(
  bodies: readonly string[],
): number {
  let attempts: ReleaseAttempt[] = [];
  let total = 0;
  for (const body of bodies) {
    const tally = parseAttemptBlock(body);
    if (tally && tally.total > total) {
      total = tally.total;
      attempts = tally.attempts;
    }
  }
  if (total === 0) {
    const single = bodies.map(parseReleaseAttemptFromBody)
      .filter((a): a is ReleaseAttempt => a !== null).at(-1);
    attempts = single ? [single] : [];
  }
  let run = 0;
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (!isTokenScopeAttempt(attempts[i]!)) break;
    run++;
  }
  return run;
}

/**
 * Whether the fleet has parked the issue and this host should leave it.
 *
 * Only a fleet-authored marker counts — anyone else's copy parks nothing —
 * and a host whose token is known to have the scope ignores it.
 */
export function isParkedForMissingWorkflowScope(
  comments: readonly FleetComment[],
  fleetAuthors: string[],
  verdict: WorkflowScopeState,
): boolean {
  if (verdict === "granted") return false;
  return comments.some((c) =>
    isFleetAuthor(c.author, fleetAuthors) &&
    c.body.includes(TOKEN_SCOPE_PARKED_MARKER)
  );
}

/** The one comment the bound posts. */
export function renderTokenScopeParkedComment(consecutive: number): string {
  return `${TOKEN_SCOPE_PARKED_MARKER}\n` +
    `### Waiting for a host that can push workflow files\n\n` +
    `This change touches \`${WORKFLOWS_DIR}\`, and the last ${consecutive} ` +
    `attempts in a row were refused because the host's token lacks the ` +
    `\`workflow\` OAuth scope. No host with that scope has picked it up.\n\n` +
    `Hosts without the scope no longer claim this issue; a host whose token ` +
    `has it still will. No label has been changed.\n\n` +
    `**Fix:** ${WORKFLOW_SCOPE_REMEDIATION}.`;
}

/** What {@link enforceTokenScopeFleetBound} found and did. */
export interface TokenScopeBoundResult {
  /** Consecutive `token-scope` releases on the tally. */
  consecutive: number;
  /** The issue is parked (already, or by this call). */
  parked: boolean;
  /** This call posted the parked comment. */
  posted: boolean;
}

/**
 * After a `token-scope` release, park the issue once the fleet bound is met.
 *
 * Called once the run's release has written its attempt to the tally (the
 * heartbeat's final clear, Issue #4330). Best-effort: a read or post failure
 * leaves the issue as it was, and the next refusal tries again.
 *
 * @param options.bound - Override {@link TOKEN_SCOPE_FLEET_BOUND} (tests)
 */
export async function enforceTokenScopeFleetBound(
  options: {
    repo: string;
    issueNumber: number;
    fleetAuthors: string[];
    bound?: number;
  },
  deps: { ghFn: (args: string[]) => Promise<string> },
): Promise<TokenScopeBoundResult> {
  const issue = await fetchIssueData(
    options.repo,
    options.issueNumber,
    deps.ghFn,
  );
  const fleet = issue.comments.filter((c) =>
    isFleetAuthor(c.author, options.fleetAuthors)
  );
  const consecutive = countConsecutiveTokenScopeReleases(
    fleet.map((c) => c.body),
  );
  if (fleet.some((c) => c.body.includes(TOKEN_SCOPE_PARKED_MARKER))) {
    return { consecutive, parked: true, posted: false };
  }
  if (consecutive < (options.bound ?? TOKEN_SCOPE_FLEET_BOUND)) {
    return { consecutive, parked: false, posted: false };
  }
  await deps.ghFn([
    "issue",
    "comment",
    String(options.issueNumber),
    "--repo",
    options.repo,
    "--body",
    renderTokenScopeParkedComment(consecutive),
  ]);
  return { consecutive, parked: true, posted: true };
}
