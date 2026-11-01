import { runPairedOfflineDenoTest } from "../../../../worker/deno/lib/offline_repo_runner.ts";
import type {
  PairedCheckRequest,
  PairedObservation,
} from "./review_regression_collection.ts";

/** Construct only in the trusted host process; sourceRepo and hostRoot are
 * host-selected, not paths supplied by the PR or the reviewer. */
export function appleRegressionRunner(
  sourceRepo: string,
  hostRoot: string,
  image?: string,
) {
  return async (request: PairedCheckRequest): Promise<PairedObservation> => {
    const result = await runPairedOfflineDenoTest({
      sourceRepo,
      hostRoot,
      image,
      head: request.head,
      base: request.base,
      cwd: request.cwd,
      testPath: request.testFile,
    });
    if (result.status !== "observed") return result;
    if (result.head.status !== "passed" || result.base.status !== "passed") {
      return {
        status: "unavailable",
        detail: "Paired result did not contain two completed checks",
      };
    }
    return {
      status: "observed",
      head: { ...result.head, status: "passed" },
      base: { ...result.base, status: "passed" },
      blob: result.blob,
    };
  };
}
