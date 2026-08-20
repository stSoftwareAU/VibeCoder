/**
 * Security command for the Vibe Coder worker.
 *
 * Provides input validation and security checks callable from shell
 * via the Deno CLI (`deno run mod.ts <command>`). Supports sub-operations:
 *   - validate-input: Validate issue title and body
 *   - check-commenter: Check if a user is authorised
 *   - detect-bots: Audit bot accounts in authorised commenters
 *
 * Migrated from worker/shared/security.sh (Issue #903).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  type BotAuditResult,
  detectBotAccounts,
  detectSuspiciousPatterns,
  isAuthorisedCommenter,
  type IssueValidationResult,
  validateIssueInput,
} from "../lib/security.ts";

/** Combined result type for the security command. */
type SecurityData = IssueValidationResult | BotAuditResult | {
  authorised: boolean;
} | { detected: boolean };

/**
 * Security command implementation.
 *
 * Args:
 *   --operation <string>   Operation to perform: validate-input, check-commenter,
 *                          detect-bots, detect-patterns
 *   --title <string>       Issue title (for validate-input)
 *   --body <string>        Issue body (for validate-input)
 *   --commenter <string>   Username to check (for check-commenter)
 *   --content <string>     Content to scan (for detect-patterns)
 *   --context <string>     Context description (for detect-patterns)
 */
export const securityCommand: Command = {
  name: "security",
  description: "Input validation and security checks",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<SecurityData>> {
    const operation = String(args["operation"] ?? "validate-input");

    switch (operation) {
      case "validate-input": {
        const title = String(args["title"] ?? "");
        const body = String(args["body"] ?? "");
        const result = validateIssueInput(title, body);

        const warnings: string[] = [];
        if (result.titleSuspicious) {
          warnings.push("Suspicious patterns detected in title");
        }
        if (result.bodySuspicious) {
          warnings.push("Suspicious patterns detected in body");
        }

        const message = warnings.length > 0
          ? `SECURITY: ${
            warnings.join("; ")
          } (ALLOWED_AUTHOR trusted, continuing). title=${result.titleLength}chars, body=${result.bodyLength}chars`
          : `Input validation complete: title=${result.titleLength}chars, body=${result.bodyLength}chars`;

        return { success: true, message, data: result };
      }

      case "check-commenter": {
        const commenter = String(args["commenter"] ?? "");
        const authorised = isAuthorisedCommenter(
          commenter,
          config.authorisedCommenters,
        );
        return {
          success: true,
          message: authorised ? "AUTHORISED" : "NOT_AUTHORISED",
          data: { authorised },
        };
      }

      case "detect-bots": {
        const result = detectBotAccounts(
          config.authorisedCommenters,
          // Issue #3206: use the allowedAuthors array rather than the
          // deprecated allowedAuthor scalar; the primary author is [0].
          config.allowedAuthors[0],
        );

        const message = result.botCount > 0
          ? `WARNING: AUTHORIZED_COMMENTERS includes ${result.botCount} bot account(s): ${
            result.botNames.join(", ")
          }`
          : "No bot accounts detected in AUTHORIZED_COMMENTERS";

        return { success: true, message, data: result };
      }

      case "detect-patterns": {
        const content = String(args["content"] ?? "");
        const context = String(args["context"] ?? "content");
        const result = detectSuspiciousPatterns(content, context);

        return {
          success: true,
          message: result.detected
            ? `SECURITY: Suspicious pattern detected in ${context}`
            : "No suspicious patterns detected",
          data: { detected: result.detected },
        };
      }

      default:
        return {
          success: false,
          message: `Unknown security operation: ${operation}`,
        };
    }
  },
};
