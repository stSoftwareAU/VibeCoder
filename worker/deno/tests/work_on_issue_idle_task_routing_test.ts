/**
 * End-to-end regression tests for idle-task wrapper routing through
 * `runWorkOnIssueCommand` (Issue #2093).
 *
 * Production log capture in #2089 showed wrappers reaching the standard
 * issue pipeline despite carrying `idle-task` label and a matching
 * title. The dispatch logic in `idle_task_claim_handler.ts` should have
 * caught them via any of three signals:
 *   1. `idle-task` label present (original signal).
 *   2. Title matches a registered template's `buildIssueTitle(repo)`
 *      (Issue #2083 — label-strip race).
 *   3. Body matches a registered template's `matchesIdleTaskBody(body)`
 *      (Issue #2087 — stale-worker / renamed-issue race).
 *
 * The `idle_task_guard` phase in `issue_worker.ts` is the final
 * defence-in-depth net — it should never fire in production when the
 * claim handler is wired correctly.
 *
 * These tests exercise the full integration path
 * (`runWorkOnIssueCommand` → real `handleIdleTaskIssue` → stub template)
 * with a stub template injected via `listTemplatesFn`. The stub records
 * its `runTask` invocations so the tests can assert routing happened
 * without driving a real security scanner.
 *
 * Audit finding (recorded in the PR summary): no production bug — the
 * dispatch logic in `idle_task_claim_handler.ts:124-222` already
 * routes ANY of the three signals to the template runner. These tests
 * lock that wiring in.
 *
 * Australian English spelling used throughout.
 */

import { assertEquals } from "@std/assert";
import {
  runWorkOnIssueCommand,
  type WorkOnIssueCommandDeps,
} from "../commands/work_on_issue.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import {
  handleIdleTaskIssue,
  type HandleIdleTaskIssueDeps,
  type HandleIdleTaskIssueOptions,
} from "../lib/idle_task_claim_handler.ts";
import { IDLE_TASK_LABEL } from "../lib/idle_task_issue.ts";
import type {
  IdleTaskRunOptions,
  IdleTaskRunResult,
  IdleTaskTemplate,
} from "../lib/idle_task_template.ts";
import { validateIssueInput } from "../lib/security.ts";
import type { WorkerConfig } from "../types.ts";
import type { IssueData } from "../lib/issue_data.ts";
import type { WorkOnIssueResult } from "../lib/issue_worker.ts";

// ---------------------------------------------------------------------------
// Test scaffolding — stub template + production-shaped wiring
// ---------------------------------------------------------------------------

/** Title the security-scan template files (Issue #2077). */
const SECURITY_SCAN_TITLE = "Run a security scan";

/** Body fingerprint the security-scan template recognises (Issue #2087). */
const SECURITY_SCAN_BODY_FINGERPRINT = "MythOS-style Security Audit";

interface StubTemplate {
  template: IdleTaskTemplate;
  /** Number of times runTask was invoked. */
  runTaskCallCount: number;
  /** Captured runTask call arguments — useful for stronger assertions. */
  captures: IdleTaskRunOptions[];
}

/**
 * Build a stub template that matches the security-scan signals (title +
 * body fingerprint) but records invocations instead of running a real
 * scanner.
 */
function makeStubTemplate(): StubTemplate {
  const stub: StubTemplate = {
    template: {
      name: "security-scan",
      description: "stub security-scan template for routing tests",
      buildIssueTitle: (_repo: string) => SECURITY_SCAN_TITLE,
      buildIssueBody: (opts) =>
        `# ${SECURITY_SCAN_BODY_FINGERPRINT}\nRepo: ${opts.repo}`,
      matchesIdleTaskBody: (body: string) =>
        body.includes(SECURITY_SCAN_BODY_FINGERPRINT),
      runTask: (opts: IdleTaskRunOptions): Promise<IdleTaskRunResult> => {
        stub.runTaskCallCount += 1;
        stub.captures.push(opts);
        return Promise.resolve({
          ok: true,
          summary: "stub security-scan complete — filed 0",
        });
      },
    },
    runTaskCallCount: 0,
    captures: [],
  };
  return stub;
}

interface Harness {
  config: WorkerConfig;
  parsedArgs: {
    repo: string;
    issueNumber: number;
    issueTitle: string;
    githubUser: string;
  };
  deps: WorkOnIssueCommandDeps;
  stub: StubTemplate;
  /** Tracks how many times the real workOnIssue orchestrator was called. */
  runOrchestratorCallCount: { value: number };
  /** Captures gh commands the command runs (issue close on idle-task route). */
  ghCalls: string[][];
}

