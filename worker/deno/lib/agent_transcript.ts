/**
 * Raw agent stream-json transcript, teed to the worker log directory behind
 * an operator switch (Issue #4169, proposal 2; Issue #1141).
 *
 * The compact `[agent-progress]` line (agent_progress.ts) is the default
 * observability; this module is the artefact for diagnosing a stuck, failed
 * or misbehaving session after the fact without re-running it. With
 * `agent_transcript_enabled: true` in `.config.json` the runner tees the raw
 * stream-json to `<log dir>/agent-<runid>[-<issue>].jsonl`; without it
 * nothing extra is written.
 *
 * **`.config.json` is the only operator switch (Issue #1141).** The worker
 * driver settles {@link AGENT_TRANSCRIPT_ENV} from the loaded configuration
 * at start — unconditionally, so a stray host export cannot turn content
 * capture on or off behind the file — and this module reads that settled
 * value wherever in the process tree it is needed. `DEBUG=true` no longer
 * enables the tee: a debug flag that silently starts capturing repository
 * content is a surprise, and it was one.
 *
 * Secrets: the stream is model output, so every line passes through the
 * console secret redaction (Issue #3661) before hitting disk. Redaction is
 * line-based with partial-line carry — a secret split across two stdout
 * chunks is reassembled before the redactor sees it. The stream is NDJSON,
 * so a line is always a complete event (embedded newlines arrive escaped).
 *
 * A line that parses as JSON is redacted value by value, not as raw text
 * ({@link redactTranscriptLine}, Issue #3826): the redaction rules read the
 * escaped form `key: \"value\"` as a bare value starting with `\`, masked
 * only the backslash, and left both an unparseable line and the value itself
 * on disk. The scheduled transcript scan skips a line it cannot parse, so a
 * broken line hid every signal on it.
 *
 * The tee is telemetry, never control flow: a write failure disables the
 * writer with a single warning, and a runaway stream stops at a size cap
 * rather than filling the disk. Appends land per chunk so a wedged
 * session's transcript is inspectable while it is still wedged.
 *
 * Retention: the housekeeping pass every run makes (`run_housekeeping.ts`)
 * runs `log-rotation` — which size-rotates the worker's own logs, transcripts
 * among them (Issue #1267) — and then
 * `worker-log-cleanup`, whose `AGENT_TRANSCRIPT_PATTERN` ages transcripts out
 * with the worker logs: three days, and a 200-file hard cap. Local retention
 * is therefore bounded without an operator doing anything; exporting a
 * transcript anywhere else is the callback hook's decision.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { REDACTION_PLACEHOLDER, redactSecrets } from "./secret_redaction.ts";
import { getRunId } from "./run_id.ts";
import type { SessionLogAbsentReason } from "./run_callbacks.ts";

/**
 * The variable the worker driver settles from `.config.json` at start, and
 * this module reads back. Internal plumbing, not an operator interface — the
 * driver writes it on every run, so exporting it by hand changes nothing.
 */
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

/**
 * Whether the transcript tee is switched on for this run.
 *
 * Reads only the value the driver settled from `agent_transcript_enabled`;
 * `DEBUG` is deliberately not consulted (Issue #1141).
 *
 * @param env - Environment reader, injectable for tests
 * @returns Whether the raw stream is teed to a transcript
 */
export function agentTranscriptEnabled(
  env: (name: string) => string | undefined = readEnvSafe,
): boolean {
  return env(AGENT_TRANSCRIPT_ENV) === "true";
}

/**
 * The directory transcripts are written to and read back from.
 *
 * The one place the location is spelled, so the writer below and
 * `run_callback_context.ts` — which has to find the file the writer made —
 * cannot drift apart, and so Issue #873's platform-standard log directory has
 * a single call site to change rather than two agreeing literals.
 *
 * @param home - The worker's home directory
 * @returns Absolute directory holding this host's transcripts
 */
