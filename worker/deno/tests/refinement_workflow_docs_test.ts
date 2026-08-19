/**
 * Tests for issue refinement workflow documentation accuracy (Issue #1139).
 *
 * These tests verify that the documented refinement workflow behaviours
 * match the actual implementation, ensuring the documentation stays
 * accurate as the code evolves.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildRefinementPrompt,
  getUnprocessedRefinementComments,
  hasWorkerRefinementResponse,
  parseRefinementResponse,
} from "../lib/refinement_processor.ts";
import {
  LABEL_DEFAULTS,
  OPERATIONAL_DEFAULTS,
} from "../lib/config_defaults.ts";
import type { GitHubComment } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeComment(overrides?: Partial<GitHubComment>): GitHubComment {
  return {
    id: 1,
    body: "Some feedback",
    author: "user1",
    createdAt: "2026-01-01T00:00:00Z",
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
    ...overrides,
  };
}

// ============================================================================
// Documented label names match config defaults
// ============================================================================

Deno.test("refinement docs - refine-issue label name matches config default", () => {
  assertEquals(
    LABEL_DEFAULTS.refineIssueLabel,
    "refine-issue",
    "Documentation states the trigger label is 'refine-issue'",
  );
});

Deno.test("refinement docs - needs-human is the completion handoff label (Issue #2029)", () => {
  // Issue #2029: the legacy `refined` completion label was retired. The
  // refinement workflow now signals handoff by adding `needs-human`.
  assertEquals(
    LABEL_DEFAULTS.needsHumanLabel,
    "needs-human",
    "Documentation states the completion handoff label is 'needs-human'",
  );
});

// ============================================================================
// Documented completion indicators match implementation
// ============================================================================

Deno.test("refinement docs - summary comment uses '## Issue Refinement' header", () => {
  // The documentation states that a "## Issue Refinement" summary comment
  // is posted on completion. The hasWorkerRefinementResponse function checks
  // for this exact header, confirming the implementation matches.
  const comments = [
    makeComment({ author: "bot", body: "## Issue Refinement\n\nSummary here" }),
  ];
  assertEquals(
    hasWorkerRefinementResponse(comments, "bot"),
    true,
    "Worker detection uses '## Issue Refinement' header as documented",
  );
});

Deno.test("refinement docs - eyes reaction marks comments as processed", () => {
  // Documentation states processed feedback comments receive an eyes reaction.
  // getUnprocessedRefinementComments filters by eyes === 0, confirming the
  // eyes reaction is the processing marker.
  const processed = makeComment({
    id: 1,
    author: "user1",
    reactions: { thumbsUp: 0, eyes: 1, confused: 0 },
  });
  const unprocessed = makeComment({
    id: 2,
    author: "user2",
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  });

  const result = getUnprocessedRefinementComments(
    [processed, unprocessed],
    "bot",
    () => true,
  );
  assertEquals(
    result.length,
    1,
    "Only comments without eyes reaction are unprocessed",
  );
  assertEquals(result[0]!.id, 2);
});

// ============================================================================
// Documented protection mechanisms match implementation
// ============================================================================

Deno.test("refinement docs - infinite loop prevention via header detection", () => {
  // Documentation states that "## Issue Refinement" header detection
  // prevents infinite loops. Verify that when the worker has already
  // responded and there is no new feedback, processing is skipped.
  const workerComment = makeComment({
    author: "bot",
    body: "## Issue Refinement\n\nPrevious response",
  });
  const processedUserComment = makeComment({
    id: 2,
    author: "user1",
    reactions: { thumbsUp: 0, eyes: 1, confused: 0 },
  });

  const hasResponse = hasWorkerRefinementResponse([
    workerComment,
    processedUserComment,
  ], "bot");
  const unprocessed = getUnprocessedRefinementComments(
    [workerComment, processedUserComment],
    "bot",
    () => true,
  );

  assertEquals(hasResponse, true, "Worker detects its own refinement response");
  assertEquals(unprocessed.length, 0, "No unprocessed comments remain");
  // Together these conditions cause the processor to skip (documented behaviour).
});

Deno.test("refinement docs - eyes reaction prevents double-processing of feedback", () => {
  // Documentation states that eyes reactions on comments prevent the same
  // feedback from being processed twice.
  const alreadyProcessed = makeComment({
    id: 1,
    author: "user1",
    body: "My feedback",
    reactions: { thumbsUp: 0, eyes: 1, confused: 0 },
  });
  const newFeedback = makeComment({
    id: 2,
    author: "user1",
    body: "More feedback",
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  });

  const result = getUnprocessedRefinementComments(
    [alreadyProcessed, newFeedback],
    "bot",
    () => true,
  );
  assertEquals(result.length, 1, "Already-processed comment is excluded");
  assertEquals(result[0]!.id, 2, "Only new feedback is included");
});

Deno.test("refinement docs - only authorised commenters trigger processing", () => {
  // Documentation states only comments from authorised commenters trigger
  // refinement processing.
  const authorised = makeComment({ id: 1, author: "allowed-user" });
  const unauthorised = makeComment({ id: 2, author: "random-user" });

  const isAuthorised = (commenter: string) => commenter === "allowed-user";
  const result = getUnprocessedRefinementComments(
    [authorised, unauthorised],
    "bot",
    isAuthorised,
  );
  assertEquals(
    result.length,
    1,
    "Only authorised commenter feedback is processed",
  );
  assertEquals(result[0]!.author, "allowed-user");
});

// ============================================================================
// Documented re-refinement workflow
// ============================================================================

Deno.test("refinement docs - re-refinement works when new feedback is added after previous response", () => {
  // Documentation states: to refine again, re-add the 'refine-issue' label
  // (Issue #2029). When new unprocessed comments exist alongside an
  // existing response, processing should proceed.
  const workerResponse = makeComment({
    id: 1,
    author: "bot",
    body: "## Issue Refinement\n\nPrevious response",
  });
  const newFeedback = makeComment({
    id: 2,
    author: "user1",
    body: "Actually, please also add acceptance criteria",
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  });

  const hasResponse = hasWorkerRefinementResponse(
    [workerResponse, newFeedback],
    "bot",
  );
  const unprocessed = getUnprocessedRefinementComments(
    [workerResponse, newFeedback],
    "bot",
    () => true,
  );

  assertEquals(hasResponse, true, "Worker's previous response is detected");
  assertEquals(unprocessed.length, 1, "New feedback is found");
  // When hasResponse is true but unprocessed.length > 0, the processor
  // continues rather than skipping — this is the documented re-refinement path.
});

// ============================================================================
// Documented refinement response format
// ============================================================================

Deno.test("refinement docs - Claude response includes title and body update fields", () => {
  // Documentation states Claude may update the issue title and/or body.
  // The parsed response has update_title/new_title and update_body/new_body.
  const response = JSON.stringify({
    update_title: true,
    new_title: "Improved title",
    update_body: true,
    new_body: "Improved body with acceptance criteria",
    summary: "Updated both title and body",
  });

  const result = parseRefinementResponse(response);
  assert(result.ok, "Valid refinement response should parse");
  if (result.ok) {
    assertEquals(result.value.update_title, true);
    assertEquals(result.value.new_title, "Improved title");
    assertEquals(result.value.update_body, true);
    assertEquals(
      result.value.new_body,
      "Improved body with acceptance criteria",
    );
    assertEquals(result.value.summary, "Updated both title and body");
  }
});

// ============================================================================
// Documented timeout defaults
// ============================================================================

Deno.test("refinement docs - refinement timeout default is 300 seconds", () => {
  assertEquals(
    OPERATIONAL_DEFAULTS.refinementTimeout,
    300,
    "Documentation states refinement timeout is 300 seconds (5 minutes)",
  );
});

// ============================================================================
// Documented prompt includes feedback
// ============================================================================

Deno.test("refinement docs - refinement prompt includes issue context and feedback", () => {
  // Documentation states the worker sends the issue + feedback to Claude.
  const prompt = buildRefinementPrompt(
    "My issue title",
    "My issue body with details",
    "User feedback: please add more detail",
  );

  assert(prompt.includes("My issue title"), "Prompt includes issue title");
  assert(
    prompt.includes("My issue body with details"),
    "Prompt includes issue body",
  );
  assert(
    prompt.includes("User feedback: please add more detail"),
    "Prompt includes user feedback",
  );
});
