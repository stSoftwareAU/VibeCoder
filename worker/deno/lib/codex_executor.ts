/**
 * Codex CLI invocation construction (Issue #4106, parent #4102).
 *
 * Everything this worker knows about the Codex command line lives here, the
 * way `claude_executor.ts` owns Claude's — the provider descriptor in
 * `agent_provider.ts` describes Codex, it does not restate the CLI.
 *
 * The shape is `codex exec [OPTIONS] <PROMPT>`: one non-interactive run of one
 * prompt, emitting JSONL events on stdout so the worker can read the run
 * machine-readably rather than scraping a TUI.
 *
 * Two Codex facts drive the translation from {@link AgentInvocationRequest}:
 *
 * - **There is no `--system-prompt`.** Dropping the static system prompt would
 *   silently deny Codex the guidance every agent is required to run under —
 *   including the sandboxed-environment guidance of Issue #4070, which reaches
 *   the agent through that prompt. It is therefore composed into the single
 *   prompt Codex takes, not discarded.
 * - **There is no per-tool disable flag.** A disallowed-tools list is likewise
 *   carried into the prompt rather than dropped on the floor.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { type AgentPromptParts, composeAgentPrompt } from "./agent_prompt.ts";

/** The Codex subcommand for a non-interactive run. */
const EXEC_SUBCOMMAND = "exec";

/** Resume the most recent recorded session (`codex exec resume --last`). */
const RESUME_SUBCOMMAND = "resume";

/**
 * Flags every worker-driven Codex run carries.
 *
 * - `--json` prints events as JSONL, the machine-readable output the worker
 *   parses (Claude's `--output-format stream-json` equivalent).
 * - `--skip-git-repo-check` — the worker chooses the working tree itself and a
 *   phase may legitimately run outside a repository.
 * - `--dangerously-bypass-approvals-and-sandbox` — the container *is* the
 *   sandbox (Issue #4060) and no operator is present to approve anything, so
 *   Codex's own approval prompts would deadlock an unattended run. This is the
 *   documented flag for "running in an environment that is externally
 *   sandboxed", and it mirrors Claude's `--dangerously-skip-permissions`.
 */
const STANDARD_FLAGS: readonly string[] = [
  "--json",
  "--skip-git-repo-check",
  "--dangerously-bypass-approvals-and-sandbox",
];

/** Codex config key carrying the reasoning effort, set via `-c key=value`. */
const REASONING_EFFORT_KEY = "model_reasoning_effort";

/** One Codex prompt: the static guidance plus the per-run instructions. */
export type CodexPromptParts = AgentPromptParts;

/**
 * Compose the single prompt string `codex exec` takes.
 *
 * Codex has no separate system-prompt or disallowed-tools channel, so both are
 * folded into the prompt by the shared composer (Issue #4107), which every
 * provider in that position uses.
 *
 * @param parts - The prompt, the optional system prompt and disallowed tools.
 * @returns The composed prompt.
 */
export function composeCodexPrompt(parts: CodexPromptParts): string {
  return composeAgentPrompt(parts);
}

/** What {@link buildCodexArgs} needs to build one invocation. */
export interface CodexInvocation extends CodexPromptParts {
  /** Explicit model id; omitted leaves Codex on its configured default. */
  model?: string;
  /** Explicit reasoning effort; omitted leaves Codex on its default. */
  effort?: string;
  /** Continue the previous run of this issue rather than starting fresh. */
  resumeSession?: boolean;
}

/**
 * Build the Codex CLI argument list for one non-interactive run.
 *
 * Session continuity uses `codex exec resume --last`: Codex names sessions
 * with its own identifiers, so the worker resumes the most recent recorded
 * session — which, within a run, is the previous phase of the same issue —
 * rather than inventing an id Codex would reject.
 *
 * @param invocation - Prompt, model/effort selection and resume state.
 * @returns The argument list, prompt last.
 */
export function buildCodexArgs(invocation: CodexInvocation): string[] {
  const args: string[] = [EXEC_SUBCOMMAND];
  if (invocation.resumeSession) args.push(RESUME_SUBCOMMAND, "--last");

  args.push(...STANDARD_FLAGS);

  if (invocation.model) args.push("--model", invocation.model);
  if (invocation.effort) {
    args.push("-c", `${REASONING_EFFORT_KEY}="${invocation.effort}"`);
  }

  args.push(composeCodexPrompt(invocation));
  return args;
}
