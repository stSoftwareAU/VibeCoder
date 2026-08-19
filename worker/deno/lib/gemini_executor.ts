/**
 * Gemini CLI invocation construction (Issue #4107, parent #4102).
 *
 * Everything this worker knows about the Gemini command line lives here, the
 * way `claude_executor.ts` owns Claude's and `codex_executor.ts` owns Codex's
 * — the provider descriptor in `agent_provider.ts` describes Gemini, it does
 * not restate the CLI.
 *
 * The shape is `gemini --prompt <PROMPT>`: the CLI is interactive by default
 * and `-p/--prompt` is what makes one run headless, which is the only mode an
 * unattended worker can use.
 *
 * In Quorum mode Gemini is the judge, so its verdict has to be read rather
 * than guessed at. Three CLI facts drive the translation from
 * {@link GeminiInvocation}:
 *
 * - **Output is structured.** `--output-format` offers `text`, `json` and
 *   `stream-json`; the streaming form is chosen because it is both parseable
 *   *and* incremental. `claude_runner.ts` kills a child that produces no
 *   stdout for the silence timeout, so a single JSON object emitted only at
 *   the end would risk a long judging run being killed as silent.
 * - **There is no `--system-prompt` and no per-tool disable flag.** Both are
 *   composed into the single prompt by the shared composer rather than
 *   dropped — the sandboxed-environment guidance of Issue #4070 reaches this
 *   provider through that prompt.
 * - **There is no reasoning-effort option.** An effort the caller supplies is
 *   therefore not translated into a flag the CLI does not have: inventing one
 *   would fail the run outright.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { type AgentPromptParts, composeAgentPrompt } from "./agent_prompt.ts";

/**
 * Flags every worker-driven Gemini run carries.
 *
 * - `--output-format stream-json` streams machine-readable events, so the
 *   judge's verdict is parsed rather than scraped, and the run keeps
 *   producing output while it thinks.
 * - `--approval-mode yolo` — the container *is* the sandbox (Issue #4060) and
 *   no operator is present to approve anything, so the CLI's own approval
 *   prompts would deadlock an unattended run. It mirrors Claude's
 *   `--dangerously-skip-permissions`. The CLI's own `--sandbox` is
 *   deliberately absent: containment is the container's job.
 * - `--skip-trust` — the worker chooses the working tree itself, so the
 *   workspace-trust prompt has nobody to answer it.
 */
const STANDARD_FLAGS: readonly string[] = [
  "--output-format",
  "stream-json",
  "--approval-mode",
  "yolo",
  "--skip-trust",
];

/** Resume the most recent recorded session (`--resume latest`). */
const RESUME_LATEST: readonly string[] = ["--resume", "latest"];

/** What {@link buildGeminiArgs} needs to build one invocation. */
export interface GeminiInvocation extends AgentPromptParts {
  /** Explicit model id; omitted leaves Gemini on its configured default. */
  model?: string;
  /** Continue the previous run of this issue rather than starting fresh. */
  resumeSession?: boolean;
}

/**
 * Build the Gemini CLI argument list for one non-interactive run.
 *
 * Session continuity uses `--resume latest`: Gemini names sessions with its
 * own identifiers, so the worker resumes the most recent recorded session —
 * which, within a run, is the previous phase of the same issue — rather than
 * inventing an id Gemini would reject.
 *
 * @param invocation - Prompt, model selection and resume state.
 * @returns The argument list, prompt last.
 */
export function buildGeminiArgs(invocation: GeminiInvocation): string[] {
  const args: string[] = [...STANDARD_FLAGS];

  if (invocation.model) args.push("--model", invocation.model);
  if (invocation.resumeSession) args.push(...RESUME_LATEST);

  args.push("--prompt", composeAgentPrompt(invocation));
  return args;
}
