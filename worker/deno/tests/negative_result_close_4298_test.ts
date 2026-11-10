/**
 * A negative-result issue is handed to a human (Issue #4298, revised by Issue
 * #4911). A performance task whose benchmarks show no gain ends with a results
 * comment and the `negative-result` label, and no code change. The worker no
 * longer closes it on the agent's word: it posts a `needs-human` escalation
 * through the shared helper and leaves the issue open, out of the queue.
 * Both directions: labelled, it is handed off; unlabelled, the ordinary
 * no-change retry is untouched.
 *
 * The phase passes its own `deps.github.ensureLabelExists` into the hand-off,
 * so the phase-level cases run the labelled path through injected deps too:
 * no case reaches a real `gh`. The direct cases drive
 * `handOffNegativeResultIssue` with injected deps.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueHandleNoChanges } from "../lib/phases/handle_no_changes_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { GitHubClient, GitHubComment, GitHubIssue } from "../types.ts";
import { findImageReferences } from "../lib/untrusted_image_signal.ts";
import {
  buildNegativeResultHandoff,
  handOffNegativeResultIssue,
} from "../lib/negative_result_close.ts";
import type { EscalateToHumanDeps } from "../lib/needs_human_escalation.ts";

const BENCHMARK_OUTPUT =
  "Benchmarked the parser before and after the buffer change: 412 ms and " +
  "409 ms over ten runs, inside the noise. Posted the results and added the " +
  "negative-result label.";

/** A fixed clock, so the dedup window is deterministic. */
const NOW_MS = Date.parse("2026-11-10T12:00:00Z");

/** Everything the mock client records, in call order where it matters. */
interface Recorder {
  /** Ordered log of the side effects that matter to the hand-off. */
  events: string[];
  comments: string[];
  labelsAdded: string[];
  closed: string[];
  /** The repo each write was addressed to. */
  repos: string[];
}

function makeRecorder(): Recorder {
  return { events: [], comments: [], labelsAdded: [], closed: [], repos: [] };
}

interface ClientOptions {
  /** Comments `getIssueComments` returns — the dedup scan reads these. */
  existingComments?: GitHubComment[];
  /** Make `postComment` reject, as a failed GitHub write would. */
  postRejects?: boolean;
  /** Make `addLabel` reject, as a failed label write would. */
  addLabelRejects?: boolean;
}