/**
 * Build production-shaped wiring: the real `handleIdleTaskIssue` (not a
 * stub) with the stub template injected via `listTemplatesFn`. This is
 * the integration path the issue specifies — exercising the dispatch
 * logic the production worker uses.
 */
function buildHarness(opts: {
  issueTitle: string;
  issueLabels: string[];
  issueBody: string;
}): Harness {
  const stub = makeStubTemplate();
  const runOrchestratorCallCount = { value: 0 };
  const ghCalls: string[][] = [];

  const config = {
    ...(buildDefaultWorkerConfig()),
    workDir: "/tmp/work",
  };

  const parsedArgs = {
    repo: "org/repo",
    issueNumber: 7,
    issueTitle: opts.issueTitle,
    githubUser: "testbot",
  };

  const fakeIssueData: IssueData = {
    title: opts.issueTitle,
    body: opts.issueBody,
    labels: opts.issueLabels,
    comments: [],
    state: "OPEN",
    milestoneTitle: "",
  };

  const handleIdleTaskWithStub = (
    handlerOpts: HandleIdleTaskIssueOptions,
    handlerDeps: { logger: HandleIdleTaskIssueDeps["logger"] },
  ) =>
    handleIdleTaskIssue(handlerOpts, {
      logger: handlerDeps.logger,
      listTemplatesFn: () => [stub.template],
    });

  const failedResult: WorkOnIssueResult = {
    success: false,
    phase: "execute",
    reason: "orchestrator should not have been called for idle-task wrapper",
    timings: {},
  };

  const deps: WorkOnIssueCommandDeps = {
    fetchIssueData: () => Promise.resolve(fakeIssueData),
    validateIssueInput,
    createDeps: () => createMockDeps(),
    runOrchestrator: () => {
      runOrchestratorCallCount.value += 1;
      return Promise.resolve(failedResult);
    },
    handleIdleTask: handleIdleTaskWithStub,
    ghCommandFn: (args: string[]) => {
      ghCalls.push(args);
      return Promise.resolve("");
    },
    // Issue #3876: pickup-time verification blocks without an approval
    // baseline, which these routing tests have no reason to establish. The
    // gate is covered by `pickup_content_integrity_test.ts`.
    verifyContentIntegrity: () => Promise.resolve({ blocked: false as const }),
  };

  return {
    config,
    parsedArgs,
    deps,
    stub,
    runOrchestratorCallCount,
    ghCalls,
  };
}

/** Shared assertions for tests A–D (any wrapper signal routes correctly). */
function assertRoutedAsIdleTask(harness: Harness): void {
  assertEquals(harness.stub.runTaskCallCount, 1);
  assertEquals(harness.runOrchestratorCallCount.value, 0);
  // The issue was closed with the template summary as the comment.
  assertEquals(harness.ghCalls.length, 1);
  const closeArgs = harness.ghCalls[0]!;
  assertEquals(closeArgs[0], "issue");
  assertEquals(closeArgs[1], "close");
  assertEquals(closeArgs[2], "7");
  // The captured runTask call carried the right repo + workDir.
  const capture = harness.stub.captures[0]!;
  assertEquals(capture.repo, "org/repo");
  assertEquals(capture.workDir, "/tmp/work");
  assertEquals(capture.idleTaskIssueNumber, 7);
}

// ---------------------------------------------------------------------------
// Tests — A through D assert routing; E asserts pass-through
// ---------------------------------------------------------------------------

Deno.test(
  "runWorkOnIssueCommand - Test A: wrapper with idle-task label AND matching title routes to template",
  async () => {
    const harness = buildHarness({
      issueTitle: SECURITY_SCAN_TITLE,
      issueLabels: [IDLE_TASK_LABEL],
      issueBody: "irrelevant body",
    });
    const result = await runWorkOnIssueCommand(
      harness.parsedArgs,
      harness.config,
      harness.deps,
    );

    assertRoutedAsIdleTask(harness);
    assertEquals(result.success, true);
    assertEquals(result.data?.phase, "idle_task");
  },
);

Deno.test(
  "runWorkOnIssueCommand - Test B: wrapper with title only (label stripped) still routes to template (Issue #2083)",
  async () => {
    const harness = buildHarness({
      issueTitle: SECURITY_SCAN_TITLE,
      // No `idle-task` label — simulates the label-strip race.
      issueLabels: ["failed-once"],
      issueBody: "irrelevant body",
    });
    const result = await runWorkOnIssueCommand(
      harness.parsedArgs,
      harness.config,
      harness.deps,
    );

    assertRoutedAsIdleTask(harness);
    assertEquals(result.success, true);
    assertEquals(result.data?.phase, "idle_task");
  },
);

