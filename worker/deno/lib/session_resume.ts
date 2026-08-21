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
  /** UUID session ID for this issue invocation (Issue #204). */
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
 * A canonical RFC 4122 UUID — the only `--session-id` the Claude CLI accepts.
 */
const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Would the Claude CLI accept this session id? (Issue #204)
 *
 * Used to reject ids persisted before the UUID fix so a stale entry degrades
 * to "no session continuity" rather than killing the invocation.
 */
export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_RE.test(sessionId);
}

/**
 * Generate a session ID for an issue invocation.
 *
 * The ID was once `<repo>-<issue>-<timestamp>`, which the Claude CLI refuses
 * outright — it validates `--session-id` as a UUID and exits ~0.2 s after
 * spawn with "Invalid session ID. Must be a valid UUID." (Issue #204). Every
 * planning turn died on that refusal, so the id is now a real UUID; the
 * repo/issue/timestamp identity lives in the resume-state file name instead
 * (see `resume_state_store.ts`).
 *
 * @returns A UUID safe to pass to `--session-id`
 */
export function generateSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Create initial session resume state for a new issue invocation.
 *
 * @returns Initial session resume state
 */
export function createSessionResumeState(): SessionResumeState {
  return {
    sessionId: generateSessionId(),
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
