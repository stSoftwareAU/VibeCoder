/**
 * A stream session belongs to the provider that created it (Issue #2638).
 *
 * On GRQ-23 a stream session built on Claude (about 1.2 MB of transcript) sat
 * in the stream record's DeepSeek slot, so the first DeepSeek run after the
 * pace fallback resumed it and died with "Prompt is too long". These tests pin
 * the binding in both directions:
 *
 * - a Claude-created session is never resumed on DeepSeek, and the skip is
 *   logged naming both providers and the session id;
 * - the same session is resumed on Claude again once Claude is back, even
 *   after a DeepSeek run in between;
 * - a record written before the provider was recorded reads as the configured
 *   preferred provider's — no migration, no crash;
 * - hand-on files a session under the provider that served the run, never the
 *   one merely anticipated;
 * - compaction never touches another provider's session.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  adoptStreamSession,
  handOnStreamSession,
  preferredStreamProviderId,
  primeStreamSession,
  recordStreamSession,
} from "../lib/stream_session.ts";
import {
  preferredAgentProviderId,
  setRunProviderOverride,
} from "../lib/agent_provider.ts";
import {
  lookupStreamSession,
  saveStreamSession,
  streamSessionPath,
} from "../lib/resume_state_store.ts";
import {
  buildSessionResumeFlags,
  sessionResumeForProvider,
} from "../lib/session_resume.ts";
import { resolveStreamId } from "../lib/stream_identity.ts";
import {
  type CompactionRunRequest,
  compactStreamSession,
} from "../lib/stream_compaction.ts";

const REPO = "stSoftwareAU/GRQ";
const CLAUDE_SESSION = "2ab1e141-0000-4000-8000-000000002638";
const DEEPSEEK_SESSION = "7cfceb4d-0000-4000-8000-000000002638";

async function withWorkDir(
  body: (workDir: string) => Promise<void>,
): Promise<void> {
  const workDir = await Deno.makeTempDir({ prefix: "stream-binding-2638-" });
  try {
    await body(workDir);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
}

function recordingLogger() {
  const lines: { level: string; message: string }[] = [];
  return {
    lines,
    logger: {
      info: (message: string) => lines.push({ level: "info", message }),
      warn: (message: string) => lines.push({ level: "warn", message }),
    },
  };
}

/** Join the blank stream as `providerId`, with Claude the preferred provider. */
function join(workDir: string, providerId: string, preferred = "claude") {
  return adoptStreamSession({
    workDir,
    repo: REPO,
    providerId,
    preferredProviderId: preferred,
    runKind: "implementation",
  });
}

Deno.test("#2638 - a Claude-created stream session is not resumed on DeepSeek", async () => {
  await withWorkDir(async (workDir) => {
    const stream = resolveStreamId(REPO, undefined);
    await recordStreamSession({
      workDir,
      stream,
      providerId: "claude",
      sessionId: CLAUDE_SESSION,
      holderHost: "test-host",
    });

    const onDeepSeek = await join(workDir, "deepseek");
    assert(onDeepSeek);
    assertEquals(onDeepSeek.outcome, "new");
    assertNotEquals(onDeepSeek.state.sessionId, CLAUDE_SESSION);
    assertEquals(buildSessionResumeFlags(onDeepSeek.state).resume, false);
  });
});

Deno.test("#2638 - a Claude session filed in the DeepSeek slot is still not resumed on DeepSeek", async () => {
  await withWorkDir(async (workDir) => {
    const stream = resolveStreamId(REPO, undefined);
    // The GRQ-23 record: the DeepSeek slot names a session Claude created.
    await Deno.mkdir(`${workDir}/.claude-sessions/resume`, { recursive: true });
    await Deno.writeTextFile(
      streamSessionPath(workDir, stream),
      JSON.stringify({
        sessions: {
          deepseek: {
            sessionId: CLAUDE_SESSION,
            savedAtEpochMs: 1,
            providerId: "claude",
          },
        },
      }),
    );

    const { lines, logger } = recordingLogger();
    const adoption = await primeStreamSession({
      workDir,
      repo: REPO,
      providerId: "deepseek",
      preferredProviderId: "claude",
      runKind: "implementation",
      logger,
    });
    assert(adoption);
    assertEquals(adoption.outcome, "new");
    assertNotEquals(adoption.state.sessionId, CLAUDE_SESSION);

    // The skip names both providers and the session it declined.
    const skip = lines.find((line) => line.message.includes(CLAUDE_SESSION));
    assert(skip, `expected a skip line, got ${JSON.stringify(lines)}`);
    assert(skip.message.includes("claude"), skip.message);
    assert(skip.message.includes("deepseek"), skip.message);
  });
});

