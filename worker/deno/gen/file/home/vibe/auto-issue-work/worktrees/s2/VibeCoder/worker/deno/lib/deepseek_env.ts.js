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
 */ import { buildAgentChildEnv, isDeniedAgentEnvVar, WORKER_ONLY_SECRET_ENV_VARS } from "./agent_env.ts";
import { CLAUDE_BASH_TIMEOUT_ENV, CLAUDE_CREDENTIAL_ENV_VARS } from "./claude_env.ts";
/**
 * DeepSeek's Anthropic-compatible endpoint.
 *
 * The base URL DeepSeek documents for the Anthropic API surface. Pinned as a
 * constant so the one value the isolation depends on has a single home.
 */ export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
/**
 * The DeepSeek child's `CLAUDE_CONFIG_DIR` leaf name.
 *
 * Deliberately *not* `.claude-config` (`claude_env.ts`) and not `.claude`: the
 * two providers run the same binary, and one shared directory is one shared
 * session store.
 */ const DEEPSEEK_CONFIG_DIR_NAME = ".claude-config-deepseek";
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
 */ export const DEEPSEEK_ENV_DENYLIST = [
  ...WORKER_ONLY_SECRET_ENV_VARS,
  ...CLAUDE_CREDENTIAL_ENV_VARS,
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_HOME",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY"
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
 */ export const DEEPSEEK_ENV_SECRET_ALLOWLIST = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "DEEPSEEK_API_KEY"
];
/**
 * Report whether a variable must be withheld from the DeepSeek child.
 *
 * @param name - Environment variable name.
 * @param denylist - Explicitly denied names (defaults to
 *   {@link DEEPSEEK_ENV_DENYLIST}).
 * @returns true when the variable is denied by name or by secret-ish shape.
 */ export function isDeniedDeepSeekEnvVar(name, denylist = DEEPSEEK_ENV_DENYLIST) {
  return isDeniedAgentEnvVar(name, {
    denylist,
    secretAllowlist: DEEPSEEK_ENV_SECRET_ALLOWLIST
  });
}
/**
 * Build the environment for the DeepSeek child subprocess.
 *
 * Filters `parentEnv` as every provider does, then pins the three values that
 * make an Anthropic CLI a DeepSeek client, and sets one default on top of them.
 * Each pin follows the same "an explicit operator value always wins" shape as
 * the `CLAUDE_CONFIG_DIR` pin in `claude_env.ts`:
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
 * - `BASH_MAX_TIMEOUT_MS` → {@link CLAUDE_BASH_TIMEOUT_ENV} (Issue #4926): the
 *   foreground command ceiling, defaulted rather than pinned, so an explicit
 *   parent value wins. The `deepseek` binary is the same Claude Code CLI, so it
 *   reads the same variable.
 *
 * Intended for use with `Deno.Command`'s `clearEnv: true` so the child receives
 * exactly this map.
 *
 * @param parentEnv - The environment to inherit from (defaults to the current
 *   process environment).
 * @param denylist - Variable names to strip (defaults to
 *   {@link DEEPSEEK_ENV_DENYLIST}).
 * @returns A new object safe to pass as the child's `env`.
 */ export function buildDeepSeekChildEnv(parentEnv = Deno.env.toObject(), denylist = DEEPSEEK_ENV_DENYLIST) {
  const env = buildAgentChildEnv(parentEnv, {
    denylist,
    secretAllowlist: DEEPSEEK_ENV_SECRET_ALLOWLIST
  });
  // Foreground command ceiling (Issue #4926, as #4913 for `claude`): the same
  // CLI version reads it; an explicit parent value wins.
  for (const [name, value] of Object.entries(CLAUDE_BASH_TIMEOUT_ENV)){
    if (env[name] === undefined) env[name] = value;
  }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9kZWVwc2Vla19lbnYudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBFbnZpcm9ubWVudCBwb2xpY3kgZm9yIHRoZSBEZWVwU2VlayBhZ2VudCBzdWJwcm9jZXNzIChJc3N1ZSAjNDEyLCAjMzk2KS5cbiAqXG4gKiBEZWVwU2VlayBzaGlwcyBubyBDTEkgb2YgaXRzIG93bjogaXQgaXMgY2FycmllZCBvbiB0aGUgKipDbGF1ZGUgQ29kZSBDTEkqKlxuICogcG9pbnRlZCBhdCBEZWVwU2VlaydzIEFudGhyb3BpYy1jb21wYXRpYmxlIGVuZHBvaW50LiBUaGF0IG1ha2VzIHRoZSBkZWZhdWx0XG4gKiBpbmhlcml0YW5jZSBleGFjdGx5IHRoZSB3cm9uZyBvbmUg4oCUIHRoZSBiaW5hcnkgcmVhZHMgQW50aHJvcGljJ3MgdmFyaWFibGVzLFxuICogYnV0IHRoZSBob3N0IG9uIHRoZSBvdGhlciBlbmQgYmVsb25ncyB0byBhIHRoaXJkIHBhcnR5OlxuICpcbiAqIC0gKipBbnRocm9waWMncyBvd24gY3JlZGVudGlhbHMgYXJlIGRlbmllZCBoZXJlKiosIGV2ZW4gdGhvdWdoIHRoZSBiaW5hcnkgaXNcbiAqICAgQW50aHJvcGljJ3MsIGJlY2F1c2UgdGhlIGVuZHBvaW50IGlzIG5vdC4gQSBgY2xhdWRlYCBjaGlsZCBsZWdpdGltYXRlbHlcbiAqICAgY2FycmllcyBgQU5USFJPUElDX0FQSV9LRVlgIChgY2xhdWRlX2Vudi50c2ApOyBhIERlZXBTZWVrIGNoaWxkIGNhcnJ5aW5nIGl0XG4gKiAgIHdvdWxkIHNlbmQgYSBsaXZlIGZpcnN0LXBhcnR5IGNyZWRlbnRpYWwgdG8gYGFwaS5kZWVwc2Vlay5jb21gIG9uIGV2ZXJ5XG4gKiAgIHJlcXVlc3QuXG4gKiAtICoqVGhlIGVuZHBvaW50IGFuZCB0aGUgY3JlZGVudGlhbCBhcmUgcGlubmVkKiosIHNvIHRoZSBDTEkgY2Fubm90IHNpbGVudGx5XG4gKiAgIGZhbGwgYmFjayB0byBBbnRocm9waWMncyBkZWZhdWx0IGhvc3Qgd2l0aCBEZWVwU2VlaydzIGtleS5cbiAqIC0gKipUaGUgY29uZmlnIGRpciBpcyBEZWVwU2VlaydzIG93bi4qKiBUaGUgYGNsYXVkZWAgYW5kIGBkZWVwc2Vla2AgcHJvdmlkZXJzXG4gKiAgIHJ1biB0aGUgc2FtZSBiaW5hcnksIHNvIG9uZSBzaGFyZWQgYENMQVVERV9DT05GSUdfRElSYCBsZXRzIGAtLXJlc3VtZWBcbiAqICAgcmVwbGF5IGEgQ2xhdWRlIHNlc3Npb24ncyB0cmFuc2NyaXB0cyBpbnRvIGEgRGVlcFNlZWsgcnVuIGFuZCBiYWNrIOKAlFxuICogICBzaWxlbnQgY3Jvc3MtcHJvdmlkZXIgc2Vzc2lvbiBibGVlZCBpbnNpZGUgYSBRdW9ydW0gaW1hZ2UuXG4gKlxuICogVGhlIGZpbHRlcmluZyBpdHNlbGYgaXMgbm90IHJlLWltcGxlbWVudGVkOiB0aGlzIG1vZHVsZSBuYW1lcyBEZWVwU2VlaydzXG4gKiB0aHJlZSBsaXN0cyBhbmQgaGFuZHMgdGhlIHdvcmsgdG8gYGFnZW50X2Vudi50c2AsIHdoaWNoIGV2ZXJ5IHByb3ZpZGVyXG4gKiBzaGFyZXMgKElzc3VlICM0MTA2KS5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB7XG4gIGJ1aWxkQWdlbnRDaGlsZEVudixcbiAgaXNEZW5pZWRBZ2VudEVudlZhcixcbiAgV09SS0VSX09OTFlfU0VDUkVUX0VOVl9WQVJTLFxufSBmcm9tIFwiLi9hZ2VudF9lbnYudHNcIjtcbmltcG9ydCB7XG4gIENMQVVERV9CQVNIX1RJTUVPVVRfRU5WLFxuICBDTEFVREVfQ1JFREVOVElBTF9FTlZfVkFSUyxcbn0gZnJvbSBcIi4vY2xhdWRlX2Vudi50c1wiO1xuXG4vKipcbiAqIERlZXBTZWVrJ3MgQW50aHJvcGljLWNvbXBhdGlibGUgZW5kcG9pbnQuXG4gKlxuICogVGhlIGJhc2UgVVJMIERlZXBTZWVrIGRvY3VtZW50cyBmb3IgdGhlIEFudGhyb3BpYyBBUEkgc3VyZmFjZS4gUGlubmVkIGFzIGFcbiAqIGNvbnN0YW50IHNvIHRoZSBvbmUgdmFsdWUgdGhlIGlzb2xhdGlvbiBkZXBlbmRzIG9uIGhhcyBhIHNpbmdsZSBob21lLlxuICovXG5leHBvcnQgY29uc3QgREVFUFNFRUtfQU5USFJPUElDX0JBU0VfVVJMID0gXCJodHRwczovL2FwaS5kZWVwc2Vlay5jb20vYW50aHJvcGljXCI7XG5cbi8qKlxuICogVGhlIERlZXBTZWVrIGNoaWxkJ3MgYENMQVVERV9DT05GSUdfRElSYCBsZWFmIG5hbWUuXG4gKlxuICogRGVsaWJlcmF0ZWx5ICpub3QqIGAuY2xhdWRlLWNvbmZpZ2AgKGBjbGF1ZGVfZW52LnRzYCkgYW5kIG5vdCBgLmNsYXVkZWA6IHRoZVxuICogdHdvIHByb3ZpZGVycyBydW4gdGhlIHNhbWUgYmluYXJ5LCBhbmQgb25lIHNoYXJlZCBkaXJlY3RvcnkgaXMgb25lIHNoYXJlZFxuICogc2Vzc2lvbiBzdG9yZS5cbiAqL1xuY29uc3QgREVFUFNFRUtfQ09ORklHX0RJUl9OQU1FID0gXCIuY2xhdWRlLWNvbmZpZy1kZWVwc2Vla1wiO1xuXG4vKipcbiAqIEVudmlyb25tZW50IHZhcmlhYmxlcyB0aGUgRGVlcFNlZWsgY2hpbGQgbXVzdCBuZXZlciBpbmhlcml0LlxuICpcbiAqIFRoZSB3b3JrZXItb25seSBzZWNyZXRzIChzZWUge0BsaW5rIFdPUktFUl9PTkxZX1NFQ1JFVF9FTlZfVkFSU30pIHBsdXMgZXZlcnlcbiAqICpvdGhlciogdmVuZG9yJ3MgY3JlZGVudGlhbCDigJQgaW5jbHVkaW5nICoqQW50aHJvcGljJ3MqKiwgd2hvc2UgQ0xJIHRoaXMgaXMuXG4gKiBgQU5USFJPUElDX0FQSV9LRVlgLCBgQU5USFJPUElDX0FVVEhfVE9LRU5gIGFuZCBgQ0xBVURFX0NPREVfT0FVVEhfVE9LRU5gXG4gKiBhcmUgZmlyc3QtcGFydHkgQW50aHJvcGljIGNyZWRlbnRpYWxzIGFuZCB0aGUgcmVxdWVzdCBnb2VzIHRvIERlZXBTZWVrLCBzb1xuICogdGhleSBhcmUgbmFtZWQgaGVyZSByYXRoZXIgdGhhbiBsZWZ0IHRvIHRoZSBzZWNyZXQtc2hhcGUgcnVsZTogbm8gZnV0dXJlXG4gKiBhbGxvd2xpc3QgZWRpdCBjYW4gaGFuZCB0aGVtIHRvIHRoaXMgY2hpbGQuXG4gKlxuICogYEFOVEhST1BJQ19BVVRIX1RPS0VOYCBpcyBkZW5pZWQgZXZlbiB0aG91Z2ggaXQgaXMgdGhlIHZhcmlhYmxlIHRoZSBDTElcbiAqIHJlYWRzIHRoZSBjcmVkZW50aWFsIHVuZGVyIChJc3N1ZSAjNDE0KS4gSW4gYSBgY2xhdWRlLGRlZXBzZWVrYCBydW4gdGhlXG4gKiBwcmVmbGlnaHQgZXhwb3J0cyBDbGF1ZGUncyBgY2xhdWRlL3Byb3ZpZGVyLmVudmAgaW50byB0aGUgd29ya2VyJ3Mgb3duXG4gKiBlbnZpcm9ubWVudCwgc28gYW4gKmluaGVyaXRlZCogYEFOVEhST1BJQ19BVVRIX1RPS0VOYCBpcyBBbnRocm9waWMncyB0b2tlbiDigJRcbiAqIGluaGVyaXRpbmcgaXQgd291bGQgc2VuZCBhIGxpdmUgZmlyc3QtcGFydHkgY3JlZGVudGlhbCB0b1xuICogYGFwaS5kZWVwc2Vlay5jb21gLiBUaGUgY2hpbGQgc3RpbGwgZ2V0cyB0aGUgdmFyaWFibGUsIGJ1dCBvbmx5IGFzXG4gKiB7QGxpbmsgYnVpbGREZWVwU2Vla0NoaWxkRW52fSBzZXRzIGl0LCBmcm9tIGBERUVQU0VFS19BUElfS0VZYC5cbiAqXG4gKiBgR0hfVE9LRU5gIGlzIGRlbGliZXJhdGVseSBub3QgZGVuaWVkIOKAlCBpdCBpcyB0aGUgc2hvcnQtbGl2ZWQgaW5zdGFsbGF0aW9uXG4gKiB0b2tlbiB0aGUgbW9kZWwgbGVnaXRpbWF0ZWx5IHVzZXMgdmlhIGBnaGAsIGNvbnN0cmFpbmVkIGJ5IHRoZSBgZ2hgIFBBVEggc2hpbVxuICogKGBnaF9ndWFyZF9zaGltLnRzYCwgSXNzdWUgIzM2NDMpLlxuICpcbiAqIFRoZSBBbnRocm9waWMgbmFtZXMgY29tZSBmcm9tIHtAbGluayBDTEFVREVfQ1JFREVOVElBTF9FTlZfVkFSU30gcmF0aGVyIHRoYW5cbiAqIGEgc2Vjb25kIGNvcHkgb2YgdGhlbSwgc28gYSBuYW1lIEFudGhyb3BpYyBhZGRzIGxhdGVyIGlzIGRlbmllZCBoZXJlIHRoZSBkYXlcbiAqIGl0IGlzIGFjY2VwdGVkIHRoZXJlLiBBIHBvb2xlZCBob3N0IGhvbGRzIHNldmVyYWwgQW50aHJvcGljIHRva2Vuc1xuICogKElzc3VlICM5MjAsIHBhcmVudCAjOTAyKTsgdGhpcyBjaGlsZCBzZWVzIG5vbmUgb2YgdGhlbSwgc2VsZWN0ZWQgb3Igbm90LFxuICogYW5kIGBhZ2VudF9lbnYudHNgIGRlbmllcyB0aGUgc3VmZml4ZWQgYW5kIGluZGV4ZWQgdmFyaWFudHMgdG9vLCBzbyB0aGVcbiAqIGRlbmlhbCBkb2VzIG5vdCByZXN0IG9uIHRoZSBzaGFwZSBwYXR0ZXJuIGhhcHBlbmluZyB0byBtYXRjaC5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRVBTRUVLX0VOVl9ERU5ZTElTVDogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gIC4uLldPUktFUl9PTkxZX1NFQ1JFVF9FTlZfVkFSUyxcbiAgLi4uQ0xBVURFX0NSRURFTlRJQUxfRU5WX1ZBUlMsXG4gIFwiT1BFTkFJX0FQSV9LRVlcIixcbiAgXCJDT0RFWF9BUElfS0VZXCIsXG4gIFwiQ09ERVhfSE9NRVwiLFxuICBcIkdFTUlOSV9BUElfS0VZXCIsXG4gIFwiR09PR0xFX0FQSV9LRVlcIixcbl07XG5cbi8qKlxuICogU2VjcmV0LXNoYXBlZCBuYW1lcyB0aGUgRGVlcFNlZWsgY2hpbGQgZ2VudWluZWx5IG5lZWRzLlxuICpcbiAqIGBHSF9UT0tFTmAgLyBgR0lUSFVCX1RPS0VOYCBhdXRoZW50aWNhdGUgdGhlIGFnZW50J3MgYGdoYCBjYWxscywgYW5kXG4gKiBgREVFUFNFRUtfQVBJX0tFWWAgaXMgdGhlIGNyZWRlbnRpYWwgdGhlIHByb3Zpc2lvbmVkIGZpbGUgc3VwcGxpZXMuXG4gKiBFdmVyeXRoaW5nIGVsc2Ugc2VjcmV0LXNoYXBlZCBpcyBkcm9wcGVkIOKAlCBpbmNsdWRpbmdcbiAqIGBBTlRIUk9QSUNfQVVUSF9UT0tFTmAsIHRoZSB2YXJpYWJsZSB0aGUgQ0xJIHJlYWRzIHRoZSBjcmVkZW50aWFsIHVuZGVyOlxuICogdGhhdCB2YWx1ZSBpcyAqc2V0KiBmcm9tIGBERUVQU0VFS19BUElfS0VZYCBieVxuICoge0BsaW5rIGJ1aWxkRGVlcFNlZWtDaGlsZEVudn0sIG5ldmVyIGluaGVyaXRlZCwgYmVjYXVzZSBhbiBpbmhlcml0ZWQgb25lIGlzXG4gKiBBbnRocm9waWMncyAoSXNzdWUgIzQxNCkuXG4gKi9cbmV4cG9ydCBjb25zdCBERUVQU0VFS19FTlZfU0VDUkVUX0FMTE9XTElTVDogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gIFwiR0hfVE9LRU5cIixcbiAgXCJHSVRIVUJfVE9LRU5cIixcbiAgXCJERUVQU0VFS19BUElfS0VZXCIsXG5dO1xuXG4vKipcbiAqIFJlcG9ydCB3aGV0aGVyIGEgdmFyaWFibGUgbXVzdCBiZSB3aXRoaGVsZCBmcm9tIHRoZSBEZWVwU2VlayBjaGlsZC5cbiAqXG4gKiBAcGFyYW0gbmFtZSAtIEVudmlyb25tZW50IHZhcmlhYmxlIG5hbWUuXG4gKiBAcGFyYW0gZGVueWxpc3QgLSBFeHBsaWNpdGx5IGRlbmllZCBuYW1lcyAoZGVmYXVsdHMgdG9cbiAqICAge0BsaW5rIERFRVBTRUVLX0VOVl9ERU5ZTElTVH0pLlxuICogQHJldHVybnMgdHJ1ZSB3aGVuIHRoZSB2YXJpYWJsZSBpcyBkZW5pZWQgYnkgbmFtZSBvciBieSBzZWNyZXQtaXNoIHNoYXBlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNEZW5pZWREZWVwU2Vla0VudlZhcihcbiAgbmFtZTogc3RyaW5nLFxuICBkZW55bGlzdDogcmVhZG9ubHkgc3RyaW5nW10gPSBERUVQU0VFS19FTlZfREVOWUxJU1QsXG4pOiBib29sZWFuIHtcbiAgcmV0dXJuIGlzRGVuaWVkQWdlbnRFbnZWYXIobmFtZSwge1xuICAgIGRlbnlsaXN0LFxuICAgIHNlY3JldEFsbG93bGlzdDogREVFUFNFRUtfRU5WX1NFQ1JFVF9BTExPV0xJU1QsXG4gIH0pO1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSBlbnZpcm9ubWVudCBmb3IgdGhlIERlZXBTZWVrIGNoaWxkIHN1YnByb2Nlc3MuXG4gKlxuICogRmlsdGVycyBgcGFyZW50RW52YCBhcyBldmVyeSBwcm92aWRlciBkb2VzLCB0aGVuIHBpbnMgdGhlIHRocmVlIHZhbHVlcyB0aGF0XG4gKiBtYWtlIGFuIEFudGhyb3BpYyBDTEkgYSBEZWVwU2VlayBjbGllbnQsIGFuZCBzZXRzIG9uZSBkZWZhdWx0IG9uIHRvcCBvZiB0aGVtLlxuICogRWFjaCBwaW4gZm9sbG93cyB0aGUgc2FtZSBcImFuIGV4cGxpY2l0IG9wZXJhdG9yIHZhbHVlIGFsd2F5cyB3aW5zXCIgc2hhcGUgYXNcbiAqIHRoZSBgQ0xBVURFX0NPTkZJR19ESVJgIHBpbiBpbiBgY2xhdWRlX2Vudi50c2A6XG4gKlxuICogLSBgQU5USFJPUElDX0JBU0VfVVJMYCDihpIge0BsaW5rIERFRVBTRUVLX0FOVEhST1BJQ19CQVNFX1VSTH0uIEFuIGVtcHR5IHZhbHVlXG4gKiAgIGlzIHRyZWF0ZWQgYXMgdW5zZXQsIG5vdCBhcyBhIGNob2ljZTogaG9ub3VyaW5nIGl0IHdvdWxkIHBvaW50IHRoZSBDTEkgYXRcbiAqICAgQW50aHJvcGljJ3MgZGVmYXVsdCBob3N0IGNhcnJ5aW5nIERlZXBTZWVrJ3Mga2V5LlxuICogLSBgQU5USFJPUElDX0FVVEhfVE9LRU5gIOKGkiBgREVFUFNFRUtfQVBJX0tFWWAsIHNvIHRoZSBjcmVkZW50aWFsIGZpbGVcbiAqICAgcHJvdmlzaW9uZWQgdW5kZXIgdGhlIGBkZWVwc2Vla2Agc3ViLWRpcmVjdG9yeSByZWFjaGVzIHRoZSBDTEkgd2l0aG91dCBhXG4gKiAgIHNlY29uZCB2YXJpYWJsZSBuYW1lIHRvIGNvbmZpZ3VyZS4gVW5saWtlIHRoZSBvdGhlciB0d28gcGlucyB0aGlzIG9uZSBoYXNcbiAqICAgbm8gb3BlcmF0b3ItdmFsdWUgZXNjYXBlIGhhdGNoOiB0aGUgdmFyaWFibGUgaXMgZGVuaWVkIG9uIHRoZSB3YXkgaW5cbiAqICAgKElzc3VlICM0MTQpLCBiZWNhdXNlIGFuIGluaGVyaXRlZCB2YWx1ZSBpcyBBbnRocm9waWMncyBvd24gdG9rZW4gYW5kIHRoZVxuICogICByZXF1ZXN0IGdvZXMgdG8gRGVlcFNlZWsuXG4gKiAtIGBDTEFVREVfQ09ORklHX0RJUmAg4oaSIGEgRGVlcFNlZWstc3BlY2lmaWMgZGlyZWN0b3J5IHVuZGVyIGBXT1JLX0RJUmAgKG9yXG4gKiAgIHVuZGVyIGBIT01FYCB3aGVuIHRoZSBydW4gZHJpdmVyIGV4cG9ydGVkIG5vIHdvcmsgZGlyKSwgc28gYC0tcmVzdW1lYFxuICogICBjYW5ub3QgY3Jvc3MgcHJvdmlkZXJzLiBVbmxpa2UgQ2xhdWRlJ3MgcGluIHRoaXMgaXMgbm90IGNvbnRhaW5lci1vbmx5OiBvblxuICogICB0aGUgaG9zdCB0aGUgQ2xhdWRlIGNoaWxkIHN0YXlzIG9uIHRoZSBvcGVyYXRvcidzIGB+Ly5jbGF1ZGVgLCB3aGljaCBpc1xuICogICBwcmVjaXNlbHkgdGhlIGRpcmVjdG9yeSBhIERlZXBTZWVrIGNoaWxkIG11c3Qgbm90IHNoYXJlLlxuICogLSBgQkFTSF9NQVhfVElNRU9VVF9NU2Ag4oaSIHtAbGluayBDTEFVREVfQkFTSF9USU1FT1VUX0VOVn0gKElzc3VlICM0OTI2KTogdGhlXG4gKiAgIGZvcmVncm91bmQgY29tbWFuZCBjZWlsaW5nLCBkZWZhdWx0ZWQgcmF0aGVyIHRoYW4gcGlubmVkLCBzbyBhbiBleHBsaWNpdFxuICogICBwYXJlbnQgdmFsdWUgd2lucy4gVGhlIGBkZWVwc2Vla2AgYmluYXJ5IGlzIHRoZSBzYW1lIENsYXVkZSBDb2RlIENMSSwgc28gaXRcbiAqICAgcmVhZHMgdGhlIHNhbWUgdmFyaWFibGUuXG4gKlxuICogSW50ZW5kZWQgZm9yIHVzZSB3aXRoIGBEZW5vLkNvbW1hbmRgJ3MgYGNsZWFyRW52OiB0cnVlYCBzbyB0aGUgY2hpbGQgcmVjZWl2ZXNcbiAqIGV4YWN0bHkgdGhpcyBtYXAuXG4gKlxuICogQHBhcmFtIHBhcmVudEVudiAtIFRoZSBlbnZpcm9ubWVudCB0byBpbmhlcml0IGZyb20gKGRlZmF1bHRzIHRvIHRoZSBjdXJyZW50XG4gKiAgIHByb2Nlc3MgZW52aXJvbm1lbnQpLlxuICogQHBhcmFtIGRlbnlsaXN0IC0gVmFyaWFibGUgbmFtZXMgdG8gc3RyaXAgKGRlZmF1bHRzIHRvXG4gKiAgIHtAbGluayBERUVQU0VFS19FTlZfREVOWUxJU1R9KS5cbiAqIEByZXR1cm5zIEEgbmV3IG9iamVjdCBzYWZlIHRvIHBhc3MgYXMgdGhlIGNoaWxkJ3MgYGVudmAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZERlZXBTZWVrQ2hpbGRFbnYoXG4gIHBhcmVudEVudjogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IERlbm8uZW52LnRvT2JqZWN0KCksXG4gIGRlbnlsaXN0OiByZWFkb25seSBzdHJpbmdbXSA9IERFRVBTRUVLX0VOVl9ERU5ZTElTVCxcbik6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xuICBjb25zdCBlbnYgPSBidWlsZEFnZW50Q2hpbGRFbnYocGFyZW50RW52LCB7XG4gICAgZGVueWxpc3QsXG4gICAgc2VjcmV0QWxsb3dsaXN0OiBERUVQU0VFS19FTlZfU0VDUkVUX0FMTE9XTElTVCxcbiAgfSk7XG5cbiAgLy8gRm9yZWdyb3VuZCBjb21tYW5kIGNlaWxpbmcgKElzc3VlICM0OTI2LCBhcyAjNDkxMyBmb3IgYGNsYXVkZWApOiB0aGUgc2FtZVxuICAvLyBDTEkgdmVyc2lvbiByZWFkcyBpdDsgYW4gZXhwbGljaXQgcGFyZW50IHZhbHVlIHdpbnMuXG4gIGZvciAoY29uc3QgW25hbWUsIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhDTEFVREVfQkFTSF9USU1FT1VUX0VOVikpIHtcbiAgICBpZiAoZW52W25hbWVdID09PSB1bmRlZmluZWQpIGVudltuYW1lXSA9IHZhbHVlO1xuICB9XG5cbiAgaWYgKCFlbnZbXCJBTlRIUk9QSUNfQkFTRV9VUkxcIl0pIHtcbiAgICBlbnZbXCJBTlRIUk9QSUNfQkFTRV9VUkxcIl0gPSBERUVQU0VFS19BTlRIUk9QSUNfQkFTRV9VUkw7XG4gIH1cblxuICAvLyBUaGUgZmlsdGVyIGFib3ZlIGRlbmllZCBhbnkgaW5oZXJpdGVkIEFOVEhST1BJQ19BVVRIX1RPS0VOLCBzbyB0aGlzIGlzIHRoZVxuICAvLyBvbmx5IHdheSB0aGUgdmFyaWFibGUgaXMgZXZlciBzZXQgZm9yIHRoaXMgY2hpbGQ6IGZyb20gRGVlcFNlZWsncyBvd24ga2V5LlxuICBpZiAoZW52W1wiREVFUFNFRUtfQVBJX0tFWVwiXSkge1xuICAgIGVudltcIkFOVEhST1BJQ19BVVRIX1RPS0VOXCJdID0gZW52W1wiREVFUFNFRUtfQVBJX0tFWVwiXTtcbiAgfVxuXG4gIGlmIChlbnZbXCJDTEFVREVfQ09ORklHX0RJUlwiXSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgLy8gVGhlIGR1cmFibGUgd29yayBkaXIgd2hlbiB0aGUgcnVuIGRyaXZlciBleHBvcnRlZCBvbmUgKElzc3VlICM0MzcwKSxcbiAgICAvLyBvdGhlcndpc2UgdGhlIGhvbWUgZGlyZWN0b3J5IOKAlCBhIGRvdC1kaXJlY3RvcnkgYmVzaWRlIGB+Ly5jbGF1ZGVgLCBuZXZlclxuICAgIC8vIGEgd29yayBkaXIgaW52ZW50ZWQgdW5kZXIgdGhlIGhvc3QncyBob21lIChJc3N1ZSAjMTM1KS5cbiAgICBjb25zdCBiYXNlID0gZW52W1wiV09SS19ESVJcIl0gPz8gZW52W1wiSE9NRVwiXTtcbiAgICBpZiAoYmFzZSkge1xuICAgICAgZW52W1wiQ0xBVURFX0NPTkZJR19ESVJcIl0gPSBgJHtiYXNlfS8ke0RFRVBTRUVLX0NPTkZJR19ESVJfTkFNRX1gO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBlbnY7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F5QkMsR0FFRCxTQUNFLGtCQUFrQixFQUNsQixtQkFBbUIsRUFDbkIsMkJBQTJCLFFBQ3RCLGlCQUFpQjtBQUN4QixTQUNFLHVCQUF1QixFQUN2QiwwQkFBMEIsUUFDckIsa0JBQWtCO0FBRXpCOzs7OztDQUtDLEdBQ0QsT0FBTyxNQUFNLDhCQUE4QixxQ0FBcUM7QUFFaEY7Ozs7OztDQU1DLEdBQ0QsTUFBTSwyQkFBMkI7QUFFakM7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0E0QkMsR0FDRCxPQUFPLE1BQU0sd0JBQTJDO0tBQ25EO0tBQ0E7RUFDSDtFQUNBO0VBQ0E7RUFDQTtFQUNBO0NBQ0QsQ0FBQztBQUVGOzs7Ozs7Ozs7O0NBVUMsR0FDRCxPQUFPLE1BQU0sZ0NBQW1EO0VBQzlEO0VBQ0E7RUFDQTtDQUNELENBQUM7QUFFRjs7Ozs7OztDQU9DLEdBQ0QsT0FBTyxTQUFTLHVCQUNkLElBQVksRUFDWixXQUE4QixxQkFBcUI7RUFFbkQsT0FBTyxvQkFBb0IsTUFBTTtJQUMvQjtJQUNBLGlCQUFpQjtFQUNuQjtBQUNGO0FBRUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBbUNDLEdBQ0QsT0FBTyxTQUFTLHNCQUNkLFlBQW9DLEtBQUssR0FBRyxDQUFDLFFBQVEsRUFBRSxFQUN2RCxXQUE4QixxQkFBcUI7RUFFbkQsTUFBTSxNQUFNLG1CQUFtQixXQUFXO0lBQ3hDO0lBQ0EsaUJBQWlCO0VBQ25CO0VBRUEsNEVBQTRFO0VBQzVFLHVEQUF1RDtFQUN2RCxLQUFLLE1BQU0sQ0FBQyxNQUFNLE1BQU0sSUFBSSxPQUFPLE9BQU8sQ0FBQyx5QkFBMEI7SUFDbkUsSUFBSSxHQUFHLENBQUMsS0FBSyxLQUFLLFdBQVcsR0FBRyxDQUFDLEtBQUssR0FBRztFQUMzQztFQUVBLElBQUksQ0FBQyxHQUFHLENBQUMscUJBQXFCLEVBQUU7SUFDOUIsR0FBRyxDQUFDLHFCQUFxQixHQUFHO0VBQzlCO0VBRUEsNkVBQTZFO0VBQzdFLDZFQUE2RTtFQUM3RSxJQUFJLEdBQUcsQ0FBQyxtQkFBbUIsRUFBRTtJQUMzQixHQUFHLENBQUMsdUJBQXVCLEdBQUcsR0FBRyxDQUFDLG1CQUFtQjtFQUN2RDtFQUVBLElBQUksR0FBRyxDQUFDLG9CQUFvQixLQUFLLFdBQVc7SUFDMUMsdUVBQXVFO0lBQ3ZFLDJFQUEyRTtJQUMzRSwwREFBMEQ7SUFDMUQsTUFBTSxPQUFPLEdBQUcsQ0FBQyxXQUFXLElBQUksR0FBRyxDQUFDLE9BQU87SUFDM0MsSUFBSSxNQUFNO01BQ1IsR0FBRyxDQUFDLG9CQUFvQixHQUFHLEdBQUcsS0FBSyxDQUFDLEVBQUUsMEJBQTBCO0lBQ2xFO0VBQ0Y7RUFFQSxPQUFPO0FBQ1QifQ==
// denoCacheMetadata=6515341409441437059,7740268369509439952