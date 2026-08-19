/**
 * Tests for the snapshot-persist failure path and the cycle that follows it
 * (Issue #3876, findings SEC-cc0eb4f8fad8 / SEC-4e8ec47d76cd).
 *
 * The two defects compounded: a capture whose write failed was silent, and the
 * next cycle then read `no_snapshot` at pickup, which returned `proceed`. So a
 * quietly failed write became a quietly passed verification on the very check
 * that exists to catch content edited between approval and prompt build.
 *
 * These tests drive the real gate with a write layer that always fails, assert
 * the `[SECURITY] [CONTENT_SNAPSHOT_PERSIST_FAILED]` marker reaches the log and
 * the failure is surfaced to the caller, then run the next cycle's pickup-time
 * verification against the store the failed write left behind.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import type { ContentApprovalDeps } from "../lib/content_approval_tracker.ts";
import { verifyWorkOnContentIntegrity } from "../lib/work_on_content_integrity.ts";
import { verifyPickupContentIntegrity } from "../lib/pickup_content_integrity.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";
import type { IssueFinderDiagnostics } from "../lib/issue_finder_logger.ts";

const WORK_DIR = "/tmp/work-integrity-persist-failure-test";

/** Read layer with no state yet; every write fails, as a full disk would. */
function createFailingWriteFs(): ContentApprovalDeps {
  return {
    readFile: () => Promise.reject(new Deno.errors.NotFound("no state yet")),
    writeFile: () => Promise.reject(new Error("disk full")),
    removeFile: () => Promise.resolve(),
  };
}

function makeConfig(): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: ["owner/repo"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    workDir: WORK_DIR,
  };
}

function makeIssue(): FilterableIssue {
  return {
    number: 7,
    title: "Fix the bug",
    url: "https://github.com/owner/repo/issues/7",
    assignees: [],
    labels: ["work-on"],
    createdAt: "2026-08-01T00:00:00Z",
    author: "mallory",
    milestone: "",
  };
}

/** `gh issue view --json title,body` serves the approved content. */
function makeGh(
  state: { title: string; body: string },
  actions: string[] = [],
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const command = args.join(" ");
    if (command.includes("issue view") && command.includes("title,body")) {
      return Promise.resolve(JSON.stringify(state));
    }
    if (command.includes("--remove-label")) {
      actions.push("remove-label");
      return Promise.resolve("");
    }
    if (command.includes("api") && command.includes("POST")) {
      actions.push("gh-write");
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };
}

/** Capture `console.error` output for the duration of `run`. */
async function captureErrors(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await run();
  } finally {
    console.error = original;
  }
  return lines;
}

/** Diagnostics stub recording only the skip reasons. */
function makeDiag(reasons: string[]): IssueFinderDiagnostics {
  return {
    logIssueSkipped: (_repo: string, _n: number, reason: string) => {
      reasons.push(reason);
    },
  } as unknown as IssueFinderDiagnostics;
}

// ---------------------------------------------------------------------------
// Scan time — a failed persist must be loud and must block
// ---------------------------------------------------------------------------

Deno.test(
  "work_on_content_integrity - a failed snapshot persist logs the marker and blocks",
  async () => {
    const config = makeConfig();
    const reasons: string[] = [];
    const actions: string[] = [];
    let verdict: "proceed" | "blocked" | undefined;

    const errors = await captureErrors(async () => {
      verdict = await verifyWorkOnContentIntegrity(
        "owner/repo",
        makeIssue(),
        config,
        makeGh(
          { title: "Fix the bug", body: "Approved specification" },
          actions,
        ),
        makeDiag(reasons),
        createFailingWriteFs(),
      );
    });

    assertEquals(
      verdict,
      "blocked",
      "A baseline that was never written must not report proceed",
    );
    assertEquals(reasons[0], "content-snapshot-persist-failed");
    assert(
      errors.some((line) =>
        line.includes("[SECURITY] [CONTENT_SNAPSHOT_PERSIST_FAILED]")
      ),
      `Expected the persist-failure marker, got: ${errors.join(" | ")}`,
    );
    assert(
      errors.some((line) => line.includes("disk full")),
      "The underlying write failure must be named in the log",
    );
    assertEquals(
      actions.length,
      0,
      "A storage fault must not strip a label or escalate",
    );
  },
);

// ---------------------------------------------------------------------------
// Next cycle — the pickup check must not silently pass on the missing baseline
// ---------------------------------------------------------------------------

Deno.test(
  "pickup_content_integrity - the cycle after a failed persist blocks, not proceeds (Issue #3876)",
  async () => {
    const config = makeConfig();
    const contentDeps = createFailingWriteFs();
    const state = { title: "Fix the bug", body: "Approved specification" };
    const actions: string[] = [];
    const gh = makeGh(state, actions);

    // Cycle 1: the scan-time capture fails to persist and blocks.
    const scan = await captureErrors(async () => {
      await verifyWorkOnContentIntegrity(
        "owner/repo",
        makeIssue(),
        config,
        gh,
        undefined,
        contentDeps,
      );
    });
    assert(
      scan.some((line) => line.includes("CONTENT_SNAPSHOT_PERSIST_FAILED")),
      "Cycle 1 must report the failed persist",
    );

    // Cycle 2: pickup reads the store the failed write left behind. Nothing
    // was ever approved for this content, so it must not reach the prompt.
    let outcome: { blocked: boolean; reason?: string } | undefined;
    const errors = await captureErrors(async () => {
      outcome = await verifyPickupContentIntegrity({
        repo: "owner/repo",
        issueNumber: 7,
        issueTitle: state.title,
        issueBody: state.body,
        issueLabels: ["work-on"],
        issueAuthor: "mallory",
        config,
      }, { ghFn: gh, contentDeps });
    });

    assertEquals(outcome?.blocked, true);
    assertEquals(outcome?.reason, "no-approval-snapshot");
    assert(
      errors.some((line) => line.includes("[SECURITY] [NO_CONTENT_SNAPSHOT]")),
      `Expected the missing-baseline marker, got: ${errors.join(" | ")}`,
    );
    assert(
      errors.some((line) => line.includes("BLOCKED")),
      "The missing-baseline warning must be followed by a block entry",
    );
    assertEquals(
      actions.length,
      0,
      "A missing baseline must not strip a label or escalate",
    );
  },
);
