/**
 * Audit-log inspection command (Issue #2380).
 *
 * Pretty-prints (or streams as JSON) the tamper-evident GitHub-mutation
 * journal for an operator, and optionally verifies the hash chain.
 *
 * Usage:
 *   deno task audit-log-tail
 *   deno task audit-log-tail --date 2026-05-29 --limit 50
 *   deno task audit-log-tail --file /path/to/audit-worker-2026-05-29.jsonl
 *   deno task audit-log-tail --worker-id ci-host --json
 *   deno task audit-log-tail --verify
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  type AuditEntry,
  auditFilePath,
  loadEntries,
  verifyChain,
} from "../lib/audit_journal.ts";

/** Typed data returned by the audit-log-tail command. */
export interface AuditLogTailData {
  /** Resolved journal file path. */
  path: string;
  /** Entries shown (after applying --limit). */
  entries: AuditEntry[];
  /** Chain verification result, when --verify was requested. */
  verification?: { valid: boolean; count: number; reason?: string };
}

/** Format a single entry as a compact, human-readable line. */
function formatEntry(e: AuditEntry): string {
  const parts = [
    e.timestamp,
    e.outcome === "success" ? "OK " : "ERR",
    e.verb,
    e.repo ?? "-",
    e.target ?? "-",
    e.exitCode !== undefined ? `exit=${e.exitCode}` : "",
    e.caller ?? "",
    `run=${e.runId}`,
  ];
  return parts.filter((p) => p.length > 0).join("  ");
}

/**
 * Audit-log-tail command implementation.
 */
export const auditLogTailCommand: Command = {
  name: "audit-log-tail",
  description:
    "Inspect or verify the tamper-evident GitHub-mutation audit journal (Issue #2380)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<AuditLogTailData>> {
    const explicitFile = args["file"] as string | undefined;
    const baseDir = args["base-dir"] as string | undefined;
    const workerId = args["worker-id"] as string | undefined;
    const date = args["date"] as string | undefined;
    const limitRaw = args["limit"];
    const asJson = args["json"] === true;
    const doVerify = args["verify"] === true;

    const limit = typeof limitRaw === "number"
      ? limitRaw
      : typeof limitRaw === "string"
      ? parseInt(limitRaw, 10)
      : undefined;

    const path = explicitFile ?? auditFilePath({
      ...(baseDir ? { baseDir } : {}),
      ...(workerId ? { workerId } : {}),
      ...(date ? { date } : {}),
    });

    const loaded = await loadEntries(path);
    if (!loaded.ok) {
      return {
        success: false,
        message: loaded.error.message,
        data: { path, entries: [] },
      };
    }

    let entries = loaded.value;
    if (limit !== undefined && !Number.isNaN(limit) && limit > 0) {
      entries = entries.slice(-limit);
    }

    let verification: AuditLogTailData["verification"];
    const lines: string[] = [];

    if (doVerify) {
      const result = await verifyChain(path);
      if (result.ok) {
        verification = {
          valid: result.value.valid,
          count: result.value.count,
          ...(result.value.reason ? { reason: result.value.reason } : {}),
        };
        lines.push(
          result.value.valid
            ? `chain OK: ${result.value.count} entries verified`
            : `chain BROKEN at entry ${result.value.brokenIndex}: ${result.value.reason}`,
        );
      } else {
        return {
          success: false,
          message: result.error.message,
          data: { path, entries },
        };
      }
    }

    if (asJson) {
      for (const e of entries) lines.push(JSON.stringify(e));
    } else {
      lines.push(`Audit journal: ${path} (${loaded.value.length} entries)`);
      for (const e of entries) lines.push(formatEntry(e));
    }

    const verifyFailed = doVerify && verification && !verification.valid;
    return {
      success: !verifyFailed,
      message: lines.join("\n"),
      data: { path, entries, ...(verification ? { verification } : {}) },
    };
  },
};
