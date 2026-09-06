/**
 * One XML character escape, shared by every generated descriptor (Issue #1220).
 *
 * `setup/launchagent.ts` (macOS plist) and `setup/scheduled_task.ts` (Windows
 * Task Scheduler XML) each carried a private copy, and the copies drifted: the
 * plist escaped only its three `EnvironmentVariables` values and interpolated
 * the path fields raw, so a `log_dir` carrying markup could close the enclosing
 * `<string>` and add elements launchd honours. Both descriptors register
 * OS-level persistence, so one escape with one owner is the fix for the class,
 * not just for the instance.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/**
 * Escape the five XML metacharacters so a value cannot alter the document.
 *
 * `&` is replaced first — replacing it later would double-escape the entities
 * the other four introduce.
 *
 * @param value - The raw text to place inside an element or attribute
 * @returns The text with `& < > " '` replaced by their entities
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
