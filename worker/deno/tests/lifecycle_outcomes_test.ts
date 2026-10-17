import { assertEquals, assertThrows } from "@std/assert";
import {
  buildLifecycleEvent,
  type LifecycleEvent,
  type LifecycleEventInput,
} from "../lib/lifecycle_ledger.ts";
import { classifyLifecycleOutcome } from "../lib/lifecycle_outcomes.ts";

const assignmentId = "11111111-1111-4111-8111-111111111111";
function event(
  input: Partial<LifecycleEventInput> & { kind: "gate" | "outcome" },
  second = 1,
): LifecycleEvent {
  return buildLifecycleEvent(
    {
      assignmentId,
      runId: "run-1",
      host: "host-1",
      repo: "org/repo",
      issueNumber: 1,
      recordedAt: `2026-10-01T00:00:${String(second).padStart(2, "0")}.000Z`,
      ...input,
    } as LifecycleEventInput,
  );
}
const opened = event({ kind: "outcome", outcome: "pr_opened", prNumber: 10 });
const quality = event({
  kind: "gate",
  gate: "quality",
  result: "pass",
  attempt: 1,
  prNumber: 10,
}, 2);
const review = event({
  kind: "gate",
  gate: "review",
  result: "pass",
  attempt: 1,
  prNumber: 10,
}, 3);
const merged = event({ kind: "outcome", outcome: "merged", prNumber: 10 }, 4);
const closed = event({
  kind: "outcome",
  outcome: "closed_unmerged",
  prNumber: 10,
}, 4);

for (
  const [name, events, cutoff, expected, success] of [
    ["pending", [], undefined, "pending", false],
    ["pr_opened", [opened], undefined, "pr_opened", false],
    ["quality_green", [opened, quality], undefined, "quality_green", false],
    ["review_approved", [opened, review], undefined, "review_approved", false],
    ["merged", [opened, quality, review, merged], undefined, "merged", true],
    ["closed_unmerged", [opened, closed], undefined, "closed_unmerged", false],
    [
      "censored_at_cutoff",
      [opened, merged],
      "2026-10-01T00:00:03.000Z",
      "censored_at_cutoff",
      false,
    ],
  ] as const
) {
  Deno.test(`lifecycle outcome: ${name}`, () => {
    const result = classifyLifecycleOutcome(events, cutoff);
    assertEquals(result.state, expected);
    assertEquals(result.success, success);
  });
}

Deno.test("lifecycle outcome requires both gates on the merged PR strictly before merge", () => {
  for (
    const gates of [
      [],
      [quality],
      [review],
      [{ ...quality, prNumber: 11 }, review],
      [quality, { ...review, recordedAt: merged.recordedAt }],
      [quality, { ...review, recordedAt: "2026-10-01T00:00:05.000Z" }],
    ]
  ) {
    const result = classifyLifecycleOutcome([opened, ...gates, merged]);
    assertEquals(result.state, "merged");
    assertEquals(result.success, false);
  }
});

Deno.test("lifecycle outcome latest gate failure revokes an earlier pass", () => {
  for (const gate of ["quality", "review"]) {
    const failed = event({
      kind: "gate",
      gate,
      result: "fail",
      attempt: 2,
      prNumber: 10,
    }, 3);
    assertEquals(
      classifyLifecycleOutcome([opened, quality, review, failed, merged])
        .success,
      false,
    );
  }
});

Deno.test("lifecycle outcome keeps each PR and chooses the gated merge", () => {
  const second = [opened, quality, review, merged].map((e) =>
    buildLifecycleEvent({ ...e, prNumber: 11 } as LifecycleEventInput)
  );
  const result = classifyLifecycleOutcome(
    [opened, closed, ...second].reverse(),
  );
  assertEquals(result.state, "merged");
  assertEquals(result.success, true);
  assertEquals(result.prs.map((p) => [p.prNumber, p.state, p.success]), [[
    10,
    "closed_unmerged",
    false,
  ], [11, "merged", true]]);
});

Deno.test("lifecycle outcome ignores duplicate events and gates after cutoff", () => {
  assertEquals(
    classifyLifecycleOutcome([opened, quality, review, merged, merged]),
    classifyLifecycleOutcome([opened, quality, review, merged]),
  );
  assertEquals(
    classifyLifecycleOutcome(
      [opened, quality, review],
      "2026-10-01T00:00:02.000Z",
    ).state,
    "censored_at_cutoff",
  );
  assertEquals(
    classifyLifecycleOutcome([], "2026-10-01T00:00:02.000Z").state,
    "censored_at_cutoff",
  );
  assertThrows(() => classifyLifecycleOutcome([], "invalid"), Error, "cutoff");
});

Deno.test("lifecycle outcome prefers a gated merge over an ungated merged sibling", () => {
  const second = [opened, quality, review, merged].map((event) =>
    buildLifecycleEvent({ ...event, prNumber: 11 } as LifecycleEventInput)
  );
  assertEquals(
    classifyLifecycleOutcome([opened, merged, ...second]).success,
    true,
  );
});
