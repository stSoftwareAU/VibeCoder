/**
 * Compacting a stream's conversation before a new issue (Issue #2337).
 *
 * A stream owns one conversation across every issue that runs on it
 * (`stream_session.ts`, #2333), so that conversation only grows. Left alone it
 * eventually fills the model's context window and the *next* issue is the one
 * that dies of it. This module compacts it once, at the join, before the
 * issue's first phase starts.
 *
 * ## Two levers, and a verified outcome
 *
 * Claude and DeepSeek run the same CLI, so the same two levers apply:
 *
 * 1. `/compact` sent as the prompt of a `--resume <sessionId>` print run.
 *    Whether that actually compacts the durable transcript is not something
 *    the worker can assume, so it is **measured**: the transcript file's size
 *    is recorded before and after, and only a genuinely smaller file counts as
 *    a compaction.
 * 2. `--autocompact 100000` — the smallest window the CLI accepts, so
 *    compaction happens as early as the CLI will do it — passed to every phase
 *    run of the issue when the first lever did not demonstrably work.
 *
 * The fallback fires on anything short of proof: an unchanged or larger
 * transcript, a non-zero `/compact` run, a transcript that cannot be measured,
 * or a spawn that failed outright. Absence of a failure is never read as
 * success. None of it can fail the issue — compaction is an optimisation, and
 * the worst outcome is the conversation the run would have carried anyway.
 *
 * Codex and Gemini expose no compaction control to the worker at all, so their
 * runs carry the stream's full transcript and say so.
 *
 * Every run logs **exactly one** compaction line, whichever path it took.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  CLAUDE_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  resolveAgentProvider,
} from "./agent_provider.ts";
import { runClaudeWithTimeout } from "./claude_runner.ts";
import type {
  StreamSessionLogger,
  StreamSessionOutcome,
} from "./stream_session.ts";

/**
 * The `--autocompact` window the fallback asks for.
 *
 * 100,000 tokens is the smallest value the CLI accepts, which is the point:
 * the smaller the window, the earlier the CLI compacts of its own accord.
 */
export const AUTOCOMPACT_WINDOW_TOKENS = 100_000;

/** The prompt that asks the CLI to compact the resumed conversation. */
export const COMPACT_PROMPT = "/compact";

/**
 * Wall-clock cap on the `/compact` run. Compaction is one summarising turn on
 * an existing conversation; anything longer is a stuck CLI, and the issue's
 * own work is still waiting behind it.
 */
export const COMPACT_TIMEOUT_SECONDS = 180;

/** The providers whose CLI exposes a compaction lever (they share one binary). */
const COMPACTABLE_PROVIDER_IDS: readonly string[] = [
  CLAUDE_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
];

/** Which of the four paths a run took. */
export type StreamCompactionAction =
  /** `/compact` ran and the transcript is measurably smaller. */
  | "compacted"
  /** Uncompacted — every phase run of this issue carries `--autocompact`. */
  | "autocompact"
  /**
   * Nothing of this provider's to compact: the stream session opened this
   * run, or another provider created it (Issue #2638).
   */
  | "skipped"
  /** The provider exposes no compaction control to the worker. */
  | "unavailable";

/** What the compaction did, and the one line the run logs about it. */
export interface StreamCompactionResult {
  action: StreamCompactionAction;
  /**
   * The `--autocompact` window every phase run of this issue must carry.
   * Present only for the `autocompact` action.
   */
  autocompactTokens?: number;
  /** The single compaction line — see the four `compaction…` phrasings. */
  message: string;
  /** Context for that line: sizes, exit codes, and why a fallback fired. */
  fields: Record<string, unknown>;
}

/** What the `/compact` print run is asked to do. */
export interface CompactionRunRequest {
  providerId: string;
  /** The stream session the print run resumes. */
  sessionId: string;
  prompt: string;
  timeoutSeconds: number;
  /** Repository checkout the CLI runs in, when the caller has one. */
  cwd?: string;
  /** Durable work volume, for the runner's own signal files. */
  workDir?: string;
}

/** How a `/compact` print run ended. */
export interface CompactionRunOutcome {
  /** Did the run happen at all? `false` means the spawn itself failed. */
  ok: boolean;
  /** The CLI's exit code, when one was produced. */
  exitCode?: number;
  /** Why the run failed, when it did. */
  detail?: string;
}

/** The `/compact` print run — injectable so a test drives it without a CLI. */
export type CompactionRunner = (
  request: CompactionRunRequest,
) => Promise<CompactionRunOutcome> | CompactionRunOutcome;

