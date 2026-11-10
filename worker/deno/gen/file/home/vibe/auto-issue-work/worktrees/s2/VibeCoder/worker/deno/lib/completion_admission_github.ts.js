/** GitHub-backed admission state; uses existing distributed locks and heartbeats. */ import { admitCompletionWork, COMPLETION_PENDING_MARKER, parseCompletionPolicy } from "./completion_admission.ts";
import { acquireBranchUpdateLock, releaseBranchUpdateLock } from "./pr_branch_lock.ts";
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
/** Malformed authenticated state is an error, never silently an empty queue. */ export function parseCompletionState(body) {
  const match = /^<!-- COMPLETION_ADMISSION_V1:(.+) -->/m.exec(body);
  if (!match) throw new Error("Invalid shared completion admission state");
  const state = JSON.parse(match[1]);
  parseCompletionPolicy(state.policy);
  if (state.version !== 1 || !state.modes || typeof state.modes !== "object" || Array.isArray(state.modes) || Object.values(state.modes).some((mode)=>typeof mode !== "boolean") || !Array.isArray(state.reservations) || state.reservations.some((r)=>!Number.isSafeInteger(r.issue) || r.issue <= 0 || !Number.isSafeInteger(r.claimId) || r.claimId <= 0 || typeof r.base !== "string" || !r.base || typeof r.workerId !== "string" || !r.workerId || r.recovery !== undefined && typeof r.recovery !== "boolean")) throw new Error("Invalid shared completion admission state");
  return state;
}
export function makeGitHubCompletionStore(options) {
  const { repo, workerId, fleetAuthors } = options;
  const gh = options.ghCommandFn ?? runGhCommand;
  const now = options.nowFn ?? (()=>Math.floor(Date.now() / 1000));
  let anchor;
  const trusted = (author)=>isFleetAuthor(author, fleetAuthors);
  if (fleetAuthors.length === 0) {
    throw new Error("Completion admission requires verified fleet authors");
  }
  async function readSnapshot(state) {
    // All authors, all pages: humans and final milestone integration add pressure.
    const pages = JSON.parse(await gh([
      "api",
      `repos/${repo}/pulls?state=open&per_page=100`,
      "--paginate",
      "--slurp"
    ]));
    if (!Array.isArray(pages) || pages.some((page)=>!Array.isArray(page))) {
      throw new Error("Incomplete open PR snapshot");
    }
    const prs = pages.flat().map((pr)=>{
      if (!Number.isSafeInteger(pr.number) || !pr.base?.ref || !pr.head?.ref || typeof pr.draft !== "boolean" || !pr.user?.login) {
        throw new Error("Invalid open PR snapshot");
      }
      // Only fleet branch identity can release an implementation reservation.
      const issue = trusted(pr.user.login) ? issueNumberFromBranch(pr.head.ref) : null;
      return {
        number: pr.number,
        base: pr.base.ref,
        draft: pr.draft,
        issues: trusted(pr.user.login) ? [
          ...new Set([
            ...issue === null ? [] : [
              issue
            ],
            ...extractClosingIssueNumbers(pr.body ?? "")
          ])
        ] : [],
        recoveryIssues: trusted(pr.user.login) ? extractDependencyReferencesDetailed(pr.body ?? "").filter((ref)=>!ref.repo || ref.repo.toLowerCase() === repo.toLowerCase()).map((ref)=>ref.number) : []
      };
    });
    const liveClaims = new Set();
    for (const r of state?.reservations ?? []){
      let comment;
      try {
        comment = JSON.parse(await gh([
          "api",
          `repos/${repo}/issues/comments/${r.claimId}`
        ]));
      } catch (error) {
        if (/HTTP 404/.test(String(error))) continue;
        throw error; // Unknown freshness cannot release a live reservation.
      }
      if (!comment.user?.login || typeof comment.body !== "string") {
        throw new Error("Invalid reservation heartbeat response");
      }
      const marker = parseHeartbeatMarker(comment.body);
      if (trusted(comment.user.login) && marker && !marker.cleared && marker.epoch > 0 && now() - marker.epoch <= DEFAULT_SWEEP_STUCK_TIMEOUT_SECONDS) {
        liveClaims.add(r.claimId);
      }
    }
    const existingReservations = [];
    if (!state) {
      // Initial activation must see work that started before a reservation
      // existed, including a claim whose assignment was accidentally removed.
      // Do not infer heartbeat freshness from the issue's updated_at timestamp.
      const issuePages = JSON.parse(await gh([
        "api",
        `repos/${repo}/issues?state=open&per_page=100`,
        "--paginate",
        "--slurp"
      ]));
      if (!Array.isArray(issuePages) || issuePages.some((page)=>!Array.isArray(page))) {
        throw new Error("Incomplete active implementation snapshot");
      }
      let defaultBranch;
      const readIssue = async (issue)=>{
        if (issue.pull_request) return;
        const claims = await fetchMarkerComments(repo, issue.number, "<!-- CLAIM_LOCK:", gh);
        for (const claim of claims){
          if (typeof claim.author !== "string" || !trusted(claim.author)) {
            continue;
          }
          // Simultaneous new claims have not reserved capacity yet. Their
          // pending marker disappears with the first admitted heartbeat.
          if (claim.body.includes(COMPLETION_PENDING_MARKER)) continue;
          const marker = parseHeartbeatMarker(claim.body);
          const worker = /<!-- CLAIM_LOCK:([^ ]+) -->/.exec(claim.body)?.[1];
          if (!worker || !marker || marker.cleared || marker.epoch <= 0 || now() - marker.epoch > DEFAULT_SWEEP_STUCK_TIMEOUT_SECONDS) continue;
          if (!defaultBranch && !issue.milestone) {
            defaultBranch = gh([
              "api",
              `repos/${repo}`,
              "--jq",
              ".default_branch"
            ]).then((raw)=>{
              const branch = raw.trim();
              if (!branch || branch === "null") {
                throw new Error("Unknown default branch during admission bootstrap");
              }
              return branch;
            });
          }
          existingReservations.push({
            issue: issue.number,
            claimId: claim.id,
            workerId: worker,
            base: issue.milestone ? createMilestoneBranchName(issue.milestone.title) : await defaultBranch
          });
          liveClaims.add(claim.id);
          break; // Existing issue ownership remains responsible for races.
        }
      };
      const issues = issuePages.flat();
      for(let offset = 0; offset < issues.length; offset += 8){
        await Promise.all(issues.slice(offset, offset + 8).map(readIssue));
      }
    }
    return {
      prs,
      liveClaims,
      existingReservations
    };
  }
  return {
    async transaction (fn) {
      // The oldest issue remains a stable anchor after it closes. No new
      // tracking issue or stream-specific anchor election is required.
      if (anchor === undefined) {
        for(let page = 1; page <= 20; page++){
          const rows = JSON.parse(await gh([
            "api",
            `repos/${repo}/issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`
          ]));
          if (!Array.isArray(rows)) {
            throw new Error("Invalid admission anchor listing");
          }
          anchor = rows.find((row)=>!row.pull_request)?.number;
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
        authorOptions: {
          fleetAuthors
        },
        note: "Checking shared implementation capacity before starting more work."
      });
      if (!lock.ok || !lock.value.acquired || lock.value.lockCommentId === undefined) {
        throw new Error("Shared completion admission is busy; retry next scan");
      }
      try {
        const rows = (await fetchMarkerComments(repo, anchor, COMPLETION_STATE_PREFIX, gh)).filter((row)=>typeof row.author === "string" && trusted(row.author));
        if (rows.length > 1) {
          throw new Error("Multiple authenticated completion states; refusing new admission");
        }
        const row = rows[0];
        let previous;
        let rebuilding = false;
        if (row) {
          try {
            previous = parseCompletionState(row.body);
          } catch (error) {
            console.warn(`[completion_admission] ${repo}: rebuilding invalid state from live claims and PRs: ${error}`);
            rebuilding = true;
          }
        }
        const snapshot = await readSnapshot(previous);
        snapshot.rebuilding = rebuilding;
        const before = JSON.stringify(previous);
        const result = await fn(previous, snapshot);
        if (now() - lockStarted >= 290) {
          throw new Error("Shared admission lock expired during snapshot; retry without reserving");
        }
        if (JSON.stringify(result.state) !== before) {
          const body = `${COMPLETION_STATE_PREFIX}${JSON.stringify(result.state)} -->\n` + "Shared implementation capacity. Live claim heartbeats retain reservations; PR maintenance continues while intake drains.";
          await gh([
            "api",
            "-X",
            row ? "PATCH" : "POST",
            row ? `repos/${repo}/issues/comments/${row.id}` : `repos/${repo}/issues/${anchor}/comments`,
            "-f",
            `body=${body}`
          ]);
        }
        return result.value;
      } finally{
        await releaseBranchUpdateLock({
          repo,
          prNumber: anchor,
          lockCommentId: lock.value.lockCommentId,
          ghCommandFn: gh
        });
      }
    }
  };
}
/** One shared snapshot per discovery pass, with no writes for each candidate. */ export async function completionAdmissionView(store, policy) {
  let view;
  const verdict = await admitCompletionWork({
    transaction: (fn)=>store.transaction(async (state, snapshot)=>{
        const result = await fn(state, snapshot);
        view = {
          state: structuredClone(result.state),
          snapshot
        };
        return result;
      })
  }, policy);
  return {
    verdict,
    check: (request)=>admitCompletionWork({
        transaction: async (fn)=>(await fn(structuredClone(view.state), view.snapshot)).value
      }, policy, request, false)
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb21wbGV0aW9uX2FkbWlzc2lvbl9naXRodWIudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqIEdpdEh1Yi1iYWNrZWQgYWRtaXNzaW9uIHN0YXRlOyB1c2VzIGV4aXN0aW5nIGRpc3RyaWJ1dGVkIGxvY2tzIGFuZCBoZWFydGJlYXRzLiAqL1xuaW1wb3J0IHtcbiAgYWRtaXRDb21wbGV0aW9uV29yayxcbiAgQ09NUExFVElPTl9QRU5ESU5HX01BUktFUixcbiAgdHlwZSBDb21wbGV0aW9uUG9saWN5LFxuICB0eXBlIENvbXBsZXRpb25QcixcbiAgdHlwZSBDb21wbGV0aW9uUmVzZXJ2YXRpb24sXG4gIHR5cGUgQ29tcGxldGlvblNuYXBzaG90LFxuICB0eXBlIENvbXBsZXRpb25TdGF0ZSxcbiAgdHlwZSBDb21wbGV0aW9uU3RvcmUsXG4gIHBhcnNlQ29tcGxldGlvblBvbGljeSxcbn0gZnJvbSBcIi4vY29tcGxldGlvbl9hZG1pc3Npb24udHNcIjtcbmltcG9ydCB7XG4gIGFjcXVpcmVCcmFuY2hVcGRhdGVMb2NrLFxuICByZWxlYXNlQnJhbmNoVXBkYXRlTG9jayxcbn0gZnJvbSBcIi4vcHJfYnJhbmNoX2xvY2sudHNcIjtcbmltcG9ydCB7IGZldGNoTWFya2VyQ29tbWVudHMgfSBmcm9tIFwiLi9tYXJrZXJfY29tbWVudF9wYWdlcy50c1wiO1xuaW1wb3J0IHsgaXNGbGVldEF1dGhvciB9IGZyb20gXCIuL2ZsZWV0X2F1dGhvcnMudHNcIjtcbmltcG9ydCB7IHBhcnNlSGVhcnRiZWF0TWFya2VyIH0gZnJvbSBcIi4vaGVhcnRiZWF0X3N0b3JhZ2UudHNcIjtcbmltcG9ydCB7IERFRkFVTFRfU1dFRVBfU1RVQ0tfVElNRU9VVF9TRUNPTkRTIH0gZnJvbSBcIi4vaGVhcnRiZWF0X3N3ZWVwLnRzXCI7XG5pbXBvcnQgeyBpc3N1ZU51bWJlckZyb21CcmFuY2ggfSBmcm9tIFwiLi9pc3N1ZV9icmFuY2hfY2FuZGlkYXRlcy50c1wiO1xuaW1wb3J0IHsgZXh0cmFjdERlcGVuZGVuY3lSZWZlcmVuY2VzRGV0YWlsZWQgfSBmcm9tIFwiLi9pc3N1ZV9kZXBlbmRlbmNpZXMudHNcIjtcbmltcG9ydCB7IHJ1bkdoQ29tbWFuZCB9IGZyb20gXCIuL2dpdGh1Yi50c1wiO1xuaW1wb3J0IHsgY3JlYXRlTWlsZXN0b25lQnJhbmNoTmFtZSB9IGZyb20gXCIuL2dpdF9icmFuY2gudHNcIjtcbmltcG9ydCB7IGV4dHJhY3RDbG9zaW5nSXNzdWVOdW1iZXJzIH0gZnJvbSBcIi4vcHJfYm9keS50c1wiO1xuXG5leHBvcnQgY29uc3QgQ09NUExFVElPTl9TVEFURV9QUkVGSVggPSBcIjwhLS0gQ09NUExFVElPTl9BRE1JU1NJT05fVjE6XCI7XG5cbmludGVyZmFjZSBPcHRpb25zIHtcbiAgcmVwbzogc3RyaW5nO1xuICB3b3JrZXJJZDogc3RyaW5nO1xuICBmbGVldEF1dGhvcnM6IHN0cmluZ1tdO1xuICBnaENvbW1hbmRGbj86IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+O1xuICBub3dGbj86ICgpID0+IG51bWJlcjtcbiAgc2xlZXBGbj86IChtczogbnVtYmVyKSA9PiBQcm9taXNlPHZvaWQ+O1xufVxuXG4vKiogTWFsZm9ybWVkIGF1dGhlbnRpY2F0ZWQgc3RhdGUgaXMgYW4gZXJyb3IsIG5ldmVyIHNpbGVudGx5IGFuIGVtcHR5IHF1ZXVlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQ29tcGxldGlvblN0YXRlKGJvZHk6IHN0cmluZyk6IENvbXBsZXRpb25TdGF0ZSB7XG4gIGNvbnN0IG1hdGNoID0gL148IS0tIENPTVBMRVRJT05fQURNSVNTSU9OX1YxOiguKykgLS0+L20uZXhlYyhib2R5KTtcbiAgaWYgKCFtYXRjaCkgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBzaGFyZWQgY29tcGxldGlvbiBhZG1pc3Npb24gc3RhdGVcIik7XG4gIGNvbnN0IHN0YXRlID0gSlNPTi5wYXJzZShtYXRjaFsxXSEpIGFzIENvbXBsZXRpb25TdGF0ZTtcbiAgcGFyc2VDb21wbGV0aW9uUG9saWN5KHN0YXRlLnBvbGljeSk7XG4gIGlmIChcbiAgICBzdGF0ZS52ZXJzaW9uICE9PSAxIHx8ICFzdGF0ZS5tb2RlcyB8fCB0eXBlb2Ygc3RhdGUubW9kZXMgIT09IFwib2JqZWN0XCIgfHxcbiAgICBBcnJheS5pc0FycmF5KHN0YXRlLm1vZGVzKSB8fFxuICAgIE9iamVjdC52YWx1ZXMoc3RhdGUubW9kZXMpLnNvbWUoKG1vZGUpID0+IHR5cGVvZiBtb2RlICE9PSBcImJvb2xlYW5cIikgfHxcbiAgICAhQXJyYXkuaXNBcnJheShzdGF0ZS5yZXNlcnZhdGlvbnMpIHx8XG4gICAgc3RhdGUucmVzZXJ2YXRpb25zLnNvbWUoKHIpID0+XG4gICAgICAhTnVtYmVyLmlzU2FmZUludGVnZXIoci5pc3N1ZSkgfHwgci5pc3N1ZSA8PSAwIHx8XG4gICAgICAhTnVtYmVyLmlzU2FmZUludGVnZXIoci5jbGFpbUlkKSB8fCByLmNsYWltSWQgPD0gMCB8fFxuICAgICAgdHlwZW9mIHIuYmFzZSAhPT0gXCJzdHJpbmdcIiB8fCAhci5iYXNlIHx8XG4gICAgICB0eXBlb2Ygci53b3JrZXJJZCAhPT0gXCJzdHJpbmdcIiB8fCAhci53b3JrZXJJZCB8fFxuICAgICAgKHIucmVjb3ZlcnkgIT09IHVuZGVmaW5lZCAmJiB0eXBlb2Ygci5yZWNvdmVyeSAhPT0gXCJib29sZWFuXCIpXG4gICAgKVxuICApIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgc2hhcmVkIGNvbXBsZXRpb24gYWRtaXNzaW9uIHN0YXRlXCIpO1xuICByZXR1cm4gc3RhdGU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYWtlR2l0SHViQ29tcGxldGlvblN0b3JlKG9wdGlvbnM6IE9wdGlvbnMpOiBDb21wbGV0aW9uU3RvcmUge1xuICBjb25zdCB7IHJlcG8sIHdvcmtlcklkLCBmbGVldEF1dGhvcnMgfSA9IG9wdGlvbnM7XG4gIGNvbnN0IGdoID0gb3B0aW9ucy5naENvbW1hbmRGbiA/PyBydW5HaENvbW1hbmQ7XG4gIGNvbnN0IG5vdyA9IG9wdGlvbnMubm93Rm4gPz8gKCgpID0+IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApKTtcbiAgbGV0IGFuY2hvcjogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICBjb25zdCB0cnVzdGVkID0gKGF1dGhvcjogc3RyaW5nKSA9PiBpc0ZsZWV0QXV0aG9yKGF1dGhvciwgZmxlZXRBdXRob3JzKTtcbiAgaWYgKGZsZWV0QXV0aG9ycy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJDb21wbGV0aW9uIGFkbWlzc2lvbiByZXF1aXJlcyB2ZXJpZmllZCBmbGVldCBhdXRob3JzXCIpO1xuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gcmVhZFNuYXBzaG90KFxuICAgIHN0YXRlPzogQ29tcGxldGlvblN0YXRlLFxuICApOiBQcm9taXNlPENvbXBsZXRpb25TbmFwc2hvdD4ge1xuICAgIC8vIEFsbCBhdXRob3JzLCBhbGwgcGFnZXM6IGh1bWFucyBhbmQgZmluYWwgbWlsZXN0b25lIGludGVncmF0aW9uIGFkZCBwcmVzc3VyZS5cbiAgICBjb25zdCBwYWdlcyA9IEpTT04ucGFyc2UoXG4gICAgICBhd2FpdCBnaChbXG4gICAgICAgIFwiYXBpXCIsXG4gICAgICAgIGByZXBvcy8ke3JlcG99L3B1bGxzP3N0YXRlPW9wZW4mcGVyX3BhZ2U9MTAwYCxcbiAgICAgICAgXCItLXBhZ2luYXRlXCIsXG4gICAgICAgIFwiLS1zbHVycFwiLFxuICAgICAgXSksXG4gICAgKSBhcyBBcnJheTxcbiAgICAgIEFycmF5PHtcbiAgICAgICAgbnVtYmVyOiBudW1iZXI7XG4gICAgICAgIGJhc2U6IHsgcmVmOiBzdHJpbmcgfTtcbiAgICAgICAgaGVhZDogeyByZWY6IHN0cmluZyB9O1xuICAgICAgICBkcmFmdDogYm9vbGVhbjtcbiAgICAgICAgYm9keTogc3RyaW5nIHwgbnVsbDtcbiAgICAgICAgdXNlcjogeyBsb2dpbjogc3RyaW5nIH07XG4gICAgICB9PlxuICAgID47XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KHBhZ2VzKSB8fCBwYWdlcy5zb21lKChwYWdlKSA9PiAhQXJyYXkuaXNBcnJheShwYWdlKSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkluY29tcGxldGUgb3BlbiBQUiBzbmFwc2hvdFwiKTtcbiAgICB9XG4gICAgY29uc3QgcHJzOiBDb21wbGV0aW9uUHJbXSA9IHBhZ2VzLmZsYXQoKS5tYXAoKHByKSA9PiB7XG4gICAgICBpZiAoXG4gICAgICAgICFOdW1iZXIuaXNTYWZlSW50ZWdlcihwci5udW1iZXIpIHx8ICFwci5iYXNlPy5yZWYgfHwgIXByLmhlYWQ/LnJlZiB8fFxuICAgICAgICB0eXBlb2YgcHIuZHJhZnQgIT09IFwiYm9vbGVhblwiIHx8ICFwci51c2VyPy5sb2dpblxuICAgICAgKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgb3BlbiBQUiBzbmFwc2hvdFwiKTtcbiAgICAgIH1cbiAgICAgIC8vIE9ubHkgZmxlZXQgYnJhbmNoIGlkZW50aXR5IGNhbiByZWxlYXNlIGFuIGltcGxlbWVudGF0aW9uIHJlc2VydmF0aW9uLlxuICAgICAgY29uc3QgaXNzdWUgPSB0cnVzdGVkKHByLnVzZXIubG9naW4pXG4gICAgICAgID8gaXNzdWVOdW1iZXJGcm9tQnJhbmNoKHByLmhlYWQucmVmKVxuICAgICAgICA6IG51bGw7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBudW1iZXI6IHByLm51bWJlcixcbiAgICAgICAgYmFzZTogcHIuYmFzZS5yZWYsXG4gICAgICAgIGRyYWZ0OiBwci5kcmFmdCxcbiAgICAgICAgaXNzdWVzOiB0cnVzdGVkKHByLnVzZXIubG9naW4pXG4gICAgICAgICAgPyBbXG4gICAgICAgICAgICAuLi5uZXcgU2V0KFtcbiAgICAgICAgICAgICAgLi4uKGlzc3VlID09PSBudWxsID8gW10gOiBbaXNzdWVdKSxcbiAgICAgICAgICAgICAgLi4uZXh0cmFjdENsb3NpbmdJc3N1ZU51bWJlcnMocHIuYm9keSA/PyBcIlwiKSxcbiAgICAgICAgICAgIF0pLFxuICAgICAgICAgIF1cbiAgICAgICAgICA6IFtdLFxuICAgICAgICByZWNvdmVyeUlzc3VlczogdHJ1c3RlZChwci51c2VyLmxvZ2luKVxuICAgICAgICAgID8gZXh0cmFjdERlcGVuZGVuY3lSZWZlcmVuY2VzRGV0YWlsZWQocHIuYm9keSA/PyBcIlwiKVxuICAgICAgICAgICAgLmZpbHRlcigocmVmKSA9PlxuICAgICAgICAgICAgICAhcmVmLnJlcG8gfHwgcmVmLnJlcG8udG9Mb3dlckNhc2UoKSA9PT0gcmVwby50b0xvd2VyQ2FzZSgpXG4gICAgICAgICAgICApXG4gICAgICAgICAgICAubWFwKChyZWYpID0+IHJlZi5udW1iZXIpXG4gICAgICAgICAgOiBbXSxcbiAgICAgIH07XG4gICAgfSk7XG4gICAgY29uc3QgbGl2ZUNsYWltcyA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuICAgIGZvciAoY29uc3QgciBvZiBzdGF0ZT8ucmVzZXJ2YXRpb25zID8/IFtdKSB7XG4gICAgICBsZXQgY29tbWVudDogeyBib2R5OiBzdHJpbmc7IHVzZXI6IHsgbG9naW46IHN0cmluZyB9IH07XG4gICAgICB0cnkge1xuICAgICAgICBjb21tZW50ID0gSlNPTi5wYXJzZShcbiAgICAgICAgICBhd2FpdCBnaChbXCJhcGlcIiwgYHJlcG9zLyR7cmVwb30vaXNzdWVzL2NvbW1lbnRzLyR7ci5jbGFpbUlkfWBdKSxcbiAgICAgICAgKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmICgvSFRUUCA0MDQvLnRlc3QoU3RyaW5nKGVycm9yKSkpIGNvbnRpbnVlO1xuICAgICAgICB0aHJvdyBlcnJvcjsgLy8gVW5rbm93biBmcmVzaG5lc3MgY2Fubm90IHJlbGVhc2UgYSBsaXZlIHJlc2VydmF0aW9uLlxuICAgICAgfVxuICAgICAgaWYgKCFjb21tZW50LnVzZXI/LmxvZ2luIHx8IHR5cGVvZiBjb21tZW50LmJvZHkgIT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCByZXNlcnZhdGlvbiBoZWFydGJlYXQgcmVzcG9uc2VcIik7XG4gICAgICB9XG4gICAgICBjb25zdCBtYXJrZXIgPSBwYXJzZUhlYXJ0YmVhdE1hcmtlcihjb21tZW50LmJvZHkpO1xuICAgICAgaWYgKFxuICAgICAgICB0cnVzdGVkKGNvbW1lbnQudXNlci5sb2dpbikgJiYgbWFya2VyICYmICFtYXJrZXIuY2xlYXJlZCAmJlxuICAgICAgICBtYXJrZXIuZXBvY2ggPiAwICYmXG4gICAgICAgIG5vdygpIC0gbWFya2VyLmVwb2NoIDw9IERFRkFVTFRfU1dFRVBfU1RVQ0tfVElNRU9VVF9TRUNPTkRTXG4gICAgICApIHtcbiAgICAgICAgbGl2ZUNsYWltcy5hZGQoci5jbGFpbUlkKTtcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgZXhpc3RpbmdSZXNlcnZhdGlvbnM6IENvbXBsZXRpb25SZXNlcnZhdGlvbltdID0gW107XG4gICAgaWYgKCFzdGF0ZSkge1xuICAgICAgLy8gSW5pdGlhbCBhY3RpdmF0aW9uIG11c3Qgc2VlIHdvcmsgdGhhdCBzdGFydGVkIGJlZm9yZSBhIHJlc2VydmF0aW9uXG4gICAgICAvLyBleGlzdGVkLCBpbmNsdWRpbmcgYSBjbGFpbSB3aG9zZSBhc3NpZ25tZW50IHdhcyBhY2NpZGVudGFsbHkgcmVtb3ZlZC5cbiAgICAgIC8vIERvIG5vdCBpbmZlciBoZWFydGJlYXQgZnJlc2huZXNzIGZyb20gdGhlIGlzc3VlJ3MgdXBkYXRlZF9hdCB0aW1lc3RhbXAuXG4gICAgICBjb25zdCBpc3N1ZVBhZ2VzID0gSlNPTi5wYXJzZShcbiAgICAgICAgYXdhaXQgZ2goW1xuICAgICAgICAgIFwiYXBpXCIsXG4gICAgICAgICAgYHJlcG9zLyR7cmVwb30vaXNzdWVzP3N0YXRlPW9wZW4mcGVyX3BhZ2U9MTAwYCxcbiAgICAgICAgICBcIi0tcGFnaW5hdGVcIixcbiAgICAgICAgICBcIi0tc2x1cnBcIixcbiAgICAgICAgXSksXG4gICAgICApIGFzIEFycmF5PFxuICAgICAgICBBcnJheTxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBudW1iZXI6IG51bWJlcjtcbiAgICAgICAgICAgIHB1bGxfcmVxdWVzdD86IHVua25vd247XG4gICAgICAgICAgICBtaWxlc3RvbmU6IHsgdGl0bGU6IHN0cmluZyB9IHwgbnVsbDtcbiAgICAgICAgICB9XG4gICAgICAgID5cbiAgICAgID47XG4gICAgICBpZiAoXG4gICAgICAgICFBcnJheS5pc0FycmF5KGlzc3VlUGFnZXMpIHx8XG4gICAgICAgIGlzc3VlUGFnZXMuc29tZSgocGFnZSkgPT4gIUFycmF5LmlzQXJyYXkocGFnZSkpXG4gICAgICApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiSW5jb21wbGV0ZSBhY3RpdmUgaW1wbGVtZW50YXRpb24gc25hcHNob3RcIik7XG4gICAgICB9XG4gICAgICBsZXQgZGVmYXVsdEJyYW5jaDogUHJvbWlzZTxzdHJpbmc+IHwgdW5kZWZpbmVkO1xuICAgICAgY29uc3QgcmVhZElzc3VlID0gYXN5bmMgKGlzc3VlOiB0eXBlb2YgaXNzdWVQYWdlc1tudW1iZXJdW251bWJlcl0pID0+IHtcbiAgICAgICAgaWYgKGlzc3VlLnB1bGxfcmVxdWVzdCkgcmV0dXJuO1xuICAgICAgICBjb25zdCBjbGFpbXMgPSBhd2FpdCBmZXRjaE1hcmtlckNvbW1lbnRzKFxuICAgICAgICAgIHJlcG8sXG4gICAgICAgICAgaXNzdWUubnVtYmVyLFxuICAgICAgICAgIFwiPCEtLSBDTEFJTV9MT0NLOlwiLFxuICAgICAgICAgIGdoLFxuICAgICAgICApO1xuICAgICAgICBmb3IgKGNvbnN0IGNsYWltIG9mIGNsYWltcykge1xuICAgICAgICAgIGlmICh0eXBlb2YgY2xhaW0uYXV0aG9yICE9PSBcInN0cmluZ1wiIHx8ICF0cnVzdGVkKGNsYWltLmF1dGhvcikpIHtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBTaW11bHRhbmVvdXMgbmV3IGNsYWltcyBoYXZlIG5vdCByZXNlcnZlZCBjYXBhY2l0eSB5ZXQuIFRoZWlyXG4gICAgICAgICAgLy8gcGVuZGluZyBtYXJrZXIgZGlzYXBwZWFycyB3aXRoIHRoZSBmaXJzdCBhZG1pdHRlZCBoZWFydGJlYXQuXG4gICAgICAgICAgaWYgKGNsYWltLmJvZHkuaW5jbHVkZXMoQ09NUExFVElPTl9QRU5ESU5HX01BUktFUikpIGNvbnRpbnVlO1xuICAgICAgICAgIGNvbnN0IG1hcmtlciA9IHBhcnNlSGVhcnRiZWF0TWFya2VyKGNsYWltLmJvZHkpO1xuICAgICAgICAgIGNvbnN0IHdvcmtlciA9IC88IS0tIENMQUlNX0xPQ0s6KFteIF0rKSAtLT4vLmV4ZWMoY2xhaW0uYm9keSk/LlsxXTtcbiAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAhd29ya2VyIHx8ICFtYXJrZXIgfHwgbWFya2VyLmNsZWFyZWQgfHwgbWFya2VyLmVwb2NoIDw9IDAgfHxcbiAgICAgICAgICAgIG5vdygpIC0gbWFya2VyLmVwb2NoID4gREVGQVVMVF9TV0VFUF9TVFVDS19USU1FT1VUX1NFQ09ORFNcbiAgICAgICAgICApIGNvbnRpbnVlO1xuICAgICAgICAgIGlmICghZGVmYXVsdEJyYW5jaCAmJiAhaXNzdWUubWlsZXN0b25lKSB7XG4gICAgICAgICAgICBkZWZhdWx0QnJhbmNoID0gZ2goW1xuICAgICAgICAgICAgICBcImFwaVwiLFxuICAgICAgICAgICAgICBgcmVwb3MvJHtyZXBvfWAsXG4gICAgICAgICAgICAgIFwiLS1qcVwiLFxuICAgICAgICAgICAgICBcIi5kZWZhdWx0X2JyYW5jaFwiLFxuICAgICAgICAgICAgXSkudGhlbigocmF3KSA9PiB7XG4gICAgICAgICAgICAgIGNvbnN0IGJyYW5jaCA9IHJhdy50cmltKCk7XG4gICAgICAgICAgICAgIGlmICghYnJhbmNoIHx8IGJyYW5jaCA9PT0gXCJudWxsXCIpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICBcIlVua25vd24gZGVmYXVsdCBicmFuY2ggZHVyaW5nIGFkbWlzc2lvbiBib290c3RyYXBcIixcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIHJldHVybiBicmFuY2g7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgZXhpc3RpbmdSZXNlcnZhdGlvbnMucHVzaCh7XG4gICAgICAgICAgICBpc3N1ZTogaXNzdWUubnVtYmVyLFxuICAgICAgICAgICAgY2xhaW1JZDogY2xhaW0uaWQsXG4gICAgICAgICAgICB3b3JrZXJJZDogd29ya2VyLFxuICAgICAgICAgICAgYmFzZTogaXNzdWUubWlsZXN0b25lXG4gICAgICAgICAgICAgID8gY3JlYXRlTWlsZXN0b25lQnJhbmNoTmFtZShpc3N1ZS5taWxlc3RvbmUudGl0bGUpXG4gICAgICAgICAgICAgIDogYXdhaXQgZGVmYXVsdEJyYW5jaCEsXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgbGl2ZUNsYWltcy5hZGQoY2xhaW0uaWQpO1xuICAgICAgICAgIGJyZWFrOyAvLyBFeGlzdGluZyBpc3N1ZSBvd25lcnNoaXAgcmVtYWlucyByZXNwb25zaWJsZSBmb3IgcmFjZXMuXG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBjb25zdCBpc3N1ZXMgPSBpc3N1ZVBhZ2VzLmZsYXQoKTtcbiAgICAgIGZvciAobGV0IG9mZnNldCA9IDA7IG9mZnNldCA8IGlzc3Vlcy5sZW5ndGg7IG9mZnNldCArPSA4KSB7XG4gICAgICAgIGF3YWl0IFByb21pc2UuYWxsKGlzc3Vlcy5zbGljZShvZmZzZXQsIG9mZnNldCArIDgpLm1hcChyZWFkSXNzdWUpKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHsgcHJzLCBsaXZlQ2xhaW1zLCBleGlzdGluZ1Jlc2VydmF0aW9ucyB9O1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBhc3luYyB0cmFuc2FjdGlvbihmbikge1xuICAgICAgLy8gVGhlIG9sZGVzdCBpc3N1ZSByZW1haW5zIGEgc3RhYmxlIGFuY2hvciBhZnRlciBpdCBjbG9zZXMuIE5vIG5ld1xuICAgICAgLy8gdHJhY2tpbmcgaXNzdWUgb3Igc3RyZWFtLXNwZWNpZmljIGFuY2hvciBlbGVjdGlvbiBpcyByZXF1aXJlZC5cbiAgICAgIGlmIChhbmNob3IgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICBmb3IgKGxldCBwYWdlID0gMTsgcGFnZSA8PSAyMDsgcGFnZSsrKSB7XG4gICAgICAgICAgY29uc3Qgcm93cyA9IEpTT04ucGFyc2UoXG4gICAgICAgICAgICBhd2FpdCBnaChbXG4gICAgICAgICAgICAgIFwiYXBpXCIsXG4gICAgICAgICAgICAgIGByZXBvcy8ke3JlcG99L2lzc3Vlcz9zdGF0ZT1hbGwmc29ydD1jcmVhdGVkJmRpcmVjdGlvbj1hc2MmcGVyX3BhZ2U9MTAwJnBhZ2U9JHtwYWdlfWAsXG4gICAgICAgICAgICBdKSxcbiAgICAgICAgICApIGFzIEFycmF5PHsgbnVtYmVyOiBudW1iZXI7IHB1bGxfcmVxdWVzdD86IHVua25vd24gfT47XG4gICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHJvd3MpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIGFkbWlzc2lvbiBhbmNob3IgbGlzdGluZ1wiKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgYW5jaG9yID0gcm93cy5maW5kKChyb3cpID0+ICFyb3cucHVsbF9yZXF1ZXN0KT8ubnVtYmVyO1xuICAgICAgICAgIGlmIChhbmNob3IgIT09IHVuZGVmaW5lZCB8fCByb3dzLmxlbmd0aCA8IDEwMCkgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcihhbmNob3IpIHx8ICFhbmNob3IgfHwgYW5jaG9yIDw9IDApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJObyBzdGFibGUgaXNzdWUgYW5jaG9yIGZvciBjb21wbGV0aW9uIGFkbWlzc2lvblwiKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgY29uc3QgbG9ja1N0YXJ0ZWQgPSBub3coKTtcbiAgICAgIGNvbnN0IGxvY2sgPSBhd2FpdCBhY3F1aXJlQnJhbmNoVXBkYXRlTG9jayh7XG4gICAgICAgIHJlcG8sXG4gICAgICAgIHByTnVtYmVyOiBhbmNob3IsXG4gICAgICAgIHdvcmtlcklkLFxuICAgICAgICBsb2NrS2luZDogXCJjb21wbGV0aW9uXCIsXG4gICAgICAgIGdoQ29tbWFuZEZuOiBnaCxcbiAgICAgICAgbm93Rm46IG5vdyxcbiAgICAgICAgc2xlZXBGbjogb3B0aW9ucy5zbGVlcEZuLFxuICAgICAgICBhdXRob3JPcHRpb25zOiB7IGZsZWV0QXV0aG9ycyB9LFxuICAgICAgICBub3RlOlxuICAgICAgICAgIFwiQ2hlY2tpbmcgc2hhcmVkIGltcGxlbWVudGF0aW9uIGNhcGFjaXR5IGJlZm9yZSBzdGFydGluZyBtb3JlIHdvcmsuXCIsXG4gICAgICB9KTtcbiAgICAgIGlmIChcbiAgICAgICAgIWxvY2sub2sgfHwgIWxvY2sudmFsdWUuYWNxdWlyZWQgfHxcbiAgICAgICAgbG9jay52YWx1ZS5sb2NrQ29tbWVudElkID09PSB1bmRlZmluZWRcbiAgICAgICkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJTaGFyZWQgY29tcGxldGlvbiBhZG1pc3Npb24gaXMgYnVzeTsgcmV0cnkgbmV4dCBzY2FuXCIpO1xuICAgICAgfVxuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgcm93cyA9XG4gICAgICAgICAgKGF3YWl0IGZldGNoTWFya2VyQ29tbWVudHMocmVwbywgYW5jaG9yLCBDT01QTEVUSU9OX1NUQVRFX1BSRUZJWCwgZ2gpKVxuICAgICAgICAgICAgLmZpbHRlcigocm93KSA9PlxuICAgICAgICAgICAgICB0eXBlb2Ygcm93LmF1dGhvciA9PT0gXCJzdHJpbmdcIiAmJiB0cnVzdGVkKHJvdy5hdXRob3IpXG4gICAgICAgICAgICApO1xuICAgICAgICBpZiAocm93cy5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJNdWx0aXBsZSBhdXRoZW50aWNhdGVkIGNvbXBsZXRpb24gc3RhdGVzOyByZWZ1c2luZyBuZXcgYWRtaXNzaW9uXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByb3cgPSByb3dzWzBdO1xuICAgICAgICBsZXQgcHJldmlvdXM6IENvbXBsZXRpb25TdGF0ZSB8IHVuZGVmaW5lZDtcbiAgICAgICAgbGV0IHJlYnVpbGRpbmcgPSBmYWxzZTtcbiAgICAgICAgaWYgKHJvdykge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBwcmV2aW91cyA9IHBhcnNlQ29tcGxldGlvblN0YXRlKHJvdy5ib2R5KTtcbiAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICAgICAgICBgW2NvbXBsZXRpb25fYWRtaXNzaW9uXSAke3JlcG99OiByZWJ1aWxkaW5nIGludmFsaWQgc3RhdGUgZnJvbSBsaXZlIGNsYWltcyBhbmQgUFJzOiAke2Vycm9yfWAsXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgcmVidWlsZGluZyA9IHRydWU7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHNuYXBzaG90ID0gYXdhaXQgcmVhZFNuYXBzaG90KHByZXZpb3VzKTtcbiAgICAgICAgc25hcHNob3QucmVidWlsZGluZyA9IHJlYnVpbGRpbmc7XG4gICAgICAgIGNvbnN0IGJlZm9yZSA9IEpTT04uc3RyaW5naWZ5KHByZXZpb3VzKTtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZm4ocHJldmlvdXMsIHNuYXBzaG90KTtcbiAgICAgICAgaWYgKG5vdygpIC0gbG9ja1N0YXJ0ZWQgPj0gMjkwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJTaGFyZWQgYWRtaXNzaW9uIGxvY2sgZXhwaXJlZCBkdXJpbmcgc25hcHNob3Q7IHJldHJ5IHdpdGhvdXQgcmVzZXJ2aW5nXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoSlNPTi5zdHJpbmdpZnkocmVzdWx0LnN0YXRlKSAhPT0gYmVmb3JlKSB7XG4gICAgICAgICAgY29uc3QgYm9keSA9XG4gICAgICAgICAgICBgJHtDT01QTEVUSU9OX1NUQVRFX1BSRUZJWH0ke0pTT04uc3RyaW5naWZ5KHJlc3VsdC5zdGF0ZSl9IC0tPlxcbmAgK1xuICAgICAgICAgICAgXCJTaGFyZWQgaW1wbGVtZW50YXRpb24gY2FwYWNpdHkuIExpdmUgY2xhaW0gaGVhcnRiZWF0cyByZXRhaW4gcmVzZXJ2YXRpb25zOyBQUiBtYWludGVuYW5jZSBjb250aW51ZXMgd2hpbGUgaW50YWtlIGRyYWlucy5cIjtcbiAgICAgICAgICBhd2FpdCBnaChbXG4gICAgICAgICAgICBcImFwaVwiLFxuICAgICAgICAgICAgXCItWFwiLFxuICAgICAgICAgICAgcm93ID8gXCJQQVRDSFwiIDogXCJQT1NUXCIsXG4gICAgICAgICAgICByb3dcbiAgICAgICAgICAgICAgPyBgcmVwb3MvJHtyZXBvfS9pc3N1ZXMvY29tbWVudHMvJHtyb3cuaWR9YFxuICAgICAgICAgICAgICA6IGByZXBvcy8ke3JlcG99L2lzc3Vlcy8ke2FuY2hvcn0vY29tbWVudHNgLFxuICAgICAgICAgICAgXCItZlwiLFxuICAgICAgICAgICAgYGJvZHk9JHtib2R5fWAsXG4gICAgICAgICAgXSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlc3VsdC52YWx1ZTtcbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIGF3YWl0IHJlbGVhc2VCcmFuY2hVcGRhdGVMb2NrKHtcbiAgICAgICAgICByZXBvLFxuICAgICAgICAgIHByTnVtYmVyOiBhbmNob3IsXG4gICAgICAgICAgbG9ja0NvbW1lbnRJZDogbG9jay52YWx1ZS5sb2NrQ29tbWVudElkLFxuICAgICAgICAgIGdoQ29tbWFuZEZuOiBnaCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSxcbiAgfTtcbn1cblxuLyoqIE9uZSBzaGFyZWQgc25hcHNob3QgcGVyIGRpc2NvdmVyeSBwYXNzLCB3aXRoIG5vIHdyaXRlcyBmb3IgZWFjaCBjYW5kaWRhdGUuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY29tcGxldGlvbkFkbWlzc2lvblZpZXcoXG4gIHN0b3JlOiBDb21wbGV0aW9uU3RvcmUsXG4gIHBvbGljeTogQ29tcGxldGlvblBvbGljeSxcbikge1xuICBsZXQgdmlldzogeyBzdGF0ZTogQ29tcGxldGlvblN0YXRlOyBzbmFwc2hvdDogQ29tcGxldGlvblNuYXBzaG90IH07XG4gIGNvbnN0IHZlcmRpY3QgPSBhd2FpdCBhZG1pdENvbXBsZXRpb25Xb3JrKHtcbiAgICB0cmFuc2FjdGlvbjogKGZuKSA9PlxuICAgICAgc3RvcmUudHJhbnNhY3Rpb24oYXN5bmMgKHN0YXRlLCBzbmFwc2hvdCkgPT4ge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBmbihzdGF0ZSwgc25hcHNob3QpO1xuICAgICAgICB2aWV3ID0geyBzdGF0ZTogc3RydWN0dXJlZENsb25lKHJlc3VsdC5zdGF0ZSksIHNuYXBzaG90IH07XG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICB9KSxcbiAgfSwgcG9saWN5KTtcbiAgcmV0dXJuIHtcbiAgICB2ZXJkaWN0LFxuICAgIGNoZWNrOiAocmVxdWVzdDogQ29tcGxldGlvblJlc2VydmF0aW9uKSA9PlxuICAgICAgYWRtaXRDb21wbGV0aW9uV29yayhcbiAgICAgICAge1xuICAgICAgICAgIHRyYW5zYWN0aW9uOiBhc3luYyAoZm4pID0+XG4gICAgICAgICAgICAoYXdhaXQgZm4oc3RydWN0dXJlZENsb25lKHZpZXcuc3RhdGUpLCB2aWV3LnNuYXBzaG90KSkudmFsdWUsXG4gICAgICAgIH0sXG4gICAgICAgIHBvbGljeSxcbiAgICAgICAgcmVxdWVzdCxcbiAgICAgICAgZmFsc2UsXG4gICAgICApLFxuICB9O1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLG1GQUFtRixHQUNuRixTQUNFLG1CQUFtQixFQUNuQix5QkFBeUIsRUFPekIscUJBQXFCLFFBQ2hCLDRCQUE0QjtBQUNuQyxTQUNFLHVCQUF1QixFQUN2Qix1QkFBdUIsUUFDbEIsc0JBQXNCO0FBQzdCLFNBQVMsbUJBQW1CLFFBQVEsNEJBQTRCO0FBQ2hFLFNBQVMsYUFBYSxRQUFRLHFCQUFxQjtBQUNuRCxTQUFTLG9CQUFvQixRQUFRLHlCQUF5QjtBQUM5RCxTQUFTLG1DQUFtQyxRQUFRLHVCQUF1QjtBQUMzRSxTQUFTLHFCQUFxQixRQUFRLCtCQUErQjtBQUNyRSxTQUFTLG1DQUFtQyxRQUFRLDBCQUEwQjtBQUM5RSxTQUFTLFlBQVksUUFBUSxjQUFjO0FBQzNDLFNBQVMseUJBQXlCLFFBQVEsa0JBQWtCO0FBQzVELFNBQVMsMEJBQTBCLFFBQVEsZUFBZTtBQUUxRCxPQUFPLE1BQU0sMEJBQTBCLGdDQUFnQztBQVd2RSw4RUFBOEUsR0FDOUUsT0FBTyxTQUFTLHFCQUFxQixJQUFZO0VBQy9DLE1BQU0sUUFBUSwwQ0FBMEMsSUFBSSxDQUFDO0VBQzdELElBQUksQ0FBQyxPQUFPLE1BQU0sSUFBSSxNQUFNO0VBQzVCLE1BQU0sUUFBUSxLQUFLLEtBQUssQ0FBQyxLQUFLLENBQUMsRUFBRTtFQUNqQyxzQkFBc0IsTUFBTSxNQUFNO0VBQ2xDLElBQ0UsTUFBTSxPQUFPLEtBQUssS0FBSyxDQUFDLE1BQU0sS0FBSyxJQUFJLE9BQU8sTUFBTSxLQUFLLEtBQUssWUFDOUQsTUFBTSxPQUFPLENBQUMsTUFBTSxLQUFLLEtBQ3pCLE9BQU8sTUFBTSxDQUFDLE1BQU0sS0FBSyxFQUFFLElBQUksQ0FBQyxDQUFDLE9BQVMsT0FBTyxTQUFTLGNBQzFELENBQUMsTUFBTSxP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
// denoCacheMetadata=7779372700347262628,11101365454549217440