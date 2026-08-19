/**
 * Shared prompt composition for coding-agent providers (Issue #4107).
 *
 * Claude takes a separate `--system-prompt` and a `--disallowed-tools` list;
 * most other CLIs take neither. Dropping either would silently deny that agent
 * the guidance every agent is required to run under — including the
 * sandboxed-environment guidance of Issue #4070 — so a provider without those
 * channels folds them into the single prompt it does take.
 *
 * That folding is one implementation here rather than one copy per vendor:
 * `codex_executor.ts` and `gemini_executor.ts` both compose through it.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

/** One agent prompt: the static guidance plus the per-run instructions. */
export interface AgentPromptParts {
  /** The user prompt. */
  prompt: string;
  /** Static system prompt, when the caller supplies one. */
  systemPrompt?: string;
  /** Tools the agent must not use. */
  disallowedTools?: readonly string[];
}

/**
 * Compose the single prompt string a CLI without separate channels takes.
 *
 * The order is fixed — system guidance first, then the tool restriction, then
 * the run's own instructions — so the composed prompt is stable across
 * providers and across runs.
 *
 * @param parts - The prompt, the optional system prompt and disallowed tools.
 * @returns The composed prompt.
 */
export function composeAgentPrompt(parts: AgentPromptParts): string {
  const sections: string[] = [];
  if (parts.systemPrompt) sections.push(parts.systemPrompt);
  const disallowed = parts.disallowedTools ?? [];
  if (disallowed.length > 0) {
    sections.push(`Do not use the following tools: ${disallowed.join(", ")}.`);
  }
  sections.push(parts.prompt);
  return sections.join("\n\n");
}
