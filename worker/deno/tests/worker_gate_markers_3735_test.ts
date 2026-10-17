/**
 * Issue #3735: one registry, `WORKER_GATE_MARKERS`, decides the category of a
 * worker gate refusal, and every classifier reads it first. Each registered
 * gate is exercised against hostile quotations of tool, agent and issue text.
 * The tests iterate the registry, so a new gate is covered by construction.
 *
 * Uses Australian English spelling (behaviour, recognised, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { classifyCodingFailure } from "../lib/coding_failure_ladder.ts";
import {
  DEADLINE_BOUND_TIMEOUT_MARKER,
  detectFailureCategory,
  getFailureCategoryDisplay,
  isWorkerGateCategory,
  isWorkerGateFailureRecord,
  PRE_PUSH_LOOKUP_FAILED_MARKER,
  SCHEDULED_RELEASE_MARKER,
  WORKER_GATE_MARKERS,
  workerGateCategoryOf,
} from "../lib/failure_diagnosis.ts";
import { detectHostFault } from "../lib/host_fault.ts";
import {
  releaseHostFaultFailureLabels,
  resetHostFaultReleaseSweepsForTest,
} from "../lib/host_fault_release.ts";
import {
  markIssueAsFailed,
  markIssueAsFailedOnce,
} from "../lib/label_failure.ts";
import { shouldRetryInfrastructureFailure } from "../lib/infra_retry.ts";
import { refusalIsMostRecentFailure } from "../lib/milestone_branch_refusal_release.ts";
import { classifyRunFailure } from "../lib/run_outcome_classifier.ts";
import type { PhaseState } from "../lib/issue_worker_types.ts";
import type { Logger } from "../types.ts";

const REPO = "stSoftwareAU/GRQ-FX-validation";
const FLEET_AUTHOR = "VibeCoderST";
const FLEET = { fleetAuthors: [FLEET_AUTHOR] };
const ISSUE = 7;

/** Text a rate-limit comment in a diff hunk would carry. */
const RATE_LIMIT_QUOTE = "// back off when the exchange rate limit is hit";
/** Text a test runner prints when a check times out. */
const TIMEOUT_QUOTE = "the check timed out";
/** Text a signal-killed child process leaves behind. */
const SIGKILL_QUOTE = "terminated by SIGKILL";
/** Text a shell prints when a tool is missing. */
const COMMAND_NOT_FOUND_QUOTE = "deno: command not found";
/** Text a full disk writes. */
const ENOSPC_QUOTE = "ENOSPC: no space left on device";
/** A catch-all `Error:` line in quoted output. */
const ERROR_QUOTE = "Error: boom";
/** A quoted `TypeError:` line in agent-written test text. */
const TYPE_ERROR_QUOTE = "TypeError: x";
/** git's own wording for a damaged clone (CLONE_CORRUPT_PATTERNS). */
const BROKEN_REF_QUOTE = "fatal: ignoring broken ref refs/heads/x";
/** A quoted line of the cycle-deadline handover. */
const DEADLINE_QUOTE = `the run timed out ${DEADLINE_BOUND_TIMEOUT_MARKER}`;
/** A quoted scheduled-release marker. */
const SCHEDULED_QUOTE = SCHEDULED_RELEASE_MARKER;
/** The milestone-branch refusal the repository's ruleset returns (Issue #2220). */
const GH013_REFUSAL = [
  "remote: error: GH013: Repository rule violations found for refs/heads/milestone/scan-20260910.",
  "remote: - 5 of 6 required status checks are expected.",
  "! [remote rejected] origin/Develop -> milestone/scan-20260910 (push declined due to repository rule violations)",
].join("\n");

/** Each quotation on its own, as a hostile tool, agent or issue text. */
const HOSTILE_QUOTES: readonly string[] = [
  RATE_LIMIT_QUOTE,
  TIMEOUT_QUOTE,
  SIGKILL_QUOTE,
  COMMAND_NOT_FOUND_QUOTE,
  ENOSPC_QUOTE,
  ERROR_QUOTE,
  TYPE_ERROR_QUOTE,
  BROKEN_REF_QUOTE,
  DEADLINE_QUOTE,
  SCHEDULED_QUOTE,
  GH013_REFUSAL,
];

/** Every quotation at once, so one reason carries all of them. */
const COMBINED_QUOTE = HOSTILE_QUOTES.join("\n");

/** Every case the per-gate tests run: each quotation alone, then combined. */
const QUOTES_UNDER_TEST: readonly string[] = [
  ...HOSTILE_QUOTES,
  COMBINED_QUOTE,
];

