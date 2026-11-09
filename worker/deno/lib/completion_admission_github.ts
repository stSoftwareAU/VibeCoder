/** GitHub-backed admission state; uses existing distributed locks and heartbeats. */
import {
  admitCompletionWork,
  COMPLETION_PENDING_MARKER,
  type CompletionPolicy,
  type CompletionPr,
  type CompletionReservation,
  type CompletionSnapshot,
  type CompletionState,
  type CompletionStore,
  parseCompletionPolicy,
} from "./completion_admission.ts";
import {
  acquireBranchUpdateLock,
  releaseBranchUpdateLock,
} from "./pr_branch_lock.ts";
import { fetchMarkerComments } from "./marker_comment_pages.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import { parseHeartbeatMarker } from "./heartbeat_storage.ts";
import { DEFAULT_SWEEP_STUCK_TIMEOUT_SECONDS } from "./heartbeat_sweep.ts";
import { issueNumberFromBranch } from "./issue_branch_candidates.ts";
import { extractDependencyReferencesDetailed } from "./issue_dependencies.ts";
import { runGhCommand } from "./github.ts";
import { createMilestoneBranchName } from "./git_branch.ts";
import { extractClosingIssueNumbers } from "./pr_body.ts";

export const COMPLETION_STATE_PREFIX = "<!-- COMPLETION_ADMISSION_V1:";

