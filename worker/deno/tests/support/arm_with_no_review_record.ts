/**
 * Arming tests written before the pre-PR review record omit the fleet set.
 *
 * Production now refuses to arm without those logins (Issue #4236). The
 * tests that use this helper are about the merge method and the retry
 * ladder, so they run as a fleet whose pull request has no review record.
 * A caller that already names a fleet is left alone.
 */

import type { EnableAutoMergeOptions } from "../../lib/pr_auto_merge.ts";

const NO_RECORD_FLEET = ["vibe-bot"];

export function armWithNoReviewRecord<T extends EnableAutoMergeOptions, R>(
  enable: (options: T) => Promise<R>,
  options: T,
): Promise<R> {
  if (options.fleetAuthors !== undefined) {
    return enable(options);
  }
  const gh = options.ghCommandFn;
  return enable({
    ...options,
    fleetAuthors: NO_RECORD_FLEET,
    ghCommandFn: (args: string[]) => {
      if (args.some((arg) => arg.endsWith("/comments"))) {
        return Promise.resolve("[]");
      }
      return gh ? gh(args) : Promise.resolve("");
    },
  });
}
