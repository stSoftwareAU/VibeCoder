/**
 * Terminal window title management for the Vibe Coder worker.
 *
 * Sets the terminal window title to indicate which task is currently being
 * worked on. This is optional and controlled by the setWindowTitle flag.
 *
 * Uses OSC (Operating System Command) escape sequences:
 *   ESC ] 0 ; <title> BEL — sets both window title and icon name
 *
 * Compatible with Terminal.app, iTerm2, VS Code integrated terminal, and most
 * xterm-compatible terminal emulators.
 *
 * Migrated from worker/shared/terminal_title.sh (Issue #900).
 * Issue #263: Set window title to the task currently being worked on.
 */

/** Maximum length for window titles to avoid terminal issues. */
export const WINDOW_TITLE_MAX_LENGTH = 80;

/** Options controlling terminal title behaviour. */
export interface TerminalTitleOptions {
  /** Whether terminal title setting is enabled. */
  enabled: boolean;
}

/** Data returned by the terminal-title command. */
export interface TerminalTitleData {
  title: string;
  sequence: string;
  enabled: boolean;
}

/**
 * Build the OSC escape sequence for a given title.
 *
 * The title is an attacker-supplied issue title, and it is written straight
 * into an OSC control sequence on the operator's terminal. Strip C0 control
 * characters and DEL first (Issue #3661, SEC-bfdd5fa86313): an embedded
 * `\x1b` or `\x07` would otherwise terminate the OSC string early and let the
 * remainder be interpreted as further terminal control — the same gap the
 * retired `issue_worker.sh` `set_window_title` carried.
 *
 * The title is then truncated to WINDOW_TITLE_MAX_LENGTH characters.
 * Returns the raw escape sequence string.
 */
export function buildTitleSequence(title: string): string {
  // deno-lint-ignore no-control-regex
  let truncated = title.replace(/[\x00-\x1f\x7f]/g, "");
  if (truncated.length > WINDOW_TITLE_MAX_LENGTH) {
    truncated = truncated.substring(0, WINDOW_TITLE_MAX_LENGTH) + "...";
  }
  return `\x1b]0;${truncated}\x07`;
}

/**
 * Set the terminal window title.
 *
 * Only produces output when enabled is true. Returns the OSC escape
 * sequence string (empty string when disabled).
 */
export function setWindowTitle(
  title: string,
  options: TerminalTitleOptions,
): string {
  if (!options.enabled) {
    return "";
  }
  return buildTitleSequence(title);
}

/**
 * Reset the terminal window title to the default "VibeCoder".
 */
export function resetWindowTitle(options: TerminalTitleOptions): string {
  return setWindowTitle("VibeCoder", options);
}

/**
 * Set title for issue processing.
 *
 * Formats: "VibeCoder: owner/repo #42 - Fix the bug"
 */
export function setWindowTitleForIssue(
  repo: string,
  issueNumber: string,
  issueTitle: string,
  options: TerminalTitleOptions,
): string {
  return setWindowTitle(
    `VibeCoder: ${repo} #${issueNumber} - ${issueTitle}`,
    options,
  );
}

/**
 * Set title for PR processing.
 *
 * Formats: "VibeCoder: owner/repo PR #99 - Feedback"
 */
export function setWindowTitleForPr(
  repo: string,
  prNumber: string,
  taskDesc: string,
  options: TerminalTitleOptions,
): string {
  return setWindowTitle(
    `VibeCoder: ${repo} PR #${prNumber} - ${taskDesc}`,
    options,
  );
}
