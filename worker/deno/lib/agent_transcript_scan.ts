/** Scheduled, local transcript evidence scan (Issue #3700). Never executes content. */
import { AGENT_TRANSCRIPT_PATTERN } from "./worker_log_cleanup.ts";
import { DEFAULT_MAX_TRANSCRIPT_BYTES } from "./agent_transcript.ts";

const SCAN_INTERVAL_MS = 6 * 3600_000;
const STATE_FILE = ".agent-transcript-scan-v1.json";
type Signal = "egress-attempt" | "credential-path" | "disallowed-tool";
interface Finding {
  file: string;
  line: number;
  signal: Signal;
  occurrences: number;
}
interface ScanResult {
  scanned: number;
  malformedLines: number;
  findings: Finding[];
  fingerprints: Record<string, string>;
  failedFiles: string[];
}
const CREDENTIAL_PATH =
  /(?:\.aws[\\/]credentials|\.ssh[\\/]id_[\w-]+|\.config[\\/]gh[\\/]hosts\.yml|\.claude[\\/]\.credentials\.json|\.codex[\\/]auth\.json|(?:^|[\s/\\])provider(?:-\d+)?\.env\b|(?:^|[\s/\\])\.env(?:\b|\.))/i;
const EGRESS_COMMAND =
  /(?:^|[\s;|&'"/])(curl|wget|ssh|scp|sftp|nc|ncat|netcat)\b/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return Object.prototype.toString.call(value) === "[object Object]"
    ? value as Record<string, unknown>
    : undefined;
}
/** Only executable tool records count; quoted instructions/prose are not attempts. */
function signals(event: unknown): Signal[] {
  const root = record(event);
  if (!root) return [];
  const found = new Set<Signal>();
  if (
    root.type === "result" && Array.isArray(root.permission_denials) &&
    root.permission_denials.length > 0
  ) {
    found.add("disallowed-tool");
  }
  // Provider-native formats: Codex exec JSONL and Gemini stream-json.
  const item = record(root.item);
  if (
    (root.type === "item.started" || root.type === "item.completed") &&
    item?.type === "command_execution"
  ) {
    if (typeof item.command === "string" && EGRESS_COMMAND.test(item.command)) {
      found.add("egress-attempt");
    }
    if (
      typeof item.command === "string" && CREDENTIAL_PATH.test(item.command)
    ) found.add("credential-path");
  }
  if (root.type === "tool_use") {
    const parameters = record(root.parameters);
    if (
      root.tool_name === "web_fetch" || root.tool_name === "google_web_search"
    ) found.add("egress-attempt");
    if (
      root.tool_name === "run_shell_command" &&
      typeof parameters?.command === "string"
    ) {
      if (EGRESS_COMMAND.test(parameters.command)) found.add("egress-attempt");
      if (CREDENTIAL_PATH.test(parameters.command)) {
        found.add("credential-path");
      }
    }
    if (
      root.tool_name === "read_file" &&
      typeof parameters?.file_path === "string" &&
      CREDENTIAL_PATH.test(parameters.file_path)
    ) found.add("credential-path");
  }
  if (
    root.type === "tool_result" && root.status === "error" &&
    /permission|denied|disallowed/i.test(String(record(root.error)?.type ?? ""))
  ) found.add("disallowed-tool");
  const content = record(root.message)?.content;
  if (root.type === "assistant" && Array.isArray(content)) {
    for (const item of content) {
      const block = record(item);
      if (block?.type !== "tool_use") continue;
      const input = record(block.input);
      const command = typeof input?.command === "string" ? input.command : "";
      const path = typeof input?.file_path === "string" ? input.file_path : "";
      if (
        block.name === "WebFetch" ||
        (block.name === "Bash" && EGRESS_COMMAND.test(command))
      ) found.add("egress-attempt");
      if (
        (block.name === "Read" && CREDENTIAL_PATH.test(path)) ||
        (block.name === "Bash" && CREDENTIAL_PATH.test(command))
      ) found.add("credential-path");
      if (block.name === "EnterPlanMode" || block.name === "ExitPlanMode") {
        found.add("disallowed-tool");
      }
    }
  }
  if (root.type === "user" && Array.isArray(content)) {
    for (const item of content) {
      const block = record(item);
      if (
        block?.type === "tool_result" && block.is_error === true &&
        typeof block.content === "string" &&
        /(?:not allowed to use|permission (?:was )?denied|tool.*(?:disallowed|not permitted))/i
          .test(block.content)
      ) found.add("disallowed-tool");
    }
  }
  return [...found];
}

/** Scan changed retained transcripts, including compressed rotation backups. */
export async function scanAgentTranscripts(
  logDir: string,
  previous: Record<string, string> = {},
  maxBytes = DEFAULT_MAX_TRANSCRIPT_BYTES,
): Promise<ScanResult> {
  const result: ScanResult = {
    scanned: 0,
    malformedLines: 0,
    findings: [],
    fingerprints: {},
    failedFiles: [],
  };
  const entries: string[] = [];
  try {
    for await (const entry of Deno.readDir(logDir)) {
      if (AGENT_TRANSCRIPT_PATTERN.test(entry.name)) {
        entries.push(entry.name);
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return result;
    throw err;
  }
  for (const name of entries.sort()) {
    try {
      const path = `${logDir}/${name}`;
      const stat = await Deno.lstat(path);
      if (!stat.isFile) continue;
      const fingerprint = `${stat.size}:${stat.mtime?.getTime() ?? 0}`;
      if (previous[name] === fingerprint) {
        result.fingerprints[name] = fingerprint;
        continue;
      }
      const malformedBefore = result.malformedLines;
      const file = await Deno.open(path, { read: true });
      let stream: ReadableStream<Uint8Array<ArrayBuffer>> = file.readable;
      if (name.endsWith(".gz")) {
        stream = stream.pipeThrough(new DecompressionStream("gzip"));
      }
      let bytes = 0;
      stream = stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            bytes += chunk.byteLength;
            if (bytes > maxBytes) {
              throw new Error(`transcript ${name} exceeds scan byte limit`);
            }
            controller.enqueue(chunk);
          },
        }),
      );
      const bySignal = new Map<Signal, Finding>();
      let lineNumber = 0;
      let carry = "";
      const consumeLine = (line: string) => {
        lineNumber++;
        if (!line.trim()) return;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          result.malformedLines++;
          return;
        }
        for (const signal of signals(event)) {
          const existing = bySignal.get(signal);
          if (existing) existing.occurrences++;
          else {
            const finding = {
              file: name,
              line: lineNumber,
              signal,
              occurrences: 1,
            };
            bySignal.set(signal, finding);
            result.findings.push(finding);
          }
        }
      };
      for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
        const lines = (carry + chunk).split("\n");
        carry = lines.pop()!; // split always produces at least one element
        for (const line of lines) consumeLine(line);
      }
      if (carry) consumeLine(carry);
      result.scanned++;
      if (result.malformedLines === malformedBefore) {
        result.fingerprints[name] = fingerprint;
      }
    } catch {
      result.failedFiles.push(name);
    }
  }
  return result;
}

