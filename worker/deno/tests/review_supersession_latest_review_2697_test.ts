/**
 * Each reviewer's latest review decides (Issue #2697) — the review
 * supersession half of lib/pr_feedback_supersede.ts that sits beside the
 * fleet-fix rule (Issue #2702).
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  parsePrReviewPages,
  type PrReview,
  selectOutstandingReviews,
} from "../lib/pr_feedback_supersede.ts";

function review(
  id: number,
  state: string,
  submittedAt: string | null,
  overrides: Partial<PrReview> = {},
): PrReview {
  return {
    login: "alice",
    id,
    body: `review ${id}`,
    state,
    submitted_at: submittedAt,
    commit_id: "shaA",
    ...overrides,
  };
}

Deno.test("selectOutstandingReviews - a lone change request is outstanding", () => {
  const cr = review(1, "CHANGES_REQUESTED", "2026-09-01T00:00:00Z");
  const { outstanding, skipped } = selectOutstandingReviews([cr]);
  assertEquals(outstanding, [cr]);
  assertEquals(skipped, []);
});

Deno.test("selectOutstandingReviews - review commit is ignored (head may have moved)", () => {
  const cr = review(1, "CHANGES_REQUESTED", "2026-09-01T00:00:00Z", {
    commit_id: "an-old-sha",
  });
  assertEquals(selectOutstandingReviews([cr]).outstanding, [cr]);
});

Deno.test("selectOutstandingReviews - a dismissed review is never outstanding", () => {
  const dismissed = review(1, "DISMISSED", "2026-09-01T00:00:00Z");
  const { outstanding, skipped } = selectOutstandingReviews([dismissed]);
  assertEquals(outstanding, []);
  assertEquals(skipped, []);
});

Deno.test("selectOutstandingReviews - a later APPROVED review supersedes the request", () => {
  const cr = review(1, "CHANGES_REQUESTED", "2026-09-01T00:00:00Z");
  const ok = review(2, "APPROVED", "2026-09-02T00:00:00Z");
  const { outstanding, skipped } = selectOutstandingReviews([cr, ok]);
  assertEquals(outstanding, []);
  assertEquals(skipped.length, 1);
  assertEquals(skipped[0]?.review, cr);
  assertEquals(
    skipped[0]?.reason,
    "superseded by alice's later APPROVED review 2",
  );
});

Deno.test("selectOutstandingReviews - a later non-empty COMMENTED review leaves the request outstanding", () => {
  const cr = review(1, "CHANGES_REQUESTED", "2026-09-01T00:00:00Z");
  const note = review(2, "COMMENTED", "2026-09-02T00:00:00Z");
  const { outstanding, skipped } = selectOutstandingReviews([cr, note]);
  assertEquals(outstanding, [cr]);
  assertEquals(skipped, []);
});

Deno.test("selectOutstandingReviews - an empty COMMENTED reply container does not supersede", () => {
  const cr = review(1, "CHANGES_REQUESTED", "2026-09-01T00:00:00Z");
  const reply = review(2, "COMMENTED", "2026-09-02T00:00:00Z", { body: "" });
  assertEquals(selectOutstandingReviews([cr, reply]).outstanding, [cr]);
});

Deno.test("selectOutstandingReviews - a PENDING draft is ignored", () => {
  const cr = review(1, "CHANGES_REQUESTED", "2026-09-01T00:00:00Z");
  const draft = review(2, "PENDING", null);
  assertEquals(selectOutstandingReviews([cr, draft]).outstanding, [cr]);
});

Deno.test("selectOutstandingReviews - one entry per reviewer: the latest request wins", () => {
  const first = review(1, "CHANGES_REQUESTED", "2026-09-01T00:00:00Z");
  const second = review(2, "CHANGES_REQUESTED", "2026-09-02T00:00:00Z");
  const { outstanding, skipped } = selectOutstandingReviews([first, second]);
  assertEquals(outstanding, [second]);
  assertEquals(skipped.map((s) => s.review.id), [1]);
});

Deno.test("selectOutstandingReviews - latest is by submitted_at, not list order", () => {
  const later = review(2, "CHANGES_REQUESTED", "2026-09-03T00:00:00Z");
  const earlier = review(1, "APPROVED", "2026-09-01T00:00:00Z");
  assertEquals(selectOutstandingReviews([later, earlier]).outstanding, [later]);
});

Deno.test("selectOutstandingReviews - reviewers are grouped case-insensitively", () => {
  const cr = review(1, "CHANGES_REQUESTED", "2026-09-01T00:00:00Z");
  const ok = review(2, "APPROVED", "2026-09-02T00:00:00Z", { login: "ALICE" });
  assertEquals(selectOutstandingReviews([cr, ok]).outstanding, []);
});

Deno.test("selectOutstandingReviews - another reviewer's approval does not supersede", () => {
  const cr = review(1, "CHANGES_REQUESTED", "2026-09-01T00:00:00Z");
  const ok = review(2, "APPROVED", "2026-09-02T00:00:00Z", { login: "bob" });
  assertEquals(selectOutstandingReviews([cr, ok]).outstanding, [cr]);
});

Deno.test("selectOutstandingReviews - missing timestamps fall back to list order", () => {
  const cr = review(1, "CHANGES_REQUESTED", null);
  const ok = review(2, "APPROVED", null);
  assertEquals(selectOutstandingReviews([cr, ok]).outstanding, []);
});

Deno.test("selectOutstandingReviews - empty input", () => {
  assertEquals(selectOutstandingReviews([]), { outstanding: [], skipped: [] });
});

Deno.test("parsePrReviewPages - flattens one array per page", () => {
  const a = review(1, "CHANGES_REQUESTED", "2026-09-01T00:00:00Z");
  const b = review(2, "APPROVED", "2026-09-02T00:00:00Z");
  const payload = `${JSON.stringify([a])}\n${JSON.stringify([b])}\n`;
  assertEquals(parsePrReviewPages(payload), [a, b]);
});

Deno.test("parsePrReviewPages - empty payload is no reviews", () => {
  assertEquals(parsePrReviewPages(""), []);
  assertEquals(parsePrReviewPages("[]\n"), []);
});

Deno.test("parsePrReviewPages - a malformed line throws", () => {
  assertThrows(() => parsePrReviewPages("[not json"));
  assertThrows(
    () => parsePrReviewPages('{"login":"a"}'),
    Error,
    "not a JSON array",
  );
});

Deno.test("parsePrReviewPages - a row missing its state throws", () => {
  assertThrows(
    () => parsePrReviewPages('[{"login":"a","id":1,"body":"x"}]'),
    Error,
    "malformed review row",
  );
});
