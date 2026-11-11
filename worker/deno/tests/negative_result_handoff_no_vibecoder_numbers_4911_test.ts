/**
 * Regression tests for Issue #4911: the negative-result hand-off posts into a
 * TARGET repository, so the comment it writes must not carry a VibeCoder issue
 * number. GitHub resolves a bare `#N` against the repository the comment lives
 * in, so `(Issue #4298)` would link to an unrelated issue there.
 *
 * Drives the hand-off with a recording client and checks every comment body as
 * posted — heading, reason, next step, dedup marker and footer together — plus
 * the hand-off text on its own. A positive control asserts a comment was
 * posted, so the no-numbers check cannot pass vacuously.
 *
 * Same approach as worker/deno/tests/reasons_no_vibecoder_numbers_4641_test.ts.
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildNegativeResultHandoff,
  handOffNegativeResultIssue,
} from "../lib/negative_result_close.ts";
import { stripDiscoveryLabelsOnEscalation } from "../lib/escalation_cleanup.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { EscalateToHumanDeps } from "../lib/needs_human_escalation.ts";
import type { GitHubClient, GitHubIssue } from "../types.ts";

/** Every `#<digits>` token in the text, in order. */
function hashNumbers(text: string): string[] {
  return text.match(/#\d+/g) ?? [];
}

const NOW_MS = Date.parse("2026-11-10T12:00:00Z");

/** A client that records every comment body and label it is asked to write. */
function recordingClient(
  posted: string[],
  labelsAdded: string[],
): GitHubClient {
  return {
    getIssue: () =>
      Promise.resolve({
        labels: ["work-on", "performance", "negative-result"],
      } as unknown as GitHubIssue),
    getIssueComments: () => Promise.resolve([]),
    addLabel: (_r, _n, label) => {
      labelsAdded.push(label);
      return Promise.resolve();
    },
    removeLabel: () => Promise.resolve(),
    postComment: (_r, _n, body) => {
      posted.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  } as GitHubClient;
}

/** Stubs the label ensure and the clock, so no real `gh` runs. */
const STUB_DEPS: EscalateToHumanDeps = {
  github: {
    ensureLabelExists: () => Promise.resolve({ ok: true, value: undefined }),
  },
  now: () => NOW_MS,
};

Deno.test("negative-result hand-off - every posted comment names no VibeCoder number (Issue #4911)", async () => {
  const posted: string[] = [];
  const labelsAdded: string[] = [];

  const handedOff = await handOffNegativeResultIssue({
    ghClient: recordingClient(posted, labelsAdded),
    repo: "org/repo",
    issueNumber: 4911,
    githubUser: "testbot",
    needsHumanLabel: "needs-human",
    logger: createMockDeps().logger,
    deps: STUB_DEPS,
  });

  // Positive control: the hand-off must have run and posted a real comment,
  // or the no-numbers check below would pass for the wrong reason.
  assertEquals(handedOff, true, "the fixture must hand the issue off");
  assertEquals(posted.length, 1, "the fixture must post a comment");
  assertEquals(labelsAdded, ["needs-human"], "the escalation label is added");
  assertStringIncludes(posted[0]!, "needs-human");
  assertStringIncludes(posted[0]!, "**Next step:**");

  for (const body of posted) {
    assertEquals(
      hashNumbers(body),
      [],
      `hand-off comment carries a VibeCoder number: ${body}`,
    );
  }
});

Deno.test("negative-result hand-off - the hand-off text names no VibeCoder number (Issue #4911)", () => {
  const handoff = buildNegativeResultHandoff();
  assert(handoff.heading.length > 0, "the heading is set");
  assert(handoff.reason.length > 0, "the reason is set");
  assert(handoff.nextStep.length > 0, "the next step is set");

  for (const part of [handoff.heading, handoff.reason, handoff.nextStep]) {
    assertEquals(
      hashNumbers(part),
      [],
      `hand-off text carries a VibeCoder number: ${part}`,
    );
  }
});

Deno.test("negative-result hand-off and discovery cleanup agree on recovery and cite no issue numbers (PR #5028 review)", async () => {
  const posted: string[] = [];
  const labelsAdded: string[] = [];
  const labels = new Set(["work-on", "performance", "negative-result"]);
  const handedOff = await handOffNegativeResultIssue({
    ghClient: recordingClient(posted, labelsAdded),
    repo: "org/repo",
    issueNumber: 27,
    githubUser: "testbot",
    needsHumanLabel: "needs-human",
    logger: createMockDeps().logger,
    deps: STUB_DEPS,
  });
  for (const label of labelsAdded) labels.add(label);
  const removed = await stripDiscoveryLabelsOnEscalation("org/repo", 27, {
    needsHumanLabel: "needs-human",
    workOnLabel: "work-on",
    issueLabels: ["top-priority"],
  }, (args) => {
    if (args[1] === "view") {
      return Promise.resolve(
        JSON.stringify({ labels: [...labels].map((name) => ({ name })) }),
      );
    }
    if (args[1] === "edit") {
      labels.delete(args[args.indexOf("--remove-label") + 1]!);
    }
    if (args[1] === "comment") posted.push(args[args.indexOf("--body") + 1]!);
    return Promise.resolve("");
  });
  assertEquals(handedOff, true);
  assertEquals(removed, ["work-on"]);
  assertEquals(labels.has("work-on"), false);
  assertEquals(
    posted.length,
    2,
    "check the hand-off and subsequent cleanup comment",
  );
  for (const body of posted) {
    assertEquals(hashNumbers(body), []);
    assertStringIncludes(body, "re-add `work-on`");
    assertStringIncludes(body, "remove `needs-human`");
  }
  assertStringIncludes(posted[0]!, "`negative-result`");
});
