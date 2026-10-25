/**
 * A negative-result issue is closed by the worker (Issue #4298).
 *
 * A performance task whose benchmarks show no gain ends with a results
 * comment and the `negative-result` label, and no code change. The coding
 * guidelines used to leave the close to a human, so the issue sat open — and,
 * as an approved issue with no PR, was retried on every cycle. The worker now
 * closes it. Both directions: labelled, it is closed; unlabelled, the ordinary
 * no-change retry is untouched.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueHandleNoChanges } from "../lib/phases/handle_no_changes_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { GitHubClient, GitHubIssue } from "../types.ts";
import { findImageReferences } from "../lib/untrusted_image_signal.ts";

const BENCHMARK_OUTPUT =
  "Benchmarked the parser before and after the buffer change: 412 ms and " +
  "409 ms over ten runs, inside the noise. Posted the results and added the " +
  "negative-result label.";

interface Calls {
  closed: string[];
  addLabel: string[];
}

function makeClient(calls: Calls, labels: string[]): GitHubClient {
  return {
    getIssue: () => Promise.resolve({ labels } as unknown as GitHubIssue),
    getIssueComments: () => Promise.resolve([]),
    addLabel: (_r, _n, label) => {
      calls.addLabel.push(label);
      return Promise.resolve();
    },
    removeLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: (_r, _n, comment) => {
      calls.closed.push(comment ?? "");
      return Promise.resolve();
    },
  } as GitHubClient;
}

function makeContext(overrides?: Partial<IssueContext>): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 77,
    issueTitle: "Speed up the parser buffer",
    issueBody: "Benchmark the buffer change and keep it only if it helps.",
    issueLabels: ["work-on", "performance"],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
    ...overrides,
  };
}

function makeState(): PhaseState {
  return {
    branchName: "issue-77-parser-buffer",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "assessed_clear",
    claudeOutput: BENCHMARK_OUTPUT,
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

Deno.test("#4298 - a no-change run that recorded a negative result closes the issue", async () => {
  const calls: Calls = { closed: [], addLabel: [] };
  const deps = createMockDeps({
    github: {
      createClient: () =>
        makeClient(calls, ["work-on", "performance", "negative-result"]),
    },
  });

  const result = await workOnIssueHandleNoChanges(
    makeContext(),
    makeState(),
    deps,
  );

  assertEquals(result.status, "early_exit");
  assertEquals(calls.closed.length, 1, "the worker closes it");
  assertStringIncludes(calls.closed[0]!, "negative-result");
  assert(!calls.addLabel.includes("needs-human"), "nobody is paged");
});

Deno.test("#4298 - without the label the no-change run is still retried", async () => {
  const calls: Calls = { closed: [], addLabel: [] };
  const deps = createMockDeps({
    github: {
      createClient: () => makeClient(calls, ["work-on", "performance"]),
    },
  });

  const result = await workOnIssueHandleNoChanges(
    makeContext(),
    makeState(),
    deps,
  );

  assertEquals(result.status, "failure");
  assertEquals(calls.closed, [], "an unfinished issue stays open");
});

Deno.test("#4298 - an untrusted image keeps a negative-result issue open (Issue #1385)", async () => {
  // The label is the agent's own record, and an image can steer the agent to
  // apply it. Like the already-resolved close, nothing the run said may close
  // the issue when an untrusted author's image sat in front of it.
  const calls: Calls = { closed: [], addLabel: [] };
  const deps = createMockDeps({
    github: {
      createClient: () =>
        makeClient(calls, ["work-on", "performance", "negative-result"]),
    },
  });
  const body = "Benchmark it. ![chart](https://evil.test/c.png)";

  const result = await workOnIssueHandleNoChanges(
    makeContext({
      issueBody: body,
      untrustedImages: findImageReferences(body),
    }),
    makeState(),
    deps,
  );

  assertEquals(calls.closed, [], "must NOT close on the run's own record");
  assertEquals(result.status, "failure");
});
