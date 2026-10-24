/**
 * Bounded, redacted evidence of a wedged container, captured before the
 * launcher watchdog reaps it (Issue #4253).
 *
 * A kill destroys the only evidence of why a container wedged: the worker's
 * last log lines, the agent's last tool call, the VM's boot log and its
 * process and memory state. This module reads that evidence first and writes
 * it to `hard-kill-<container>-<epoch>.json` in the evidence directory.
 *
 * Capture never blocks or throws. Every step is bounded by a timeout, the
 * whole capture is bounded by a total cap, and a step that fails is recorded
 * in the file as `unavailable: <cause>` rather than dropped silently. Every
 * string in the record is passed through `redactGhBodyText` (see
 * `gh_body_redaction.ts`) before it is written.
 *
 * Uses Australian English spelling throughout (behaviour, colour, etc.).
 */

import { redactGhBodyText } from "./gh_body_redaction.ts";

/** Schema version of the evidence file. */
export const HARD_KILL_EVIDENCE_VERSION = 1;

/** Prefix on every field that could not be collected, and why. */
export const UNAVAILABLE_PREFIX = "unavailable: ";

/** Lines of the worker log kept in the evidence. */
export const WORKER_LOG_TAIL_LINES = 200;

/** Lines of the agent transcript kept in the evidence. */
export const TRANSCRIPT_TAIL_LINES = 50;

/** Bytes read from the end of each log or transcript. */
export const TAIL_READ_BYTES = 256 * 1024;

/** Longest text kept for any one evidence field. */
export const MAX_FIELD_CHARS = 64 * 1024;

/** Longest single line kept; longer lines are cut and marked. */
export const MAX_LINE_CHARS = 2000;

/** Longest serialised tool call kept. */
export const MAX_TOOL_CALL_CHARS = 500;

/** Bound on one `container exec` or boot-log invocation for guest probes. */
export const DEFAULT_EXEC_TIMEOUT_MS = 10_000;

/** Bound on one evidence step (a listing, a read, a write, a runtime call). */
export const DEFAULT_STEP_TIMEOUT_MS = 15_000;

/** Bound on the whole capture, after which fields not yet read stay unavailable. */
export const DEFAULT_TOTAL_CAP_MS = 60_000;

/** Lines of the VM boot log kept in the evidence. */
const BOOT_LOG_TAIL_LINES = 200;

/** Lines of guest command output kept for each guest field. */
const GUEST_TAIL_LINES = 500;

const WORKER_LOG_RE = /^worker(?:-\d+)*\.log$/;
const TRANSCRIPT_RE = /^agent-.+\.jsonl$/;
const RUN_ID_RE = /\bvibe-[0-9a-z]+-[0-9a-f]{6}\b/g;
const TRANSCRIPT_RUN_ID_RE =
  /^agent-(vibe-[0-9a-z]+-[0-9a-f]{6})(?:-\d+)?\.jsonl$/;
const LOG_TIMESTAMP_RE = /^\[(\d{4}-\d{2}-\d{2}[T ][0-9:.]+Z?)\]/;

/** What one bounded runtime invocation reported (code -1 = not completed). */
export interface EvidenceInvocation {
  code: number;
  stdout: string;
  stderr: string;
}

/** Every operation the capture needs, injected so tests perform none of them. */
export interface EvidenceSeams {
  /** Run the container runtime, bounded by a timeout. */
  runRuntime(
    args: readonly string[],
    timeoutMs: number,
  ): Promise<EvidenceInvocation>;
  /** List the regular files in a directory, with their modification times. */
  listLogFiles(dir: string): Promise<{ name: string; mtimeMs: number }[]>;
  /** Read up to the last `maxBytes` bytes of a file as text. */
  readTail(path: string, maxBytes: number): Promise<string>;
  /** Create the file's directory if needed and write the text to the file. */
  writeFile(path: string, text: string): Promise<void>;
  /** The host's name. */
  hostname(): string;
  /** A timer whose promise resolves after `ms`, and which can be cancelled. */
  timeout(ms: number): { promise: Promise<void>; cancel: () => void };
}

