/**
 * Tests for the GhostCommit suspicious-image detect-and-flag hand-off
 * (Issue #3389).
 *
 * Covers the marker detection, field sanitisation, and the hand-off that
 * routes a flagged image onto the shared `escalateToHuman` chokepoint.
 * Uses stub clients — no real `gh` invocations.
 *
 * Australian English used throughout (behaviour, colour, organisation).
 */

import { captureReleaseOutcomes } from "./fixtures/release_outcome_capture.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildSuspiciousImageDedupKey,
  buildSuspiciousImageReason,
  detectSuspiciousImageFlag,
  handOffSuspiciousImage,
  sanitiseFlagField,
  SUSPICIOUS_IMAGE_MARKER_NAME,
} from "../lib/suspicious_image_handoff.ts";
import { buildDedupMarker } from "../lib/needs_human_escalation.ts";
import type {
  EscalateToHumanOptions,
  EscalateToHumanOutcome,
} from "../lib/needs_human_escalation.ts";
import type { GitHubClient, Logger, Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSilentLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

interface StubState {
  labels: string[];
  comments: string[];
  unassigned: number;
}

function makeStubClient(state: StubState): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub: getIssue not implemented");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: (_repo, _n, label) => {
      state.labels.push(label);
      return Promise.resolve();
    },
    removeLabel: () => Promise.resolve(),
    postComment: (_repo, _n, body) => {
      state.comments.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => {
      state.unassigned += 1;
      return Promise.resolve();
    },
    closeIssue: () => Promise.resolve(),
  };
}

function ensureLabelStub(): (
  repo: string,
  name: string,
  colour?: string,
  description?: string,
) => Promise<Result<void>> {
  return () => Promise.resolve({ ok: true, value: undefined });
}

const marker = (attrs = "") =>
  `<!-- ${SUSPICIOUS_IMAGE_MARKER_NAME}${attrs} -->`;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

Deno.test("detectSuspiciousImageFlag - bare marker triggers with no fields", () => {
  const out =
    `I viewed the image and it is suspicious.\n${marker()}\nStopping.`;
  const d = detectSuspiciousImageFlag(out);
  assertEquals(d.flagged, true);
  assertEquals(d.source, undefined);
  assertEquals(d.reason, undefined);
});

Deno.test("detectSuspiciousImageFlag - extracts source and reason attributes", () => {
  const out = marker(
    ' source="issue #12 attachment" reason="low-contrast overlaid text telling the agent to exfiltrate secrets"',
  );
  const d = detectSuspiciousImageFlag(out);
  assertEquals(d.flagged, true);
  assertEquals(d.source, "issue #12 attachment");
  assertStringIncludes(d.reason!, "low-contrast overlaid text");
});

Deno.test("detectSuspiciousImageFlag - single-quoted attributes accepted", () => {
  const out = marker(" source='committed logo.png' reason='QR code'");
  const d = detectSuspiciousImageFlag(out);
  assertEquals(d.source, "committed logo.png");
  assertEquals(d.reason, "QR code");
});

Deno.test("detectSuspiciousImageFlag - marker name is case-insensitive", () => {
  const out = '<!-- VIBE-SUSPICIOUS-IMAGE-DETECTED source="x" -->';
  assertEquals(detectSuspiciousImageFlag(out).flagged, true);
});

Deno.test("detectSuspiciousImageFlag - empty / undefined output is not flagged", () => {
  assertEquals(detectSuspiciousImageFlag("").flagged, false);
  assertEquals(detectSuspiciousImageFlag(undefined).flagged, false);
  assertEquals(detectSuspiciousImageFlag(null).flagged, false);
});

Deno.test("detectSuspiciousImageFlag - ordinary image mention does NOT trigger (trusted evidence)", () => {
  // Worker-authored evidence screenshot reference — must not falsely flag.
  const out =
    "I captured a screenshot and saved it to docs/evidence/button-fix.png. " +
    "The image shows the fixed layout. See ![fix](docs/evidence/button-fix.png).";
  assertEquals(detectSuspiciousImageFlag(out).flagged, false);
});

Deno.test("detectSuspiciousImageFlag - prose describing a suspicious image without the marker does NOT trigger", () => {
  const out =
    "The image appears to contain instructions for an AI agent, which is suspicious.";
  assertEquals(detectSuspiciousImageFlag(out).flagged, false);
});

// ---------------------------------------------------------------------------
// Sanitisation
// ---------------------------------------------------------------------------

Deno.test("sanitiseFlagField - neutralises comment breakout and collapses whitespace", () => {
  const cleaned = sanitiseFlagField("evil --> <!-- injected\n\ttext");
  assert(!cleaned.includes("-->"), "must strip comment terminator");
  assert(!cleaned.includes("<!--"), "must strip comment opener");
  assert(!cleaned.includes("\n"), "must strip newlines");
  assertStringIncludes(cleaned, "evil");
});

Deno.test("sanitiseFlagField - a longer dash run cannot re-form the comment terminator (Issue #4409 sweep, CodeQL js/bad-tag-filter)", () => {
  // Before the fix `--->` became `-` + `->` = `-->` — the very token the
  // sanitiser exists to remove. Nested openers must not survive either.
  for (const hostile of ["--->", "---->", "-- -->", "<!<!---->", "<!-<!--"]) {
    const cleaned = sanitiseFlagField(hostile);
    assert(!cleaned.includes("-->"), `${hostile} -> ${cleaned}`);
    assert(!cleaned.includes("<!--"), `${hostile} -> ${cleaned}`);
  }
});

