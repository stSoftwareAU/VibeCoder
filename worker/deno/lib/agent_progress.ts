/**
 * Agent-phase progress lines from the stream-json already in hand
 * (Issue #4169).
 *
 * A 70+ minute execute phase used to show nothing in `worker-*.log` between
 * "Processing issue …" and the outcome — indistinguishable from a hang, so
 * the operator's only gauges were host-side forensics through the work-dir
 * mount, which unattended operation and containment exist to make
 * unnecessary. The runner already parses the agent's `--output-format
 * stream-json` (the no-output watchdog proves the events are read); this
 * tracker folds those events into one compact line per interval:
 *
 *   [agent-progress] execute: 12m4s elapsed · 47 tool calls (last: Edit
 *   worker/deno/lib/container_runtime.ts, 8s ago)
 *
 * Emission is chunk-driven — no timers, so nothing can leak past a test
 * boundary or fire into a closed logger. A silent agent therefore emits
 * nothing, which is exactly the no-output watchdog's territory
 * (Issue #1825); this module reports activity, not silence.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Default milliseconds between progress lines. */
export const AGENT_PROGRESS_INTERVAL_MS = 60_000;

/** Longest tool-detail fragment carried into a progress line. */
const DETAIL_MAX_LENGTH = 80;

/** Options for {@link AgentProgressTracker}. */
export interface AgentProgressTrackerOptions {
  /** Phase name shown in each line (execute, planning, grill-me, …). */
  phase: string;
  /** Milliseconds between lines. Defaults to one minute. */
  intervalMs?: number;
  /** Sink for the progress lines (the worker logger's info). */
  log: (message: string) => void;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/** The last tool call seen in the stream. */
interface LastToolCall {
  summary: string;
  atMs: number;
}

/**
 * The tracker's activity, readable (Issue #4293, part of #4290).
 *
 * The same data the progress line folds in, exposed so the progress-aware
 * timeout can ask "is this run still doing anything?" — how many tool
 * calls, when the last one was, and when the last stdout chunk arrived
 * (which distinguishes "streaming prose, no tools" from "nothing at all").
 */
export interface AgentActivitySnapshot {
  /** Tool calls seen since the run started. */
  toolCalls: number;
  /** Epoch-ms of the most recent tool call, or undefined if none yet. */
  lastToolCallAtMs?: number;
  /**
   * Epoch-ms of the most recent stdout chunk fed to the tracker — every
   * `feed()` advances it, tool_use or not. Before any chunk it is the
   * construction time.
   */
  lastChunkAtMs: number;
}

/** Tool-like Codex item types counted as progress (Issue #1702). */
const CODEX_TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "command",
  "function_call",
  "mcp_tool_call",
  "mcp_tool",
  "tool",
]);

/** Folds stream-json chunks into periodic one-line progress reports. */
export class AgentProgressTracker {
  readonly #phase: string;
  readonly #intervalMs: number;
  readonly #log: (message: string) => void;
  readonly #now: () => number;
  readonly #startMs: number;
  #carry = "";
  #toolCalls = 0;
  #lastTool: LastToolCall | undefined;
  #lastEmitMs: number;
  #lastChunkMs: number;
  /** Codex item ids already counted, so started+completed is not two calls. */
  #seenCodexItems = new Set<string>();

  constructor(options: AgentProgressTrackerOptions) {
    this.#phase = options.phase;
    this.#intervalMs = options.intervalMs ?? AGENT_PROGRESS_INTERVAL_MS;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    this.#startMs = this.#now();
    this.#lastEmitMs = this.#startMs;
    this.#lastChunkMs = this.#startMs;
  }

