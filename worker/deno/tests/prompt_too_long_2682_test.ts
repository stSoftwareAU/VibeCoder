/**
 * Issue #2682 — a `Prompt is too long` refusal on a resumed session is retried
 * once on a fresh session, uncounted; only a fresh-session refusal fails.
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  buildPromptTooLongReason,
  decidePromptTooLong,
  discardResumedSession,
  isPromptTooLongOutput,
  PROMPT_TOO_LONG_MAX_OUTPUT_CHARS,
  resumedSessionIdOf,
} from "../lib/prompt_too_long.ts";
import {
  detectFailureCategory,
  getFailureCategoryDisplay,
  PROMPT_TOO_LONG_MARKER,
} from "../lib/failure_diagnosis.ts";
import {
  loadResumeState,
  loadStreamSession,
  saveResumeState,
  saveStreamSession,
} from "../lib/resume_state_store.ts";
import { resolveStreamId } from "../lib/stream_identity.ts";
import { handleIssueFailure } from "../lib/label_manager.ts";
import { classifyCodingFailure } from "../lib/coding_failure_ladder.ts";

const REPO = "acme/widgets";
const ISSUE = 2682;

function recordingLogger() {
  const warns: { message: string; fields?: Record<string, unknown> }[] = [];
  return {
    warns,
    info: () => {},
    warn: (message: string, fields?: Record<string, unknown>) =>
      warns.push({ message, fields }),
  };
}

async function withWorkDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "ptl_2682_" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("#2682 isPromptTooLongOutput - matches the bare CLI refusal", () => {
  assert(isPromptTooLongOutput("Prompt is too long"));
  assert(isPromptTooLongOutput("  prompt is too long\n"));
  assert(
    isPromptTooLongOutput(
      "API Error: 400 prompt is too long: 215000 tokens > 200000 maximum",
    ),
  );
});

Deno.test("#2682 isPromptTooLongOutput - ignores empty, unrelated and long output", () => {
  assertEquals(isPromptTooLongOutput(undefined), false);
  assertEquals(isPromptTooLongOutput("   "), false);
  assertEquals(isPromptTooLongOutput("Done: fixed the parser"), false);
  // A real run that merely mentions the phrase is not a refusal.
  const long = "Prompt is too long ".padEnd(
    PROMPT_TOO_LONG_MAX_OUTPUT_CHARS + 1,
    "x",
  );
  assertEquals(isPromptTooLongOutput(long), false);
});

Deno.test("#2682 decidePromptTooLong - resumed session, first refusal → retry", () => {
  assertEquals(
    decidePromptTooLong({
      output: "Prompt is too long",
      resumedSessionId: "sess-1",
      alreadyRetried: false,
    }),
    "retry",
  );
});

Deno.test("#2682 decidePromptTooLong - refusal after the retry → fail", () => {
  assertEquals(
    decidePromptTooLong({
      output: "Prompt is too long",
      resumedSessionId: "sess-2",
      alreadyRetried: true,
    }),
    "fail",
  );
});

Deno.test("#2682 decidePromptTooLong - refusal on a fresh session → fail", () => {
  assertEquals(
    decidePromptTooLong({
      output: "Prompt is too long",
      alreadyRetried: false,
    }),
    "fail",
  );
});

Deno.test("#2682 decidePromptTooLong - other output → none", () => {
  assertEquals(
    decidePromptTooLong({
      output: "Implemented the change",
      resumedSessionId: "sess-1",
      alreadyRetried: false,
    }),
    "none",
  );
});

Deno.test("#2682 resumedSessionIdOf - only a session with a completed phase is resumed", () => {
  assertEquals(resumedSessionIdOf(undefined), undefined);
  assertEquals(
    resumedSessionIdOf({ sessionId: "fresh", phaseCount: 0 }),
    undefined,
  );
  assertEquals(
    resumedSessionIdOf({ sessionId: "old", phaseCount: 2 }),
    "old",
  );
});

Deno.test("#2682 buildPromptTooLongReason - reports category prompt-too-long", () => {
  const reason = buildPromptTooLongReason("Prompt is too long");
  assert(reason.startsWith(PROMPT_TOO_LONG_MARKER));
  assertStringIncludes(reason, "Agent output: Prompt is too long");
  assertEquals(detectFailureCategory(reason), "prompt_too_long");
  assertEquals(
    getFailureCategoryDisplay(detectFailureCategory(reason)),
    "prompt-too-long",
  );
  // No snippet when the output is empty.
  assertEquals(buildPromptTooLongReason("").includes("Agent output"), false);
});

Deno.test("#2682 discardResumedSession - drops the stream slot and resume pointer, logs one line", async () => {
  await withWorkDir(async (workDir) => {
    const stream = resolveStreamId(REPO, undefined);
    await saveStreamSession(workDir, stream, {
      providerId: "claude",
      sessionId: "oversized",
    });
    await saveStreamSession(workDir, stream, {
      providerId: "codex",
      sessionId: "sibling",
    });
    await saveResumeState(workDir, REPO, ISSUE, {
      sessionId: "oversized",
      phaseCount: 3,
      branch: "issue-2682",
    });
    const logger = recordingLogger();

    const fresh = await discardResumedSession({
      workDir,
      repo: REPO,
      issueNumber: ISSUE,
      sessionId: "oversized",
      streamSession: { stream, providerId: "claude" },
      logger,
      reason: "Prompt is too long",
    });

    assertEquals(fresh.phaseCount, 0);
    assertNotEquals(fresh.sessionId, "oversized");
    assertEquals(await loadStreamSession(workDir, stream, "claude"), null);
    // Another provider's session is left alone.
    assertEquals(
      (await loadStreamSession(workDir, stream, "codex"))?.sessionId,
      "sibling",
    );
    assertEquals(await loadResumeState(workDir, REPO, ISSUE), null);
    assertEquals(logger.warns.length, 1);
    assertStringIncludes(logger.warns[0].message, "oversized");
    assertStringIncludes(logger.warns[0].message, fresh.sessionId);
    assertStringIncludes(logger.warns[0].message, "retrying once");
  });
});

Deno.test("#2682 discardResumedSession - no stream joined and nothing persisted still succeeds", async () => {
  await withWorkDir(async (workDir) => {
    const logger = recordingLogger();
    const fresh = await discardResumedSession({
      workDir,
      repo: REPO,
      issueNumber: ISSUE,
      sessionId: "gone",
      logger,
      reason: "Prompt is too long",
    });
    assertEquals(fresh.phaseCount, 0);
    assertEquals(logger.warns.length, 1);
  });
});

// ---------------------------------------------------------------------------
// The fresh-session refusal is an ordinary failure: failed-once, then failed
// ---------------------------------------------------------------------------

function ghRecorder(existingLabels: string) {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined.includes("issue view") && joined.includes("labels")) {
      return Promise.resolve(existingLabels);
    }
    if (joined.includes("label list")) {
      return Promise.resolve("failed\nfailed-once\n");
    }
    if (joined.includes("Automated Processing Failed")) {
      return Promise.resolve("0");
    }
    return Promise.resolve("");
  };
  const commentBody = () => {
    const call = calls.find((c) => c[0] === "issue" && c[1] === "comment");
    const idx = call ? call.indexOf("--body") : -1;
    return call && idx >= 0 ? call[idx + 1] ?? "" : "";
  };
  return { calls, ghCommandFn, commentBody };
}

Deno.test("#2682 handleIssueFailure - a fresh-session refusal marks failed-once and reports prompt-too-long", async () => {
  await withWorkDir(async (cacheDir) => {
    const gh = ghRecorder("bug");
    const result = await handleIssueFailure({
      repo: REPO,
      issueNumber: ISSUE,
      githubUser: "worker-user",
      failureMessage: buildPromptTooLongReason("Prompt is too long"),
    }, { ghCommandFn: gh.ghCommandFn, cacheDir });

    assert(result.ok);
    assertEquals(result.value.markedAsFailedOnce, true);
    assertEquals(result.value.markedAsFailed, false);
    assertEquals(result.value.failureCategory, "prompt_too_long");
    assertEquals(result.value.isInfrastructure, false);
    assertStringIncludes(gh.commentBody(), "prompt-too-long");
  });
});

Deno.test("#2682 handleIssueFailure - a repeat refusal after failed-once marks failed", async () => {
  await withWorkDir(async (cacheDir) => {
    const gh = ghRecorder("bug,failed-once");
    const result = await handleIssueFailure({
      repo: REPO,
      issueNumber: ISSUE,
      githubUser: "worker-user",
      failureMessage: buildPromptTooLongReason("Prompt is too long"),
    }, { ghCommandFn: gh.ghCommandFn, cacheDir });

    assert(result.ok);
    assertEquals(result.value.markedAsFailed, true);
    assertEquals(result.value.failureCategory, "prompt_too_long");
  });
});

Deno.test("#2682 classifyCodingFailure - a fresh-session refusal enters the ladder", () => {
  const decision = classifyCodingFailure(
    buildPromptTooLongReason("Prompt is too long"),
  );
  assertEquals(decision.disposition, "ladder");
  assertEquals(decision.failureClass, "prompt-too-long");
});
