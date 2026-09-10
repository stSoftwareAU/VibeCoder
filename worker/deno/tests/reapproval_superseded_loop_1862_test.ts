/**
 * End-to-end regression for the re-approved-then-superseded claim loop
 * (Issue #1862).
 *
 * GRQ-25, 2026-09-10, stSoftwareAU/GRQ-AutoTrader#106: PR #116 merged at
 * 09:35Z; a maintainer re-applied `work-on` at 15:49Z, after the merge. Every
 * cycle from then on:
 *
 *   - the merged-PR pre-check honoured the re-approval and kept the issue open
 *     (Issue #1618) — "NOT closing — approval post-dates merge";
 *   - a fresh agent was started on the original issue text, which PR #116
 *     already satisfied, so it had nothing to change;
 *   - the branch, level with `milestone/pwa`, was released as superseded
 *     (Issue #218) — a success, no comment, the label untouched;
 *   - so the next scan claimed the issue again. Three claims in four hours,
 *     each an Opus invocation for no output.
 *
 * These tests drive the whole `workOnIssue` pipeline with injected doubles and
 * assert what a human and the next scan actually see: one explanatory comment
 * carrying the dedup marker, `needs-human` applied, the reason stated on the
 * claim release, and no second comment on a repeat run.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssue } from "../lib/issue_worker.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { reapprovalSupersededDedupKey } from "../lib/reapproval_superseded_handoff.ts";
import type { IssueContext } from "../lib/issue_worker_types.ts";
import type { WorkOnIssueResult } from "../lib/issue_worker_types.ts";

const REPO = "stSoftwareAU/GRQ-AutoTrader";
const ISSUE = 106;
const BRANCH = "issue-106-feat-web-pwa-manifest-and-shell-precaching-service";
const PR_URL = `https://github.com/${REPO}/pull/116`;
const WORKER = "testbot";
/** PR #116's merge. */
const MERGED_AT = "2026-09-09T09:35:27Z";
/** The maintainer's `work-on` re-add, 6h14m after that merge. */
const AFTER_MERGE = "2026-09-09T15:49:15Z";
/** An approval that pre-dates the merge — the ordinary close case. */
const BEFORE_MERGE = "2026-09-08T09:00:00Z";

const MARKER = `<!-- needs-human-escalation: ${
  reapprovalSupersededDedupKey(ISSUE)
} -->`;

/** What one run of the pipeline did to the issue. */
interface RunRecord {
  result: WorkOnIssueResult;
  /** Comment bodies posted through the REST comments endpoint. */
  comments: string[];
  /** Labels added through the REST labels endpoint. */
  labelsAdded: string[];
}

/**
 * Run the pipeline against a merged PR #116, a `work-on` add at
 * `labelAddedAt`, and `priorComments` already on the issue.
 */