Deno.test(
  "runWorkOnIssueCommand - Test C: wrapper with body fingerprint only routes to template (Issue #2087)",
  async () => {
    const harness = buildHarness({
      // Both label AND title miss — only the body fingerprint identifies
      // this as a wrapper. Simulates the stale-worker / renamed-issue
      // race captured in VibeCoder#2086.
      issueTitle: "Investigate dependency bloat",
      issueLabels: ["bug"],
      issueBody:
        `# ${SECURITY_SCAN_BODY_FINGERPRINT} — Four-Phase Scan (v2)\n\n` +
        "You are a security auditor performing a static, evidence-backed " +
        "audit of `org/repo`...",
    });
    const result = await runWorkOnIssueCommand(
      harness.parsedArgs,
      harness.config,
      harness.deps,
    );

    assertRoutedAsIdleTask(harness);
    assertEquals(result.success, true);
    assertEquals(result.data?.phase, "idle_task");
  },
);

Deno.test(
  "runWorkOnIssueCommand - Test D: wrapper with all three signals routes to template",
  async () => {
    const harness = buildHarness({
      issueTitle: SECURITY_SCAN_TITLE,
      issueLabels: [IDLE_TASK_LABEL, "enhancement"],
      issueBody: `# ${SECURITY_SCAN_BODY_FINGERPRINT} — Four-Phase Scan (v2)`,
    });
    const result = await runWorkOnIssueCommand(
      harness.parsedArgs,
      harness.config,
      harness.deps,
    );

    assertRoutedAsIdleTask(harness);
    assertEquals(result.success, true);
    assertEquals(result.data?.phase, "idle_task");
  },
);

Deno.test(
  "runWorkOnIssueCommand - Test E (negative control): ordinary issue with no idle-task signals falls through to orchestrator",
  async () => {
    const harness = buildHarness({
      issueTitle: "Fix the date parser",
      issueLabels: ["bug"],
      issueBody: "The parser drops timezone information for ISO-8601 inputs.",
    });
    // Swap the orchestrator stub for one that returns success — this
    // path should reach the standard pipeline.
    const successResult: WorkOnIssueResult = {
      success: true,
      phase: "completion",
      reason: "Issue processed successfully",
      timings: {},
    };
    harness.deps.runOrchestrator = () => {
      harness.runOrchestratorCallCount.value += 1;
      return Promise.resolve(successResult);
    };

    const result = await runWorkOnIssueCommand(
      harness.parsedArgs,
      harness.config,
      harness.deps,
    );

    // Routing happened: handler returned `handled: false`, orchestrator
    // ran exactly once, and no idle-task issue close was attempted.
    assertEquals(harness.stub.runTaskCallCount, 0);
    assertEquals(harness.runOrchestratorCallCount.value, 1);
    assertEquals(harness.ghCalls.length, 0);
    assertEquals(result.success, true);
    assertEquals(result.data?.phase, "completion");
  },
);

Deno.test(
  "runWorkOnIssueCommand - Test F: idle-task label only (non-wrapper title/body) is worked as ordinary lowest-priority work",
  async () => {
    // `idle-task` is just the lowest of the four work-trigger
    // priorities, NOT a scan-only marker. A finding labelled `idle-task`
    // whose title and body match no template is ordinary work: the claim
    // handler passes through, the `idle_task_guard` does NOT fire (it
    // keys on title/body wrapper signals, not the bare label), and the
    // standard orchestrator runs it to raise a fix PR.
    const harness = buildHarness({
      issueTitle: "dead-code: unused export `foo` in src/bar.ts",
      issueLabels: [IDLE_TASK_LABEL],
      issueBody: "Remove the unused export `foo`.",
    });
    const successResult: WorkOnIssueResult = {
      success: true,
      phase: "completion",
      reason: "Issue processed successfully",
      timings: {},
    };
    harness.deps.runOrchestrator = () => {
      harness.runOrchestratorCallCount.value += 1;
      return Promise.resolve(successResult);
    };

    const result = await runWorkOnIssueCommand(
      harness.parsedArgs,
      harness.config,
      harness.deps,
    );

    // Not routed to a template, not closed — worked through the standard
    // pipeline like any other issue.
    assertEquals(harness.stub.runTaskCallCount, 0);
    assertEquals(harness.runOrchestratorCallCount.value, 1);
    assertEquals(harness.ghCalls.length, 0);
    assertEquals(result.success, true);
    assertEquals(result.data?.phase, "completion");
  },
);
