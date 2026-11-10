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
 */ /**
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
 */ const AUTH_PATTERNS = [
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
  "oauth token has expired"
];
/** Number of lines to check from the end of a file for auth errors. */ const AUTH_TAIL_LINES = 30;
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
 */ export function isClaudeAuthError(errorOutput) {
  if (!errorOutput) return false;
  const lower = errorOutput.toLowerCase();
  return AUTH_PATTERNS.some((pattern)=>lower.includes(pattern));
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
 */ export async function isClaudeAuthErrorInFile(filePath) {
  try {
    const content = await Deno.readTextFile(filePath);
    const lines = content.split("\n");
    const tailLines = lines.slice(-AUTH_TAIL_LINES).join("\n");
    return {
      ok: true,
      value: isClaudeAuthError(tailLines)
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        ok: true,
        value: false
      };
    }
    return {
      ok: false,
      error: new Error(`Failed to read file ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
    };
  }
}
/**
 * Return a human-readable message telling the operator how to fix an
 * expired Claude CLI session.
 *
 * @returns The actionable error message
 */ export function claudeAuthActionableMessage() {
  return "Claude CLI login required — run: claude login";
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jbGF1ZGVfYXV0aC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIENsYXVkZSBDTEkgYXV0aGVudGljYXRpb24gdmVyaWZpY2F0aW9uIChJc3N1ZSAjNjE3LCAjOTEzKS5cbiAqXG4gKiBEZXRlY3RzIHdoZW4gXCJjbGF1ZGUgbG9naW5cIiBpcyByZXF1aXJlZCBieSBpbnNwZWN0aW5nIENsYXVkZSBDTElcbiAqIGVycm9yIG91dHB1dCBmb3IgYXV0aGVudGljYXRpb24tcmVsYXRlZCBwYXR0ZXJucy4gUHJvdmlkZXMgaHVtYW4tcmVhZGFibGVcbiAqIGZpeCBpbnN0cnVjdGlvbnMuXG4gKlxuICogTWlncmF0ZWQgZnJvbSB3b3JrZXIvc2hhcmVkL2NsYXVkZV9hdXRoLnNoLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbi8qKlxuICogQXV0aGVudGljYXRpb24gZXJyb3IgcGF0dGVybnMgbWF0Y2hlZCBjYXNlLWluc2Vuc2l0aXZlbHkuXG4gKlxuICogVGhlc2UgYXJlIHRoZSBDbGF1ZGUgQ0xJJ3MgT1dOIGF1dGhlbnRpY2F0aW9uLWZhaWx1cmUgcGhyYXNpbmdzLCBib3RoXG4gKiBBbWVyaWNhbiBhbmQgQXVzdHJhbGlhbiBzcGVsbGluZ3Mgb2YgXCJ1bmF1dGhvcmlzZWRcIi9cInVuYXV0aG9yaXplZFwiLlxuICpcbiAqIElzc3VlICM0NTogdGhlIGJhcmUgc3Vic3RyaW5nIGBcImFwaSBrZXlcImAgYW5kIGEgbG9vc2UgYGludmFsaWRgK2B0b2tlbmBcbiAqIHBhaXIgd2VyZSByZW1vdmVkIOKAlCB0aGV5IG1hdGNoZWQgYW55IGlzc3VlIHdob3NlIHN1YmplY3QgaXMga2V5cywgdG9rZW5zIG9yXG4gKiBjcmVkZW50aWFscyAoYSByZWRhY3Rpb24vc2VjdXJpdHkgaXNzdWUpIG9uIHRoZSBtb2RlbCdzIG93biBwcm9zZSwgcmVjb3JkaW5nXG4gKiBhIHN1Y2Nlc3NmdWwgcnVuIGFzIGFuIGF1dGhlbnRpY2F0aW9uIGZhaWx1cmUuIEV2ZXJ5IHBhdHRlcm4gaGVyZSBpcyBub3cgYVxuICogcGhyYXNlIHRoZSBDTEkgYWN0dWFsbHkgcHJpbnRzIHdoZW4gdGhlIGNyZWRlbnRpYWwgaXMgYmFkLCBzbyBhIHRyYW5zY3JpcHRcbiAqIG1lcmVseSAqZGlzY3Vzc2luZyogQVBJIGtleXMgbm8gbG9uZ2VyIHRyaXBzIGl0LlxuICovXG5jb25zdCBBVVRIX1BBVFRFUk5TOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgXCJub3QgbG9nZ2VkIGluXCIsXG4gIFwicGxlYXNlIGxvZyBpblwiLFxuICBcImNsYXVkZSBsb2dpblwiLFxuICBcImF1dGhlbnRpY2F0aW9uIHJlcXVpcmVkXCIsXG4gIFwiYXV0aGVudGljYXRpb24gZmFpbGVkXCIsXG4gIFwic2Vzc2lvbiBleHBpcmVkXCIsXG4gIFwidW5hdXRob3JpemVkXCIsXG4gIFwidW5hdXRob3Jpc2VkXCIsXG4gIFwiaW52YWxpZCBhcGkga2V5XCIsXG4gIFwiaW5jb3JyZWN0IGFwaSBrZXlcIixcbiAgXCJpbnZhbGlkIHgtYXBpLWtleVwiLFxuICBcImFwaSBrZXkgbm90IGZvdW5kXCIsXG4gIFwibWlzc2luZyBhcGkga2V5XCIsXG4gIFwibm8gYXBpIGtleVwiLFxuICBcImludmFsaWQgdG9rZW5cIixcbiAgXCJleHBpcmVkIHRva2VuXCIsXG4gIFwib2F1dGggdG9rZW4gaGFzIGV4cGlyZWRcIixcbl07XG5cbi8qKiBOdW1iZXIgb2YgbGluZXMgdG8gY2hlY2sgZnJvbSB0aGUgZW5kIG9mIGEgZmlsZSBmb3IgYXV0aCBlcnJvcnMuICovXG5jb25zdCBBVVRIX1RBSUxfTElORVMgPSAzMDtcblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIGVycm9yIG91dHB1dCBpbmRpY2F0ZXMgYSBDbGF1ZGUgQ0xJIGF1dGhlbnRpY2F0aW9uIG9yXG4gKiBsb2dpbiBmYWlsdXJlLlxuICpcbiAqIE1hdGNoZXMgdGhlIENMSSdzIG93biBwaHJhc2luZ3Mg4oCUIFwibm90IGxvZ2dlZCBpblwiLCBcImNsYXVkZSBsb2dpblwiLFxuICogXCJhdXRoZW50aWNhdGlvbiByZXF1aXJlZC9mYWlsZWRcIiwgXCJzZXNzaW9uIGV4cGlyZWRcIixcbiAqIFwidW5hdXRob3Jpc2VkL3VuYXV0aG9yaXplZFwiLCBcImludmFsaWQvaW5jb3JyZWN0L21pc3NpbmcgYXBpIGtleVwiLFxuICogXCJpbnZhbGlkL2V4cGlyZWQgdG9rZW5cIiAoY2FzZS1pbnNlbnNpdGl2ZSkuXG4gKlxuICogSXNzdWUgIzQ1OiBldmVyeSBwYXR0ZXJuIGlzIGFuIGFkamFjZW50IHBocmFzZSB0aGUgQ0xJIHByaW50cywgc28gdGhpcyBtdXN0XG4gKiBiZSBydW4gb3ZlciB0aGUgQ0xJJ3MgZXJyb3Igc3VyZmFjZSAoc3RkZXJyIC8gdGhlIGZpbmFsIGVycm9yIGxpbmVzKSwgbm90IGFcbiAqIHdob2xlIHN1Y2Nlc3NmdWwgdHJhbnNjcmlwdCDigJQgYSBydW4gdGhhdCBtZXJlbHkgZGlzY3Vzc2VzIEFQSSBrZXlzIGlzIG5vdCBhblxuICogYXV0aCBmYWlsdXJlLiBUaGUgYGludmFsaWRgK2B0b2tlbmAgbG9vc2UgcGFpciB3YXMgZHJvcHBlZCBmb3IgdGhlIHNhbWVcbiAqIHJlYXNvbjogXCJhbiBpbnZhbGlkIHRva2VuIGFkZHJlc3NcIiBpbiBpc3N1ZSBwcm9zZSBpcyBub3QgYSBjcmVkZW50aWFsIGVycm9yLlxuICpcbiAqIEBwYXJhbSBlcnJvck91dHB1dCAtIFRoZSBzdGRlcnIgLyBmaW5hbCBlcnJvciB0ZXh0IGZyb20gYSBmYWlsZWQgQ2xhdWRlIGNvbW1hbmRcbiAqIEByZXR1cm5zIHRydWUgaWYgdGhlIG91dHB1dCBsb29rcyBsaWtlIGFuIGF1dGgvbG9naW4gZXJyb3JcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQ2xhdWRlQXV0aEVycm9yKGVycm9yT3V0cHV0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgaWYgKCFlcnJvck91dHB1dCkgcmV0dXJuIGZhbHNlO1xuXG4gIGNvbnN0IGxvd2VyID0gZXJyb3JPdXRwdXQudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIEFVVEhfUEFUVEVSTlMuc29tZSgocGF0dGVybikgPT4gbG93ZXIuaW5jbHVkZXMocGF0dGVybikpO1xufVxuXG4vKipcbiAqIENoZWNrIHdoZXRoZXIgdGhlIGxhc3QgTiBsaW5lcyBvZiBhIGZpbGUgY29udGFpbiBDbGF1ZGUgQ0xJXG4gKiBhdXRoZW50aWNhdGlvbiBlcnJvcnMuXG4gKlxuICogT25seSBjaGVja3MgdGhlIHRhaWwgb2YgdGhlIGZpbGUgdG8gYXZvaWQgZmFsc2UgcG9zaXRpdmVzIGZyb21cbiAqIENsYXVkZSBkaXNjdXNzaW5nIGF1dGhlbnRpY2F0aW9uIGFzIHBhcnQgb2YgaXRzIHdvcmsgb3V0cHV0LlxuICpcbiAqIEBwYXJhbSBmaWxlUGF0aCAtIFBhdGggdG8gdGhlIG91dHB1dCBmaWxlIHRvIGluc3BlY3RcbiAqIEByZXR1cm5zIFJlc3VsdCB3aXRoIHRydWUgaWYgYW4gYXV0aCBlcnJvciB3YXMgZm91bmQsIGZhbHNlIG90aGVyd2lzZVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaXNDbGF1ZGVBdXRoRXJyb3JJbkZpbGUoXG4gIGZpbGVQYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPFJlc3VsdDxib29sZWFuPj4ge1xuICB0cnkge1xuICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShmaWxlUGF0aCk7XG4gICAgY29uc3QgbGluZXMgPSBjb250ZW50LnNwbGl0KFwiXFxuXCIpO1xuICAgIGNvbnN0IHRhaWxMaW5lcyA9IGxpbmVzLnNsaWNlKC1BVVRIX1RBSUxfTElORVMpLmpvaW4oXCJcXG5cIik7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBpc0NsYXVkZUF1dGhFcnJvcih0YWlsTGluZXMpIH07XG4gIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgaWYgKGVycm9yIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuTm90Rm91bmQpIHtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogZmFsc2UgfTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBGYWlsZWQgdG8gcmVhZCBmaWxlICR7ZmlsZVBhdGh9OiAke1xuICAgICAgICAgIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKVxuICAgICAgICB9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIFJldHVybiBhIGh1bWFuLXJlYWRhYmxlIG1lc3NhZ2UgdGVsbGluZyB0aGUgb3BlcmF0b3IgaG93IHRvIGZpeCBhblxuICogZXhwaXJlZCBDbGF1ZGUgQ0xJIHNlc3Npb24uXG4gKlxuICogQHJldHVybnMgVGhlIGFjdGlvbmFibGUgZXJyb3IgbWVzc2FnZVxuICovXG5leHBvcnQgZnVuY3Rpb24gY2xhdWRlQXV0aEFjdGlvbmFibGVNZXNzYWdlKCk6IHN0cmluZyB7XG4gIHJldHVybiBcIkNsYXVkZSBDTEkgbG9naW4gcmVxdWlyZWQg4oCUIHJ1bjogY2xhdWRlIGxvZ2luXCI7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Q0FVQyxHQUlEOzs7Ozs7Ozs7Ozs7Q0FZQyxHQUNELE1BQU0sZ0JBQW1DO0VBQ3ZDO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7Q0FDRDtBQUVELHFFQUFxRSxHQUNyRSxNQUFNLGtCQUFrQjtBQUV4Qjs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FpQkMsR0FDRCxPQUFPLFNBQVMsa0JBQWtCLFdBQW1CO0VBQ25ELElBQUksQ0FBQyxhQUFhLE9BQU87RUFFekIsTUFBTSxRQUFRLFlBQVksV0FBVztFQUNyQyxPQUFPLGNBQWMsSUFBSSxDQUFDLENBQUMsVUFBWSxNQUFNLFFBQVEsQ0FBQztBQUN4RDtBQUVBOzs7Ozs7Ozs7Q0FTQyxHQUNELE9BQU8sZUFBZSx3QkFDcEIsUUFBZ0I7RUFFaEIsSUFBSTtJQUNGLE1BQU0sVUFBVSxNQUFNLEtBQUssWUFBWSxDQUFDO0lBQ3hDLE1BQU0sUUFBUSxRQUFRLEtBQUssQ0FBQztJQUM1QixNQUFNLFlBQVksTUFBTSxLQUFLLENBQUMsQ0FBQyxpQkFBaUIsSUFBSSxDQUFDO0lBQ3JELE9BQU87TUFBRSxJQUFJO01BQU0sT0FBTyxrQkFBa0I7SUFBVztFQUN6RCxFQUFFLE9BQU8sT0FBZ0I7SUFDdkIsSUFBSSxpQkFBaUIsS0FBSyxNQUFNLENBQUMsUUFBUSxFQUFFO01BQ3pDLE9BQU87UUFBRSxJQUFJO1FBQU0sT0FBTztNQUFNO0lBQ2xDO0lBQ0EsT0FBTztNQUNMLElBQUk7TUFDSixPQUFPLElBQUksTUFDVCxDQUFDLG9CQUFvQixFQUFFLFNBQVMsRUFBRSxFQUNoQyxpQkFBaUIsUUFBUSxNQUFNLE9BQU8sR0FBRyxPQUFPLFFBQ2hEO0lBRU47RUFDRjtBQUNGO0FBRUE7Ozs7O0NBS0MsR0FDRCxPQUFPLFNBQVM7RUFDZCxPQUFPO0FBQ1QifQ==
// denoCacheMetadata=6818038548900778983,1670593569681288733