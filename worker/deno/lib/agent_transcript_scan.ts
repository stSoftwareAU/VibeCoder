/**
 * Scheduled scan of retained agent transcripts (Issue #3700).
 *
 * Transcripts (`agent-vibe-<runid>[-<issue>].jsonl`, written by
 * `agent_transcript.ts` and retained for at least 30 days by
 * `worker_log_cleanup.ts`) are the only record of what an agent actually
 * tried. This module reads them back and flags three signals:
 *
 *  - `egress` — a Bash command in command position runs a network client
 *    (`curl`, `wget`, `nc`, `ssh`, …) or opens a `/dev/tcp/` or `/dev/udp/`
 *    socket.
 *  - `credential-read` — a tool touches a credential path: a Bash token or a
 *    `file_path` / `path` / `notebook_path` input naming an SSH key, a cloud or
 *    registry credential store, a `gh` hosts file, or `/proc/<pid>/environ`.
 *    Edit and Write content is text the agent writes, not a read, and is never
 *    scanned for this.
 *  - `disallowed-tool` — a guard refused an action (a `[SECURITY] [*_BLOCKED]`
 *    or `[SECURITY] [*_REFUSED]` marker on an error tool result), the agent
 *    named a tool that does not exist, or the CLI recorded a permission denial.
 *
 * Findings are recorded to `transcript-scan-findings.jsonl` in the log
 * directory, deduplicated by fingerprint so a re-scan reports nothing twice.
 * The `agent-transcript-scan` command (`commands/agent_transcript_scan.ts`)
 * fails loud on any new finding. Files already scanned are memoised by
 * size and mtime in `transcript-scan-state.json`, so a pass over a quiet
 * directory reads nothing.
 *
 * These are heuristics over model output, not a verdict. A command the
 * scanner cannot parse, such as one that hides its client behind a flag with a
 * value, is missed, and an innocent string that happens to name a credential
 * path is flagged. A finding means "look at this", never "this happened".
 *
 * Uses Australian English throughout (behaviour, memoised, recognise, etc.).
 */

import { redactSecrets } from "./secret_redaction.ts";
import { FORBIDDEN_STAGED_PATTERNS } from "./pre_commit_safety.ts";
import { AGENT_TRANSCRIPT_PATTERN } from "./worker_log_cleanup.ts";

/** The three signals a finding can carry. */
export type TranscriptSignal = "egress" | "credential-read" | "disallowed-tool";

/** One finding in a single transcript line, before it is located in a file. */
export interface TranscriptLineFinding {
  signal: TranscriptSignal;
  /** Tool the finding came from (`Bash`, `Read`, `tool_result`, …). */
  tool: string;
  /** Redacted, truncated description for the operator. */
  detail: string;
}

/** Result of scanning one transcript line. */
export interface TranscriptLineScan {
  /** False when the line is not a JSON object (blank lines count as parsed). */
  parsed: boolean;
  findings: TranscriptLineFinding[];
}

/**
 * Version of the rules above. Bump it when the rules change so every file is
 * rescanned under the new rules: a memo written under old rules says nothing
 * about them.
 */
export const TRANSCRIPT_SCAN_RULES_VERSION = 1;

/** State file, in the log directory, memoising files already scanned. */
export const TRANSCRIPT_SCAN_STATE_FILE = "transcript-scan-state.json";

/** Ledger, in the log directory, of every finding ever recorded. */
export const TRANSCRIPT_SCAN_FINDINGS_FILE = "transcript-scan-findings.jsonl";

/** A finding as written to the ledger, located in its transcript file. */
export interface RecordedTranscriptFinding {
  version: 1;
  fingerprint: string;
  detectedAt: string;
  /** Basename of the transcript file. */
  file: string;
  /** 1-based line number within that file. */
  line: number;
  signal: TranscriptSignal;
  tool: string;
  detail: string;
}

/** Options for {@link scanAgentTranscripts}. */
export interface TranscriptScanOptions {
  /** Override "now" for deterministic tests. */
  now?: Date;
}

/** What one pass over a log directory found. */
export interface TranscriptScanResult {
  /** The directory scanned. */
  logDir: string;
  /** The ledger new findings were appended to. */
  findingsPath: string;
  /** Basenames of transcripts read in full this pass. */
  scannedFiles: string[];
  /** Transcripts skipped because the memo says they are unchanged. */
  unchangedFiles: number;
  /** Gzipped transcripts, which are not scanned and so not passed. */
  notChecked: string[];
  /** Transcripts that could not be read; these are not memoised. */
  unreadable: { file: string; error: string }[];
  /** Findings not previously recorded, now appended to the ledger. */
  newFindings: RecordedTranscriptFinding[];
  /** Findings already in the ledger (or repeated within this pass). */
  knownFindings: number;
  /** Lines that were not a JSON object. */
  unparsedLines: number;
  /** Set when the memo could not be written. The next pass rescans. */
  stateError?: string;
}

