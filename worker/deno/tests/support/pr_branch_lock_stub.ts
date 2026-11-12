import {
  acquireBranchUpdateLock,
  type BranchUpdateLockOptions,
} from "../../lib/pr_branch_lock.ts";
import type { GitHubDeps } from "../../lib/issue_worker_wiring.ts";
import { openPrGh } from "./pr_live_state_stub.ts";

/** A `gh` stub serving base-ref reads and the CI command's branch-lock timeline. */
export function openPrWithBranchLockGh(): GitHubDeps["runGhCommand"] {
  let lockBody = "";
  return openPrGh((args: string[]) => {
    if (args[0] === "issue" && args[1] === "comment") {
      lockBody = args[args.indexOf("--body") + 1] ?? "";
      return Promise.resolve(
        "https://github.com/org/repo/issues/42#issuecomment-123",
      );
    }
    if (
      args.includes("--paginate") &&
      args.some((arg) => arg.includes("BRANCH_UPDATE_LOCK"))
    ) {
      return Promise.resolve(JSON.stringify(
        lockBody
          ? [{
            id: 123,
            body: lockBody,
            created_at: new Date().toISOString(),
            author: "worker",
          }]
          : [],
      ));
    }
    if (
      args[0] === "pr" && args[1] === "view" && args.includes("baseRefName")
    ) {
      return Promise.resolve("main");
    }
    return Promise.resolve("");
  });
}
/** Use the real lock transaction without waiting on GitHub consistency in a local fake. */
export function acquireBranchLockWithoutDelay(
  options: BranchUpdateLockOptions,
) {
  return acquireBranchUpdateLock({
    ...options,
    sleepFn: () => Promise.resolve(),
  });
}