  /**
   * Read the activity signal (Issue #4293). Pure: no side effects, no
   * timers — safe to call from a watchdog at any cadence.
   */
  snapshot(): AgentActivitySnapshot {
    return {
      toolCalls: this.#toolCalls,
      ...(this.#lastTool ? { lastToolCallAtMs: this.#lastTool.atMs } : {}),
      lastChunkAtMs: this.#lastChunkMs,
    };
  }

  /**
   * Feed decoded stream-json text. Partial lines are carried until their
   * newline arrives; anything unparseable is ignored — the stream is model
   * output and this is telemetry, never control flow.
   */
  feed(text: string): void {
    // Every chunk advances the chunk clock (Issue #4293) — including chunks
    // with no tool_use, so a caller can tell prose from silence.
    //
    // The clock is read ONCE and that reading dates both the chunk and every
    // tool call found in it (Issue #508). Reading it again per tool call let a
    // millisecond tick land in between, dating the call after the chunk that
    // carried it and breaking the lastToolCallAtMs <= lastChunkAtMs invariant
    // the progress-extension gate relies on.
    const atMs = this.#now();
    this.#lastChunkMs = atMs;
    this.#carry += text;
    const pieces = this.#carry.split("\n");
    this.#carry = pieces.pop() ?? "";
    for (const line of pieces) {
      if (line.includes('"tool_use"')) this.#recordToolUses(line, atMs);
      if (
        line.includes('"item.started"') || line.includes('"item.completed"')
      ) {
        this.#recordCodexItems(line, atMs);
      }
    }
    this.#maybeEmit();
  }

  #recordToolUses(line: string, atMs: number): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const message = (parsed as { message?: { content?: unknown } }).message;
    if (!message || !Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (
        typeof block === "object" && block !== null &&
        (block as { type?: unknown }).type === "tool_use"
      ) {
        const name = String((block as { name?: unknown }).name ?? "tool");
        const detail = describeToolInput(
          (block as { input?: unknown }).input,
        );
        this.#toolCalls++;
        this.#lastTool = {
          summary: detail ? `${name} ${detail}` : name,
          atMs,
        };
      }
    }
  }

  /**
   * Count Codex `item.started` / `item.completed` tool-like events
   * (Issue #1702). Reasoning and the final agent message are not tools.
   */
  #recordCodexItems(line: string, atMs: number): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const record = parsed as Record<string, unknown>;
    const msg = record.msg !== null && typeof record.msg === "object" &&
        !Array.isArray(record.msg)
      ? record.msg as Record<string, unknown>
      : undefined;
    const kind = typeof record.type === "string"
      ? record.type
      : typeof msg?.type === "string"
      ? msg.type
      : undefined;
    if (kind !== "item.started" && kind !== "item.completed") return;
    const rawItem = record.item ?? msg?.item;
    if (
      typeof rawItem !== "object" || rawItem === null || Array.isArray(rawItem)
    ) {
      return;
    }
    const item = rawItem as Record<string, unknown>;
    const itemType = typeof item.item_type === "string"
      ? item.item_type
      : typeof item.type === "string"
      ? item.type
      : undefined;
    if (!itemType || !CODEX_TOOL_ITEM_TYPES.has(itemType)) return;
    const id = typeof item.id === "string" ? item.id : undefined;
    if (id) {
      if (this.#seenCodexItems.has(id)) return;
      this.#seenCodexItems.add(id);
    }
    const name = itemType === "command_execution" || itemType === "command"
      ? "Bash"
      : itemType === "mcp_tool_call" || itemType === "mcp_tool"
      ? String(item.name ?? item.server ?? "mcp")
      : String(item.name ?? itemType);
    const detail = describeToolInput({
      command: item.command,
      path: item.path,
      file_path: item.file_path,
      url: item.url,
    });
    this.#toolCalls++;
    this.#lastTool = {
      summary: detail ? `${name} ${detail}` : name,
      atMs,
    };
  }

  #maybeEmit(): void {
    const now = this.#now();
    if (now - this.#lastEmitMs < this.#intervalMs) return;
    this.#lastEmitMs = now;

    const calls = this.#toolCalls === 1 ? "1 tool call" : (
      `${this.#toolCalls} tool calls`
    );
    const last = this.#lastTool
      ? ` (last: ${this.#lastTool.summary}, ${
        formatDuration(now - this.#lastTool.atMs)
      } ago)`
      : "";
    this.#log(
      `[agent-progress] ${this.#phase}: ${
        formatDuration(now - this.#startMs)
      } elapsed · ${calls}${last}`,
    );
  }
}

/** The most operator-useful fragment of a tool call's input. */
function describeToolInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  const candidate = record.file_path ?? record.path ?? record.command ??
    record.pattern ?? record.url;
  if (typeof candidate !== "string" || !candidate) return "";
  const flat = candidate.replace(/\s+/g, " ").trim();
  return flat.length > DETAIL_MAX_LENGTH
    ? `${flat.slice(0, DETAIL_MAX_LENGTH)}…`
    : flat;
}

/** Compact duration: 45s, 1m3s, 12m0s. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}