/** What one capture is asked to record. */
export interface EvidenceOptions {
  /** The wedged container. */
  containerName: string;
  /** The container runtime executable the launcher chose. */
  runtimeExecutable: string;
  /** Directory the worker and transcript logs are read from, and the file written to. */
  evidenceDir: string;
  /** Why the reap was triggered, in operator-facing words. */
  reason: string;
  /** Which layer triggered it. */
  trigger: string;
  /** The capture time, in milliseconds since the epoch. */
  nowMs: number;
  /** Bound on one guest probe, in milliseconds. */
  execTimeoutMs?: number;
  /** Bound on one evidence step, in milliseconds. */
  stepTimeoutMs?: number;
  /** Bound on the whole capture, in milliseconds. */
  totalCapMs?: number;
}

/** Guest state read through the container runtime's exec. */
export interface GuestEvidence {
  ps: string;
  meminfo: string;
  pressureCpu: string;
  pressureMemory: string;
  pressureIo: string;
}

/** The evidence file's contents. */
export interface HardKillEvidence {
  version: number;
  /** ISO-8601 capture time. */
  capturedAt: string;
  host: string;
  container: string;
  /** The run the container was working on, or "unknown". */
  runId: string;
  trigger: string;
  reason: string;
  lastLogLine: string;
  /** Timestamp of the last log line, or "unknown". */
  lastLogTimestamp: string;
  lastToolCall: string;
  evidence: {
    workerLogTail: string;
    agentTranscriptTail: string;
    bootLogs: string;
    guest: GuestEvidence;
  };
}

/** Whether the evidence file was written. */
export type CaptureOutcome =
  | { ok: true; file: string }
  | { ok: false; error: string };

/**
 * The runtime arguments that read a container's boot log.
 *
 * Apple `container` has a `--boot` flag; Docker and Podman do not, so they
 * get the tail of the container's ordinary log instead.
 *
 * @param runtimeExecutable - Runtime executable path or name
 * @param containerName - The container
 * @returns The arguments to pass the runtime
 */
export function bootLogsArgs(
  runtimeExecutable: string,
  containerName: string,
): string[] {
  const base = runtimeExecutable.replace(/\\/g, "/").split("/").pop() ?? "";
  const stem = base.replace(/\.exe$/i, "").toLowerCase();
  return stem === "container"
    ? ["logs", "--boot", containerName]
    : ["logs", "--tail", "200", containerName];
}

/** Join a directory and a file name with a single slash. */
function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

/** The directory holding a path. */
function dirnameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash > 0) return path.slice(0, slash);
  return slash === 0 ? "/" : ".";
}

/** Cut text to a limit, marking the cut. */
function capText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * The last `maxLines` lines of a text, each line and the whole result capped.
 *
 * @param text - The text, typically a byte-tail of a log
 * @param maxLines - Lines to keep, from the end
 * @returns The kept lines joined by newlines
 */
export function tailLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const kept = lines
    .slice(Math.max(0, lines.length - maxLines))
    .map((line) => capText(line, MAX_LINE_CHARS));
  const joined = kept.join("\n");
  return joined.length > MAX_FIELD_CHARS
    ? joined.slice(joined.length - MAX_FIELD_CHARS)
    : joined;
}

/** The tool call an assistant message carries, when it carries one. */
function toolUseOf(
  parsed: unknown,
): { name: string; input: unknown } | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const message = (parsed as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return undefined;
  for (let index = content.length - 1; index >= 0; index--) {
    const block = content[index];
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] === "tool_use" && typeof record["name"] === "string") {
      return { name: record["name"], input: record["input"] };
    }
  }
  return undefined;
}

/**
 * The agent's last tool call, from the end of a stream-json transcript.
 *
 * @param transcriptTail - The transcript's byte-tail
 * @returns `<tool name> <input as JSON>`, capped, or null when there is none
 */
export function lastToolCall(transcriptTail: string): string | null {
  const lines = transcriptTail.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (!line.includes('"tool_use"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A byte-tail's first line is usually cut mid-record; that is expected.
      continue;
    }
    const found = toolUseOf(parsed);
    if (found === undefined) continue;
    return capText(
      `${found.name} ${JSON.stringify(found.input ?? null)}`,
      MAX_TOOL_CALL_CHARS,
    );
  }
  return null;
}

/** Outcome of one bounded step. */
type Bounded<T> = { ok: true; value: T } | { ok: false; cause: string };

