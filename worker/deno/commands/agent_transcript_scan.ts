/**
 * Scheduled scan of retained agent transcripts (Issue #3700).
 *
 * Runs `scanAgentTranscripts` over the worker log directory and fails loud
 * when a transcript shows an egress attempt, a read of a credential path or a
 * disallowed-tool attempt. Each new finding is recorded in the findings ledger
 * (`transcript-scan-findings.jsonl`) before the command reports it, so the
 * record survives the message scrolling away.
 *
 * Usage:
 *   deno task agent-transcript-scan
 *   deno task agent-transcript-scan --log-dir /path/to/logs
 *
 * Uses Australian English throughout (behaviour, recognise, organisation).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { agentTranscriptDir } from "../lib/agent_transcript.ts";
import {
  scanAgentTranscripts,
  type TranscriptScanResult,
} from "../lib/agent_transcript_scan.ts";

/** Most findings named in the failure message; the rest are counted. */
const MAX_NAMED_FINDINGS = 10;

/**
 * Agent transcript scan command implementation.
 */
export const agentTranscriptScanCommand: Command = {
  name: "agent-transcript-scan",
  description:
    "Scan retained agent transcripts for egress, credential reads and disallowed-tool attempts (Issue #3700)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<TranscriptScanResult>> {
    const logDirArg = args["log-dir"];
    const logDir = typeof logDirArg === "string" && logDirArg.length > 0
      ? logDirArg
      : agentTranscriptDir(Deno.env.get("HOME") ?? "/tmp");

    let result: TranscriptScanResult;
    try {
      result = await scanAgentTranscripts(logDir);
    } catch (err) {
      return {
        success: false,
        message: `[SECURITY] [AGENT_TRANSCRIPT_SCAN_FAILED] ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    const flagged = result.newFindings.length;
    if (flagged > 0) {
      const named = result.newFindings.slice(0, MAX_NAMED_FINDINGS).map((f) =>
        `${f.signal} ${f.file}:${f.line} ${f.detail}`
      ).join("; ");
      const more = flagged > MAX_NAMED_FINDINGS
        ? ` (and ${flagged - MAX_NAMED_FINDINGS} more)`
        : "";
      return {
        success: false,
        message: `[SECURITY] [AGENT_TRANSCRIPT_FLAGGED] ${flagged} new ` +
          `finding(s) in agent transcripts, recorded in ` +
          `${result.findingsPath}: ${named}${more}`,
        data: result,
      };
    }

    if (result.unreadable.length > 0 || result.stateError !== undefined) {
      const problems = result.unreadable.map((u) => `${u.file}: ${u.error}`);
      if (result.stateError !== undefined) {
        problems.push(`state file: ${result.stateError}`);
      }
      return {
        success: false,
        message: `[SECURITY] [AGENT_TRANSCRIPT_SCAN_INCOMPLETE] ${
          problems.join("; ")
        }`,
        data: result,
      };
    }

    let message = `agent transcript scan: scanned ${result.scannedFiles.length}, ` +
      `unchanged ${result.unchangedFiles}, new findings 0 ` +
      `(${result.knownFindings} already recorded)`;
    if (result.notChecked.length > 0) {
      message += `, not checked (gzipped) ${result.notChecked.length}`;
    }
    if (result.unparsedLines > 0) {
      message += `, unparsed lines ${result.unparsedLines}`;
    }
    return { success: true, message, data: result };
  },
};