Deno.test("#2638 - switching back to Claude resumes Claude's own session after a DeepSeek run", async () => {
  await withWorkDir(async (workDir) => {
    const stream = resolveStreamId(REPO, undefined);
    await recordStreamSession({
      workDir,
      stream,
      providerId: "claude",
      sessionId: CLAUDE_SESSION,
    });

    // The pace fallback runs one issue on DeepSeek, which opens its own.
    const onDeepSeek = await join(workDir, "deepseek");
    assertEquals(onDeepSeek?.outcome, "new");
    await handOnStreamSession({
      workDir,
      joined: { stream, providerId: "deepseek" },
      state: { sessionId: DEEPSEEK_SESSION, phaseCount: 1 },
      runProviderId: "deepseek",
      logger: recordingLogger().logger,
    });

    // Claude is back: its own session resumes, untouched by the DeepSeek run.
    const onClaude = await join(workDir, "claude");
    assertEquals(onClaude?.outcome, "resumed");
    assertEquals(onClaude?.state.sessionId, CLAUDE_SESSION);
    assertEquals(onClaude?.state.providerId, "claude");

    // And DeepSeek resumes its own, not Claude's.
    const deepSeekAgain = await join(workDir, "deepseek");
    assertEquals(deepSeekAgain?.outcome, "resumed");
    assertEquals(deepSeekAgain?.state.sessionId, DEEPSEEK_SESSION);
  });
});

Deno.test("#2638 - a resumed stream state is bound to its creator at spawn", async () => {
  await withWorkDir(async (workDir) => {
    const stream = resolveStreamId(REPO, undefined);
    await recordStreamSession({
      workDir,
      stream,
      providerId: "claude",
      sessionId: CLAUDE_SESSION,
    });
    const onClaude = await join(workDir, "claude");
    assert(onClaude);
    // If the spawn lands on DeepSeek after all, the CLI flags drop the resume.
    assertEquals(
      sessionResumeForProvider(onClaude.state, "deepseek"),
      undefined,
    );
    assertEquals(
      sessionResumeForProvider(onClaude.state, "claude")?.sessionId,
      CLAUDE_SESSION,
    );
  });
});

Deno.test("#2638 - a legacy record with no provider reads as the preferred provider's", async () => {
  await withWorkDir(async (workDir) => {
    const stream = resolveStreamId(REPO, undefined);
    // Written before the provider was recorded: no `providerId` in either entry.
    await Deno.mkdir(`${workDir}/.claude-sessions/resume`, { recursive: true });
    await Deno.writeTextFile(
      streamSessionPath(workDir, stream),
      JSON.stringify({
        sessions: {
          claude: { sessionId: CLAUDE_SESSION, savedAtEpochMs: 1 },
          deepseek: { sessionId: DEEPSEEK_SESSION, savedAtEpochMs: 2 },
        },
      }),
    );

    // Claude preferred: Claude's legacy entry resumes...
    const onClaude = await join(workDir, "claude");
    assertEquals(onClaude?.outcome, "resumed");
    assertEquals(onClaude?.state.sessionId, CLAUDE_SESSION);
    // ...and the DeepSeek slot's legacy entry is presumed Claude's, so it is
    // not resumed on DeepSeek — which is exactly the GRQ-23 record.
    const onDeepSeek = await join(workDir, "deepseek");
    assertEquals(onDeepSeek?.outcome, "new");
    assertNotEquals(onDeepSeek?.state.sessionId, DEEPSEEK_SESSION);

    // With DeepSeek the preferred provider, the reading flips.
    const preferDeepSeek = await join(workDir, "deepseek", "deepseek");
    assertEquals(preferDeepSeek?.outcome, "resumed");
    assertEquals(preferDeepSeek?.state.sessionId, DEEPSEEK_SESSION);
    const claudeUnderDeepSeek = await join(workDir, "claude", "deepseek");
    assertEquals(claudeUnderDeepSeek?.outcome, "new");

    // The skipped entry is not discarded: the record still holds both.
    const lookup = await lookupStreamSession(workDir, stream, "claude", {
      legacyProviderId: "claude",
    });
    assertEquals(lookup.status, "usable");
  });
});