/**
 * The first non-empty line of an error or output, capped. Redacted before it
 * is cut (SECURITY.md: redact before you truncate).
 */
function firstLine(text: string, limit = 200): string {
  const line = redactGhBodyText(text)
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "") ?? "";
  return capText(line, limit);
}

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one step against a timer. Never throws: a timeout, a rejection or a
 * throwing seam is reported as a cause.
 */
async function bounded<T>(
  seams: EvidenceSeams,
  work: () => Promise<T>,
  ms: number,
): Promise<Bounded<T>> {
  try {
    const timer = seams.timeout(ms);
    try {
      return await Promise.race([
        Promise.resolve().then(work).then((value) => ({
          ok: true as const,
          value,
        })),
        timer.promise.then(() => ({
          ok: false as const,
          cause: `no answer within ${ms}ms`,
        })),
      ]);
    } finally {
      timer.cancel();
    }
  } catch (error) {
    return { ok: false, cause: firstLine(messageOf(error)) };
  }
}

/** A listed file's name and modification time. */
interface ListedFile {
  name: string;
  mtimeMs: number;
}

/** The newest listed file whose name matches, ties broken by name, descending. */
function newestMatching(
  files: readonly ListedFile[],
  pattern: RegExp,
): ListedFile | undefined {
  return files
    .filter((file) => pattern.test(file.name))
    .sort((a, b) => {
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
      if (a.name === b.name) return 0;
      return a.name < b.name ? 1 : -1;
    })[0];
}

/** Deep copy with every string passed through the redaction chokepoint. */
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactGhBodyText(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)]),
    );
  }
  return value;
}

/**
 * Capture the evidence for a wedged container and write it to a file.
 *
 * Never throws for a failed step: each failure is written into the record.
 *
 * @param seams - Injected operations
 * @param options - What to capture and where
 * @returns The file written, or why it could not be
 */