function makeClient(
  rec: Recorder,
  labels: string[],
  opts: ClientOptions = {},
): GitHubClient {
  return {
    getIssue: () => Promise.resolve({ labels } as unknown as GitHubIssue),
    getIssueComments: () => Promise.resolve(opts.existingComments ?? []),
    addLabel: (r, _n, label) => {
      if (opts.addLabelRejects) {
        return Promise.reject(new Error("GitHub returned 422"));
      }
      rec.repos.push(`label:${r}`);
      rec.events.push(`label:${label}`);
      rec.labelsAdded.push(label);
      return Promise.resolve();
    },
    removeLabel: () => Promise.resolve(),
    postComment: (r, _n, body) => {
      if (opts.postRejects) {
        return Promise.reject(new Error("GitHub returned 502"));
      }
      rec.repos.push(`comment:${r}`);
      rec.events.push("comment");
      rec.comments.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: (_r, _n, users) => {
      rec.events.push(`unassign:${users.join(",")}`);
      return Promise.resolve();
    },
    closeIssue: (_r, _n, comment) => {
      rec.events.push("close");
      rec.closed.push(comment ?? "");
      return Promise.resolve();
    },
  } as GitHubClient;
}

/** Deps for the direct hand-off: a stubbed label ensure and a fixed clock. */
function directDeps(rec: Recorder): EscalateToHumanDeps {
  return {
    github: {
      ensureLabelExists: () => {
        rec.events.push("ensure");
        return Promise.resolve({ ok: true, value: undefined });
      },
    },
    now: () => NOW_MS,
  };
}

/** A comment as the fleet would read it back: its own author, created now. */
function priorComment(body: string): GitHubComment {
  return {
    id: 1,
    body,
    author: "testbot",
    createdAt: new Date(NOW_MS).toISOString(),
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  } as unknown as GitHubComment;
}

/** The hand-off comments in a recording (the retry's own comment is not one). */
function handOffComments(rec: Recorder): string[] {
  return rec.comments.filter((body) =>
    body.includes("Negative result needs review")
  );
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

Deno.test("#4911 - a labelled negative result is handed to a human, comment first, never closed", async () => {
  const rec = makeRecorder();
  const handedOff = await handOffNegativeResultIssue({
    ghClient: makeClient(rec, ["work-on", "performance", "negative-result"]),
    repo: "org/repo",
    issueNumber: 77,
    githubUser: "testbot",
    needsHumanLabel: "needs-human",
    logger: createMockDeps().logger,
    deps: directDeps(rec),
  });

  assertEquals(handedOff, true);
  assertEquals(rec.comments.length, 1, "one hand-off comment is posted");
  assertStringIncludes(rec.comments[0]!, "## Negative result needs review");
  assertStringIncludes(
    rec.comments[0]!,
    "<!-- needs-human-escalation: negative-result-handoff:77 -->",
  );
  assertEquals(
    rec.labelsAdded,
    ["needs-human"],
    "the escalation label is added",
  );
  assertEquals(rec.closed, [], "the worker never closes the issue");
  assertEquals(
    rec.repos,
    ["comment:org/repo", "label:org/repo"],
    "the comment and the label are addressed to the issue's repo",
  );
  const handoff = buildNegativeResultHandoff();
  assertStringIncludes(rec.comments[0]!, `**Why:** ${handoff.reason}`);
  assertStringIncludes(rec.comments[0]!, `**Next step:** ${handoff.nextStep}`);
  assertEquals(
    rec.events,
    ["comment", "ensure", "label:needs-human", "unassign:testbot"],
    "the label lands only after the comment, and the worker unassigns itself",
  );
});

Deno.test("#4911 - a second hand-off finds its own earlier comment and posts nothing new", async () => {
  const labels = ["work-on", "performance", "negative-result"];
  const first = makeRecorder();
  await handOffNegativeResultIssue({
    ghClient: makeClient(first, labels),
    repo: "org/repo",
    issueNumber: 77,
    githubUser: "testbot",
    needsHumanLabel: "needs-human",
    logger: createMockDeps().logger,
    deps: directDeps(first),
  });
  const earlier = first.comments[0]!;

  const second = makeRecorder();
  const handedOff = await handOffNegativeResultIssue({
    ghClient: makeClient(second, labels, {
      existingComments: [priorComment(earlier)],
    }),
    repo: "org/repo",
    issueNumber: 77,
    githubUser: "testbot",
    needsHumanLabel: "needs-human",
    logger: createMockDeps().logger,
    deps: directDeps(second),
  });

  assertEquals(handedOff, true, "the earlier hand-off still counts as success");
  assertEquals(second.comments, [], "no second comment is posted");
  assertEquals(
    second.labelsAdded,
    ["needs-human"],
    "the label is re-applied idempotently",
  );
  assertEquals(second.closed, [], "the issue is still never closed");
});

Deno.test("#4911 - a rejected label add leaves the hand-off unconfirmed and never closes", async () => {
  // The comment lands first, then the label add rejects. escalateToHuman warns
  // and returns ok with labelAdded false, so the hand-off is not confirmed: the
  // worker does not unassign, returns false for the ordinary retry, and never
  // closes the issue.
  const rec = makeRecorder();
  const handedOff = await handOffNegativeResultIssue({
    ghClient: makeClient(rec, ["work-on", "performance", "negative-result"], {
      addLabelRejects: true,
    }),
    repo: "org/repo",
    issueNumber: 77,
    githubUser: "testbot",
    needsHumanLabel: "needs-human",
    logger: createMockDeps().logger,
    deps: directDeps(rec),
  });

  assertEquals(
    handedOff,
    false,
    "an unconfirmed hand-off is not reported as handed off",
  );
  assertEquals(rec.comments.length, 1, "the explanation comment is posted");
  assertStringIncludes(rec.comments[0]!, "## Negative result needs review");
  assertEquals(rec.labelsAdded, [], "no label is recorded");
  assert(
    !rec.events.includes("unassign:testbot"),
    "the worker does not unassign",
  );
  assertEquals(rec.closed, [], "closeIssue is never called");
});

Deno.test("#4911 - a labelled run through the phase is handed to needs-human, comment first, never closed", async () => {
  // The phase injects its own ensureLabelExists into the hand-off, so the
  // recorded ensure call proves the wiring and no real `gh` runs.
  const rec = makeRecorder();
  const ensured: string[] = [];
  const deps = createMockDeps({
    github: {
      createClient: () =>
        makeClient(rec, ["work-on", "performance", "negative-result"]),
      ensureLabelExists: (_r, label) => {
        ensured.push(label);
        return Promise.resolve({ ok: true, value: undefined });
      },
    },
  });

  const result = await workOnIssueHandleNoChanges(
    makeContext(),
    makeState(),
    deps,
  );

  assertEquals(result.status, "early_exit");
  assertEquals(
    result.status === "early_exit" && result.reason,
    "negative_result_handed_off",
  );
  assertEquals(
    handOffComments(rec).length,
    1,
    "one hand-off comment is posted",
  );
  assertEquals(
    ensured,
    ["needs-human"],
    "the label is ensured through the phase's deps",
  );
  assertEquals(
    rec.labelsAdded,
    ["needs-human"],
    "the default needs-human label is added",
  );
  assertEquals(rec.closed, [], "closeIssue is never called");
});

Deno.test("#4911 - the phase hands off to the configured needsHumanLabel, not a literal", async () => {
  // "escalated" is an allowlisted, non-default label, so the worker may apply
  // it. A literal "needs-human" in the phase would add the wrong label here.
  const rec = makeRecorder();
  const ensured: string[] = [];
  const deps = createMockDeps({
    github: {
      createClient: () =>
        makeClient(rec, ["work-on", "performance", "negative-result"]),
      ensureLabelExists: (_r, label) => {
        ensured.push(label);
        return Promise.resolve({ ok: true, value: undefined });
      },
    },
  });

  const result = await workOnIssueHandleNoChanges(
    makeContext({
      config: buildDefaultWorkerConfig({ needsHumanLabel: "escalated" }),
    }),
    makeState(),
    deps,
  );

  assertEquals(result.status, "early_exit");
  assertEquals(
    result.status === "early_exit" && result.reason,
    "negative_result_handed_off",
  );
  assertEquals(ensured, ["escalated"], "the configured label is ensured");
  assertEquals(rec.labelsAdded, ["escalated"], "the configured label is added");
  assertEquals(rec.closed, [], "closeIssue is never called");
});

Deno.test("#4911 - without the label the no-change run is not handed off", async () => {
  const rec = makeRecorder();
  const deps = createMockDeps({
    github: {
      createClient: () => makeClient(rec, ["work-on", "performance"]),
    },
  });

  const result = await workOnIssueHandleNoChanges(
    makeContext(),
    makeState(),
    deps,
  );

  assertEquals(result.status, "failure");
  assertEquals(handOffComments(rec), [], "no hand-off comment is posted");
  assert(!rec.labelsAdded.includes("needs-human"), "nobody is paged");
  assertEquals(rec.closed, [], "an unfinished issue is not closed");
});

Deno.test("#4911 - an untrusted image keeps a negative result out of the hand-off (Issue #1385)", async () => {
  // The label is the agent's own record, and an image can steer the agent to
  // apply it. Like the already-resolved close, nothing the run said may hand
  // the issue off when an untrusted author's image sat in front of it.
  const rec = makeRecorder();
  const deps = createMockDeps({
    github: {
      createClient: () =>
        makeClient(rec, ["work-on", "performance", "negative-result"]),
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

  assertEquals(result.status, "failure");
  assertEquals(handOffComments(rec), [], "no hand-off comment is posted");
  assert(!rec.labelsAdded.includes("needs-human"), "no label is added");
  assertEquals(rec.closed, [], "must NOT close on the run's own record");
});

Deno.test("#4911 - a failed hand-off falls through to the ordinary retry and never closes", async () => {
  // The comment post rejects, so the hand-off has nothing on the issue and no
  // label is attempted. The run must retry, not close.
  const rec = makeRecorder();
  const deps = createMockDeps({
    github: {
      createClient: () =>
        makeClient(rec, ["work-on", "performance", "negative-result"], {
          postRejects: true,
        }),
    },
  });

  const result = await workOnIssueHandleNoChanges(
    makeContext(),
    makeState(),
    deps,
  );

  assertEquals(result.status, "failure", "the ordinary retry takes over");
  assertEquals(handOffComments(rec), [], "no hand-off comment landed");
  assert(!rec.labelsAdded.includes("needs-human"), "no label was added");
  assertEquals(rec.closed, [], "closeIssue is never called");
});

Deno.test("#4911 - a failed direct hand-off warns with the repo, issue and error and returns false", async () => {
  const rec = makeRecorder();
  const warnings: Array<
    { message: string; context?: Record<string, unknown> }
  > = [];
  const logger = createMockDeps({
    logger: {
      warn: (message, context) => {
        warnings.push({ message, context });
      },
    },
  }).logger;

  const handedOff = await handOffNegativeResultIssue({
    ghClient: makeClient(rec, ["work-on", "performance", "negative-result"], {
      postRejects: true,
    }),
    repo: "org/repo",
    issueNumber: 77,
    githubUser: "testbot",
    needsHumanLabel: "needs-human",
    logger,
    deps: directDeps(rec),
  });

  assertEquals(handedOff, false);
  const failure = warnings.find((w) =>
    w.message === "Failed to hand the negative-result issue to a human"
  );
  assert(failure, "the failed hand-off is logged");
  assertEquals(failure.context?.repo, "org/repo");
  assertEquals(failure.context?.issueNumber, 77);
  assert(
    typeof failure.context?.error === "string" &&
      failure.context.error.length > 0,
    "the warning carries the failure's message",
  );
  assertEquals(rec.closed, [], "closeIssue is never called");
});
