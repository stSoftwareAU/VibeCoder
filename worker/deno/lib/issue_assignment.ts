/**
 * Stable issue assignment and its treatment, recorded before the agent runs
 * (Issue #3718, part of #3644).
 *
 * Every run of an issue, on any host, must attach its telemetry to the same
 * assignment, or the lifecycle ledger cannot say what a cohort achieved. The
 * assignment is therefore a marker comment on the issue itself:
 *
 *   <!-- vibe-assignment id="<uuid>" cohort="<label>" assigned="<ISO>" -->
 *
 * Any run first reads the issue's comments. A marker posted by a trusted
 * fleet author is reused, so a restart, or a second host, carries on the
 * same assignment. When none exists, the run mints an id and posts one. Two
 * hosts that race each post a marker, so each re-reads the issue after
 * posting and adopts the earliest trusted marker it can now see. The hosts
 * converge on one assignment.
 *
 * The assignment event is built and validated BEFORE any marker is posted,
 * so an invalid label is refused before it reaches GitHub. Only the comment's
 * author is authenticated: anyone can type a marker, so an untrusted marker is
 * ignored, as {@link selectTrustedAssignment} does for claim markers.
 *
 * Australian English spelling used throughout.
 */

import {
  type AgentDefinition,
  type AgentProviderDescriptor,
  CLAUDE_PROVIDER_ID,
  resolveInvocationRouting,
} from "./agent_provider.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";
import { getRunId } from "./run_id.ts";
import {
  appendLifecycleEvent,
  buildLifecycleEvent,
  isPlainObject,
  isValidAssignmentId,
  isValidLifecycleLabel,
  isValidLifecycleTimestamp,
  lifecycleLedgerPath,
  type RoleTreatment,
  UNASSIGNED_COHORT,
} from "./lifecycle_ledger.ts";
import {
  ISSUE_EXECUTOR_AGENT_NAME,
  SPEC_REVIEWER_AGENT_NAME,
  STANDARDS_REVIEWER_AGENT_NAME,
} from "./issue_executor_agents.ts";
import { getHostname } from "./worker_identity.ts";
import {
  type WorkerBuildFacts,
  workerBuildFacts,
} from "./worker_build_info.ts";

/** Opens every assignment marker comment. */
export const ASSIGNMENT_MARKER_PREFIX = "<!-- vibe-assignment ";

/** The assignment a marker records. */
export interface AssignmentMarker {
  assignmentId: string;
  cohort: string;
  assignedAt: string;
}

/**
 * Pulls the three values out of a marker. Each is then re-checked with the
 * ledger's predicates, so the pattern only has to be bounded, not exact.
 */
const ASSIGNMENT_MARKER_PATTERN =
  /<!-- vibe-assignment id="([0-9a-f-]{36})" cohort="([a-z0-9][a-z0-9._-]{0,63})" assigned="([0-9TZ:.-]{20,24})" -->/;

/**
 * Format an assignment as the marker comment text.
 *
 * @param marker - The assignment to record.
 * @returns The single-line HTML comment.
 */
export function formatAssignmentMarker(marker: AssignmentMarker): string {
  return `<!-- vibe-assignment id="${marker.assignmentId}" cohort="${marker.cohort}" assigned="${marker.assignedAt}" -->`;
}

/**
 * Find the first assignment marker in a comment body.
 *
 * @param body - A comment body.
 * @returns The marker, or `undefined` when the body carries none, or carries
 *   one whose values the ledger would refuse.
 */
export function parseAssignmentMarker(
  body: string,
): AssignmentMarker | undefined {
  const match = ASSIGNMENT_MARKER_PATTERN.exec(body);
  if (!match) return undefined;
  const [, assignmentId, cohort, assignedAt] = match;
  if (
    !isValidAssignmentId(assignmentId) ||
    !isValidLifecycleLabel(cohort) ||
    !isValidLifecycleTimestamp(assignedAt)
  ) {
    return undefined;
  }
  return { assignmentId, cohort, assignedAt };
}

/**
 * The visible comment that carries a marker.
 *
 * A body holding only an HTML comment renders blank, so the marker travels
 * beneath a sentence a human can read.
 *
 * @param marker - The assignment being recorded.
 * @returns The comment body.
 */
export function assignmentCommentBody(marker: AssignmentMarker): string {
  return "Lifecycle assignment recorded — cohort `" + marker.cohort + "`. " +
    "Every run of this issue, on any host, attaches its telemetry to this " +
    "assignment.\n\n" + formatAssignmentMarker(marker);
}

/** One issue comment that carries an assignment marker. */
export interface AssignmentMarkerComment {
  author: string;
  createdAt: string;
  body: string;
}

/**
 * The port the assignment reads and writes issue comments through. Tests use
 * an in-memory fake; production uses {@link ghAssignmentMarkerStore}.
 */