/** Everything {@link compactStreamSession} needs to decide and act. */
export interface StreamCompactionOptions {
  /** What joining the stream did — only a `resumed` session has a history. */
  outcome: StreamSessionOutcome;
  /** The provider this run is on — the one the print run would spawn. */
  providerId: string;
  /**
   * The provider that created {@link sessionId} (Issue #2638), when the
   * session state records it. A session another provider created is never
   * compacted: the print run would replay that provider's transcript on this
   * one's endpoint.
   */
  sessionProviderId?: string;
  /** The stream session id the print run resumes. */
  sessionId: string;
  /**
   * The child's `CLAUDE_CONFIG_DIR`, holding `projects/**\/<sessionId>.jsonl`.
   * Omitted — every production caller — it is read from the provider's own
   * child environment, which is where the CLI will write the transcript.
   */
  transcriptRoot?: string;
  /** Parent environment the child env is derived from; tests name their own. */
  parentEnv?: Record<string, string>;
  /** Repository checkout the print run happens in. */
  cwd?: string;
  /** Durable work volume. */
  workDir?: string;
  runner?: CompactionRunner;
  timeoutSeconds?: number;
}

/** Does this provider expose a compaction lever to the worker? */
export function supportsCompaction(providerId: string): boolean {
  return COMPACTABLE_PROVIDER_IDS.includes(providerId);
}

/** The fallback outcome — every phase run of the issue carries the flag. */
function autocompactResult(
  fields: Record<string, unknown>,
): StreamCompactionResult {
  return {
    action: "autocompact",
    autocompactTokens: AUTOCOMPACT_WINDOW_TOKENS,
    message: `compaction: autocompact ${AUTOCOMPACT_WINDOW_TOKENS}`,
    fields,
  };
}

/**
 * Total bytes of the session's transcript, or `undefined` when there is
 * nothing to measure.
 *
 * The CLI files transcripts one directory per project under `projects/`, and
 * the worker does not own that naming, so the tree is walked for the session's
 * own `<sessionId>.jsonl` rather than a path being predicted. `undefined` is
 * deliberately distinct from `0`: "cannot be measured" must never be read as a
 * shrink.
 */
async function transcriptBytes(
  transcriptRoot: string,
  sessionId: string,
): Promise<number | undefined> {
  const wanted = `${sessionId}.jsonl`;
  let total: number | undefined;
  const walk = async (dir: string): Promise<void> => {
    // `Deno.readDir` hands back the iterable synchronously and raises
    // `NotFound` on the first `next()`, so the iteration — not the call —
    // is what has to be guarded. A host whose `projects/` directory does not
    // exist yet is the ordinary first run, not a fault to propagate.
    try {
      for await (const entry of Deno.readDir(dir)) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory) {
          await walk(path);
          continue;
        }
        if (entry.name !== wanted) continue;
        try {
          const stat = await Deno.stat(path);
          total = (total ?? 0) + stat.size;
        } catch {
          // Vanished between readDir and stat — it measures nothing.
        }
      }
    } catch {
      // Missing or unreadable: nothing to measure here. The caller reads an
      // unmeasured transcript as "not proved compacted", never as a shrink.
    }
  };
  await walk(`${transcriptRoot}/projects`);
  return total;
}

/**
 * Where this provider's CLI writes its transcripts, read from the very child
 * environment the run will use, so Claude's and DeepSeek's separate config
 * directories are each found without restating either here.
 */
function resolveTranscriptRoot(
  providerId: string,
  parentEnv?: Record<string, string>,
): string | undefined {
  const env = resolveAgentProvider(providerId).buildChildEnv(parentEnv);
  const configured = env["CLAUDE_CONFIG_DIR"];
  if (configured) return configured;
  return env["HOME"] ? `${env["HOME"]}/.claude` : undefined;
}

/** The production `/compact` run: one print turn resuming the stream session. */
async function defaultCompactionRunner(
  request: CompactionRunRequest,
): Promise<CompactionRunOutcome> {
  const result = await runClaudeWithTimeout({
    prompt: request.prompt,
    timeoutSeconds: request.timeoutSeconds,
    agentProvider: request.providerId,
    // Named so the run is not one more `phase=unknown` telemetry line
    // (Issue #2709's complaint). No table routes this phase, so the chain
    // falls through to the configured base model — a summarising turn has no
    // use for the issue phase's top tier.
    phase: "compaction",
    // phaseCount 1 is what makes the CLI flags `--resume <id>` rather than
    // `--session-id <id>`: this run continues the stream's conversation.
    sessionResumeState: {
      sessionId: request.sessionId,
      phaseCount: 1,
      providerId: request.providerId,
    },
    ...(request.cwd ? { cwd: request.cwd } : {}),
    ...(request.workDir ? { workDir: request.workDir } : {}),
  });
  if (!result.ok) return { ok: false, detail: result.error.message };
  return { ok: true, exitCode: result.value.exitCode };
}

