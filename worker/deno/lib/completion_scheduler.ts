/** Admission previews and reuse of the existing repair dispatcher (#4942). */
import type {
  CompletionPolicy,
  CompletionStore,
} from "./completion_admission.ts";
import { completionAdmissionView } from "./completion_admission_github.ts";
import { createMilestoneBranchName } from "./git_branch.ts";
import type { IssueCandidate } from "./issue_priority.ts";

export function createCompletionScheduler(options: {
  policies: ReadonlyMap<string, CompletionPolicy>;
  store(repo: string): CompletionStore;
  defaultBranch(repo: string): Promise<string>;
  repair(repo: string): Promise<boolean>;
  log(message: string): void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const views = new Map<string, {
    at: number;
    value: ReturnType<typeof completionAdmissionView>;
  }>();
  const lastAttempt = new Map<string, number>();
  const busy = new Set<string>();
  const stores = new Map<string, CompletionStore>();
  const branches = new Map<string, { at: number; value: Promise<string> }>();
  const defaultBranch = (repo: string) => {
    let cached = branches.get(repo);
    if (!cached || now() - cached.at >= 30_000) {
      cached = { at: now(), value: options.defaultBranch(repo) };
      branches.set(repo, cached);
    }
    return cached.value;
  };
  const view = (repo: string) => {
    let cached = views.get(repo);
    if (!cached || now() - cached.at >= 30_000) {
      if (!stores.has(repo)) stores.set(repo, options.store(repo));
      cached = {
        at: now(),
        value: completionAdmissionView(
          stores.get(repo)!,
          options.policies.get(repo)!,
        ),
      };
      views.set(repo, cached);
    }
    return cached.value;
  };
  return {
    async gate(candidate: IssueCandidate): Promise<string | undefined> {
      if (!options.policies.has(candidate.repo)) return undefined;
      try {
        const snapshot = await view(candidate.repo);
        const base = candidate.milestone
          ? createMilestoneBranchName(candidate.milestone)
          : await defaultBranch(candidate.repo);
        const result = await snapshot.check({
          issue: candidate.number,
          base,
          claimId: 0,
          workerId: "discovery",
        });
        return result.allowed ? undefined : result.reason;
      } catch (error) {
        // Failure parks intake for this repo only, never maintenance elsewhere.
        return `shared capacity unavailable; retry next scan: ${error}`;
      }
    },
    async process(): Promise<boolean> {
      for (const repo of options.policies.keys()) {
        if (
          busy.has(repo) ||
          now() - (lastAttempt.get(repo) ?? -Infinity) < 30_000
        ) continue;
        busy.add(repo);
        try {
          const snapshot = await view(repo);
          if (snapshot.verdict.mode !== "complete") continue;
          lastAttempt.set(repo, now());
          options.log(
            `[completion_mode] ${repo}: assigning capacity to existing PR repair`,
          );
          if (await options.repair(repo)) {
            views.delete(repo);
            return true;
          }
        } catch (error) {
          options.log(`[completion_mode] ${repo}: retry next scan: ${error}`);
        } finally {
          busy.delete(repo);
        }
      }
      return false;
    },
  };
}