const noop = () => {};
const logger: Logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  security: noop,
  skipReason: noop,
  timing: noop,
  scanSummary: noop,
  workerSummary: noop,
};

const state = (): PhaseState => ({
  branchName: "issue-7-test",
  baseBranch: "main",
  defaultBranch: "main",
  repoPath: "/tmp/test-repo",
  clarityStatus: "not_assessed",
  claudeOutput: "",
  executeStartTime: 0,
  baselineQualityPassed: true,
  baselineQualityOutput: "",
});

/**
 * In-memory repository for the host-fault release sweep: one failed-once issue
 * whose comments are `comments`. Removing a label is recorded in `labels`.
 */
function fakeRepo(comments: readonly string[]) {
  const labels = new Set(["failed-once"]);
  const fn = (args: string[]): Promise<string> => {
    if (args[1] === "list") {
      const label = args[args.indexOf("--label") + 1] ?? "";
      const matching = labels.has(label)
        ? [{ number: ISSUE, labels: [...labels].map((name) => ({ name })) }]
        : [];
      return Promise.resolve(JSON.stringify(matching));
    }
    if (args[1] === "view") {
      return Promise.resolve(JSON.stringify({
        comments: comments.map((body) => ({
          body,
          author: { login: FLEET_AUTHOR },
        })),
      }));
    }
    if (args[1] === "edit") {
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--remove-label") labels.delete(args[i + 1] ?? "");
      }
    }
    return Promise.resolve("");
  };
  return { fn, labels };
}

/** Whether the host-fault release sweep releases the label for `body`. */
async function hostFaultSweepReleases(body: string): Promise<boolean> {
  resetHostFaultReleaseSweepsForTest();
  const repo = fakeRepo([body]);
  const outcome = await releaseHostFaultFailureLabels({
    repo: REPO,
    ghCommandFn: repo.fn,
    authorOptions: FLEET,
  });
  return outcome.released.includes(ISSUE);
}

/**
 * The comment bodies the real label writers post for `reason`: the first
 * attempt (`markIssueAsFailedOnce`) and the second (`markIssueAsFailed`).
 */
async function postedBodies(reason: string): Promise<string[]> {
  const bodies: string[] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    if (args[1] === "comment") {
      bodies.push(args[args.indexOf("--body") + 1] ?? "");
    }
    return Promise.resolve("");
  };
  const options = {
    repo: REPO,
    issueNumber: ISSUE,
    githubUser: FLEET_AUTHOR,
    failureMessage: reason,
  };
  await markIssueAsFailedOnce(options, { ghCommandFn });
  await markIssueAsFailed(options, { ghCommandFn });
  return bodies;
}

/** A failure record the worker did not mark: the `unknown` category line. */
function unmarkedRecord(quote: string): string {
  return `## Automated Processing Failed (First Attempt)\n\n` +
    `**Category:** \`unknown\`\n\n### Error Output\n> ${quote}\n`;
}

for (const entry of WORKER_GATE_MARKERS) {
  Deno.test(`worker gate ${entry.category} - hostile quotes cannot change its category, disposition, host-fault or retry verdict (Issue #3735)`, async () => {
    for (const quote of QUOTES_UNDER_TEST) {
      const reason = `${entry.marker}: ${quote}`;
      assertEquals(detectFailureCategory(reason), entry.category, quote);
      assertEquals(
        classifyRunFailure(entry.category, reason).failureClass,
        "agent-outcome",
        quote,
      );
      const decision = classifyCodingFailure(reason);
      assertEquals(decision.disposition, "ladder", quote);
      assertEquals(decision.category, entry.category, quote);
      assertEquals(decision.cooldownKind, "non_transient", quote);
      assertEquals(detectHostFault(reason), null, quote);
      assertEquals(
        await shouldRetryInfrastructureFailure(
          "completion",
          reason,
          state(),
          logger,
          { backoffMs: 0 },
        ),
        false,
        quote,
      );
    }
  });

  Deno.test(`worker gate ${entry.category} - the posted failure record is a worker gate record the label sweeps leave alone (Issue #3735)`, async () => {
    for (const quote of QUOTES_UNDER_TEST) {
      const bodies = await postedBodies(`${entry.marker}: ${quote}`);
      assertEquals(bodies.length, 2, quote);
      for (const body of bodies) {
        assert(isWorkerGateFailureRecord(body), quote);
        assertEquals(refusalIsMostRecentFailure([body]), false, quote);
        assertEquals(await hostFaultSweepReleases(body), false, quote);
      }
    }
  });
}