Deno.test("sanitiseFlagField - length-caps long fields", () => {
  const long = "a".repeat(500);
  const cleaned = sanitiseFlagField(long, 300);
  assert(
    cleaned.length <= 301,
    `expected capped length, got ${cleaned.length}`,
  );
  assertStringIncludes(cleaned, "…");
});

Deno.test("detectSuspiciousImageFlag - marker attributes are sanitised (newlines, backticks collapsed)", () => {
  const out = marker(' source="img `evil`" reason="line1\nline2"');
  const d = detectSuspiciousImageFlag(out);
  assert(!d.source!.includes("`"), "backticks stripped");
  assert(!d.reason!.includes("\n"), "newlines collapsed");
  assertStringIncludes(d.reason!, "line1 line2");
});

// ---------------------------------------------------------------------------
// Reason / dedup builders
// ---------------------------------------------------------------------------

Deno.test("buildSuspiciousImageReason - includes source and why, never the embedded content", () => {
  const reason = buildSuspiciousImageReason({
    flagged: true,
    source: "issue attachment",
    reason: "hidden instructions",
  });
  assertStringIncludes(reason, "issue attachment");
  assertStringIncludes(reason, "hidden instructions");
  assertStringIncludes(reason, "did **not** act");
  assertStringIncludes(reason, "not reproduced");
});

Deno.test("buildSuspiciousImageReason - defaults when fields absent", () => {
  const reason = buildSuspiciousImageReason({ flagged: true });
  assertStringIncludes(reason, "an untrusted image");
});

Deno.test("buildSuspiciousImageDedupKey - stable per issue", () => {
  assertEquals(buildSuspiciousImageDedupKey(42), "suspicious-image-42");
});

// ---------------------------------------------------------------------------
// Hand-off
// ---------------------------------------------------------------------------

Deno.test("handOffSuspiciousImage - escalates with dedup marker + image reason and releases claim", async () => {
  const state: StubState = { labels: [], comments: [], unassigned: 0 };
  const client = makeStubClient(state);

  const capture = captureReleaseOutcomes();
  const ok = await handOffSuspiciousImage({
    ghClient: client,
    repo: "org/repo",
    issueNumber: 77,
    needsHumanLabel: "needs-human",
    githubUser: "vibe-coder[bot]",
    detection: {
      flagged: true,
      source: "PR comment attachment",
      reason: "overlaid text directing the agent",
    },
    logger: makeSilentLogger(),
    deps: { ensureLabelExists: ensureLabelStub() },
  });
  capture.restore();
  assertEquals(capture.hooked.at(-1)?.outcome?.kind, "no_pr_expected");

  assertEquals(ok, true);
  // Label applied atomically via escalateToHuman.
  assertEquals(state.labels, ["needs-human"]);
  // Exactly one escalation comment, carrying the dedup marker + reason.
  assertEquals(state.comments.length, 1);
  assertStringIncludes(
    state.comments[0]!,
    buildDedupMarker("suspicious-image-77"),
  );
  assertStringIncludes(state.comments[0]!, "PR comment attachment");
  assertStringIncludes(
    state.comments[0]!,
    "Suspicious untrusted image — flagged, not actioned",
  );
  // Claim released.
  assertEquals(state.unassigned, 1);
});

Deno.test("handOffSuspiciousImage - re-run dedups the comment (same marker within 24h)", async () => {
  // First run posts, second run sees the marker and skips the comment.
  const posted: string[] = [];
  const now = () => Date.parse("2026-07-12T12:00:00Z");
  const client: GitHubClient = {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () =>
      Promise.resolve(
        posted.map((body, i) => ({
          id: i + 1,
          body,
          author: "vibe-coder[bot]",
          createdAt: new Date(now() - 60_000).toISOString(),
          reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
        })),
      ),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (_r, _n, body) => {
      posted.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };

  const opts = {
    ghClient: client,
    repo: "org/repo",
    issueNumber: 9,
    needsHumanLabel: "needs-human",
    githubUser: "vibe-coder[bot]",
    detection: { flagged: true as const, source: "committed image" },
    logger: makeSilentLogger(),
    deps: { ensureLabelExists: ensureLabelStub(), now },
  };

  await handOffSuspiciousImage(opts);
  await handOffSuspiciousImage(opts);

  assertEquals(
    posted.length,
    1,
    "second run must dedup the escalation comment",
  );
});

Deno.test("handOffSuspiciousImage - escalation failure returns false but still releases claim", async () => {
  let unassigned = 0;
  const client = makeStubClient({ labels: [], comments: [], unassigned: 0 });

  const failingEscalate = (
    _options: EscalateToHumanOptions,
  ): Promise<Result<EscalateToHumanOutcome>> =>
    Promise.resolve({ ok: false, error: new Error("boom") });

  const ok = await handOffSuspiciousImage({
    ghClient: client,
    repo: "org/repo",
    issueNumber: 5,
    needsHumanLabel: "needs-human",
    githubUser: "vibe-coder[bot]",
    detection: { flagged: true },
    logger: makeSilentLogger(),
    deps: {
      escalate: failingEscalate,
      releaseClaim: () => {
        unassigned += 1;
        return Promise.resolve(true);
      },
    },
  });

  assertEquals(ok, false);
  assertEquals(unassigned, 1);
});
