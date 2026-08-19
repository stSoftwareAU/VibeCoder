/**
 * Session resume support for multi-phase issue processing (Issue #1324).
 *
 * Enables Claude Code CLI session continuity across phases of the same
 * issue by using `--session-id` and `--resume` flags. This allows
 * subsequent phases (e.g., quality check after implementation) to build
 * on context already established, rather than starting from scratch.
 *
 * Complementary to the per-repo `.claude/` directory persistence
 * (Issue #1321) — that handles file-system-level session state, this
 * handles CLI-level session continuity.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Session tracking state for a single issue invocation.
 *
 * Stored in memory during issue processing and used to determine
 * whether to pass `--session-id` (first phase) or `--resume`
 * (subsequent phases) to the Claude CLI.
 */
export interface SessionResumeState {
  /** Deterministic session ID for this issue invocation. */
  sessionId: string;
  /** Number of phases completed using this session. */
  phaseCount: number;
}

/**
 * CLI flags to pass to the Claude CLI for session resume.
 */
export interface SessionResumeFlags {
  /** The `--session-id` value, if applicable. */
  sessionId?: string;
  /** Whether to pass `--resume` (true for subsequent phases). */
  resume: boolean;
}

/**
 * Generate a deterministic session ID for an issue invocation.
 *
 * The ID combines the repository, issue number, and a timestamp to
 * ensure uniqueness across invocations while remaining deterministic
 * within a single run.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - The issue number
 * @param timestamp - Unix timestamp in milliseconds (defaults to Date.now())
 * @returns A sanitised session ID string safe for CLI usage
 */
export function generateSessionId(
  repo: string,
  issueNumber: number,
  timestamp?: number,
): string {
  const ts = timestamp ?? Date.now();
  // Sanitise repo name: replace non-alphanumeric characters with hyphens
  const sanitisedRepo = repo.replace(/[^a-zA-Z0-9]/g, "-");
  return `${sanitisedRepo}-${issueNumber}-${ts}`;
}

/**
 * Create initial session resume state for a new issue invocation.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - The issue number
 * @param timestamp - Optional timestamp for deterministic testing
 * @returns Initial session resume state
 */
export function createSessionResumeState(
  repo: string,
  issueNumber: number,
  timestamp?: number,
): SessionResumeState {
  return {
    sessionId: generateSessionId(repo, issueNumber, timestamp),
    phaseCount: 0,
  };
}

/**
 * Build CLI flags for session resume based on current state.
 *
 * - First phase (phaseCount === 0): passes `--session-id` only
 * - Subsequent phases (phaseCount > 0): passes both `--session-id` and `--resume`
 *
 * @param state - Current session resume state (undefined if feature disabled)
 * @returns CLI flags to apply, or empty flags if state is undefined
 */
export function buildSessionResumeFlags(
  state: SessionResumeState | undefined,
): SessionResumeFlags {
  if (!state) {
    return { resume: false };
  }

  return {
    sessionId: state.sessionId,
    resume: state.phaseCount > 0,
  };
}

/**
 * Record that a phase has been completed, advancing the phase count.
 *
 * Call this after a successful Claude invocation to ensure the next
 * phase will use `--resume`.
 *
 * @param state - Current session resume state
 * @returns Updated state with incremented phase count
 */
export function recordPhaseCompletion(
  state: SessionResumeState,
): SessionResumeState {
  return {
    ...state,
    phaseCount: state.phaseCount + 1,
  };
}

/**
 * Build the CLI argument array for session resume flags.
 *
 * Converts the structured flags into an array of CLI arguments
 * suitable for passing to `Deno.Command`.
 *
 * @param flags - Session resume flags
 * @returns Array of CLI arguments (e.g., ["--session-id", "abc-123", "--resume"])
 */
export function buildSessionResumeArgs(
  flags: SessionResumeFlags,
): string[] {
  const args: string[] = [];

  if (flags.sessionId) {
    args.push("--session-id", flags.sessionId);
  }

  if (flags.resume) {
    args.push("--resume");
  }

  return args;
}