/** Longest detail kept on a finding, after redaction. */
const DETAIL_MAX_CHARS = 200;

/** Longest token checked against the credential patterns; longer ones are skipped. */
const TOKEN_MAX_CHARS = 4096;

/** Network clients whose invocation in command position is an egress attempt. */
const NETWORK_CLIENTS: ReadonlySet<string> = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "telnet",
  "ssh",
  "scp",
  "sftp",
  "ftp",
]);

/** Wrappers that run another command; they are looked through to find it. */
const WRAPPER_WORDS: ReadonlySet<string> = new Set([
  "sudo",
  "env",
  "nohup",
  "exec",
  "command",
  "time",
  "xargs",
  "timeout",
  "gtimeout",
  "nice",
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NUMERIC_OR_DURATION = /^\d+[smhd]?$/;

/** Fixed command separators: a segment after one of these is in command position. */
const COMMAND_SEPARATOR = /;|\||&|\n|\$\(|`|\(/;

/** Token separators for the credential check on a Bash command. */
const COMMAND_TOKEN_SEPARATOR = /[\s;|&()<>`'"=]+/;

/** Input keys, on a non-Bash tool, whose string value is a path the tool reads. */
const PATH_INPUT_KEYS = ["file_path", "path", "notebook_path"] as const;

/** Credential paths: the forbidden-commit patterns plus the runtime-only ones. */
const CREDENTIAL_PATH_PATTERNS: readonly RegExp[] = [
  ...FORBIDDEN_STAGED_PATTERNS,
  /(^|\/)\.git-credentials$/,
  /(^|\/)gh\/hosts\.yml$/,
  /(^|\/)\.credentials\.json$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.kube\/config$/,
  /^\/proc\/[^/]+\/environ$/,
];

/** A guard refusal marker. The bracketed code is capped so the match is bounded. */
const GUARD_REFUSAL = /\[SECURITY\] \[([A-Z_]{1,64})\]/g;

/** Whether a finding code names a refusal the operator should see. */
function isRefusalCode(code: string): boolean {
  return code.endsWith("_BLOCKED") || code.endsWith("_REFUSED");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Strip surrounding single or double quotes with two anchored loops. A
 * trailing regex such as `/['"]+$/` backtracks quadratically on a long run of
 * quotes that does not end the token (Issue #3942 linearity rule).
 */
function stripQuotes(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && isQuote(token.charCodeAt(start))) start++;
  while (end > start && isQuote(token.charCodeAt(end - 1))) end--;
  return token.slice(start, end);
}

function isQuote(code: number): boolean {
  return code === 0x27 || code === 0x22; // ' and "
}

/**
 * The command word of one shell segment: the first token left once leading
 * env assignments, wrappers, options and numeric or duration arguments are
 * dropped.
 */
function commandWordOf(segment: string): string | undefined {
  for (const token of segment.split(/\s+/)) {
    if (token.length === 0) continue;
    if (
      ENV_ASSIGNMENT.test(token) ||
      WRAPPER_WORDS.has(token) ||
      token.startsWith("-") ||
      NUMERIC_OR_DURATION.test(token)
    ) {
      continue;
    }
    return token;
  }
  return undefined;
}

/** Egress finding for a Bash command, or undefined. */
function egressFinding(command: string): TranscriptLineFinding | undefined {
  if (command.includes("/dev/tcp/") || command.includes("/dev/udp/")) {
    return { signal: "egress", tool: "Bash", detail: `raw socket: ${command}` };
  }
  for (const segment of command.split(COMMAND_SEPARATOR)) {
    const word = commandWordOf(segment);
    if (word === undefined) continue;
    const name = stripQuotes(word);
    const base = name.slice(name.lastIndexOf("/") + 1);
    if (NETWORK_CLIENTS.has(base)) {
      return {
        signal: "egress",
        tool: "Bash",
        detail: `network client "${base}": ${command}`,
      };
    }
  }
  return undefined;
}

/** Whether one token names a credential path. */
function isCredentialPath(token: string): boolean {
  if (token.length > TOKEN_MAX_CHARS) return false;
  return CREDENTIAL_PATH_PATTERNS.some((pattern) => pattern.test(token));
}

/** Credential-read finding for the first matching value, or undefined. */
function credentialFinding(
  tool: string,
  values: readonly string[],
): TranscriptLineFinding | undefined {
  for (const value of values) {
    if (isCredentialPath(value)) {
      return {
        signal: "credential-read",
        tool,
        detail: `credential path "${value}"`,
      };
    }
  }
  return undefined;
}

/** Findings for every `tool_use` block of an assistant event. */
function scanAssistantEvent(
  event: Record<string, unknown>,
  out: TranscriptLineFinding[],
): void {
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    const name = block.name;
    const input = block.input;
    if (typeof name !== "string" || !isRecord(input)) continue;

    const command = input.command;
    if (name === "Bash" && typeof command === "string") {
      const egress = egressFinding(command);
      if (egress) out.push(egress);
      const credential = credentialFinding(
        "Bash",
        command.split(COMMAND_TOKEN_SEPARATOR),
      );
      if (credential) out.push(credential);
      continue;
    }

    const paths = PATH_INPUT_KEYS.map((key) => input[key]).filter(
      (value): value is string => typeof value === "string",
    );
    const credential = credentialFinding(name, paths);
    if (credential) out.push(credential);
  }
}

/** Findings for each permission denial recorded on a result event. */
function scanResultEvent(
  event: Record<string, unknown>,
  out: TranscriptLineFinding[],
): void {
  const denials = event.permission_denials;
  if (!Array.isArray(denials)) return;
  for (const denial of denials) {
    if (!isRecord(denial)) continue;
    const tool = typeof denial.tool_name === "string"
      ? denial.tool_name
      : "unknown";
    const input = denial.tool_input === undefined
      ? ""
      : JSON.stringify(denial.tool_input);
    out.push({
      signal: "disallowed-tool",
      tool,
      detail: input
        ? `permission denied: ${tool} ${input}`
        : `permission denied: ${tool}`,
    });
  }
}

/** The text of a tool result: a string, or the joined text blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      isRecord(block) && block.type === "text" && typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** The first guard refusal code in `text` that names a refusal, or undefined. */
function guardRefusalCode(text: string): string | undefined {
  for (const match of text.matchAll(GUARD_REFUSAL)) {
    const code = match[1] ?? "";
    if (isRefusalCode(code)) return code;
  }
  return undefined;
}

/**
 * Findings for each error tool result of a user event. Only `is_error: true`
 * results count: a Read of a document that quotes a marker is not a refusal.
 */
function scanUserEvent(
  event: Record<string, unknown>,
  out: TranscriptLineFinding[],
): void {
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (
      !isRecord(block) || block.type !== "tool_result" ||
      block.is_error !== true
    ) {
      continue;
    }
    const text = toolResultText(block.content);
    const code = guardRefusalCode(text);
    if (code !== undefined) {
      out.push({
        signal: "disallowed-tool",
        tool: "tool_result",
        detail: `guard refusal [${code}]`,
      });
      continue;
    }
    if (
      text.includes("No such tool available") &&
      !text.includes("Tool names are case-sensitive")
    ) {
      out.push({
        signal: "disallowed-tool",
        tool: "tool_result",
        detail: text.trim(),
      });
    }
  }
}

/** Redact, then truncate, every finding detail (redact before truncate). */
function finalise(findings: TranscriptLineFinding[]): TranscriptLineFinding[] {
  return findings.map((finding) => ({
    ...finding,
    detail: redactSecrets(finding.detail).slice(0, DETAIL_MAX_CHARS),
  }));
}

/**
 * Scan one stream-json transcript line for the three signals.
 *
 * Blank lines are parsed and empty. A line that is not a JSON object is
 * reported as unparsed. Other event types (system, rate_limit_event,
 * tool_progress) carry none of the signals and are ignored.
 *
 * @param rawLine - One line of a transcript, without its newline
 * @returns Whether the line parsed, and any findings in it
 */
export function scanTranscriptLine(rawLine: string): TranscriptLineScan {
  const line = rawLine.trim();
  if (line.length === 0) return { parsed: true, findings: [] };
  if (!line.startsWith("{")) return { parsed: false, findings: [] };

  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return { parsed: false, findings: [] };
  }
  if (!isRecord(event)) return { parsed: false, findings: [] };

  const found: TranscriptLineFinding[] = [];
  if (event.type === "assistant") {
    scanAssistantEvent(event, found);
  } else if (event.type === "user") {
    scanUserEvent(event, found);
  } else if (event.type === "result") {
    scanResultEvent(event, found);
  }
  return { parsed: true, findings: finalise(found) };
}

/** A transcript selected for scanning. */
interface Candidate {
  name: string;
  path: string;
  /**
   * Memo key, `size:mtimeMs`. Undefined when the mtime is unknown, and then
   * the file is never memoised. The key is size and mtime, not the name, so
   * a log-rotation rename (`.jsonl` to `.jsonl.1`) is not rescanned.
   */
  key: string | undefined;
}

/**
 * Select the transcripts in `logDir`. Gzipped transcripts go to
 * `result.notChecked`: the worker never gzips them, so one is reported as not
 * checked rather than passed. Returns undefined when the directory is absent.
 */
async function listCandidates(
  logDir: string,
  result: TranscriptScanResult,
): Promise<Candidate[] | undefined> {
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(logDir)) entries.push(entry);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw new Error(
      `agent transcript scan: cannot read log directory ${logDir}: ${
        messageOf(err)
      }`,
      { cause: err },
    );
  }

  const candidates: Candidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile || !AGENT_TRANSCRIPT_PATTERN.test(entry.name)) continue;
    if (entry.name.endsWith(".gz")) {
      result.notChecked.push(entry.name);
      continue;
    }
    const path = `${logDir}/${entry.name}`;
    try {
      const stat = await Deno.stat(path);
      const mtime = stat.mtime?.getTime();
      candidates.push({
        name: entry.name,
        path,
        key: mtime === undefined ? undefined : `${stat.size}:${mtime}`,
      });
    } catch (err) {
      // Rotated away between the listing and the stat: nothing to report.
      if (err instanceof Deno.errors.NotFound) continue;
      result.unreadable.push({ file: entry.name, error: messageOf(err) });
    }
  }
  candidates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  result.notChecked.sort();
  return candidates;
}