Deno.test("worker gate markers (Issue #3735) - the quotations are hostile when unmarked, so the marker is what protects them", async () => {
  // The same quotation with no gate marker is read as the failure it names.
  assertEquals(
    classifyCodingFailure(RATE_LIMIT_QUOTE).disposition,
    "transient",
  );
  assertEquals(detectFailureCategory(SIGKILL_QUOTE), "killed");
  assertEquals(detectHostFault(ENOSPC_QUOTE), "disk-full");
  assertEquals(detectHostFault(BROKEN_REF_QUOTE), "clone-corrupt");
  assertEquals(
    await hostFaultSweepReleases(unmarkedRecord(BROKEN_REF_QUOTE)),
    true,
  );
  assertEquals(detectFailureCategory(GH013_REFUSAL), "repo_config");
  assertEquals(
    refusalIsMostRecentFailure([unmarkedRecord(GH013_REFUSAL)]),
    true,
  );
  // And no quotation on its own is a registered gate category.
  for (const quote of HOSTILE_QUOTES) {
    assertEquals(
      isWorkerGateCategory(detectFailureCategory(quote)),
      false,
      quote,
    );
  }
});

Deno.test("workerGateCategoryOf - each registered marker maps to its category and a non-gate message maps to null (Issue #3735)", () => {
  for (const entry of WORKER_GATE_MARKERS) {
    assertEquals(workerGateCategoryOf(`${entry.marker}: x`), entry.category);
    assertEquals(workerGateCategoryOf(entry.marker), entry.category);
    assertEquals(isWorkerGateCategory(entry.category), true);
  }
  assertEquals(workerGateCategoryOf("Claude timed out after 3600s"), null);
});

Deno.test("isWorkerGateCategory - only the registered gate categories are gates (Issue #3735)", () => {
  for (
    const category of [
      "timeout",
      "push_failure",
      "scheduled_release",
      "repo_config",
      "unknown",
    ] as const
  ) {
    assertEquals(isWorkerGateCategory(category), false, category);
  }
});

Deno.test("WORKER_GATE_MARKERS - a marker only contained later in the message is not that gate (Issue #3735)", () => {
  for (const entry of WORKER_GATE_MARKERS) {
    const message = `Claude timed out after 3600s: ${entry.marker}`;
    assertEquals(workerGateCategoryOf(message), null, entry.category);
    assertEquals(detectFailureCategory(message), "timeout", entry.category);
  }
});

Deno.test("WORKER_GATE_MARKERS - the lookup-failed marker is deliberately not registered, as it is infrastructure (Issue #3735)", () => {
  assertEquals(workerGateCategoryOf(PRE_PUSH_LOOKUP_FAILED_MARKER), null);
  assertEquals(
    detectFailureCategory(`${PRE_PUSH_LOOKUP_FAILED_MARKER}: x`),
    "push_failure",
  );
});

Deno.test("WORKER_GATE_MARKERS - markers and categories are distinct, and no marker is a prefix of another (Issue #3735)", () => {
  const markers = WORKER_GATE_MARKERS.map((entry) => entry.marker);
  const categories = WORKER_GATE_MARKERS.map((entry) => entry.category);
  assertEquals(new Set(markers).size, markers.length);
  assertEquals(new Set(categories).size, categories.length);
  for (const a of markers) {
    for (const b of markers) {
      if (a !== b) {
        assertEquals(b.startsWith(a), false, `${a} prefixes ${b}`);
      }
    }
  }
});

Deno.test("isWorkerGateFailureRecord - a non-gate record quoting a gate category line further down is not a gate record (Issue #3735)", () => {
  const body = "## Automated Processing Failed (First Attempt)\n\n" +
    "**Category:** `timeout`\n\n### Error Output\n" +
    "> **Category:** `pre-push-gate`";
  assertEquals(isWorkerGateFailureRecord(body), false);
});

Deno.test("isWorkerGateFailureRecord - a record whose head Category line is timeout is not a gate record (Issue #3735)", () => {
  const body =
    "## Automated Processing Failed (Second Attempt - Permanently Failed)\n\n" +
    "**Category:** `timeout`\n\n### Error Output\n> the check timed out";
  assertEquals(isWorkerGateFailureRecord(body), false);
});

Deno.test("isWorkerGateFailureRecord - a registered gate category in the head line is a gate record (Issue #3735)", () => {
  for (const entry of WORKER_GATE_MARKERS) {
    const body = `## Automated Processing Failed (First Attempt)\n\n` +
      `**Category:** \`${getFailureCategoryDisplay(entry.category)}\``;
    assertEquals(isWorkerGateFailureRecord(body), true, entry.category);
  }
});
