/**
 * Where the coding agent's own state lives (Issue #1407).
 *
 * The agent's configuration, session stores and memories used to sit *inside*
 * the work directory, beside every repository clone, the audit journal and
 * the caches. That single shared volume is what made bounding the work volume
 * expensive: any grant tightened there risked locking the agent out of its own
 * state, so every proposal escalated to per-slot accounts and groups.
 *
 * The two concerns are separable, and separating them is the whole change:
 *
 * - **The agent must be able to write its own state.** Its configuration, the
 *   transcripts `--resume` replays, and the per-repository session stores.
 *   Containment that stops the agent doing its job is not containment, it is
 *   a broken worker — see the containment goal in `docs/THREAT-MODEL.md`.
 * - **The agent should not need to write anything else.** With its state
 *   elsewhere, the work volume can be tightened on its own merits without
 *   that tightening ever reaching the agent's own store.
 *
 * So the store is a **sibling** of `workDir`, never a child, on its own named
 * volume — exactly the shape `content_approval_state_dir.ts` already uses for
 * the approval baseline, and for a closely related reason: a directory inside
 * the work tree is one that `nukeWorkDir()` deletes wholesale under disk
 * pressure, and one an agent-driven `rm` inside the work tree can reach.
 *
 * Deriving it from `workDir` rather than from `HOME` keeps each worker
 * identity isolated — fleet members have separate `HOME`s and so separate work
 * directories — without depending on `HOME` being set at all.
 *
 * ## Session isolation is unchanged
 *
 * Session stores were already keyed per owner, per repository and per work
 * stream (`session_manager.ts`), so runs on different repositories could not
 * confuse each other before this change and cannot now. Only the root moves.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

/** Suffix appended to `workDir` to name the agent-state root. */
const AGENT_STATE_DIR_SUFFIX = "-agent-state";

/**
 * Resolve the root holding the coding agent's own state.
 *
 * `""` is the explicit *unconfigured* sentinel, matching
 * `resolveContentApprovalStateDir`: `workDir` names no directory the store
 * can sit beside. Callers fall back to their previous behaviour on it rather
 * than inventing a relative directory.
 *
 * @param workDir - The agent-writable work directory (`config.workDir`).
 * @returns The agent-state root, or `""` when `workDir` names no directory
 *   (unset, whitespace-only, or `/`).
 */
export function resolveAgentStateDir(workDir: string): string {
  const trimmed = workDir.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return `${trimmed}${AGENT_STATE_DIR_SUFFIX}`;
}
