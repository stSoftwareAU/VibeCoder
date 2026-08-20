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
 * These are the Claude CLI's OWN authentication-failure phrasings, both
 * American and Australian spellings of "unauthorised"/"unauthorized".
 *
 * Issue #45: the bare substring `"api key"` and a loose `invalid`+`token`
 * pair were removed — they matched any issue whose subject is keys, tokens or
 * credentials (a redaction/security issue) on the model's own prose, recording
 * a successful run as an authentication failure. Every pattern here is now a
 * phrase the CLI actually prints when the credential is bad, so a transcript
 * merely *discussing* API keys no longer trips it.
 */
const AUTH_PATTERNS: readonly string[] = [
  "not logged in",
  "please log in",
  "claude login",
  "authentication required",
  "authentication failed",
  "session expired",
  "unauthorized",
  "unauthorised",
  "invalid api key",
  "incorrect api key",
  "invalid x-api-key",
  "api key not found",
  "missing api key",
  "no api key",
  "invalid token",
  "expired token",
  "oauth token has expired",
];

/** Number of lines to check from the end of a file for auth errors. */
const AUTH_TAIL_LINES = 30;

/**
 * Check whether error output indicates a Claude CLI authentication or
 * login failure.
 *
 * Matches the CLI's own phrasings — "not logged in", "claude login",
 * "authentication required/failed", "session expired",
 * "unauthorised/unauthorized", "invalid/incorrect/missing api key",
 * "invalid/expired token" (case-insensitive).
 *
 * Issue #45: every pattern is an adjacent phrase the CLI prints, so this must
 * be run over the CLI's error surface (stderr / the final error lines), not a
 * whole successful transcript — a run that merely discusses API keys is not an
 * auth failure. The `invalid`+`token` loose pair was dropped for the same
 * reason: "an invalid token address" in issue prose is not a credential error.
 *
 * @param errorOutput - The stderr / final error text from a failed Claude command
 * @returns true if the output looks like an auth/login error
 */
export function isClaudeAuthError(errorOutput: string): boolean {
  if (!errorOutput) return false;

  const lower = errorOutput.toLowerCase();
  return AUTH_PATTERNS.some((pattern) => lower.includes(pattern));
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