/**
 * The memo: keys of files scanned under the current rules. A missing,
 * unparseable, wrong-version or different-rules-version state means nothing
 * is memoised, so every file is rescanned.
 */
async function loadMemo(statePath: string): Promise<Set<string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(statePath));
  } catch {
    return new Set();
  }
  if (
    !isRecord(parsed) || parsed.version !== 1 ||
    parsed.rulesVersion !== TRANSCRIPT_SCAN_RULES_VERSION ||
    !Array.isArray(parsed.scanned)
  ) {
    return new Set();
  }
  return new Set(
    parsed.scanned.filter((key): key is string => typeof key === "string"),
  );
}

/**
 * Fingerprints of every finding already in the ledger. A missing ledger means
 * none; a malformed line is skipped. Any other read error throws, because
 * treating an unreadable ledger as empty would report every finding again.
 */
async function loadKnownFingerprints(
  findingsPath: string,
): Promise<Set<string>> {
  let text: string;
  try {
    // SIMPLE-ON-PURPOSE: whole-ledger read, fine to ~10,000 findings; upgrade when the ledger exceeds 10,000 lines.
    text = await Deno.readTextFile(findingsPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return new Set();
    throw new Error(
      `agent transcript scan: cannot read findings ledger ${findingsPath}: ${
        messageOf(err)
      }`,
      { cause: err },
    );
  }
  const known = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const record = JSON.parse(line);
      if (isRecord(record) && typeof record.fingerprint === "string") {
        known.add(record.fingerprint);
      }
    } catch {
      // A malformed ledger line is skipped, not fatal.
    }
  }
  return known;
}