export function agentTranscriptDir(home: string): string {
  return `${home}/logs`;
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

const transcriptAbsence = new Map<string, SessionLogAbsentReason>();

function absenceKey(runId: string, issueNumber: number): string {
  return `${runId}#${issueNumber}`;
}

/** Record why this issue's transcript will not be on disk. */
export function recordTranscriptAbsence(
  runId: string,
  issueNumber: number,
  reason: SessionLogAbsentReason,
): void {
  transcriptAbsence.set(absenceKey(runId, issueNumber), reason);
}

/** The last recorded absence reason for this issue, if any. */
export function peekTranscriptAbsence(
  runId: string,
  issueNumber: number,
): SessionLogAbsentReason | undefined {
  return transcriptAbsence.get(absenceKey(runId, issueNumber));
}

/** Test seam: drop recorded reasons so cases cannot leak into each other. */
export function resetTranscriptAbsenceForTests(): void {
  transcriptAbsence.clear();
}

/**
 * Redact one stream-json line without breaking its JSON (Issue #3826).
 *
 * A line that parses is redacted on its *decoded* strings and re-serialised,
 * so no rule ever sees — or consumes — the backslash of an escaped quote. The
 * raw-text pass still runs over the whole line, and nothing it masks is
 * allowed back onto disk:
 *
 *  - a member whose key alone makes it a secret (`"api_key":"…"`) is masked
 *    whole, as the raw pass masked it;
 *  - a string or key holding text the raw pass masked but the decoded pass
 *    kept (a rule whose context spans sibling strings, such as an AWS key id
 *    beside its secret) is masked whole;
 *  - a line that is clean decoded but not as raw text (a secret in an earlier
 *    duplicate key, which `JSON.parse` drops) is re-serialised rather than
 *    written as it arrived.
 *
 * Only a line clean both ways is written byte for byte. A line that is not
 * JSON (a stray stderr line, a truncated tail) — or one the walk cannot finish,
 * such as one nested deeper than the call stack — gets the raw-text pass,
 * which is the most that can be done for it and never throws.
 *
 * @param line - One NDJSON line, without its newline
 * @param redact - Text redactor (the console secret redaction)
 * @returns The redacted line; valid JSON whenever the input was and could be
 *          walked
 */
export function redactTranscriptLine(
  line: string,
  redact: (text: string) => string = redactSecrets,
): string {
  const raw = redact(line);
  try {
    return redactDecodedLine(line, raw, redact);
  } catch {
    return raw;
  }
}

/**
 * The decoded half of {@link redactTranscriptLine}. Throws when the line is
 * not JSON or is too deeply nested to walk; the caller falls back to `raw`.
 */
function redactDecodedLine(
  line: string,
  raw: string,
  redact: (text: string) => string,
): string {
  const event: unknown = JSON.parse(line);
  const rawChanged = raw !== line;
  // Compare cross-string detections against a canonical serialisation whose
  // structural separators carry whitespace. That preserves JSON.stringify's
  // property order (including integer-like keys, matching Object.entries)
  // while stopping a raw secret-assignment rule from reading through the end
  // of one JSON string into the next member. Rules deliberately spanning
  // siblings (for example the AWS key-id/secret pair) still see both strings.
  const contextLine = spaceJsonSeparators(JSON.stringify(event));
  const contextRaw = redact(contextLine);
  const contextChanged = contextRaw !== contextLine;
  let changed = false;
  // Whether the key alone makes a member a secret, judged on a neutral value.
  const secretNamed = (key: string): boolean => {
    const probe = `${key}: "x1"`;
    return redact(probe) !== probe;
  };
  const escaped = (text: string): string => JSON.stringify(text).slice(1, -1);
  // The words of an escaped string, split on masks, whitespace, double quotes
  // and escape sequences: the raw pass rewrites the escaped quote itself (the
  // Issue #3826 backslash) and reads an escaped newline as ordinary text.
  const words = (text: string): string[] =>
    text.split(REDACTION_PLACEHOLDER)
      .flatMap((run) => run.split(WORD_SEPARATOR))
      .filter((word) => word !== "");
  // Whether the raw pass masked something in `text`, through context outside
  // it, that the decoded pass (`own`) kept.
  //
  // Strings and keys are visited in JSON.stringify/Object.entries order, so
  // one cursor moves forward through `contextRaw` for the whole walk, and
  // each string is looked for only in its own span after the cursor (its
  // length, plus RAW_SPAN_SLACK, plus the numbers, booleans and nulls walked
  // since the last string):
  // the check stays linear in the line, as redaction over model and tool
  // output must (SECURITY.md). A string the raw pass left alone matches its
  // decoded mask; one it masked only through its own text — such as a bare
  // value running past an escaped newline — matches its own raw-pass result
  // (`local`). Anything else is checked word by word, and a word counts as
  // lost only when `local` keeps it but the span does not: that is a mask
  // made from context outside the string (an AWS key id in a sibling
  // string). Words may share a position, because the raw pass rewrites the
  // escaped quote.
  let lineCursor = 0;
  let skipped = 0;
  const lostToRaw = (text: string, own: string): boolean => {
    if (!contextChanged) return false;
    const slack = RAW_SPAN_SLACK + skipped;
    skipped = 0;
    const whole = escaped(own);
    const near = contextRaw.slice(
      lineCursor,
      lineCursor + whole.length + slack,
    );
    const at = near.indexOf(whole);
    if (at !== -1) {
      lineCursor += at + whole.length;
      return false;
    }
    const local = redact(escaped(text));
    const span = contextRaw.slice(
      lineCursor,
      lineCursor + Math.max(whole.length, local.length) + slack,
    );
    const localAt = span.indexOf(local);
    if (localAt !== -1) {
      lineCursor += localAt + local.length;
      return false;
    }
    const kept = new Set(words(local));
    let cursor = 0;
    let reached = 0;
    let lost = false;
    for (const word of words(whole)) {
      if (!kept.has(word)) continue;
      const found = span.indexOf(word, cursor);
      if (found === -1) {
        lost = true;
        continue;
      }
      cursor = found;
      reached = Math.max(reached, found + word.length);
    }
    lineCursor += reached;
    return lost;
  };
  // A string's own mask, widened to the whole string when the raw pass saw a
  // secret in it through context the decoded string lacks (an AWS key id in
  // a sibling string). Strings both passes agree on keep the finer mask.
  const redactString = (text: string): string => {
    const own = redact(text);
    if (lostToRaw(text, own)) {
      changed = true;
      return REDACTION_PLACEHOLDER;
    }
    if (own !== text) changed = true;
    return own;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") {
      skipped += String(value).length + 1;
      return value;
    }
    // Null prototype, so a `__proto__` member stays an ordinary own property.
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, member] of Object.entries(value)) {
      const name = redactString(key);
      if (typeof member === "string" && secretNamed(key)) {
        const assignment = `${key}: ${JSON.stringify(member)}`;
        if (redact(assignment) !== assignment) {
          changed = true;
          out[name] = REDACTION_PLACEHOLDER;
          continue;
        }
      }
      out[name] = walk(member);
    }
    return out;
  };
  const redacted = walk(event);
  return changed || rawChanged ? JSON.stringify(redacted) : line;
}

