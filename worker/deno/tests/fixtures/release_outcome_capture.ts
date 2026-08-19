/**
 * Test helper (Issue #4330): capture the run outcome each release path
 * supplies — via the shared claim-release marker hook and via the
 * heartbeat's final clear (which parks the outcome for the marker path).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { setMarkerReleaseHook } from "../../lib/claim_release.ts";
import { takePendingReleaseOutcome } from "../../lib/heartbeat_storage.ts";
import type { RunOutcome } from "../../lib/run_outcome.ts";
import type { Result } from "../../types.ts";

export interface CapturedRelease {
  repo: string;
  issueNumber: number;
  outcome: RunOutcome | undefined;
}

export interface ReleaseOutcomeCapture {
  /** Outcomes forwarded through releaseClaim / releaseAllWorkerClaims. */
  hooked: CapturedRelease[];
  /** Outcomes carried by the heartbeat's final clear (stopHeartbeat). */
  cleared: CapturedRelease[];
  /** Drop-in for `crashHandling.clearHeartbeat`. */
  clearHeartbeat: (
    workDir: string,
    repo: string,
    issueNumber: number,
  ) => Promise<Result<void>>;
  /** Every outcome seen on either path, in order. */
  all(): (RunOutcome | undefined)[];
  restore(): void;
}

export function captureReleaseOutcomes(): ReleaseOutcomeCapture {
  const hooked: CapturedRelease[] = [];
  const cleared: CapturedRelease[] = [];
  const restore = setMarkerReleaseHook((repo, issueNumber, outcome) => {
    hooked.push({ repo, issueNumber, outcome });
    return Promise.resolve();
  });
  return {
    hooked,
    cleared,
    clearHeartbeat: (_workDir, repo, issueNumber) => {
      cleared.push({
        repo,
        issueNumber,
        outcome: takePendingReleaseOutcome(repo, issueNumber),
      });
      return Promise.resolve({ ok: true, value: undefined });
    },
    all: () => [...hooked, ...cleared].map((c) => c.outcome),
    restore,
  };
}
