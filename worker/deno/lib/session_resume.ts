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
  /**
   * CLI session id for this issue invocation.
   *
   * Claude (and DeepSeek) require a UUID (Issue #204). Codex names its own
   * thread; the worker captures it from the CLI after the first run
   * (Issue #1699) and must never invent one or pass Claude's UUID into
   * `codex exec resume`.
   */
  sessionId: string;
  /** Number of phases completed using this session. */
  phaseCount: number;
  /**
   * Provider that owns {@link sessionId} (Issue #1699). Absent on records
   * written before this field existed — those ids are Claude UUIDs.
   */
  providerId?: string;
  /**
   * Credential label that opened the session (Issue #1699), when known.
   * A later spawn on a different account must not resume this id.
   */
  credentialScope?: string;
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
 * - First phase (phaseCount === 0): a new session under `--session-id`
 * - Subsequent phases (phaseCount > 0): `--resume <that id>` (Issue #1580)
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
 * Record the CLI's own session id after a run (Issue #1699).
 *
 * Codex (and any provider that names sessions itself) reports the id on
 * its event stream. The worker-generated UUID used to open a Claude
 * conversation is not that id, and passing it to another vendor resumes
 * nothing useful — or worse, another issue's thread when `--last` is used.
 */
export function adoptProviderSession(
  state: SessionResumeState,
  input: {
    sessionId?: string;
    providerId: string;
    credentialScope?: string;
  },
): SessionResumeState {
  // A missing capture must not relabel a worker-generated Claude UUID as a
  // Codex thread: the next phase would then `exec resume` an id the CLI
  // never minted (Issue #1699).
  if (!input.sessionId) return state;
  return {
    sessionId: input.sessionId,
    phaseCount: state.phaseCount,
    providerId: input.providerId,
    ...(input.credentialScope !== undefined
      ? { credentialScope: input.credentialScope }
      : state.credentialScope !== undefined
      ? { credentialScope: state.credentialScope }
      : {}),
  };
}

/**
 * The session id Codex may pass to `exec resume <id>`.
 *
 * Empty until a Codex run has reported one: a pre-generated Claude UUID
 * must not be sent, and `--last` is never a substitute (Issue #1699).
 */
export function codexResumeSessionId(
  state: SessionResumeState | undefined,
): string | undefined {
  if (!state) return undefined;
  if (!buildSessionResumeFlags(state).resume) return undefined;
  if (state.providerId !== "codex") return undefined;
  return state.sessionId || undefined;
}

/** A session id the store may persist for this provider. */
export function isPersistableSessionId(
  sessionId: string,
  providerId: string | undefined,
): boolean {
  if (!sessionId) return false;
  if (providerId === "codex") return true;
  return isValidSessionId(sessionId);
}

/**
 * Build the CLI argument array for session resume flags.
 *
 * Converts the structured flags into an array of CLI arguments
 * suitable for passing to `Deno.Command`.
 *
 * The two flags name two different things (Issue #1580): `--session-id
 * <uuid>` is the id a NEW conversation is created under, and `--resume
 * <uuid>` continues an existing one. A subsequent phase therefore sends
 * `--resume <id>` alone. It used to send `--session-id <id> --resume`, which
 * Claude Code 2.1.261 refuses at start-up — "--session-id can only be used
 * with --continue or --resume if --fork-session is also specified" — because
 * that pairing asks for a fork, which is not what a continuation wants.
 *
 * @param flags - Session resume flags
 * @returns Array of CLI arguments, e.g. `["--session-id", "<uuid>"]` for the
 *   first phase and `["--resume", "<uuid>"]` for a later one
 */
export function buildSessionResumeArgs(
  flags: SessionResumeFlags,
): string[] {
  if (flags.resume) {
    return flags.sessionId ? ["--resume", flags.sessionId] : ["--resume"];
  }
  return flags.sessionId ? ["--session-id", flags.sessionId] : [];
}

/**
 * Session state this provider may resume (Issue #1699).
 *
 * A stored id belongs to one vendor. Feeding a Claude UUID to Codex, or a
 * Codex thread to Claude, is not continuity — it is a start-up refusal or
 * another issue's conversation. Legacy records with no `providerId` are
 * Claude (or DeepSeek) UUIDs.
 */
export function sessionResumeForProvider(
  state: SessionResumeState | undefined,
  providerId: string,
): SessionResumeState | undefined {
  if (!state) return undefined;
  if (state.providerId && state.providerId !== providerId) return undefined;
  if (
    !state.providerId &&
    providerId !== "claude" &&
    providerId !== "deepseek"
  ) {
    return undefined;
  }
  return state;
}