interface Options {
  repo: string;
  workerId: string;
  fleetAuthors: string[];
  ghCommandFn?: (args: string[]) => Promise<string>;
  nowFn?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

/** Malformed authenticated state is an error, never silently an empty queue. */
export function parseCompletionState(body: string): CompletionState {
  const match = /^<!-- COMPLETION_ADMISSION_V1:(.+) -->/m.exec(body);
  if (!match) throw new Error("Invalid shared completion admission state");
  const state = JSON.parse(match[1]!) as CompletionState;
  parseCompletionPolicy(state.policy);
  if (
    state.version !== 1 || !state.modes || typeof state.modes !== "object" ||
    Array.isArray(state.modes) ||
    Object.values(state.modes).some((mode) => typeof mode !== "boolean") ||
    !Array.isArray(state.reservations) ||
    state.reservations.some((r) =>
      !Number.isSafeInteger(r.issue) || r.issue <= 0 ||
      !Number.isSafeInteger(r.claimId) || r.claimId <= 0 ||
      typeof r.base !== "string" || !r.base ||
      typeof r.workerId !== "string" || !r.workerId ||
      (r.recovery !== undefined && typeof r.recovery !== "boolean")
    )
  ) throw new Error("Invalid shared completion admission state");
  return state;
}

export function makeGitHubCompletionStore(options: Options): CompletionStore {
  const { repo, workerId, fleetAuthors } = options;
  const gh = options.ghCommandFn ?? runGhCommand;
  const now = options.nowFn ?? (() => Math.floor(Date.now() / 1000));
  let anchor: number | undefined;
  const trusted = (author: string) => isFleetAuthor(author, fleetAuthors);
  if (fleetAuthors.length === 0) {
    throw new Error("Completion admission requires verified fleet authors");
  }

  async function readSnapshot(
    state?: CompletionState,
  ): Promise<CompletionSnapshot> {
    // All authors, all pages: humans and final milestone integration add pressure.
    const pages = JSON.parse(
      await gh([
        "api",
        `repos/${repo}/pulls?state=open&per_page=100`,
        "--paginate",
        "--slurp",
      ]),
    ) as Array<
      Array<{
        number: number;
        base: { ref: string };
        head: { ref: string };
        draft: boolean;
        body: string | null;
        user: { login: string };
      }>
    >;
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
      throw new Error("Incomplete open PR snapshot");
    }
    const prs: CompletionPr[] = pages.flat().map((pr) => {
      if (
        !Number.isSafeInteger(pr.number) || !pr.base?.ref || !pr.head?.ref ||
        typeof pr.draft !== "boolean" || !pr.user?.login
      ) {
        throw new Error("Invalid open PR snapshot");
      }
      // Only fleet branch identity can release an implementation reservation.
      const issue = trusted(pr.user.login)
        ? issueNumberFromBranch(pr.head.ref)
        : null;
      return {
        number: pr.number,
        base: pr.base.ref,
        draft: pr.draft,
        issues: trusted(pr.user.login)
          ? [
            ...new Set([
              ...(issue === null ? [] : [issue]),
              ...extractClosingIssueNumbers(pr.body ?? ""),
            ]),
          ]
          : [],
        recoveryIssues: trusted(pr.user.login)
          ? extractDependencyReferencesDetailed(pr.body ?? "")
            .filter((ref) =>
              !ref.repo || ref.repo.toLowerCase() === repo.toLowerCase()
            )
            .map((ref) => ref.number)
          : [],
      };
    });
    const liveClaims = new Set<number>();
    for (const r of state?.reservations ?? []) {
      let comment: { body: string; user: { login: string } };
      try {
        comment = JSON.parse(
          await gh(["api", `repos/${repo}/issues/comments/${r.claimId}`]),
        );
      } catch (error) {
        if (/HTTP 404/.test(String(error))) continue;
        throw error; // Unknown freshness cannot release a live reservation.
      }
      if (!comment.user?.login || typeof comment.body !== "string") {
        throw new Error("Invalid reservation heartbeat response");
      }
      const marker = parseHeartbeatMarker(comment.body);
      if (
        trusted(comment.user.login) && marker && !marker.cleared &&
        marker.epoch > 0 &&
        now() - marker.epoch <= DEFAULT_SWEEP_STUCK_TIMEOUT_SECONDS
      ) {
        liveClaims.add(r.claimId);
      }
    }
    const existingReservations: CompletionReservation[] = [];
    if (!state) {
      // Initial activation must see work that started before a reservation
      // existed, including a claim whose assignment was accidentally removed.
      // Do not infer heartbeat freshness from the issue's updated_at timestamp.
      const issuePages = JSON.parse(
        await gh([
          "api",
          `repos/${repo}/issues?state=open&per_page=100`,
          "--paginate",
          "--slurp",
        ]),
      ) as Array<
        Array<
          {
            number: number;
            pull_request?: unknown;
            milestone: { title: string } | null;
          }
        >
      >;
      if (
        !Array.isArray(issuePages) ||
        issuePages.some((page) => !Array.isArray(page))
      ) {
        throw new Error("Incomplete active implementation snapshot");
      }
      let defaultBranch: Promise<string> | undefined;
      const readIssue = async (issue: typeof issuePages[number][number]) => {
        if (issue.pull_request) return;
        const claims = await fetchMarkerComments(
          repo,
          issue.number,
          "<!-- CLAIM_LOCK:",
          gh,
        );
        for (const claim of claims) {
          if (typeof claim.author !== "string" || !trusted(claim.author)) {
            continue;
          }
          // Simultaneous new claims have not reserved capacity yet. Their
          // pending marker disappears with the first admitted heartbeat.
          if (claim.body.includes(COMPLETION_PENDING_MARKER)) continue;
          const marker = parseHeartbeatMarker(claim.body);
          const worker = /<!-- CLAIM_LOCK:([^ ]+) -->/.exec(claim.body)?.[1];
          if (
            !worker || !marker || marker.cleared || marker.epoch <= 0 ||
            now() - marker.epoch > DEFAULT_SWEEP_STUCK_TIMEOUT_SECONDS
          ) continue;
          if (!defaultBranch && !issue.milestone) {
            defaultBranch = gh([
              "api",
              `repos/${repo}`,
              "--jq",
              ".default_branch",
            ]).then((raw) => {
              const branch = raw.trim();
              if (!branch || branch === "null") {
                throw new Error(
                  "Unknown default branch during admission bootstrap",
                );
              }
              return branch;
            });
          }
          existingReservations.push({
            issue: issue.number,
            claimId: claim.id,
            workerId: worker,
            base: issue.milestone
              ? createMilestoneBranchName(issue.milestone.title)
              : await defaultBranch!,
          });
          liveClaims.add(claim.id);
          break; // Existing issue ownership remains responsible for races.
        }
      };
      const issues = issuePages.flat();
      for (let offset = 0; offset < issues.length; offset += 8) {
        await Promise.all(issues.slice(offset, offset + 8).map(readIssue));
      }
    }
    return { prs, liveClaims, existingReservations };
  }

