/**
 * Claude CLI authentication verification (Issue #617, #913).
 *
 * Detects when "claude login" is required by inspecting Claude CLI
 * error output for authentication-related patterns. Provides human-readable
 * fix instructions.
 *
 * Migrated from worker/shared/claude_auth.sh.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";

/**
 * Authentication error patterns matched case-insensitively.
 *
 * These cover the known Claude CLI authentication failure messages
 * including both American and Australian English spelling of
 * "unauthorised"/"unauthorized".
 */
const AUTH_PATTERNS: readonly string[] = [
  "not logged in",
  "please log in",
  "claude login",
  "authentication required",
  "session expired",
  "unauthorized",
  "unauthorised",
  "invalid token",
  "api key",
];

/** Number of lines to check from the end of a file for auth errors. */
const AUTH_TAIL_LINES = 30;

/**
 * Check whether error output indicates a Claude CLI authentication or
 * login failure.
 *
 * Matches patterns such as "not logged in", "claude login",
 * "authentication required", "session expired", "unauthorised/unauthorized",
 * "invalid token", and "api key" (case-insensitive).
 *
 * @param errorOutput - The stderr/stdout text from a failed Claude command
 * @returns true if the output looks like an auth/login error
 */
export function isClaudeAuthError(errorOutput: string): boolean {
  if (!errorOutput) return false;

  const lower = errorOutput.toLowerCase();

  // "invalid token" needs special handling: both words must be present
  // but may not be adjacent in all patterns. The original shell checked
  // *"invalid"*"token"* which allows intervening text.
  for (const pattern of AUTH_PATTERNS) {
    if (pattern === "invalid token") {
      if (lower.includes("invalid") && lower.includes("token")) {
        return true;
      }
    } else if (lower.includes(pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Check whether the last N lines of a file contain Claude CLI
 * authentication errors.
 *
 * Only checks the tail of the file to avoid false positives from
 * Claude discussing authentication as part of its work output.
 *
 * @param filePath - Path to the output file to inspect
 * @returns Result with true if an auth error was found, false otherwise
 */
export async function isClaudeAuthErrorInFile(
  filePath: string,
): Promise<Result<boolean>> {
  try {
    const content = await Deno.readTextFile(filePath);
    const lines = content.split("\n");
    const tailLines = lines.slice(-AUTH_TAIL_LINES).join("\n");
    return { ok: true, value: isClaudeAuthError(tailLines) };
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) {
      return { ok: true, value: false };
    }
    return {
      ok: false,
      error: new Error(
        `Failed to read file ${filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }
}

/**
 * Return a human-readable message telling the operator how to fix an
 * expired Claude CLI session.
 *
 * @returns The actionable error message
 */
export function claudeAuthActionableMessage(): string {
  return "Claude CLI login required — run: claude login";
}