export async function captureHardKillEvidence(
  seams: EvidenceSeams,
  options: EvidenceOptions,
): Promise<CaptureOutcome> {
  const { containerName, evidenceDir, runtimeExecutable } = options;
  const execMs = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const stepMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const totalCapMs = options.totalCapMs ?? DEFAULT_TOTAL_CAP_MS;
  const unavailable = (cause: string): string =>
    `${UNAVAILABLE_PREFIX}${cause}`;
  const notCollected = unavailable(
    `not collected before the ${totalCapMs}ms capture cap ended`,
  );

  let host: string;
  try {
    host = seams.hostname();
  } catch {
    host = "unknown";
  }

  const record: HardKillEvidence = {
    version: HARD_KILL_EVIDENCE_VERSION,
    capturedAt: new Date(options.nowMs).toISOString(),
    host,
    container: containerName,
    runId: "unknown",
    trigger: options.trigger,
    reason: options.reason,
    lastLogLine: notCollected,
    lastLogTimestamp: "unknown",
    lastToolCall: notCollected,
    evidence: {
      workerLogTail: notCollected,
      agentTranscriptTail: notCollected,
      bootLogs: notCollected,
      guest: {
        ps: notCollected,
        meminfo: notCollected,
        pressureCpu: notCollected,
        pressureMemory: notCollected,
        pressureIo: notCollected,
      },
    },
  };

  // Started now, so the listing overlaps the runtime probes below.
  const filesP = bounded(
    seams,
    () => seams.listLogFiles(evidenceDir),
    stepMs,
  );

  let logRunId: string | undefined;
  let transcriptRunId: string | undefined;

  const workerLogBranch = async (): Promise<void> => {
    const files = await filesP;
    if (!files.ok) {
      const cause = unavailable(
        `could not list ${evidenceDir}: ${files.cause}`,
      );
      record.evidence.workerLogTail = cause;
      record.lastLogLine = cause;
      return;
    }
    const newest = newestMatching(files.value, WORKER_LOG_RE);
    if (newest === undefined) {
      const cause = unavailable(`no worker log in ${evidenceDir}`);
      record.evidence.workerLogTail = cause;
      record.lastLogLine = cause;
      return;
    }
    const read = await bounded(
      seams,
      () => seams.readTail(joinPath(evidenceDir, newest.name), TAIL_READ_BYTES),
      stepMs,
    );
    if (!read.ok) {
      const cause = unavailable(`could not read ${newest.name}: ${read.cause}`);
      record.evidence.workerLogTail = cause;
      record.lastLogLine = cause;
      return;
    }
    // Redact the raw text before any cut: a secret straddling a line or field
    // boundary would otherwise leave an unredactable fragment (SECURITY.md).
    const text = redactGhBodyText(read.value);
    if (text.trim() === "") {
      const cause = unavailable(`${newest.name} is empty`);
      record.evidence.workerLogTail = cause;
      record.lastLogLine = cause;
      return;
    }
    record.evidence.workerLogTail = tailLines(text, WORKER_LOG_TAIL_LINES);
    const lastLine = text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .pop() ?? "";
    record.lastLogLine = capText(lastLine, MAX_LINE_CHARS);
    const stamp = LOG_TIMESTAMP_RE.exec(lastLine);
    record.lastLogTimestamp = stamp
      ? stamp[1]!
      : `${
        new Date(newest.mtimeMs).toISOString()
      } (log file modified time; the last line carries no timestamp)`;
    for (const match of text.matchAll(RUN_ID_RE)) logRunId = match[0];
  };

  const transcriptBranch = async (): Promise<void> => {
    const files = await filesP;
    if (!files.ok) {
      const cause = unavailable(
        `could not list ${evidenceDir}: ${files.cause}`,
      );
      record.evidence.agentTranscriptTail = cause;
      record.lastToolCall = cause;
      return;
    }
    const newest = newestMatching(files.value, TRANSCRIPT_RE);
    if (newest === undefined) {
      const cause = unavailable(`no agent transcript in ${evidenceDir}`);
      record.evidence.agentTranscriptTail = cause;
      record.lastToolCall = cause;
      return;
    }
    transcriptRunId = TRANSCRIPT_RUN_ID_RE.exec(newest.name)?.[1];
    const noToolCall = unavailable(
      `no tool call in the last ${TAIL_READ_BYTES} bytes of ${newest.name}`,
    );
    const read = await bounded(
      seams,
      () => seams.readTail(joinPath(evidenceDir, newest.name), TAIL_READ_BYTES),
      stepMs,
    );
    if (!read.ok) {
      const cause = unavailable(`could not read ${newest.name}: ${read.cause}`);
      record.evidence.agentTranscriptTail = cause;
      record.lastToolCall = cause;
      return;
    }
    // Redact the raw transcript before the tool call is cut to its cap.
    const text = redactGhBodyText(read.value);
    record.evidence.agentTranscriptTail = text.trim() === ""
      ? unavailable(`${newest.name} is empty`)
      : tailLines(text, TRANSCRIPT_TAIL_LINES);
    record.lastToolCall = lastToolCall(text) ?? noToolCall;
  };

  const execField = async (args: readonly string[]): Promise<string> => {
    const result = await bounded(
      seams,
      () => seams.runRuntime(["exec", containerName, ...args], execMs),
      execMs,
    );
    if (!result.ok) return unavailable(result.cause);
    if (result.value.code !== 0) {
      return unavailable(
        `exit ${result.value.code}: ${firstLine(result.value.stderr)}`,
      );
    }
    return tailLines(
      redactGhBodyText(result.value.stdout).trim(),
      GUEST_TAIL_LINES,
    );
  };

  const guestBranch = async (): Promise<void> => {
    // Probe first: a wedged VM must not be asked for five more things.
    const probe = await bounded(
      seams,
      () => seams.runRuntime(["exec", containerName, "true"], execMs),
      execMs,
    );
    let failure: string | undefined;
    if (!probe.ok) {
      failure = probe.cause;
    } else if (probe.value.code !== 0) {
      failure = `exit ${probe.value.code}: ${firstLine(probe.value.stderr)}`;
    }
    if (failure !== undefined) {
      const cause = unavailable(`container exec did not answer: ${failure}`);
      record.evidence.guest = {
        ps: cause,
        meminfo: cause,
        pressureCpu: cause,
        pressureMemory: cause,
        pressureIo: cause,
      };
      return;
    }
    const [ps, meminfo, pressureCpu, pressureMemory, pressureIo] = await Promise
      .all([
        execField(["ps", "-eo", "pid,ppid,stat,pcpu,pmem,etime,args"]),
        execField(["cat", "/proc/meminfo"]),
        execField(["cat", "/proc/pressure/cpu"]),
        execField(["cat", "/proc/pressure/memory"]),
        execField(["cat", "/proc/pressure/io"]),
      ]);
    record.evidence.guest = {
      ps,
      meminfo,
      pressureCpu,
      pressureMemory,
      pressureIo,
    };
  };

  const runtimeBranch = async (): Promise<void> => {
    const bootP = (async () => {
      const boot = await bounded(
        seams,
        () =>
          seams.runRuntime(
            bootLogsArgs(runtimeExecutable, containerName),
            stepMs,
          ),
        stepMs,
      );
      if (!boot.ok) {
        record.evidence.bootLogs = unavailable(boot.cause);
      } else if (boot.value.code === 0) {
        record.evidence.bootLogs = tailLines(
          redactGhBodyText(boot.value.stdout),
          BOOT_LOG_TAIL_LINES,
        );
      } else {
        record.evidence.bootLogs = unavailable(
          `exit ${boot.value.code}: ${firstLine(boot.value.stderr)}`,
        );
      }
    })();
    await Promise.all([bootP, guestBranch()]);
  };

  // The branches never reject; a step that fails leaves its field recorded
  // as unavailable, and a field never reached stays "not collected".
  const branches = Promise.all([
    workerLogBranch(),
    transcriptBranch(),
    runtimeBranch(),
  ]).then(() => undefined, () => undefined);

  try {
    const cap = seams.timeout(totalCapMs);
    try {
      await Promise.race([branches, cap.promise]);
    } finally {
      cap.cancel();
    }
  } catch {
    // A throwing timer leaves the fields unfilled, which the record shows.
  }

  record.runId = logRunId ?? transcriptRunId ?? "unknown";

  const redacted = redactDeep(record) as HardKillEvidence;
  const file = `${evidenceDir.replace(/\/+$/, "")}/hard-kill-${containerName}-${
    Math.floor(options.nowMs / 1000)
  }.json`;
  const body = `${JSON.stringify(redacted, null, 2)}\n`;
  const written = await bounded(
    seams,
    () => seams.writeFile(file, body),
    stepMs,
  );
  if (!written.ok) {
    return { ok: false, error: `could not write ${file}: ${written.cause}` };
  }
  return { ok: true, file };
}

