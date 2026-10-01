/**
 * Tests for the merge-conflict marker vocabulary (Issue #2996).
 *
 * Covers the shared resolution budget: the `pass="…"`-attributed
 * attempt/failed/resolved writers, the frozen-prefix compatibility of
 * {@link CONFLICT_RESOLVED_MARKER} with legacy bodies, and the pure reader
 * {@link readResolutionAttempts} that tallies attempts across the ladder,
 * sync and takeover passes.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  CONFLICT_RESOLVED_MARKER,
  conflictAttemptMarker,
  conflictFailedMarker,
  conflictResolvedMarker,
  readResolutionAttempts,
} from "../lib/merge_conflict_markers.ts";

const HEAD = "abc1234";
const OTHER_HEAD = "def5678";

function trustedOnly(login: string): boolean {
  return login === "vibe-coder-bot";
}

function comment(
  body: string,
  login: string | undefined,
  createdAt: string | undefined,
): unknown {
  return {
    body,
    created_at: createdAt,
    ...(login === undefined ? {} : { user: { login } }),
  };
}

Deno.test("conflictAttemptMarker writes the documented line", () => {
  const line = conflictAttemptMarker(1, "ladder", HEAD);
  assertEquals(
    line,
    `<!-- vibe-coder:merge-conflict-attempt n="1" pass="ladder" head="${HEAD}" -->`,
  );
});

Deno.test("conflictFailedMarker writes the documented line and keeps the n= grammar", () => {
  const line = conflictFailedMarker(2, "sync", HEAD);
  assertEquals(
    line,
    `<!-- vibe-coder:merge-conflict-failed n="2" pass="sync" head="${HEAD}" -->`,
  );
  const match = /merge-conflict-failed\s+n="(\d+)"/.exec(line);
  assertEquals(match?.[1], "2");
});

Deno.test("conflictResolvedMarker writes the documented line", () => {
  const line = conflictResolvedMarker("takeover", HEAD);
  assertEquals(
    line,
    `<!-- vibe-coder:merge-conflict-resolved pass="takeover" head="${HEAD}" -->`,
  );
});

Deno.test("writers throw on a bad head sha", () => {
  assertThrows(() => conflictAttemptMarker(1, "ladder", "not-a-sha"));
  assertThrows(() => conflictFailedMarker(1, "ladder", "not-a-sha"));
  assertThrows(() => conflictResolvedMarker("ladder", "not-a-sha"));
});

Deno.test("writers throw on a bad attempt number", () => {
  assertThrows(() => conflictAttemptMarker(0, "ladder", HEAD));
  assertThrows(() => conflictAttemptMarker(-1, "ladder", HEAD));
  assertThrows(() => conflictAttemptMarker(1.5, "ladder", HEAD));
  assertThrows(() => conflictFailedMarker(0, "ladder", HEAD));
});

Deno.test("CONFLICT_RESOLVED_MARKER matches both the new attributed body and the legacy body", () => {
  const attributed = conflictResolvedMarker("ladder", HEAD);
  assertEquals(attributed.includes(CONFLICT_RESOLVED_MARKER), true);

  const legacy = "<!-- vibe-coder:merge-conflict-resolved -->";
  assertEquals(legacy.includes(CONFLICT_RESOLVED_MARKER), true);
});

Deno.test("readResolutionAttempts tallies an attempt+failed pair per pass", () => {
  for (const pass of ["ladder", "sync", "takeover"] as const) {
    const comments = [
      comment(
        conflictAttemptMarker(1, pass, HEAD),
        "vibe-coder-bot",
        "2026-01-01T00:00:00Z",
      ),
      comment(
        conflictFailedMarker(1, pass, HEAD),
        "vibe-coder-bot",
        "2026-01-01T01:00:00Z",
      ),
    ];
    const attempts = readResolutionAttempts(comments, trustedOnly);
    assertEquals(attempts.length, 1);
    assertEquals(attempts[0]!.pass, pass);
    assertEquals(attempts[0]!.headSha, HEAD);
    assertEquals(attempts[0]!.outcome, "failed");
    assertEquals(attempts[0]!.atMs, Date.parse("2026-01-01T01:00:00Z"));
  }
});

Deno.test("readResolutionAttempts ignores markers from an untrusted author", () => {
  const comments = [
    comment(
      conflictAttemptMarker(1, "ladder", HEAD),
      "some-random-user",
      "2026-01-01T00:00:00Z",
    ),
  ];
  const attempts = readResolutionAttempts(comments, trustedOnly);
  assertEquals(attempts.length, 0);
});

Deno.test("readResolutionAttempts ignores a comment with no readable login", () => {
  const comments = [
    comment(conflictAttemptMarker(1, "ladder", HEAD), undefined, undefined),
  ];
  const attempts = readResolutionAttempts(comments, trustedOnly);
  assertEquals(attempts.length, 0);
});

Deno.test("readResolutionAttempts reads a legacy marker with no pass= or head= as ladder with no headSha", () => {
  const comments = [
    comment(
      "<!-- vibe-coder:merge-conflict-attempt -->",
      "vibe-coder-bot",
      "2026-01-01T00:00:00Z",
    ),
    comment(
      "<!-- vibe-coder:merge-conflict-failed -->",
      "vibe-coder-bot",
      "2026-01-01T01:00:00Z",
    ),
  ];
  const attempts = readResolutionAttempts(comments, trustedOnly);
  assertEquals(attempts.length, 1);
  assertEquals(attempts[0]!.pass, "ladder");
  assertEquals(attempts[0]!.headSha, undefined);
  assertEquals(attempts[0]!.outcome, "failed");
});

Deno.test("readResolutionAttempts does not let a legacy conclusion overwrite an attributed attempt's pass", () => {
  const comments = [
    comment(
      conflictAttemptMarker(1, "sync", HEAD),
      "vibe-coder-bot",
      "2026-01-01T00:00:00Z",
    ),
    comment(
      "<!-- vibe-coder:merge-conflict-failed -->",
      "vibe-coder-bot",
      "2026-01-01T01:00:00Z",
    ),
  ];
  const attempts = readResolutionAttempts(comments, trustedOnly);
  assertEquals(attempts.length, 1);
  assertEquals(attempts[0]!.pass, "sync");
  assertEquals(attempts[0]!.outcome, "failed");
});

Deno.test("readResolutionAttempts counts a conclusion with no open attempt as its own entry", () => {
  const comments = [
    comment(
      conflictFailedMarker(1, "takeover", HEAD),
      "vibe-coder-bot",
      "2026-01-01T00:00:00Z",
    ),
  ];
  const attempts = readResolutionAttempts(comments, trustedOnly);
  assertEquals(attempts.length, 1);
  assertEquals(attempts[0]!.pass, "takeover");
  assertEquals(attempts[0]!.outcome, "failed");
  assertEquals(attempts[0]!.headSha, HEAD);
});

Deno.test("readResolutionAttempts reads an unrecognised pass as ladder", () => {
  const comments = [
    comment(
      `<!-- vibe-coder:merge-conflict-attempt n="1" pass="unknown" head="${HEAD}" -->`,
      "vibe-coder-bot",
      "2026-01-01T00:00:00Z",
    ),
  ];
  const attempts = readResolutionAttempts(comments, trustedOnly);
  assertEquals(attempts.length, 1);
  assertEquals(attempts[0]!.pass, "ladder");
  assertEquals(attempts[0]!.outcome, "open");
});

Deno.test("readResolutionAttempts leaves a still-open attempt open and resolves a later one", () => {
  const comments = [
    comment(
      conflictAttemptMarker(1, "ladder", HEAD),
      "vibe-coder-bot",
      "2026-01-01T00:00:00Z",
    ),
    comment(
      conflictAttemptMarker(2, "ladder", OTHER_HEAD),
      "vibe-coder-bot",
      "2026-01-01T02:00:00Z",
    ),
    comment(
      conflictResolvedMarker("ladder", OTHER_HEAD),
      "vibe-coder-bot",
      "2026-01-01T03:00:00Z",
    ),
  ];
  const attempts = readResolutionAttempts(comments, trustedOnly);
  assertEquals(attempts.length, 2);
  assertEquals(attempts[0]!.outcome, "open");
  assertEquals(attempts[1]!.outcome, "resolved");
  assertEquals(attempts[1]!.headSha, OTHER_HEAD);
});
