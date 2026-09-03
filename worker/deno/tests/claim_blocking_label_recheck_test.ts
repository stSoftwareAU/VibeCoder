/**
 * A label applied since the scan's snapshot refuses the claim (Issue #831).
 *
 * Discovery already excludes `needs-human` — `filterAndSort` has it in the
 * blocking set — but discovery ranks a *snapshot* of the issue list. Nothing
 * re-read the labels at claim time, so a label applied in that window was
 * invisible.
 *
 * The worker is itself the common source: a grill-me round ends by removing
 * `grill-me` and adding `needs-human`. On VibeCoder#793 that happened at
 * 21:47:16, and a scan holding the earlier snapshot claimed the issue at
 * 21:53:31 — assigning itself and posting a CLAIM_LOCK comment on an issue
 * parked for a person six minutes earlier, before releasing it 8 seconds
 * later.
 *
 * `claim_issue.ts` already had the two neighbouring guards: a refusal for an
 * issue this run closed (#181, same stale-snapshot cause) and a live
 * open-PR re-check (#3150). This is the label one, and it runs *before* the
 * assignment so a parked issue collects neither an assignee nor a comment.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { claimIssue } from "../lib/claim_issue.ts";
import { LABEL_DEFAULTS } from "../lib/config_defaults.ts";

/** A `gh` stub that records every invocation and answers the label read. */
function ghStub(labels: string[], options: { failLabelRead?: boolean } = {}) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    const isLabelRead = args[0] === "issue" && args[1] === "view" &&
      args.includes("labels");
    if (isLabelRead) {
      if (options.failLabelRead) {
        return Promise.reject(new Error("gh: API rate limit exceeded"));
      }
      return Promise.resolve(
        JSON.stringify({ labels: labels.map((name) => ({ name })) }),
      );
    }
    // Any other call would be part of the claim sequence proper.
    return Promise.resolve("");
  };
  return { gh, calls };
}

/** Did the stub see an assignment or a claim comment? */
function mutated(calls: string[][]): { assigned: boolean; commented: boolean } {
  return {
    assigned: calls.some((c) => c.includes("--add-assignee")),
    commented: calls.some((c) => c[0] === "issue" && c[1] === "comment"),
  };
}

Deno.test("claim - needs-human applied since the snapshot refuses the claim (Issue #831)", async () => {
  const { gh } = ghStub(["bug", LABEL_DEFAULTS.needsHumanLabel]);

  const result = await claimIssue({
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 793,
    githubUser: "VibeCoderST",
    workerId: "VibeCoderST-1788386006238",
    ghCommandFn: gh,
    sleepFn: () => Promise.resolve(),
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.claimed, false);
  assertEquals(result.value.reason, "blocking_label");
  assert(
    result.value.reasonDetail?.includes(LABEL_DEFAULTS.needsHumanLabel),
    `the refusal must name the label: ${result.value.reasonDetail}`,
  );
});

Deno.test("claim - a refused claim assigns nobody and comments nowhere (Issue #831)", async () => {
  // The whole point of checking before the assign: #793 collected an
  // assignment and a CLAIM_LOCK comment it then had to undo.
  const { gh, calls } = ghStub(["bug", LABEL_DEFAULTS.needsHumanLabel]);

  await claimIssue({
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 793,
    githubUser: "VibeCoderST",
    workerId: "worker-1",
    ghCommandFn: gh,
    sleepFn: () => Promise.resolve(),
  });

  const { assigned, commented } = mutated(calls);
  assertEquals(assigned, false, "a parked issue must not be assigned");
  assertEquals(commented, false, "a parked issue must not get a claim comment");
});

Deno.test("claim - an issue with no blocking label proceeds past the check (Issue #831)", async () => {
  const { gh, calls } = ghStub(["bug", "work-on"]);

  await claimIssue({
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 808,
    githubUser: "VibeCoderST",
    workerId: "worker-1",
    ghCommandFn: gh,
    sleepFn: () => Promise.resolve(),
  });

  // It got past the label gate and started the claim sequence proper.
  assertEquals(
    mutated(calls).assigned,
    true,
    "a claimable issue must still be claimed",
  );
});

Deno.test("claim - the label read fails open (Issue #831)", async () => {
  // A gh hiccup must never withhold a legitimate claim, matching the
  // fail-open contract of the neighbouring open-PR re-check.
  const { gh, calls } = ghStub([LABEL_DEFAULTS.needsHumanLabel], {
    failLabelRead: true,
  });

  const result = await claimIssue({
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 793,
    githubUser: "VibeCoderST",
    workerId: "worker-1",
    ghCommandFn: gh,
    sleepFn: () => Promise.resolve(),
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.reason === "blocking_label",
    false,
    "an unreadable label list must not refuse the claim",
  );
  assertEquals(mutated(calls).assigned, true);
});

Deno.test("claim - the default blocks needs-human and nothing else (Issue #831)", async () => {
  // Deliberately narrow: `question`, `planning`, `refine-issue`,
  // `needs-revision`, `grill-me` and `quorum` are each some processor's
  // pickup signal, so blocking the whole discovery set here would stop every
  // one of those phases.
  for (
    const label of [
      LABEL_DEFAULTS.questionLabel,
      LABEL_DEFAULTS.planningLabel,
      LABEL_DEFAULTS.refineIssueLabel,
      LABEL_DEFAULTS.needsRevisionLabel,
      LABEL_DEFAULTS.grillMeLabel,
      LABEL_DEFAULTS.quorumLabel,
      LABEL_DEFAULTS.failedLabel,
    ]
  ) {
    const { gh, calls } = ghStub([label]);
    const result = await claimIssue({
      repo: "org/repo",
      issueNumber: 1,
      githubUser: "bot",
      workerId: "worker-1",
      ghCommandFn: gh,
      sleepFn: () => Promise.resolve(),
    });
    assertEquals(result.ok, true);
    if (!result.ok) continue;
    assertEquals(
      result.value.reason === "blocking_label",
      false,
      `\`${label}\` is a processor's pickup signal and must still be claimable`,
    );
    assertEquals(mutated(calls).assigned, true, label);
  }
});

Deno.test("claim - an explicit blockingLabels set is honoured (Issue #831)", async () => {
  const { gh } = ghStub(["frozen"]);
  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 1,
    githubUser: "bot",
    workerId: "worker-1",
    ghCommandFn: gh,
    blockingLabels: ["frozen"],
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.reason, "blocking_label");
});

Deno.test("claim - the label match is case-insensitive (Issue #831)", async () => {
  // GitHub treats label names case-insensitively, and the trust check in
  // `label_security.ts` already lower-cases before comparing (Issue #3088).
  const { gh } = ghStub(["Needs-Human"]);
  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 1,
    githubUser: "bot",
    workerId: "worker-1",
    ghCommandFn: gh,
    sleepFn: () => Promise.resolve(),
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.reason, "blocking_label");
});