/**
 * Compact this stream's conversation, and say what actually happened.
 *
 * Never throws and never fails an issue: every fault resolves to the
 * `autocompact` fallback with the reason recorded in {@link
 * StreamCompactionResult.fields}.
 */
export async function compactStreamSession(
  options: StreamCompactionOptions,
): Promise<StreamCompactionResult> {
  const { outcome, providerId, sessionId } = options;

  if (outcome !== "resumed") {
    return {
      action: "skipped",
      message: "compaction skipped: new stream session",
      fields: { providerId, outcome },
    };
  }

  const { sessionProviderId } = options;
  if (sessionProviderId !== undefined && sessionProviderId !== providerId) {
    return {
      action: "skipped",
      message: `compaction skipped: stream session ${sessionId} was created ` +
        `by ${sessionProviderId}, not ${providerId} (Issue #2638)`,
      fields: { providerId, sessionProviderId, outcome },
    };
  }

  if (!supportsCompaction(providerId)) {
    return {
      action: "unavailable",
      message:
        `compaction unavailable: ${providerId} exposes no compaction control ` +
        `to the worker, so this run carries the stream's full transcript`,
      fields: { providerId },
    };
  }

  let transcriptRoot: string | undefined;
  try {
    transcriptRoot = options.transcriptRoot ??
      resolveTranscriptRoot(providerId, options.parentEnv);
  } catch (error) {
    return autocompactResult({
      providerId,
      compactError: describe(error),
      reason: "the provider's transcript directory could not be resolved",
    });
  }
  if (!transcriptRoot) {
    return autocompactResult({
      providerId,
      reason: "no transcript directory to measure the compaction against",
    });
  }

  const before = await transcriptBytes(transcriptRoot, sessionId);

  const runner = options.runner ?? defaultCompactionRunner;
  let run: CompactionRunOutcome;
  try {
    run = await runner({
      providerId,
      sessionId,
      prompt: COMPACT_PROMPT,
      timeoutSeconds: options.timeoutSeconds ?? COMPACT_TIMEOUT_SECONDS,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.workDir ? { workDir: options.workDir } : {}),
    });
  } catch (error) {
    return autocompactResult({
      providerId,
      compactError: describe(error),
      reason: "the /compact run could not be spawned",
    });
  }

  const exitFields = {
    providerId,
    ...(run.exitCode !== undefined ? { compactExitCode: run.exitCode } : {}),
    ...(run.detail ? { compactError: run.detail } : {}),
  };

  if (!run.ok || run.exitCode !== 0) {
    return autocompactResult({
      ...exitFields,
      reason: "the /compact run did not exit cleanly",
    });
  }

  const after = await transcriptBytes(transcriptRoot, sessionId);
  if (before === undefined || after === undefined) {
    return autocompactResult({
      ...exitFields,
      reason:
        "the transcript could not be measured, so nothing proved it shrank",
    });
  }
  if (after >= before) {
    return autocompactResult({
      ...exitFields,
      transcriptBytesBefore: before,
      transcriptBytesAfter: after,
      reason: "the transcript did not shrink",
    });
  }

  return {
    action: "compacted",
    message: "compaction: /compact",
    fields: {
      ...exitFields,
      transcriptBytesBefore: before,
      transcriptBytesAfter: after,
    },
  };
}

/**
 * {@link compactStreamSession} for a run: logs the one compaction line and
 * returns the `--autocompact` window the issue's phase runs must carry
 * (`undefined` when they must not).
 */
export async function primeStreamCompaction(
  options: StreamCompactionOptions & {
    logger: StreamSessionLogger;
    /** Extra fields for the log line — the repo and issue, typically. */
    logFields?: Record<string, unknown>;
  },
): Promise<number | undefined> {
  const { logger, logFields, ...rest } = options;
  let result: StreamCompactionResult;
  try {
    result = await compactStreamSession(rest);
  } catch (error) {
    // `compactStreamSession` handles its own faults; this is the backstop
    // that keeps a compaction from ever reaching the issue as a failure.
    result = supportsCompaction(rest.providerId)
      ? autocompactResult({
        providerId: rest.providerId,
        compactError: describe(error),
        reason: "the compaction itself faulted",
      })
      : {
        action: "unavailable",
        message: `compaction unavailable: ${rest.providerId}`,
        fields: { providerId: rest.providerId, compactError: describe(error) },
      };
  }
  // One line, at the level that says what the reader must do: the fallback is
  // a degraded run that continues — the conversation was not compacted and the
  // CLI's own window is now the only defence — so it is a warning, while a
  // verified compaction, a new session and a provider without the lever are
  // all expected outcomes.
  const record = result.action === "autocompact" ? logger.warn : logger.info;
  record.call(logger, result.message, { ...logFields, ...result.fields });
  return result.autocompactTokens;
}

/** An error's message, whatever was thrown. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
