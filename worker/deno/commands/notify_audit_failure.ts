/**
 * notify-audit-failure command (Issue #2691 — SCR-AUTO-UPDATE).
 *
 * Invoked from `.github/workflows/dependency-audit.yml` on a failing
 * *scheduled* run of the Deno dependency audit. It files (or skips, when
 * one already exists) a single tracking issue so a known advisory against
 * an already-committed Deno dependency surfaces an actionable item rather
 * than a silent red cron.
 *
 * Usage:
 *   deno run --allow-run --allow-env --allow-read \
 *     worker/deno/mod.ts notify-audit-failure \
 *       --repo owner/repo --ecosystem deno --run-url <url> \
 *       --audit-log <path to the captured audit output>
 *
 * Config-optional: the command needs only `gh` and its arguments, no
 * worker config.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  notifyAuditFailure,
  type NotifyAuditFailureResult,
} from "../lib/audit_failure_notifier.ts";

export const notifyAuditFailureCommand: Command = {
  name: "notify-audit-failure",
  description:
    "File a tracking issue when a scheduled dependency audit fails (Issue #2691)",
  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<NotifyAuditFailureResult>> {
    const repo = typeof args["repo"] === "string" ? args["repo"].trim() : "";
    const ecosystem = typeof args["ecosystem"] === "string"
      ? args["ecosystem"].trim()
      : "deno";
    const runUrl = typeof args["run-url"] === "string"
      ? args["run-url"].trim()
      : undefined;
    // Issue #3955: the captured audit output tells "the advisory service
    // did not answer" apart from "a committed dependency is vulnerable".
    const auditLogPath = typeof args["audit-log"] === "string"
      ? args["audit-log"].trim()
      : undefined;

    if (repo === "") {
      return {
        success: false,
        message: "notify-audit-failure: --repo is required (owner/repo)",
      };
    }

    const result = await notifyAuditFailure({
      repo,
      ecosystem,
      runUrl,
      auditLogPath,
    });

    const message = result.action === "filed"
      ? `[audit-notify] repo=${repo} ecosystem=${ecosystem} action=filed ` +
        `issue=${result.issueNumber ?? "unknown"} label=${
          result.labelApplied ? "applied" : "skipped"
        }`
      : result.action === "skipped"
      ? `[audit-notify] repo=${repo} ecosystem=${ecosystem} action=skipped ` +
        `reason=existing issue=${result.issueNumber ?? "unknown"}`
      : `[audit-notify] repo=${repo} ecosystem=${ecosystem} action=error ` +
        `reason=${result.reason ?? "unknown"}`;

    // An `error` action means the convenience notification could not be
    // filed; the audit failure itself is still surfaced by the red CI run,
    // so this command never masks the real failure.
    return {
      success: result.action !== "error",
      message,
      data: result,
    };
  },
};