export interface AssignmentMarkerStore {
  listMarkerComments(
    repo: string,
    issueNumber: number,
  ): Promise<AssignmentMarkerComment[]>;
  postMarkerComment(
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<void>;
}

/**
 * The production {@link AssignmentMarkerStore}, backed by the `gh` CLI.
 *
 * Comments are read through the bounded page helper
 * {@link fetchIssueCommentPages}, so a long thread is never materialised
 * without a cap. Each raw REST comment is reshaped into an
 * {@link AssignmentMarkerComment} and only marker-bearing comments are kept.
 * A marker-bearing comment without a string `user.login` and `created_at` is
 * skipped as unattributable, since it could never be trusted anyway. Errors
 * from the page fetch propagate: an unreadable thread is never treated as "no
 * marker", which would let a run mint a second assignment.
 *
 * @param runGh - Runs `gh` with the given arguments and returns its stdout.
 * @returns The store.
 */
export function ghAssignmentMarkerStore(
  runGh: (args: string[]) => Promise<string>,
): AssignmentMarkerStore {
  return {
    async listMarkerComments(repo, issueNumber) {
      const raw = await fetchIssueCommentPages(repo, issueNumber, runGh);
      const comments: AssignmentMarkerComment[] = [];
      for (const item of raw) {
        if (!isPlainObject(item) || typeof item.body !== "string") continue;
        if (!item.body.includes(ASSIGNMENT_MARKER_PREFIX)) continue;
        const user = item.user;
        const login = isPlainObject(user) ? user.login : undefined;
        if (typeof login !== "string" || typeof item.created_at !== "string") {
          continue;
        }
        comments.push({
          author: login,
          createdAt: item.created_at,
          body: item.body,
        });
      }
      return comments;
    },
    async postMarkerComment(repo, issueNumber, body) {
      await runGh([
        "issue",
        "comment",
        String(issueNumber),
        "--repo",
        repo,
        "--body",
        body,
      ]);
    },
  };
}

/**
 * The earliest marker a trusted author posted, or `undefined`.
 *
 * A marker is just text anyone can post, so only comments by a fleet author
 * count. An empty trusted set trusts nothing. Earliest wins, so two hosts that
 * raced to post converge on the same assignment.
 *
 * @param comments - The issue's marker comments.
 * @param trustedAuthors - The fleet logins whose markers are believed.
 * @returns The earliest trusted marker that parses.
 */
export function selectTrustedAssignment(
  comments: readonly AssignmentMarkerComment[],
  trustedAuthors: readonly string[],
): AssignmentMarker | undefined {
  const trusted = comments.filter((comment) =>
    isFleetAuthor(comment.author, [...trustedAuthors])
  );
  const earliestFirst = [...trusted].sort(
    (a, b) => createdAtMillis(a.createdAt) - createdAtMillis(b.createdAt),
  );
  for (const comment of earliestFirst) {
    const marker = parseAssignmentMarker(comment.body);
    if (marker !== undefined) return marker;
  }
  return undefined;
}

/**
 * Sort key for a comment's creation time. An unreadable time sorts last, so
 * it can never displace a comment whose time is known.
 */
function createdAtMillis(createdAt: string): number {
  const millis = Date.parse(createdAt);
  return Number.isNaN(millis) ? Number.POSITIVE_INFINITY : millis;
}

/** The issue an assignment is recorded against, and who may record it. */
export interface IssueAssignmentInput {
  repo: string;
  issueNumber: number;
  /** Fleet logins whose markers are believed. */
  trustedAuthors: readonly string[];
  /** The treatment each role ran under this run. */
  roles: readonly RoleTreatment[];
  /** The subscription the run was allocated to, when one was. */
  subscriptionAllocation?: string;
}

/** Everything the assignment reads from the outside world. */
export interface IssueAssignmentSeams {
  store: AssignmentMarkerStore;
  ledgerPath: string;
  host: string;
  runId: string;
  now: () => number;
  mintId: () => string;
  buildFacts: () => WorkerBuildFacts;
}

/** The assignment a run ended up attached to. */
export interface IssueAssignmentRecord {
  assignmentId: string;
  cohort: string;
  /** True when an earlier trusted marker was found and reused. */
  reused: boolean;
}

/**
 * Attach this run to the issue's assignment, creating it when none exists.
 *
 * The order is deliberate. The event is built and validated before anything is
 * posted, so an invalid input is refused with no side effect. A minted marker
 * is then posted and the issue re-read: if a racing host's earlier trusted
 * marker is now visible, this run adopts that assignment and records it with
 * `reused: true`, so two hosts converge. Every error propagates, and nothing is
 * appended if any read or post fails; the caller logs it at error level.
 *
 * @param input - The issue, the trusted authors and the run's treatment.
 * @param seams - The store, ledger path, identity and clock.
 * @returns The assignment ID and cohort, and whether they were reused.
 * @throws {LifecycleEventSchemaError} When the input is refused.
 */
export async function recordIssueAssignment(
  input: IssueAssignmentInput,
  seams: IssueAssignmentSeams,
): Promise<IssueAssignmentRecord> {
  const comments = await seams.store.listMarkerComments(
    input.repo,
    input.issueNumber,
  );
  const existing = selectTrustedAssignment(comments, input.trustedAuthors);
  let marker: AssignmentMarker = existing ?? {
    assignmentId: seams.mintId(),
    cohort: UNASSIGNED_COHORT,
    assignedAt: new Date(seams.now()).toISOString(),
  };
  let reused = existing !== undefined;

  const facts = seams.buildFacts();
  const subscriptionAllocation =
    typeof input.subscriptionAllocation === "string" &&
      input.subscriptionAllocation.trim() !== ""
      ? input.subscriptionAllocation
      : undefined;
  const buildEvent = (assigned: AssignmentMarker, wasReused: boolean) =>
    buildLifecycleEvent({
      kind: "assignment",
      assignmentId: assigned.assignmentId,
      runId: seams.runId,
      host: seams.host,
      repo: input.repo,
      issueNumber: input.issueNumber,
      recordedAt: new Date(seams.now()).toISOString(),
      assignedAt: assigned.assignedAt,
      cohort: assigned.cohort,
      reused: wasReused,
      treatment: {
        roles: [...input.roles],
        ...(facts.version ? { workerVersion: facts.version } : {}),
        ...(facts.commit ? { workerCommit: facts.commit } : {}),
        ...(subscriptionAllocation !== undefined
          ? { subscriptionAllocation }
          : {}),
      },
    });
  // Built before anything is posted, so an invalid input refuses with no side
  // effect.
  let event = buildEvent(marker, reused);

  if (existing === undefined) {
    await seams.store.postMarkerComment(
      input.repo,
      input.issueNumber,
      assignmentCommentBody(marker),
    );
    // Re-read after posting. A racing host may have posted an earlier trusted
    // marker; if so, this run adopts that assignment rather than its own.
    const relisted = await seams.store.listMarkerComments(
      input.repo,
      input.issueNumber,
    );
    const settled = selectTrustedAssignment(relisted, input.trustedAuthors) ??
      marker;
    if (!sameAssignment(settled, marker)) {
      marker = settled;
      reused = true;
      event = buildEvent(marker, reused);
    }
  }
  await appendLifecycleEvent(seams.ledgerPath, event);
  return {
    assignmentId: marker.assignmentId,
    cohort: marker.cohort,
    reused,
  };
}

/** Whether two markers describe the same assignment in every field. */
function sameAssignment(a: AssignmentMarker, b: AssignmentMarker): boolean {
  return a.assignmentId === b.assignmentId && a.cohort === b.cohort &&
    a.assignedAt === b.assignedAt;
}

/** The role a sub-agent name runs as, or `undefined` for a non-role agent. */
function roleForAgent(name: string): RoleTreatment["role"] | undefined {
  if (name === ISSUE_EXECUTOR_AGENT_NAME) return "executor";
  if (
    name === SPEC_REVIEWER_AGENT_NAME ||
    name === STANDARDS_REVIEWER_AGENT_NAME
  ) {
    return "reviewer";
  }
  return undefined;
}

/** Whether a value is a string with visible content. */
function isNonBlank(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The treatment each of the run's roles ran under.
 *
 * The manager is the phase's own routing. Sub-agents appear only on Claude,
 * the one provider that carries `--agents`; the read-only explorer is not one
 * of the three roles and is skipped.
 *
 * @param args - The provider, any explicit Claude model, and the sub-agents.
 * @returns One treatment per role the run had.
 */
export function issueRunRoleTreatments(args: {
  provider: AgentProviderDescriptor;
  claudeModel?: string;
  agents?: Readonly<Record<string, AgentDefinition>>;
}): RoleTreatment[] {
  const { provider } = args;
  const routing = resolveInvocationRouting(provider, {
    prompt: "",
    phase: "issue",
    ...(args.claudeModel ? { model: args.claudeModel } : {}),
  });
  const treatments: RoleTreatment[] = [{
    role: "manager",
    provider: provider.id,
    ...(isNonBlank(routing.model) ? { model: routing.model } : {}),
    ...(isNonBlank(routing.effort) ? { effort: routing.effort } : {}),
  }];
  if (provider.id !== CLAUDE_PROVIDER_ID || args.agents === undefined) {
    return treatments;
  }
  for (const [name, definition] of Object.entries(args.agents)) {
    const role = roleForAgent(name);
    if (role === undefined) continue;
    treatments.push({
      role,
      agent: name,
      provider: provider.id,
      ...(isNonBlank(definition.model) ? { model: definition.model } : {}),
      ...(isNonBlank(definition.effort) ? { effort: definition.effort } : {}),
    });
  }
  return treatments;
}

/**
 * The seams a production run uses: `gh` for the issue comments, the host's
 * ledger, the process run id, and the system clock.
 *
 * @param workDir - The worker's work directory.
 * @param runGh - Runs `gh` with the given arguments and returns its stdout.
 * @returns The production seams.
 */
export function productionIssueAssignmentSeams(
  workDir: string,
  runGh: (args: string[]) => Promise<string>,
): IssueAssignmentSeams {
  return {
    store: ghAssignmentMarkerStore(runGh),
    ledgerPath: lifecycleLedgerPath(workDir, getHostname()),
    host: getHostname(),
    runId: getRunId(),
    now: Date.now,
    mintId: () => crypto.randomUUID(),
    buildFacts: () => workerBuildFacts(),
  };
}
