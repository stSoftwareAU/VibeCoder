/**
 * Shared identifiers for AI coding-agent GitHub Actions (Issue #3313,
 * parent #3309 — harden Vibe Coder against GitLost-style prompt-injection
 * data leaks).
 *
 * A GitLost-style attack pipes untrusted GitHub event text (an issue body,
 * comment, or title) into an autonomous coding agent invoked from a
 * workflow. Two native scans need to recognise such an agent step:
 *
 *   - `run_injection_scanner.ts` — flag untrusted `${{ github.event.* }}`
 *     reaching an AI action's `prompt:` / `with.*` inputs (the agentic
 *     counterpart to the existing `run:` shell-injection sink).
 *   - `llm_usage_detection.ts` — treat an issue/comment-triggered agent
 *     action as an LLM surface, so the OWASP LLM01 prompt-injection class
 *     is no longer skipped for agent-only repos.
 *
 * Both share this single list rather than each hard-coding its own, so a
 * new agent action is recognised everywhere by editing one place (DRY).
 *
 * Detection is **precision-first**: only concrete, known agent-action
 * slugs match. A speculative substring match (e.g. bare `copilot`) would
 * over-flag unrelated actions, so the list stays explicit and is grown
 * deliberately.
 *
 * Australian English spelling used throughout (behaviour, organisation,
 * authorised).
 */

/**
 * Known AI coding-agent action slugs (`owner/name`, lower-cased). An
 * action matches when its normalised `uses:` reference equals one of
 * these or sits beneath it as a sub-path (`<slug>/<subpath>`).
 */
export const AI_ACTION_SLUGS: readonly string[] = Object.freeze([
  "anthropics/claude-code-action",
  "anthropics/claude-code-base-action",
  "google-gemini/run-gemini-cli",
  "github/copilot-cli",
]);

/**
 * Normalise a `uses:` reference to a bare, lower-cased `owner/name`
 * (optionally with a sub-path). Strips surrounding quotes and the
 * `@<ref>` version/SHA suffix. Examples:
 * `anthropics/claude-code-action@beta` →
 * `anthropics/claude-code-action`; `"Anthropics/Claude-Code-Action@sha"`
 * → `anthropics/claude-code-action`.
 *
 * Pure — no I/O.
 */
export function normaliseUses(uses: string): string {
  let s = uses.trim().replace(/^["']|["']$/g, "");
  const at = s.indexOf("@");
  if (at > 0) s = s.slice(0, at);
  return s.toLowerCase();
}

/**
 * True when a `uses:` reference names a known AI coding-agent action.
 *
 * Matches the exact slug or a sub-path of it (`<slug>/<subpath>`), so a
 * versioned or sub-actioned reference is still recognised. Local (`./`)
 * and `docker://` references never match. Pure — no I/O.
 */
export function isAiAction(uses: string): boolean {
  const norm = normaliseUses(uses);
  if (!norm.includes("/")) return false;
  return AI_ACTION_SLUGS.some((slug) =>
    norm === slug || norm.startsWith(`${slug}/`)
  );
}
