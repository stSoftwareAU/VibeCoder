/**
 * Raw agent stream-json transcript, teed to `~/logs` behind a debug flag
 * (Issue #4169, proposal 2).
 *
 * The compact `[agent-progress]` line (agent_progress.ts) is the default
 * observability; this module is the on-demand artefact for diagnosing a
 * stuck or misbehaving session after the fact without re-running it. With
 * `VIBE_AGENT_TRANSCRIPT=true` (or `DEBUG=true`) the runner tees the raw
 * stream-json to `~/logs/agent-<runid>[-<issue>].jsonl`; without the flag
 * nothing extra is written.
 *
 * Secrets: the stream is model output, so every line passes through the
 * console secret redaction (Issue #3661) before hitting disk. Redaction is
 * line-based with partial-line carry — a secret split across two stdout
 * chunks is reassembled before the redactor sees it. The stream is NDJSON,
 * so a line is always a complete event (embedded newlines arrive escaped);
 * line-level redaction therefore sees the same unit the logger does.
 *
 * The tee is telemetry, never control flow: a write failure disables the
 * writer with a single warning, and a runaway stream stops at a size cap
 * rather than filling the disk. Appends land per chunk so a wedged
 * session's transcript is inspectable while it is still wedged.
 *
 * Retention: worker_log_cleanup.ts ages transcripts out with the worker
 * logs, and log_rotation.ts already size-rotates `*.jsonl` files.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { redactSecrets } from "./secret_redaction.ts";
import { getRunId } from "./run_id.ts";

/** Env flag that enables the transcript tee on its own. */
export const AGENT_TRANSCRIPT_ENV = "VIBE_AGENT_TRANSCRIPT";

/**
 * Ceiling on transcript bytes per invocation. A long execute phase streams
 * a few MB; anything near this cap is a runaway and the tail is unlikely
 * to add diagnostic value over the first 100 MB.
 */
export const DEFAULT_MAX_TRANSCRIPT_BYTES = 100 * 1024 * 1024;

/** Reads an env var, tolerating a denied `--allow-env`. */
function readEnvSafe(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** Whether the transcript tee is enabled by environment flags. */
export function agentTranscriptEnabled(
  env: (name: string) => string | undefined = readEnvSafe,
): boolean {
  return env(AGENT_TRANSCRIPT_ENV) === "true" || env("DEBUG") === "true";
}

/** Transcript file path: `agent-<runid>[-<issue>].jsonl` under the log dir. */
export function agentTranscriptPath(
  logDir: string,
  runId: string,
  issueNumber?: number,
): string {
  const issue = issueNumber !== undefined ? `-${issueNumber}` : "";
  return `${logDir}/agent-${runId}${issue}.jsonl`;
}

/** Options for {@link AgentTranscriptWriter}. */
export interface AgentTranscriptWriterOptions {
  /** Destination file; appended to, created if missing. */
  filePath: string;
  /** Redactor applied to every whole line. Defaults to {@link redactSecrets}. */
  redact?: (text: string) => string;
  /** Sink for the single disable warning (the worker logger's warn). */
  warn?: (message: string) => void;
  /** Byte ceiling. Defaults to {@link DEFAULT_MAX_TRANSCRIPT_BYTES}. */
  maxBytes?: number;
}

/**
 * Tees decoded stream-json text to a redacted transcript file.
 *
 * Chunk-driven like {@link AgentProgressTracker} — no timers, nothing to
 * leak past a test boundary. `feed()` appends completed lines; `close()`
 * flushes a trailing partial line.
 */
export class AgentTranscriptWriter {
  readonly #filePath: string;
  readonly #redact: (text: string) => string;
  readonly #warn: ((message: string) => void) | undefined;
  readonly #maxBytes: number;
  #carry = "";
  #bytesWritten = 0;
  #disabled = false;

  constructor(options: AgentTranscriptWriterOptions) {
    this.#filePath = options.filePath;
    this.#redact = options.redact ?? redactSecrets;
    this.#warn = options.warn;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
  }

  /** Where the transcript is being written. */
  get filePath(): string {
    return this.#filePath;
  }

  /**
   * Feed decoded stream text. Partial lines are carried until their newline
   * arrives so the redactor always sees whole lines.
   */
  feed(text: string): void {
    if (this.#disabled) return;
    this.#carry += text;
    const pieces = this.#carry.split("\n");
    this.#carry = pieces.pop() ?? "";
    if (pieces.length === 0) return;
    this.#append(pieces.map((line) => this.#redact(line)).join("\n") + "\n");
  }

  /** Flush any trailing partial line. Safe to call more than once. */
  close(): void {
    if (this.#disabled || this.#carry.length === 0) return;
    const tail = this.#carry;
    this.#carry = "";
    this.#append(this.#redact(tail) + "\n");
  }

  #append(text: string): void {
    if (this.#bytesWritten + text.length > this.#maxBytes) {
      this.#disabled = true;
      this.#warn?.(
        `Agent transcript ${this.#filePath} reached its ${
          Math.round(this.#maxBytes / (1024 * 1024))
        }MB size cap — tee stopped, the stream keeps running`,
      );
      return;
    }
    try {
      Deno.writeTextFileSync(this.#filePath, text, { append: true });
      this.#bytesWritten += text.length;
    } catch (err) {
      this.#disabled = true;
      this.#warn?.(
        `Agent transcript write to ${this.#filePath} failed (${
          err instanceof Error ? err.message : String(err)
        }) — tee disabled for this invocation`,
      );
    }
  }
}

/** Options for {@link maybeCreateAgentTranscriptWriter}. */
export interface MaybeCreateAgentTranscriptOptions {
  /** Issue number for the file name, when the invocation has one. */
  issueNumber?: number;
  /**
   * Explicit destination (test seam / caller override). When set, the tee
   * is created regardless of the env flags.
   */
  explicitPath?: string;
  /** Sink for warnings (the worker logger's warn). */
  warn?: (message: string) => void;
  /** Env reader, injectable for tests. */
  env?: (name: string) => string | undefined;
}

/**
 * Create the transcript writer when the debug flag asks for one.
 *
 * Returns undefined — and writes nothing, ever — when neither
 * `VIBE_AGENT_TRANSCRIPT=true` nor `DEBUG=true` is set and no explicit
 * path was given. Failure to create the log directory disables the tee
 * with a warning rather than failing the phase.
 */
export function maybeCreateAgentTranscriptWriter(
  options: MaybeCreateAgentTranscriptOptions = {},
): AgentTranscriptWriter | undefined {
  const env = options.env ?? readEnvSafe;
  let filePath = options.explicitPath;
  if (filePath === undefined) {
    if (!agentTranscriptEnabled(env)) return undefined;
    const home = env("HOME") ?? env("USERPROFILE") ?? "";
    if (!home) return undefined;
    filePath = agentTranscriptPath(
      `${home}/logs`,
      env("VIBE_RUN_ID")?.trim() || getRunId(),
      options.issueNumber,
    );
  }
  const dir = filePath.slice(0, filePath.lastIndexOf("/"));
  if (dir) {
    try {
      Deno.mkdirSync(dir, { recursive: true });
    } catch (err) {
      options.warn?.(
        `Agent transcript directory ${dir} could not be created (${
          err instanceof Error ? err.message : String(err)
        }) — tee disabled for this invocation`,
      );
      return undefined;
    }
  }
  return new AgentTranscriptWriter({
    filePath,
    ...(options.warn ? { warn: options.warn } : {}),
  });
}
