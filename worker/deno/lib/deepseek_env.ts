/**
 * Environment policy for the DeepSeek agent subprocess (Issue #412, #396).
 *
 * DeepSeek ships no CLI of its own: it is carried on the **Claude Code CLI**
 * pointed at DeepSeek's Anthropic-compatible endpoint. That makes the default
 * inheritance exactly the wrong one — the binary reads Anthropic's variables,
 * but the host on the other end belongs to a third party:
 *
 * - **Anthropic's own credentials are denied here**, even though the binary is
 *   Anthropic's, because the endpoint is not. A `claude` child legitimately
 *   carries `ANTHROPIC_API_KEY` (`claude_env.ts`); a DeepSeek child carrying it
 *   would send a live first-party credential to `api.deepseek.com` on every
 *   request.
 * - **The endpoint and the credential are pinned**, so the CLI cannot silently
 *   fall back to Anthropic's default host with DeepSeek's key.
 * - **The config dir is DeepSeek's own.** The `claude` and `deepseek` providers
 *   run the same binary, so one shared `CLAUDE_CONFIG_DIR` lets `--resume`
 *   replay a Claude session's transcripts into a DeepSeek run and back —
 *   silent cross-provider session bleed inside a Quorum image.
 *
 * The filtering itself is not re-implemented: this module names DeepSeek's
 * three lists and hands the work to `agent_env.ts`, which every provider
 * shares (Issue #4106).
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  buildAgentChildEnv,
  isDeniedAgentEnvVar,
  WORKER_ONLY_SECRET_ENV_VARS,
} from "./agent_env.ts";
import { CLAUDE_CREDENTIAL_ENV_VARS } from "./claude_env.ts";

/**
 * DeepSeek's Anthropic-compatible endpoint.
 *
 * The base URL DeepSeek documents for the Anthropic API surface. Pinned as a
 * constant so the one value the isolation depends on has a single home.
 */
export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";

/**
 * The DeepSeek child's `CLAUDE_CONFIG_DIR` leaf name.
 *
 * Deliberately *not* `.claude-config` (`claude_env.ts`) and not `.claude`: the
 * two providers run the same binary, and one shared directory is one shared
 * session store.
 */
const DEEPSEEK_CONFIG_DIR_NAME = ".claude-config-deepseek";

/**
 * Environment variables the DeepSeek child must never inherit.
 *
 * The worker-only secrets (see {@link WORKER_ONLY_SECRET_ENV_VARS}) plus every
 * *other* vendor's credential — including **Anthropic's**, whose CLI this is.
 * `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`
 * are first-party Anthropic credentials and the request goes to DeepSeek, so
 * they are named here rather than left to the secret-shape rule: no future
 * allowlist edit can hand them to this child.
 *
 * `ANTHROPIC_AUTH_TOKEN` is denied even though it is the variable the CLI
 * reads the credential under (Issue #414). In a `claude,deepseek` run the
 * preflight exports Claude's `claude/provider.env` into the worker's own
 * environment, so an *inherited* `ANTHROPIC_AUTH_TOKEN` is Anthropic's token —
 * inheriting it would send a live first-party credential to
 * `api.deepseek.com`. The child still gets the variable, but only as
 * {@link buildDeepSeekChildEnv} sets it, from `DEEPSEEK_API_KEY`.
 *
 * `GH_TOKEN` is deliberately not denied — it is the short-lived installation
 * token the model legitimately uses via `gh`, constrained by the `gh` PATH shim
 * (`gh_guard_shim.ts`, Issue #3643).
 *
 * The Anthropic names come from {@link CLAUDE_CREDENTIAL_ENV_VARS} rather than
 * a second copy of them, so a name Anthropic adds later is denied here the day
 * it is accepted there. A pooled host holds several Anthropic tokens
 * (Issue #920, parent #902); this child sees none of them, selected or not,
 * and `agent_env.ts` denies the suffixed and indexed variants too, so the
 * denial does not rest on the shape pattern happening to match.
 */