async function runCycle(opts: {
  labelAddedAt: string;
  priorComments?: Array<{ body: string; author: string; createdAt: string }>;
}): Promise<RunRecord> {
  const comments: string[] = [];
  const labelsAdded: string[] = [];

  const deps = createMockDeps({
    claude: {
      // The agent has nothing to do: the merged PR already satisfies the
      // original description, so the run burns its budget and stops.
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: {
            output: "nothing left to change",
            exitCode: 124,
            rawExitCode: 143,
            timedOut: true,
            timeoutReason: "hard-timeout",
          },
        })) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: PR_URL })) as never,
    },
    github: {
      runGhCommand: ((args: string[]) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(JSON.stringify({
            state: "MERGED",
            mergedAt: MERGED_AT,
            headRefName: BRANCH,
            baseRefName: "milestone/pwa",
            mergeCommit: { oid: "abc123" },
          }));
        }
        if (args[0] === "api" && String(args[1]).includes("/timeline")) {
          return Promise.resolve(JSON.stringify([{
            event: "labeled",
            label: { name: "work-on" },
            actor: { login: "nleck" },
            created_at: opts.labelAddedAt,
          }]));
        }
        // The escalation's dedup read.
        if (args[0] === "api" && String(args[1]).includes("/comments?")) {
          return Promise.resolve(JSON.stringify(
            (opts.priorComments ?? []).map((c, index) => ({
              id: index + 1,
              body: c.body,
              created_at: c.createdAt,
              user: { login: c.author },
            })),
          ));
        }
        if (args[0] === "api" && args.includes("-X")) {
          const path = args.find((a) => a.startsWith("repos/")) ?? "";
          if (path.endsWith("/comments")) {
            const body = args.find((a) => a.startsWith("body="));
            comments.push((body ?? "").slice("body=".length));
            return Promise.resolve("{}");
          }
          if (path.endsWith(`/issues/${ISSUE}/labels`)) {
            const label = args.find((a) => a.startsWith("labels[]="));
            labelsAdded.push((label ?? "").slice("labels[]=".length));
            return Promise.resolve("[]");
          }
        }
        if (args[0] === "issue" && args[1] === "view") {
          return Promise.resolve(
            JSON.stringify({ state: "OPEN", milestone: null, labels: [] }),
          );
        }
        return Promise.resolve("");
      }) as never,
    },
  });

  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "web: PWA manifest and shell precaching service",
    issueBody: "Add a web app manifest and precache the app shell.",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: WORKER,
    config: {
      ...buildDefaultWorkerConfig(),
      allowedAuthors: ["nleck"],
      infraRetryBackoffMs: 10,
    },
  };

  const result = await workOnIssue(ctx, deps);
  return { result, comments, labelsAdded };
}

Deno.test(
  "workOnIssue - a re-approved run that ends superseded is handed to a human once (Issue #1862)",
  async () => {
    const run = await runCycle({ labelAddedAt: AFTER_MERGE });

    // The #218 stop still stands: superseded, not a failure.
    assertEquals(run.result.outcome?.kind, "superseded");

    // Exactly one comment, and it explains the loop.
    assertEquals(run.comments.length, 1);
    const body = run.comments[0]!;
    assertStringIncludes(body, "Re-approved after the PR merged");
    // The PR that resolved the issue, and who re-approved it afterwards.
    assertStringIncludes(body, "PR #116");
    assertStringIncludes(body, "@nleck");
    // The request: say what the re-approval should change.
    assertStringIncludes(body, "Put it in the issue description");
    // The marker a repeat run recognises.
    assertStringIncludes(body, MARKER);

    // `needs-human` is what drops the issue from the next scan, and the main
    // loop's discovery-label strip keys off it.
    assert(
      run.labelsAdded.includes("needs-human"),
      `expected needs-human to be applied, got ${run.labelsAdded.join(", ")}`,
    );

    // The claim release says why the run produced nothing.
    const notes = run.result.outcome?.notes ?? [];
    assert(
      notes.some((note) => note.includes("nothing left to change")),
      `expected a hand-off note on the outcome, got ${JSON.stringify(notes)}`,
    );
  },
);

Deno.test(
  "workOnIssue - a repeat run posts no second comment (Issue #1862)",
  async () => {
    const first = await runCycle({ labelAddedAt: AFTER_MERGE });
    assertEquals(first.comments.length, 1);

    // The next cycle sees the comment the first run left. Created now, so the
    // 24-hour dedup window is measured against the run's own clock rather
    // than a fixed date that would age out of it.
    const second = await runCycle({
      labelAddedAt: AFTER_MERGE,
      priorComments: [{
        body: first.comments[0]!,
        author: WORKER,
        createdAt: new Date().toISOString(),
      }],
    });

    assertEquals(second.comments.length, 0);
    // The label add stays idempotent, so a stripped label is re-applied.
    assert(second.labelsAdded.includes("needs-human"));
  },
);

Deno.test(
  "workOnIssue - an approval that pre-dates the merge closes as before, with no hand-off (Issue #1862)",
  async () => {
    const run = await runCycle({ labelAddedAt: BEFORE_MERGE });

    // No re-approval, so the pre-check takes its ordinary close path and the
    // hand-off never fires — the loop this issue fixes is the re-approved one.
    assertEquals(run.comments.filter((c) => c.includes(MARKER)).length, 0);
    assertEquals(run.labelsAdded.includes("needs-human"), false);
  },
);