/**
 * The production seams: real directory reads, real files and a real timer,
 * with the runtime invocation supplied by the caller.
 *
 * @param runRuntime - Runs the container runtime, bounded by a timeout
 * @returns Seams for {@link captureHardKillEvidence}
 */
export function createEvidenceSeams(
  runRuntime: (
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<EvidenceInvocation>,
): EvidenceSeams {
  return {
    runRuntime,
    listLogFiles: async (dir) => {
      const files: { name: string; mtimeMs: number }[] = [];
      for await (const entry of Deno.readDir(dir)) {
        if (!entry.isFile) continue;
        const info = await Deno.stat(joinPath(dir, entry.name));
        files.push({ name: entry.name, mtimeMs: info.mtime?.getTime() ?? 0 });
      }
      return files;
    },
    readTail: async (path, maxBytes) => {
      const file = await Deno.open(path, { read: true });
      try {
        const info = await file.stat();
        await file.seek(Math.max(0, info.size - maxBytes), Deno.SeekMode.Start);
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (total < maxBytes) {
          const buffer = new Uint8Array(Math.min(64 * 1024, maxBytes - total));
          const read = await file.read(buffer);
          if (read === null) break;
          chunks.push(buffer.subarray(0, read));
          total += read;
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return new TextDecoder().decode(bytes);
      } finally {
        file.close();
      }
    },
    writeFile: async (path, text) => {
      await Deno.mkdir(dirnameOf(path), { recursive: true });
      await Deno.writeTextFile(path, text, { mode: 0o600 });
    },
    hostname: () => {
      try {
        return Deno.hostname();
      } catch {
        return "unknown";
      }
    },
    timeout: (ms) => {
      let handle: ReturnType<typeof setTimeout> | undefined;
      const promise = new Promise<void>((resolve) => {
        handle = setTimeout(resolve, ms);
      });
      return { promise, cancel: () => clearTimeout(handle) };
    },
  };
}
