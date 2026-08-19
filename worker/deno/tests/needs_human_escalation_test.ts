/**
 * Tests for the `escalateToHuman` shared helper (Issue #2208).
 *
 * Verifies behaviour for the happy path, partial failures, dedup window,
 * and PR vs issue targeting. Tests use stub `GitHubClient` instances —
 * no real `gh` invocations.
 *
 * Australian English used throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildDedupMarker,
  buildEscalationCommentBody,
  escalateToHuman,
} from "../lib/needs_human_escalation.ts";
import {
  buildSuspiciousImageDedupKey,
  detectSuspiciousImageFlag,
  handOffSuspiciousImage,
} from "../lib/suspicious_image_handoff.ts";
import type { GitHubClient, GitHubComment, Logger, Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface RecordedComment {
  repo: string;
  issueNumber: number;
  body: string;
}

interface RecordedLabel {
  repo: string;
  issueNumber: number;
  label: string;
}

interface StubClientOptions {
  postCommentThrows?: boolean;
  addLabelThrows?: boolean;
  getIssueCommentsThrows?: boolean;
  existingComments?: GitHubComment[];
}

function makeStubClient(opts: StubClientOptions = {}): {
  client: GitHubClient;
  comments: RecordedComment[];
  labels: RecordedLabel[];
  removedLabels: RecordedLabel[];
} {
  const comments: RecordedComment[] = [];
  const labels: RecordedLabel[] = [];
  const removedLabels: RecordedLabel[] = [];

  const client: GitHubClient = {
    getIssue: () => {
      throw new Error("stub: getIssue not implemented");
    },
    getIssueComments: (_repo: string, _n: number) => {
      if (opts.getIssueCommentsThrows) {
        return Promise.reject(new Error("stub: getIssueComments failed"));
      }
      return Promise.resolve(opts.existingComments ?? []);
    },
    addLabel: (repo: string, n: number, label: string) => {
      if (opts.addLabelThrows) {
        return Promise.reject(new Error("stub: addLabel failed"));
      }
      labels.push({ repo, issueNumber: n, label });
      return Promise.resolve();
    },
    removeLabel: (repo: string, n: number, label: string) => {
      removedLabels.push({ repo, issueNumber: n, label });
      return Promise.resolve();
    },
    postComment: (repo: string, n: number, body: string) => {
      if (opts.postCommentThrows) {
        return Promise.reject(new Error("stub: postComment failed"));
      }
      comments.push({ repo, issueNumber: n, body });
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };

  return { client, comments, labels, removedLabels };
}

function makeSilentLogger(): {
  logger: Logger;
  warnings: Array<{ message: string; context?: Record<string, unknown> }>;
} {
  const warnings: Array<
    { message: string; context?: Record<string, unknown> }
  > = [];
  const logger: Logger = {
    info: () => {},
    warn: (message, context) => {
      warnings.push({ message, context });
    },
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
  return { logger, warnings };
}

function makeEnsureLabelStub(
  options: { fails?: boolean; throws?: boolean } = {},
): {
  fn: (
    repo: string,
    name: string,
    colour?: string,
    description?: string,
  ) => Promise<Result<void>>;
  calls: Array<
    { repo: string; name: string; colour?: string; description?: string }
  >;
} {
  const calls: Array<
    { repo: string; name: string; colour?: string; description?: string }
  > = [];
  const fn = (
    repo: string,
    name: string,
    colour?: string,
    description?: string,
  ): Promise<Result<void>> => {
    calls.push({ repo, name, colour, description });
    if (options.throws) {
      return Promise.reject(new Error("stub: ensureLabelExists threw"));
    }
    if (options.fails) {
      return Promise.resolve({
        ok: false,
        error: new Error("stub: ensureLabelExists soft-failed"),
      });
    }
    return Promise.resolve({ ok: true, value: undefined });
  };
  return { fn, calls };
}

function makeComment(
  body: string,
  createdAt: string,
  id = 1,
): GitHubComment {
  return {
    id,
    body,
    author: "vibe-coder[bot]",
    createdAt,
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  };
}

// ---------------------------------------------------------------------------
// Comment body builder
// ---------------------------------------------------------------------------

Deno.test("escalateToHuman - buildEscalationCommentBody contains heading, reason, next step and footer", () => {
  const body = buildEscalationCommentBody({
    reason: "CI keeps failing on a missing secret",
    nextStep: "Add the SLACK_TOKEN secret to repo settings.",
    githubUser: "vibe-coder[bot]",
  });
  assertStringIncludes(body, "## Needs human attention");
  assertStringIncludes(body, "**Why:** CI keeps failing on a missing secret");
  assertStringIncludes(
    body,
    "**Next step:** Add the SLACK_TOKEN secret to repo settings.",
  );
  assertStringIncludes(body, "🤖 Processed by: vibe-coder[bot]");
});

Deno.test("escalateToHuman - buildEscalationCommentBody supports custom heading and dedup marker", () => {
  const body = buildEscalationCommentBody({
    heading: "Blocked on secret",
    reason: "r",
    nextStep: "n",
    dedupKey: "ci-2208",
  });
  assertStringIncludes(body, "## Blocked on secret");
  assertStringIncludes(body, buildDedupMarker("ci-2208"));
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

Deno.test("escalateToHuman - happy path posts comment with correct format and adds label", async () => {
  const { client, comments, labels } = makeStubClient();
  const ensureLabel = makeEnsureLabelStub();
  const { logger } = makeSilentLogger();

  const result = await escalateToHuman({
    ghClient: client,
    repo: "org/repo",
    target: { kind: "issue", number: 42 },
    needsHumanLabel: "needs-human",
    reason: "Worker cannot resolve product question",
    nextStep: "Reply on the issue with the chosen approach.",
    githubUser: "vibe-coder[bot]",
    deps: { github: { ensureLabelExists: ensureLabel.fn } },
    logger,
  });

  assert(result.ok, "expected success");
  assertEquals(result.value, {
    commentPosted: true,
    labelAdded: true,
    dedupSkipped: false,
  });

  assertEquals(labels.length, 1);
  assertEquals(labels[0], {
    repo: "org/repo",
    issueNumber: 42,
    label: "needs-human",
  });

  assertEquals(comments.length, 1);
  const body = comments[0]!.body;
  assertStringIncludes(body, "## Needs human attention");
  assertStringIncludes(body, "**Why:** Worker cannot resolve product question");
  assertStringIncludes(
    body,
    "**Next step:** Reply on the issue with the chosen approach.",
  );
  assertStringIncludes(body, "🤖 Processed by: vibe-coder[bot]");

  // ensureLabelExists was called with the canonical colour
  assertEquals(ensureLabel.calls.length, 1);
  assertEquals(ensureLabel.calls[0]!.name, "needs-human");
  assertEquals(ensureLabel.calls[0]!.colour, "fbca04");
});

// ---------------------------------------------------------------------------
// Partial failures
// ---------------------------------------------------------------------------

Deno.test("escalateToHuman - label add fails, comment still posted", async () => {
  const { client, comments, labels } = makeStubClient({ addLabelThrows: true });
  const ensureLabel = makeEnsureLabelStub();
  const { logger, warnings } = makeSilentLogger();

  const result = await escalateToHuman({
    ghClient: client,
    repo: "org/repo",
    target: { kind: "issue", number: 1 },
    needsHumanLabel: "needs-human",
    reason: "r",
    nextStep: "n",
    deps: { github: { ensureLabelExists: ensureLabel.fn } },
    logger,
  });

  assert(result.ok, "expected success because comment posted");
  assertEquals(result.value.labelAdded, false);
  assertEquals(result.value.commentPosted, true);
  assertEquals(labels.length, 0);
  assertEquals(comments.length, 1);
  assert(
    warnings.some((w) => w.message.includes("addLabel failed")),
    "expected addLabel warning",
  );
});

Deno.test("escalateToHuman - comment post fails, label still applied", async () => {
  const { client, comments, labels } = makeStubClient({
    postCommentThrows: true,
  });
  const ensureLabel = makeEnsureLabelStub();
  const { logger, warnings } = makeSilentLogger();

  const result = await escalateToHuman({
    ghClient: client,
    repo: "org/repo",
    target: { kind: "issue", number: 1 },
    needsHumanLabel: "needs-human",
    reason: "r",
    nextStep: "n",
    deps: { github: { ensureLabelExists: ensureLabel.fn } },
    logger,
  });

  assert(result.ok, "expected success because label was added");
  assertEquals(result.value.labelAdded, true);
  assertEquals(result.value.commentPosted, false);
  assertEquals(labels.length, 1);
  assertEquals(comments.length, 0);
  assert(
    warnings.some((w) => w.message.includes("postComment failed")),
    "expected postComment warning",
  );
});

Deno.test("escalateToHuman - both label and comment fail returns error", async () => {
  const { client } = makeStubClient({
    addLabelThrows: true,
    postCommentThrows: true,
  });
  const ensureLabel = makeEnsureLabelStub();
  const { logger } = makeSilentLogger();

  const result = await escalateToHuman({
    ghClient: client,
    repo: "org/repo",
    target: { kind: "issue", number: 1 },
    needsHumanLabel: "needs-human",
    reason: "r",
    nextStep: "n",
    deps: { github: { ensureLabelExists: ensureLabel.fn } },
    logger,
  });

  assert(!result.ok, "expected failure when both side effects failed");
});

Deno.test("escalateToHuman - ensureLabelExists soft-failure still attempts label add", async () => {
  const { client, labels, comments } = makeStubClient();
  const ensureLabel = makeEnsureLabelStub({ fails: true });
  const { logger, warnings } = makeSilentLogger();

  const result = await escalateToHuman({
    ghClient: client,
    repo: "org/repo",
    target: { kind: "issue", number: 7 },
    needsHumanLabel: "needs-human",
    reason: "r",
    nextStep: "n",
    deps: { github: { ensureLabelExists: ensureLabel.fn } },
    logger,
  });

  assert(result.ok);
  // Label add was still attempted and succeeded against the stub client.
  assertEquals(labels.length, 1);
  assertEquals(comments.length, 1);
  assert(
    warnings.some((w) => w.message.includes("ensureLabelExists failed")),
    "expected ensureLabelExists warning",
  );
});

// ---------------------------------------------------------------------------
// Dedup behaviour
// ---------------------------------------------------------------------------

Deno.test("escalateToHuman - dedup: same key within 24h skips comment, still ensures label", async () => {
  const fixedNow = Date.parse("2026-05-24T12:00:00Z");
  // Existing escalation comment posted 1 hour ago with the same marker.
  const existing = makeComment(
    `## Needs human attention\n\n**Why:** earlier\n\n**Next step:** earlier\n\n${
      buildDedupMarker("ci-secret")
    }\n\n---\n🤖 Processed by: vibe-coder[bot]`,
    new Date(fixedNow - 60 * 60 * 1000).toISOString(),
  );
  const { client, comments, labels } = makeStubClient({
    existingComments: [existing],
  });
  const ensureLabel = makeEnsureLabelStub();
  const { logger } = makeSilentLogger();

  const result = await escalateToHuman({
    ghClient: client,
    repo: "org/repo",
    target: { kind: "issue", number: 9 },
    needsHumanLabel: "needs-human",
    reason: "still broken",
    nextStep: "still broken",
    dedupKey: "ci-secret",
    deps: {
      github: { ensureLabelExists: ensureLabel.fn },
      now: () => fixedNow,
    },
    logger,
  });

  assert(result.ok);
  assertEquals(result.value.dedupSkipped, true);
  assertEquals(result.value.commentPosted, false);
  assertEquals(result.value.labelAdded, true);
  assertEquals(comments.length, 0); // no new comment posted
  assertEquals(labels.length, 1); // label still re-applied
});

Deno.test("escalateToHuman - dedup: different key posts a fresh comment", async () => {
  const fixedNow = Date.parse("2026-05-24T12:00:00Z");
  const existing = makeComment(
    `${buildDedupMarker("other-key")}`,
    new Date(fixedNow - 60 * 60 * 1000).toISOString(),
  );
  const { client, comments } = makeStubClient({
    existingComments: [existing],
  });
  const ensureLabel = makeEnsureLabelStub();
  const { logger } = makeSilentLogger();

  const result = await escalateToHuman({
    ghClient: client,
    repo: "org/repo",
    target: { kind: "issue", number: 9 },
    needsHumanLabel: "needs-human",
    reason: "r",
    nextStep: "n",
    dedupKey: "ci-secret", // different from the existing marker
    deps: {
      github: { ensureLabelExists: ensureLabel.fn },
      now: () => fixedNow,
    },
    logger,
  });

  assert(result.ok);
  assertEquals(result.value.dedupSkipped, false);
  assertEquals(result.value.commentPosted, true);
  assertEquals(comments.length, 1);
  assertStringIncludes(comments[0]!.body, buildDedupMarker("ci-secret"));
});

Deno.test("escalateToHuman - dedup: expired marker (>24h) posts a fresh comment", async () => {
  const fixedNow = Date.parse("2026-05-24T12:00:00Z");
  // Marker present, but the comment was created two days ago.
  const existing = makeComment(
    `Some old escalation ${buildDedupMarker("ci-secret")}`,
    new Date(fixedNow - 48 * 60 * 60 * 1000).toISOString(),
  );
  const { client, comments } = makeStubClient({
    existingComments: [existing],
  });
  const ensureLabel = makeEnsureLabelStub();
  const { logger } = makeSilentLogger();

  const result = await escalateToHuman({
    ghClient: client,
    repo: "org/repo",
    target: { kind: "issue", number: 9 },
    needsHumanLabel: "needs-human",
    reason: "r",
    nextStep: "n",
    dedupKey: "ci-secret",
    deps: {
      github: { ensureLabelExists: ensureLabel.fn },
      now: () => fixedNow,
    },
    logger,
  });

  assert(result.ok);
  assertEquals(result.value.dedupSkipped, false);
  assertEquals(result.value.commentPosted, true);
  assertEquals(comments.length, 1);
});

Deno.test("escalateToHuman - dedup lookup failure falls back to posting comment", async () => {
  const { client, comments } = makeStubClient({
    getIssueCommentsThrows: true,
  });
  const ensureLabel = makeEnsureLabelStub();
  const { logger, warnings } = makeSilentLogger();

  const result = await escalateToHuman({
    ghClient: client,
    repo: "org/repo",
    target: { kind: "issue", number: 9 },
    needsHumanLabel: "needs-human",
    reason: "r",
    nextStep: "n",
    dedupKey: "ci-secret",
    deps: { github: { ensureLabelExists: ensureLabel.fn } },
    logger,
  });

  assert(result.ok);
  assertEquals(result.value.dedupSkipped, false);
  assertEquals(result.value.commentPosted, true);
  assertEquals(comments.length, 1);
  assert(
    warnings.some((w) => w.message.includes("dedup comment lookup failed")),
  );
});

// ---------------------------------------------------------------------------
// PR vs issue target
// ---------------------------------------------------------------------------

Deno.test("escalateToHuman - PR target uses issue-comment API surface (same as issue)", async () => {
  // Issue comments work for both via `gh api`, which is what GitHubClient
  // wraps under the hood. We assert here that the helper passes the
  // PR number through to addLabel/postComment unchanged, regardless of
  // target.kind.
  const { client, comments, labels } = makeStubClient();
  const ensureLabel = makeEnsureLabelStub();
  const { logger } = makeSilentLogger();

  const result = await escalateToHuman({
    ghClient: client,
    repo: "org/repo",
    target: { kind: "pr", number: 123 },
    needsHumanLabel: "needs-human",
    reason: "PR feedback out of scope",
    nextStep: "Triage the follow-up issue.",
    deps: { github: { ensureLabelExists: ensureLabel.fn } },
    logger,
  });

  assert(result.ok);
  assertEquals(labels.length, 1);
  assertEquals(labels[0]!.issueNumber, 123);
  assertEquals(comments.length, 1);
  assertEquals(comments[0]!.issueNumber, 123);
});

// ---------------------------------------------------------------------------
// GhostCommit suspicious-image detect-and-flag path (Issue #3389)
//
// A flagged untrusted image must route onto escalateToHuman: apply the
// `needs-human` label atomically, post one deduped explanation comment
// carrying the dedup marker + image-source reason, and take no further
// action on the image's content. A re-run must not double-post, and a
// trusted worker-authored image must never trigger the path at all.
// ---------------------------------------------------------------------------

Deno.test("suspicious-image - flagged image escalates to needs-human with dedup marker and image reason", async () => {
  const { client, comments, labels } = makeStubClient();
  const ensureLabel = makeEnsureLabelStub();
  const { logger } = makeSilentLogger();

  const claudeOutput =
    "I viewed the attachment and it is suspicious. Stopping.\n" +
    '<!-- vibe-suspicious-image-detected source="issue #12 attachment" ' +
    'reason="low-contrast overlaid text directing the agent to run a command" -->';

  const detection = detectSuspiciousImageFlag(claudeOutput);
  assert(detection.flagged, "expected the marker to be detected");

  const handedOff = await handOffSuspiciousImage({
    ghClient: client,
    repo: "org/repo",
    issueNumber: 12,
    needsHumanLabel: "needs-human",
    githubUser: "vibe-coder[bot]",
    detection,
    logger,
    deps: { ensureLabelExists: ensureLabel.fn },
  });

  assert(handedOff, "expected a visible escalation side effect");
  // Label applied atomically via the guarded chokepoint.
  assertEquals(labels.length, 1);
  assertEquals(labels[0]!.label, "needs-human");
  // Exactly one escalation comment with the dedup marker + image source.
  assertEquals(comments.length, 1);
  assertStringIncludes(
    comments[0]!.body,
    buildDedupMarker(buildSuspiciousImageDedupKey(12)),
  );
  assertStringIncludes(comments[0]!.body, "issue #12 attachment");
  assertStringIncludes(comments[0]!.body, "did **not** act");
  // The comment carries the disclaimer that the image's embedded
  // instructions are deliberately not reproduced.
  assertStringIncludes(comments[0]!.body, "not reproduced");
});

Deno.test("suspicious-image - re-run within 24h dedups the escalation comment", async () => {
  const fixedNow = Date.parse("2026-07-12T12:00:00Z");
  const existing = makeComment(
    `## Suspicious untrusted image — flagged, not actioned\n\n${
      buildDedupMarker(buildSuspiciousImageDedupKey(12))
    }`,
    new Date(fixedNow - 60 * 60 * 1000).toISOString(),
  );
  const { client, comments, labels } = makeStubClient({
    existingComments: [existing],
  });
  const ensureLabel = makeEnsureLabelStub();
  const { logger } = makeSilentLogger();

  const handedOff = await handOffSuspiciousImage({
    ghClient: client,
    repo: "org/repo",
    issueNumber: 12,
    needsHumanLabel: "needs-human",
    githubUser: "vibe-coder[bot]",
    detection: { flagged: true, source: "committed image" },
    logger,
    deps: { ensureLabelExists: ensureLabel.fn, now: () => fixedNow },
  });

  assert(handedOff, "dedup still counts as a successful hand-off");
  // No new comment posted (deduped), label still (re-)applied idempotently.
  assertEquals(comments.length, 0);
  assertEquals(labels.length, 1);
});

Deno.test("suspicious-image - trusted worker evidence screenshot does not trigger the path", () => {
  // Worker-authored evidence reference — must not be detected as a flag.
  const output =
    "Captured a screenshot to docs/evidence/button-fix.png showing the fix. " +
    "![fix](docs/evidence/button-fix.png)";
  assertEquals(detectSuspiciousImageFlag(output).flagged, false);
});

Deno.test("escalateToHuman - default footer when githubUser omitted", async () => {
  const { client, comments } = makeStubClient();
  const ensureLabel = makeEnsureLabelStub();
  const { logger } = makeSilentLogger();

  const result = await escalateToHuman({
    ghClient: client,
    repo: "org/repo",
    target: { kind: "issue", number: 1 },
    needsHumanLabel: "needs-human",
    reason: "r",
    nextStep: "n",
    deps: { github: { ensureLabelExists: ensureLabel.fn } },
    logger,
  });

  assert(result.ok);
  assertStringIncludes(comments[0]!.body, "🤖 Processed by: the worker");
});