  return {
    async transaction(fn) {
      // The oldest issue remains a stable anchor after it closes. No new
      // tracking issue or stream-specific anchor election is required.
      if (anchor === undefined) {
        for (let page = 1; page <= 20; page++) {
          const rows = JSON.parse(
            await gh([
              "api",
              `repos/${repo}/issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`,
            ]),
          ) as Array<{ number: number; pull_request?: unknown }>;
          if (!Array.isArray(rows)) {
            throw new Error("Invalid admission anchor listing");
          }
          anchor = rows.find((row) => !row.pull_request)?.number;
          if (anchor !== undefined || rows.length < 100) break;
        }
        if (!Number.isSafeInteger(anchor) || !anchor || anchor <= 0) {
          throw new Error("No stable issue anchor for completion admission");
        }
      }
      const lockStarted = now();
      const lock = await acquireBranchUpdateLock({
        repo,
        prNumber: anchor,
        workerId,
        lockKind: "completion",
        ghCommandFn: gh,
        nowFn: now,
        sleepFn: options.sleepFn,
        authorOptions: { fleetAuthors },
        note:
          "Checking shared implementation capacity before starting more work.",
      });
      if (
        !lock.ok || !lock.value.acquired ||
        lock.value.lockCommentId === undefined
      ) {
        throw new Error("Shared completion admission is busy; retry next scan");
      }
      try {
        const rows =
          (await fetchMarkerComments(repo, anchor, COMPLETION_STATE_PREFIX, gh))
            .filter((row) =>
              typeof row.author === "string" && trusted(row.author)
            );
        if (rows.length > 1) {
          throw new Error(
            "Multiple authenticated completion states; refusing new admission",
          );
        }
        const row = rows[0];
        let previous: CompletionState | undefined;
        let rebuilding = false;
        if (row) {
          try {
            previous = parseCompletionState(row.body);
          } catch (error) {
            console.warn(
              `[completion_admission] ${repo}: rebuilding invalid state from live claims and PRs: ${error}`,
            );
            rebuilding = true;
          }
        }
        const snapshot = await readSnapshot(previous);
        snapshot.rebuilding = rebuilding;
        const before = JSON.stringify(previous);
        const result = await fn(previous, snapshot);
        if (now() - lockStarted >= 290) {
          throw new Error(
            "Shared admission lock expired during snapshot; retry without reserving",
          );
        }
        if (JSON.stringify(result.state) !== before) {
          const body =
            `${COMPLETION_STATE_PREFIX}${JSON.stringify(result.state)} -->\n` +
            "Shared implementation capacity. Live claim heartbeats retain reservations; PR maintenance continues while intake drains.";
          await gh([
            "api",
            "-X",
            row ? "PATCH" : "POST",
            row
              ? `repos/${repo}/issues/comments/${row.id}`
              : `repos/${repo}/issues/${anchor}/comments`,
            "-f",
            `body=${body}`,
          ]);
        }
        return result.value;
      } finally {
        await releaseBranchUpdateLock({
          repo,
          prNumber: anchor,
          lockCommentId: lock.value.lockCommentId,
          ghCommandFn: gh,
        });
      }
    },
  };
}

/** One shared snapshot per discovery pass, with no writes for each candidate. */
export async function completionAdmissionView(
  store: CompletionStore,
  policy: CompletionPolicy,
) {
  let view: { state: CompletionState; snapshot: CompletionSnapshot };
  const verdict = await admitCompletionWork({
    transaction: (fn) =>
      store.transaction(async (state, snapshot) => {
        const result = await fn(state, snapshot);
        view = { state: structuredClone(result.state), snapshot };
        return result;
      }),
  }, policy);
  return {
    verdict,
    check: (request: CompletionReservation) =>
      admitCompletionWork(
        {
          transaction: async (fn) =>
            (await fn(structuredClone(view.state), view.snapshot)).value,
        },
        policy,
        request,
        false,
      ),
  };
}
