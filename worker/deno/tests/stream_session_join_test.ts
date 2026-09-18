/**
 * Implementation and planning runs join their stream; other kinds do not
 * (Issue #2333).
 *
 * Covers the join itself — first issue opens the conversation, the second
 * resumes it, an unresumable record resets rather than fails, a fallback
 * provider starts its own session beside the primary's — and the exclusion
 * list that keeps grill-me, question, idle-task, PR-feedback and CI-fix runs
 * on per-issue sessions that touch no stream record.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  adoptStreamSession,
  describeStreamSession,
  joinsStream,
  PER_ISSUE_RUN_KINDS,
  primeStreamSession,
  recordStreamSession,
  resolveStreamRunKind,
  type StreamRunKind,
  type StreamSessionAdoption,
} from "../lib/stream_session.ts";
import {
  loadStreamSession,
  saveStreamSession,
  streamSessionPath,
} from "../lib/resume_state_store.ts";
import { buildSessionResumeFlags } from "../lib/session_resume.ts";
import { resolveStreamId } from "../lib/stream_identity.ts";

const REPO = "stSoftwareAU/VibeCoder";
const MILESTONE = "#2319 session resume on by default";

/** Run a case in a throwaway work directory. */
async function withWorkDir(
  body: (workDir: string) => Promise<void>,
): Promise<void> {
  const workDir = await Deno.makeTempDir({ prefix: "stream-session-" });
  try {
    await body(workDir);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
}

/** Adopt, then write the adopted id back exactly as a finished run does. */
async function runIssue(
  workDir: string,
  options: {
    milestoneTitle?: string;
    providerId?: string;
    runKind?: StreamRunKind;
  } = {},
): Promise<StreamSessionAdoption | undefined> {
  const providerId = options.providerId ?? "claude";
  const adoption = await adoptStreamSession({
    workDir,
    repo: REPO,
    ...(options.milestoneTitle !== undefined
      ? { milestoneTitle: options.milestoneTitle }
      : {}),
    providerId,
    runKind: options.runKind ?? "implementation",
  });
  if (adoption) {
    await recordStreamSession({
      workDir,
      stream: adoption.stream,
      providerId,
      sessionId: adoption.state.sessionId,
      holderHost: "test-host",
    });
  }
  return adoption;
}

Deno.test("#2333 - the second issue of a stream resumes the first issue's session", async () => {
  await withWorkDir(async (workDir) => {
    const first = await runIssue(workDir, { milestoneTitle: MILESTONE });
    assertEquals(first?.outcome, "new");

    const second = await runIssue(workDir, { milestoneTitle: MILESTONE });
    assertEquals(second?.outcome, "resumed");
    assertEquals(second?.state.sessionId, first?.state.sessionId);
    // Resumed state must actually emit `--resume`, not open a new session.
    assertEquals(buildSessionResumeFlags(second?.state).resume, true);
    assertEquals(buildSessionResumeFlags(first?.state).resume, false);
  });
});

Deno.test("#2333 - the log line names the stream, the session and the outcome", async () => {
  await withWorkDir(async (workDir) => {
    const first = await runIssue(workDir, { milestoneTitle: MILESTONE });
    assert(first);
    assertEquals(
      describeStreamSession(first),
      `stream ${REPO}${MILESTONE} session ${first.state.sessionId} (new)`,
    );
    const second = await runIssue(workDir, { milestoneTitle: MILESTONE });
    assert(second);
    assert(describeStreamSession(second).endsWith("(resumed)"));
  });
});

Deno.test("#2333 - a freshly planned milestone starts new, not on the planning session", async () => {
  await withWorkDir(async (workDir) => {
    // The planning issue carries no milestone, so it runs on the blank stream.
    const planning = await runIssue(workDir, { runKind: "planning" });
    assertEquals(planning?.outcome, "new");

    // Its first sub-issue carries the milestone the plan created.
    const subIssue = await runIssue(workDir, { milestoneTitle: MILESTONE });
    assertEquals(subIssue?.outcome, "new");
    assertNotEquals(subIssue?.state.sessionId, planning?.state.sessionId);
  });
});

Deno.test("#2333 - an unresumable stream session resets with a reason and a new id", async () => {
  await withWorkDir(async (workDir) => {
    const stream = resolveStreamId(REPO, MILESTONE);
    // An id written before the UUID fix (#204): recorded, but the Claude CLI
    // refuses it outright.
    await saveStreamSession(workDir, stream, {
      providerId: "claude",
      sessionId: "VibeCoder-2333-1700000000",
      holderHost: "dead-host",
    });

    const warnings: string[] = [];
    const adoption = await primeStreamSession({
      workDir,
      repo: REPO,
      milestoneTitle: MILESTONE,
      providerId: "claude",
      runKind: "implementation",
      logger: {
        info: () => {},
        warn: (message: string) => warnings.push(message),
      },
    });

    assertEquals(adoption?.outcome, "reset");
    assertNotEquals(adoption?.state.sessionId, "VibeCoder-2333-1700000000");
    assert(
      warnings.some((line) => line.startsWith("stream session reset: ")),
      `expected a reset line, got ${JSON.stringify(warnings)}`,
    );
    // The dead entry is gone, so the next run does not reset a second time.
    assertEquals(await loadStreamSession(workDir, stream, "claude"), null);
  });
});

Deno.test("#2333 - a fallback provider starts its own session without disturbing the primary's", async () => {
  await withWorkDir(async (workDir) => {
    const stream = resolveStreamId(REPO, MILESTONE);
    const primary = await runIssue(workDir, { milestoneTitle: MILESTONE });
    assertEquals(primary?.outcome, "new");

    // A sub-issue that runs under Codex finds no session of its own.
    const fallbackFirst = await adoptStreamSession({
      workDir,
      repo: REPO,
      milestoneTitle: MILESTONE,
      providerId: "codex",
      runKind: "implementation",
    });
    assertEquals(fallbackFirst?.outcome, "new");
    await recordStreamSession({
      workDir,
      stream,
      providerId: "codex",
      // Codex names its own thread; it need not be a UUID (#1699).
      sessionId: "codex-thread-2333",
      holderHost: "test-host",
    });

    // The next Codex run resumes the Codex thread...
    const fallbackSecond = await adoptStreamSession({
      workDir,
      repo: REPO,
      milestoneTitle: MILESTONE,
      providerId: "codex",
      runKind: "implementation",
    });
    assertEquals(fallbackSecond?.outcome, "resumed");
    assertEquals(fallbackSecond?.state.sessionId, "codex-thread-2333");

    // ...and the primary's session is untouched.
    const primaryAgain = await adoptStreamSession({
      workDir,
      repo: REPO,
      milestoneTitle: MILESTONE,
      providerId: "claude",
      runKind: "implementation",
    });
    assertEquals(primaryAgain?.outcome, "resumed");
    assertEquals(primaryAgain?.state.sessionId, primary?.state.sessionId);
  });
});

Deno.test("#2333 - excluded run kinds read and write no stream record", async () => {
  await withWorkDir(async (workDir) => {
    const stream = resolveStreamId(REPO, MILESTONE);
    const implementation = await runIssue(workDir, {
      milestoneTitle: MILESTONE,
    });
    assert(implementation);

    for (const runKind of PER_ISSUE_RUN_KINDS) {
      assertEquals(joinsStream(runKind), false);
      const adoption = await runIssue(workDir, {
        milestoneTitle: MILESTONE,
        runKind,
      });
      assertEquals(
        adoption,
        undefined,
        `${runKind} must not join the stream`,
      );
    }

    // The stream still names the implementation run's session and nothing else.
    const recorded = await loadStreamSession(workDir, stream, "claude");
    assertEquals(recorded?.sessionId, implementation.state.sessionId);
  });
});

Deno.test("#2333 - an excluded run kind writes no record even on a stream that has none", async () => {
  await withWorkDir(async (workDir) => {
    const stream = resolveStreamId(REPO, MILESTONE);
    const adoption = await runIssue(workDir, {
      milestoneTitle: MILESTONE,
      runKind: "grill-me",
    });
    assertEquals(adoption, undefined);
    // No file was created at all.
    let exists = true;
    try {
      await Deno.stat(streamSessionPath(workDir, stream));
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  });
});

Deno.test("#2333 - idle-task labels route to the per-issue run kind", () => {
  assertEquals(resolveStreamRunKind(["top-priority"]), "implementation");
  assertEquals(resolveStreamRunKind(["work-on"]), "implementation");
  assertEquals(resolveStreamRunKind(["Idle-Task"]), "idle-task");
  assertEquals(resolveStreamRunKind(["work-on", "idle-task"]), "idle-task");
  assertEquals(joinsStream("implementation"), true);
  assertEquals(joinsStream("planning"), true);
});

Deno.test("#2333 - a malformed repository degrades to a per-issue session, never a failure", async () => {
  await withWorkDir(async (workDir) => {
    const warnings: string[] = [];
    const adoption = await primeStreamSession({
      workDir,
      repo: "not-a-repo",
      providerId: "claude",
      runKind: "implementation",
      logger: {
        info: () => {},
        warn: (message: string) => warnings.push(message),
      },
    });
    assertEquals(adoption, undefined);
    assertEquals(warnings.length, 1);
    assert(warnings[0]?.includes("Could not join the stream conversation"));
  });
});

Deno.test("#2333 - a session id the CLI would refuse is never recorded", async () => {
  await withWorkDir(async (workDir) => {
    const stream = resolveStreamId(REPO, MILESTONE);
    assertEquals(
      await recordStreamSession({
        workDir,
        stream,
        providerId: "claude",
        sessionId: "VibeCoder-2333-1700000000",
      }),
      false,
    );
    assertEquals(await loadStreamSession(workDir, stream, "claude"), null);
  });
});
