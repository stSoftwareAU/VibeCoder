/** Trusted audit boundary for actual fleet reviewer posts (Issue #4658). */

import { recordMutation } from "./audit_journal.ts";
import type { Outcome } from "./fleet_review_log.ts";

/** Post at the verified head; this is the reviewer mutation's audit boundary. */
export async function postReviewAtHead(
  pr: { repo: string; number: number; headSha: string },
  outcome: Outcome,
  bodyFile: string,
  options: {
    auditDir: string;
    runId: string;
    runGh: (args: string[]) => Promise<string>;
    now?: () => Date;
  },
): Promise<void> {
  const flag = outcome === "approved"
    ? "--approve"
    : outcome === "held"
    ? "--comment"
    : "--request-changes";
  let confirmed = false;
  try {
    await options.runGh([
      "pr",
      "review",
      String(pr.number),
      "-R",
      pr.repo,
      flag,
      "--body-file",
      bodyFile,
    ]);
    confirmed = true;
  } finally {
    const timestamp = (options.now ?? (() => new Date()))().toISOString();
    const recorded = await recordMutation({
      actionId: crypto.randomUUID(),
      runId: options.runId,
      component: "reviewer",
      actionKind: "review",
      caller: "worker/deno/lib/fleet_review_post.ts",
      repo: pr.repo,
      prNumber: pr.number,
      headSha: pr.headSha,
      verb: "pr-review",
      target: String(pr.number),
      outcome: confirmed ? "success" : "error",
      timestamp,
    }, {
      baseDir: options.auditDir,
      workerId: "fleet-reviewer",
      date: timestamp.slice(0, 10),
      // Audit identity and storage are explicit; the reviewer script grants
      // HOME/XDG_STATE_HOME rather than worker-only environment variables.
      env: () => undefined,
    });
    if (!recorded.ok) {
      console.error(
        `[SECURITY] [AUDIT_JOURNAL_REFUSED] pr-review: ${recorded.error.message}`,
      );
    }
  }
}