/** Rate-limited idle task; persists its schedule and changed-file cursor across restarts. */
export function createScheduledTranscriptScan(options: {
  logDir: string;
  warn: (message: string) => void;
  info: (message: string) => void;
  now?: () => number;
}): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const now = (options.now ?? Date.now)();
      const path = `${options.logDir}/${STATE_FILE}`;
      let previous: Record<string, string> = {};
      try {
        const state = JSON.parse(await Deno.readTextFile(path));
        if (
          typeof state.lastScan !== "number" || !record(state.fingerprints) ||
          Object.values(state.fingerprints).some((v) => typeof v !== "string")
        ) throw new Error("invalid transcript scan state");
        if (now >= state.lastScan && now - state.lastScan < SCAN_INTERVAL_MS) {
          return;
        }
        previous = state.fingerprints;
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
          options.warn(
            "[agent-transcript-scan] state unreadable; rescanning retained evidence",
          );
        }
      }
      const result = await scanAgentTranscripts(options.logDir, previous);
      for (const finding of result.findings) {
        // No command, URL, input, output or credential is copied to the alert.
        options.warn(
          `[AGENT_TRANSCRIPT_SIGNAL] ${finding.file}:${finding.line} signal=${finding.signal} occurrences=${finding.occurrences}; inspect locally using SECURITY.md agent-incident runbook`,
        );
      }
      for (const name of result.failedFiles) {
        options.warn(
          `[agent-transcript-scan] ${name}: unreadable, invalid compression or over byte limit; retry on next scheduled scan`,
        );
      }
      const summary =
        `[agent-transcript-scan] scanned=${result.scanned} findings=${result.findings.length} malformed_lines=${result.malformedLines} failed_files=${result.failedFiles.length}`;
      (result.malformedLines > 0 || result.failedFiles.length > 0
        ? options.warn
        : options.info)(summary);
      await Deno.mkdir(options.logDir, { recursive: true });
      const temp = await Deno.makeTempFile({
        dir: options.logDir,
        prefix: ".transcript-scan-",
      });
      try {
        await Deno.writeTextFile(
          temp,
          JSON.stringify({ lastScan: now, fingerprints: result.fingerprints }),
        );
        await Deno.rename(temp, path);
      } finally {
        try {
          await Deno.remove(temp);
        } catch (err) {
          if (!(err instanceof Deno.errors.NotFound)) {
            options.warn(
              "[agent-transcript-scan] temporary state cleanup failed",
            );
          }
        }
      }
    } catch (err) {
      // Paths and parser messages may contain untrusted content: keep the log static.
      options.warn(
        `[agent-transcript-scan] scan failed (${
          err instanceof Error ? err.name : "unknown error"
        }); retained evidence was not marked scanned`,
      );
    } finally {
      running = false;
    }
  };
}