Deno.test("#2638 - a saved stream session records the provider that created it", async () => {
  await withWorkDir(async (workDir) => {
    const stream = resolveStreamId(REPO, undefined);
    await saveStreamSession(workDir, stream, {
      providerId: "claude",
      sessionId: CLAUDE_SESSION,
    });
    const raw = JSON.parse(
      await Deno.readTextFile(streamSessionPath(workDir, stream)),
    );
    assertEquals(raw.sessions.claude.providerId, "claude");
  });
});

Deno.test("#2638 - hand-on files the session under the provider that served the run", async () => {
  await withWorkDir(async (workDir) => {
    const stream = resolveStreamId(REPO, undefined);
    // Anticipated DeepSeek, but Claude actually served the run and the state
    // carries no provider of its own (a first phase with no captured id).
    await handOnStreamSession({
      workDir,
      joined: { stream, providerId: "deepseek" },
      state: { sessionId: CLAUDE_SESSION, phaseCount: 1 },
      runProviderId: "claude",
      logger: recordingLogger().logger,
    });
    assertEquals(
      (await lookupStreamSession(workDir, stream, "deepseek")).status,
      "none",
    );
    const claude = await lookupStreamSession(workDir, stream, "claude");
    assertEquals(claude.status, "usable");
  });
});

Deno.test("#2638 - compaction never touches another provider's session", async () => {
  const calls: CompactionRunRequest[] = [];
  const result = await compactStreamSession({
    outcome: "resumed",
    providerId: "deepseek",
    sessionProviderId: "claude",
    sessionId: CLAUDE_SESSION,
    transcriptRoot: "/nonexistent",
    runner: (request) => {
      calls.push(request);
      return { ok: true, exitCode: 0 };
    },
  });
  assertEquals(calls.length, 0);
  assertEquals(result.action, "skipped");
  assert(result.message.includes("claude"), result.message);
  assert(result.message.includes("deepseek"), result.message);
  assert(result.message.includes(CLAUDE_SESSION), result.message);
});

Deno.test("#2638 - compaction still runs on the provider's own session", async () => {
  await withWorkDir(async (transcriptRoot) => {
    const calls: CompactionRunRequest[] = [];
    await compactStreamSession({
      outcome: "resumed",
      providerId: "claude",
      sessionProviderId: "claude",
      sessionId: CLAUDE_SESSION,
      transcriptRoot,
      runner: (request) => {
        calls.push(request);
        return { ok: true, exitCode: 0 };
      },
    });
    assertEquals(calls.length, 1);
  });
});

Deno.test("#2638 - the preferred provider ignores the pace fallback's run override", () => {
  const selection = { configured: "claude", env: () => undefined };
  setRunProviderOverride("deepseek");
  try {
    assertEquals(preferredAgentProviderId(selection), "claude");
    assertEquals(preferredStreamProviderId({ selection }), "claude");
    // A repository's pin is its preferred provider.
    assertEquals(
      preferredStreamProviderId({
        repoConfig: { agentProvider: "codex" },
        selection,
      }),
      "codex",
    );
  } finally {
    setRunProviderOverride(undefined);
  }
});