/** SHA-256 hex of the signal, tool, detail and raw line. */
async function fingerprintOf(
  finding: TranscriptLineFinding,
  rawLine: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    `${finding.signal}\n${finding.tool}\n${finding.detail}\n${rawLine}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What one streamed transcript contributed. */
interface FileScan {
  records: RecordedTranscriptFinding[];
  knownHits: number;
  unparsed: number;
}

/**
 * Stream one transcript line by line, carrying a partial line across chunks.
 * Only `carry` is held in memory, not the whole file. Nothing is merged into
 * the pass until the file has been read to the end, so a read error leaves
 * no half-recorded findings behind.
 */
async function scanFile(
  path: string,
  name: string,
  detectedAt: string,
  known: ReadonlySet<string>,
): Promise<FileScan> {
  const scan: FileScan = { records: [], knownHits: 0, unparsed: 0 };
  const seen = new Set<string>();
  let lineNo = 0;

  const onLine = async (rawLine: string): Promise<void> => {
    lineNo++;
    const lineScan = scanTranscriptLine(rawLine);
    if (!lineScan.parsed) scan.unparsed++;
    for (const finding of lineScan.findings) {
      const fingerprint = await fingerprintOf(finding, rawLine);
      if (known.has(fingerprint) || seen.has(fingerprint)) {
        scan.knownHits++;
        continue;
      }
      seen.add(fingerprint);
      scan.records.push({
        version: 1,
        fingerprint,
        detectedAt,
        file: name,
        line: lineNo,
        signal: finding.signal,
        tool: finding.tool,
        detail: finding.detail,
      });
    }
  };

  const file = await Deno.open(path, { read: true });
  try {
    const reader = file.readable.pipeThrough(new TextDecoderStream())
      .getReader();
    let carry = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      // Search only the newly appended text, so a long line is not rescanned
      // on every chunk (quadratic otherwise).
      const from = carry.length;
      carry += value;
      let newline = carry.indexOf("\n", from);
      let start = 0;
      while (newline !== -1) {
        await onLine(carry.slice(start, newline));
        start = newline + 1;
        newline = carry.indexOf("\n", start);
      }
      if (start > 0) carry = carry.slice(start);
    }
    if (carry.length > 0) await onLine(carry);
  } finally {
    try {
      file.close();
    } catch {
      // Already closed by the stream on EOF or error.
    }
  }
  return scan;
}

/**
 * Scan every agent transcript in `logDir` once, recording new findings.
 *
 * Order matters. New findings are appended to the ledger before the memo is
 * written, so a failed append throws and the files are rescanned next time
 * rather than skipped. A failed memo write is reported on the result and does
 * not throw: the ledger keeps the findings, so a rescan cannot report them
 * twice.
 *
 * @param logDir - Directory holding the transcripts (the worker log directory)
 * @param options - Override "now" for deterministic tests
 * @returns What the pass found, read and skipped
 * @throws When the directory cannot be read, or the ledger cannot be read or
 *   appended to
 */
export async function scanAgentTranscripts(
  logDir: string,
  options: TranscriptScanOptions = {},
): Promise<TranscriptScanResult> {
  const detectedAt = (options.now ?? new Date()).toISOString();
  const findingsPath = `${logDir}/${TRANSCRIPT_SCAN_FINDINGS_FILE}`;
  const statePath = `${logDir}/${TRANSCRIPT_SCAN_STATE_FILE}`;
  const result: TranscriptScanResult = {
    logDir,
    findingsPath,
    scannedFiles: [],
    unchangedFiles: 0,
    notChecked: [],
    unreadable: [],
    newFindings: [],
    knownFindings: 0,
    unparsedLines: 0,
  };

  const candidates = await listCandidates(logDir, result);
  if (candidates === undefined) return result;

  const memo = await loadMemo(statePath);
  const known = await loadKnownFingerprints(findingsPath);
  const keep = new Set<string>();

  for (const candidate of candidates) {
    if (candidate.key !== undefined && memo.has(candidate.key)) {
      result.unchangedFiles++;
      keep.add(candidate.key);
      continue;
    }
    let scan: FileScan;
    try {
      scan = await scanFile(candidate.path, candidate.name, detectedAt, known);
    } catch (err) {
      result.unreadable.push({ file: candidate.name, error: messageOf(err) });
      continue;
    }
    for (const record of scan.records) {
      known.add(record.fingerprint);
      result.newFindings.push(record);
    }
    result.knownFindings += scan.knownHits;
    result.unparsedLines += scan.unparsed;
    result.scannedFiles.push(candidate.name);
    if (candidate.key !== undefined) keep.add(candidate.key);
  }

  if (result.newFindings.length > 0) {
    const lines = result.newFindings.map((f) => `${JSON.stringify(f)}\n`)
      .join("");
    try {
      await Deno.writeTextFile(findingsPath, lines, { append: true });
    } catch (err) {
      throw new Error(
        `agent transcript scan: cannot record findings in ${findingsPath}: ${
          messageOf(err)
        }`,
        { cause: err },
      );
    }
  }

  // Only files present this pass and scanned or unchanged are kept, so a
  // vanished file's key is pruned from the memo.
  try {
    const state = {
      version: 1,
      rulesVersion: TRANSCRIPT_SCAN_RULES_VERSION,
      scanned: [...keep].sort(),
    };
    const tmpPath = `${statePath}.tmp`;
    await Deno.writeTextFile(tmpPath, `${JSON.stringify(state)}\n`);
    await Deno.rename(tmpPath, statePath);
  } catch (err) {
    result.stateError = messageOf(err);
  }

  return result;
}