export const DEEPSEEK_ENV_DENYLIST: readonly string[] = [
  ...WORKER_ONLY_SECRET_ENV_VARS,
  ...CLAUDE_CREDENTIAL_ENV_VARS,
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

/**
 * Secret-shaped names the DeepSeek child genuinely needs.
 *
 * `GH_TOKEN` / `GITHUB_TOKEN` authenticate the agent's `gh` calls, and
 * `DEEPSEEK_API_KEY` is the credential the provisioned file supplies.
 * Everything else secret-shaped is dropped — including
 * `ANTHROPIC_AUTH_TOKEN`, the variable the CLI reads the credential under:
 * that value is *set* from `DEEPSEEK_API_KEY` by
 * {@link buildDeepSeekChildEnv}, never inherited, because an inherited one is
 * Anthropic's (Issue #414).
 */
export const DEEPSEEK_ENV_SECRET_ALLOWLIST: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "DEEPSEEK_API_KEY",
];

/**
 * Report whether a variable must be withheld from the DeepSeek child.
 *
 * @param name - Environment variable name.
 * @param denylist - Explicitly denied names (defaults to
 *   {@link DEEPSEEK_ENV_DENYLIST}).
 * @returns true when the variable is denied by name or by secret-ish shape.
 */
export function isDeniedDeepSeekEnvVar(
  name: string,
  denylist: readonly string[] = DEEPSEEK_ENV_DENYLIST,
): boolean {
  return isDeniedAgentEnvVar(name, {
    denylist,
    secretAllowlist: DEEPSEEK_ENV_SECRET_ALLOWLIST,
  });
}

/**
 * Build the environment for the DeepSeek child subprocess.
 *
 * Filters `parentEnv` as every provider does, then pins the three values that
 * make an Anthropic CLI a DeepSeek client. Each pin follows the same "an
 * explicit operator value always wins" shape as the `CLAUDE_CONFIG_DIR` pin in
 * `claude_env.ts`:
 *
 * - `ANTHROPIC_BASE_URL` → {@link DEEPSEEK_ANTHROPIC_BASE_URL}. An empty value
 *   is treated as unset, not as a choice: honouring it would point the CLI at
 *   Anthropic's default host carrying DeepSeek's key.
 * - `ANTHROPIC_AUTH_TOKEN` → `DEEPSEEK_API_KEY`, so the credential file
 *   provisioned under the `deepseek` sub-directory reaches the CLI without a
 *   second variable name to configure. Unlike the other two pins this one has
 *   no operator-value escape hatch: the variable is denied on the way in
 *   (Issue #414), because an inherited value is Anthropic's own token and the
 *   request goes to DeepSeek.
 * - `CLAUDE_CONFIG_DIR` → a DeepSeek-specific directory under `WORK_DIR` (or
 *   under `HOME` when the run driver exported no work dir), so `--resume`
 *   cannot cross providers. Unlike Claude's pin this is not container-only: on
 *   the host the Claude child stays on the operator's `~/.claude`, which is
 *   precisely the directory a DeepSeek child must not share.
 *
 * Intended for use with `Deno.Command`'s `clearEnv: true` so the child receives
 * exactly this map.
 *
 * @param parentEnv - The environment to inherit from (defaults to the current
 *   process environment).
 * @param denylist - Variable names to strip (defaults to
 *   {@link DEEPSEEK_ENV_DENYLIST}).
 * @returns A new object safe to pass as the child's `env`.
 */
export function buildDeepSeekChildEnv(
  parentEnv: Record<string, string> = Deno.env.toObject(),
  denylist: readonly string[] = DEEPSEEK_ENV_DENYLIST,
): Record<string, string> {
  const env = buildAgentChildEnv(parentEnv, {
    denylist,
    secretAllowlist: DEEPSEEK_ENV_SECRET_ALLOWLIST,
  });

  if (!env["ANTHROPIC_BASE_URL"]) {
    env["ANTHROPIC_BASE_URL"] = DEEPSEEK_ANTHROPIC_BASE_URL;
  }

  // The filter above denied any inherited ANTHROPIC_AUTH_TOKEN, so this is the
  // only way the variable is ever set for this child: from DeepSeek's own key.
  if (env["DEEPSEEK_API_KEY"]) {
    env["ANTHROPIC_AUTH_TOKEN"] = env["DEEPSEEK_API_KEY"];
  }

  if (env["CLAUDE_CONFIG_DIR"] === undefined) {
    // The durable work dir when the run driver exported one (Issue #4370),
    // otherwise the home directory — a dot-directory beside `~/.claude`, never
    // a work dir invented under the host's home (Issue #135).
    const base = env["WORK_DIR"] ?? env["HOME"];
    if (base) {
      env["CLAUDE_CONFIG_DIR"] = `${base}/${DEEPSEEK_CONFIG_DIR_NAME}`;
    }
  }

  return env;
}