/**
 * Add one space after structural commas and colons in compact JSON.
 *
 * This is deliberately token-aware: punctuation inside JSON strings is left
 * untouched. The resulting text need not be written anywhere; it exists only
 * to give the raw redactor the same sibling context without letting a
 * non-whitespace lookahead cross a JSON member boundary.
 */
function spaceJsonSeparators(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const char of json) {
    out += char;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "," || char === ":") {
      out += " ";
    }
  }
  return out;
}

/**
 * How far past a string's own length its span in the raw-pass output may
 * reach, beyond the non-string values walked before it: room for the JSON
 * punctuation before it and for masks longer than what they replaced. A
 * string not found within it is judged word by word, which only masks more.
 */
const RAW_SPAN_SLACK = 256;

/** Splits escaped JSON string text into words: see `words` above. */
const WORD_SEPARATOR = /(?:[\s"]|\\u[0-9a-fA-F]{4}|\\.)+/;

/** Options for {@link AgentTranscriptWriter}. */
export interface AgentTranscriptWriterOptions {
  /** Destination file; appended to, created if missing. */
  filePath: string;
  /**
   * Text redactor, applied through {@link redactTranscriptLine} to every
   * whole line. Defaults to {@link redactSecrets}.
   */
  redact?: (text: string) => string;
  /** Sink for the single disable warning (the worker logger's warn). */
  warn?: (message: string) => void;
  /** Byte ceiling. Defaults to {@link DEFAULT_MAX_TRANSCRIPT_BYTES}. */
  maxBytes?: number;
  /** Run id, so a disable reason can reach the callback context. */
  runId?: string;
  /** Issue number, so a disable reason can reach the callback context. */
  issueNumber?: number;
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
  readonly #runId: string | undefined;
  readonly #issueNumber: number | undefined;
  #carry = "";
  #bytesWritten = 0;
  #disabled = false;
  #disableReason: SessionLogAbsentReason | undefined;

  constructor(options: AgentTranscriptWriterOptions) {
    this.#filePath = options.filePath;
    this.#redact = options.redact ?? redactSecrets;
    this.#warn = options.warn;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
    this.#runId = options.runId;
    this.#issueNumber = options.issueNumber;
  }

  /** Where the transcript is being written. */
  get filePath(): string {
    return this.#filePath;
  }

  /** Why the tee stopped, when it has. */
  get disableReason(): SessionLogAbsentReason | undefined {
    return this.#disableReason;
  }

  #recordDisable(reason: SessionLogAbsentReason): void {
    this.#disabled = true;
    this.#disableReason = reason;
    if (this.#runId !== undefined && this.#issueNumber !== undefined) {
      recordTranscriptAbsence(this.#runId, this.#issueNumber, reason);
    }
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
    const redacted = this.#redactLines(pieces);
    if (redacted !== undefined) this.#append(redacted);
  }

  /** Flush any trailing partial line. Safe to call more than once. */
  close(): void {
    if (this.#disabled || this.#carry.length === 0) return;
    const tail = this.#carry;
    this.#carry = "";
    const redacted = this.#redactLines([tail]);
    if (redacted !== undefined) this.#append(redacted);
  }

  /**
   * Redact whole lines for the file. The tee is telemetry, never control
   * flow: it runs inside the agent's stdout pump, so a redactor that throws
   * disables the writer with its single warning instead of propagating.
   */
  #redactLines(lines: string[]): string | undefined {
    try {
      return lines.map((line) => redactTranscriptLine(line, this.#redact))
        .join("\n") + "\n";
    } catch (err) {
      this.#recordDisable("write_failed");
      this.#warn?.(
        `Agent transcript redaction for ${this.#filePath} failed (${
          err instanceof Error ? err.message : String(err)
        }) — tee disabled for this invocation`,
      );
      return undefined;
    }
  }

  #append(text: string): void {
    if (this.#bytesWritten + text.length > this.#maxBytes) {
      this.#recordDisable("size_cap_exceeded");
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
      this.#recordDisable("write_failed");
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
   * is created regardless of the configured switch.
   */
  explicitPath?: string;
  /** Sink for warnings (the worker logger's warn). */
  warn?: (message: string) => void;
  /** Env reader, injectable for tests. */
  env?: (name: string) => string | undefined;
}

/**
 * Create the transcript writer when the configured switch asks for one.
 *
 * Returns undefined — and writes nothing, ever — when the configured switch
 * is off and no explicit path was given. Failure to create the log directory
 * disables the tee with a warning rather than failing the phase.
 */
export function maybeCreateAgentTranscriptWriter(
  options: MaybeCreateAgentTranscriptOptions = {},
): AgentTranscriptWriter | undefined {
  const env = options.env ?? readEnvSafe;
  const runId = env("VIBE_RUN_ID")?.trim() || getRunId();
  let filePath = options.explicitPath;
  if (filePath === undefined) {
    if (!agentTranscriptEnabled(env)) return undefined;
    const home = env("HOME") ?? env("USERPROFILE") ?? "";
    if (!home) {
      if (options.issueNumber !== undefined) {
        recordTranscriptAbsence(
          runId,
          options.issueNumber,
          "log_dir_unavailable",
        );
      }
      return undefined;
    }
    filePath = agentTranscriptPath(
      agentTranscriptDir(home),
      runId,
      options.issueNumber,
    );
  }
  const dir = filePath.slice(0, filePath.lastIndexOf("/"));
  if (dir) {
    try {
      Deno.mkdirSync(dir, { recursive: true });
    } catch (err) {
      if (options.issueNumber !== undefined) {
        recordTranscriptAbsence(
          runId,
          options.issueNumber,
          "log_dir_unavailable",
        );
      }
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
    runId,
    ...(options.issueNumber !== undefined
      ? { issueNumber: options.issueNumber }
      : {}),
  });
}
