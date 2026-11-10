/**
 * Which kind of Codex credential is in use — subscription or API key
 * (Issue #1697, parent #1694).
 *
 * The distinction is not cosmetic: a ChatGPT subscription login has rolling
 * usage windows the backend reports as percentages, while an API key has **no
 * such window at all** — its spend is bounded by the account's own rate limits
 * and billing. Inventing a weekly allowance for an API-key account, so the
 * pool has a number to rank on, would be a fabricated figure of exactly the
 * kind `provider_token_usage.ts` exists to prevent. So the budget adapter asks
 * this module first, and answers `api-key-account` rather than a percentage.
 *
 * Verified against the pinned CLI (`openai/codex` at `rust-v0.147.0`):
 * `AuthDotJson` (`codex-rs/login/src/auth/storage.rs`) is
 * `$CODEX_HOME/auth.json` with an optional `auth_mode`, an `OPENAI_API_KEY`
 * string and an optional `tokens` object; `AuthMode`
 * (`codex-rs/protocol/src/auth.rs`) serialises `rename_all = "lowercase"` with
 * explicit renames for the camelCase variants.
 *
 * The classifier returns only authentication metadata, never credential
 * values. The initialiser copies login state into a new persistent home
 * without returning or logging its contents.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */ import { resolveAgentStateDir } from "./agent_state_dir.ts";
import { CODEX_API_KEY_ENV_VARS, CODEX_HOME_ENV_VAR } from "./codex_auth.ts";
import { processEnvLookup } from "./env_lookup.ts";
/** `AuthMode` spellings that mean "metered API key, no subscription window". */ const API_KEY_AUTH_MODES = [
  "apikey",
  "bedrockapikey"
];
/** `AuthMode` spellings that mean "ChatGPT login, windows exist". */ const CHATGPT_AUTH_MODES = [
  "chatgpt",
  "chatgptauthtokens"
];
/** True for a plain object. */ function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Resolve which Codex credential kind is in play.
 *
 * Precedence, most authoritative first:
 *   1. `OPENAI_API_KEY` / `CODEX_API_KEY` in the environment — metered API
 *      authentication. `CODEX_HOME` is deliberately NOT in this check: it is
 *      only a pointer to the file-backed login inspected below (#1924).
 *   2. `auth.json`'s own `auth_mode` field, when it names a mode.
 *   3. `auth.json`'s shape: a `tokens` object is a ChatGPT login; a non-empty
 *      `OPENAI_API_KEY` is an API key.
 *
 * @param codexHome - The `CODEX_HOME` directory holding `auth.json`.
 * @param env - Environment lookup; defaults to the process environment.
 * @returns The mode and where it was established, never throwing.
 */ export function resolveCodexAuthMode(codexHome, env = processEnvLookup) {
  for (const name of CODEX_API_KEY_ENV_VARS){
    if ((env(name) ?? "").trim().length > 0) {
      return {
        mode: "api-key",
        source: "env",
        detail: `${name} is set`
      };
    }
  }
  const authPath = `${codexHome.replace(/\/+$/, "")}/auth.json`;
  let raw;
  try {
    raw = Deno.readTextFileSync(authPath);
  } catch (error) {
    // A missing file is the ordinary "not logged in yet" case, not a fault.
    if (error instanceof Deno.errors.NotFound) {
      return {
        mode: "unknown",
        source: "absent",
        detail: "no auth.json"
      };
    }
    return {
      mode: "unknown",
      source: "read-error",
      detail: `auth.json unreadable: ${error instanceof Error ? error.name : "unknown error"}`
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch  {
    return {
      mode: "unknown",
      source: "read-error",
      detail: "auth.json is not valid JSON"
    };
  }
  if (!isRecord(parsed)) {
    return {
      mode: "unknown",
      source: "read-error",
      detail: "auth.json is not an object"
    };
  }
  const declared = typeof parsed.auth_mode === "string" ? parsed.auth_mode.trim().toLowerCase() : "";
  if (API_KEY_AUTH_MODES.includes(declared)) {
    return {
      mode: "api-key",
      source: "auth-json-field"
    };
  }
  if (CHATGPT_AUTH_MODES.includes(declared)) {
    return {
      mode: "chatgpt",
      source: "auth-json-field"
    };
  }
  if (isRecord(parsed.tokens)) {
    return {
      mode: "chatgpt",
      source: "auth-json-shape"
    };
  }
  if (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim().length > 0) {
    return {
      mode: "api-key",
      source: "auth-json-shape"
    };
  }
  return {
    mode: "unknown",
    source: "auth-json-shape",
    detail: declared.length > 0 ? `auth_mode "${declared}" carries no subscription-window meaning` : "auth.json names neither tokens nor an API key"
  };
}
/**
 * Where this host keeps Codex's persistent login state (Issue #1923).
 *
 * `CODEX_HOME` wins when the operator set one. Otherwise the login lives on
 * the durable agent-state volume beside the work directory, which is what
 * lets a ChatGPT subscription survive the roughly hourly container refresh.
 *
 * Stated here — beside the auth-mode question it answers — so the routing
 * paths that need it do not each re-derive the path. The billing probe
 * (`resolveStoredBilling`) no longer uses this agent-state fallback (Issue
 * #3955): the child CLI is only given `CODEX_HOME` when the operator set one,
 * so with it unset the CLI reads `$HOME/.codex`, not this directory.
 *
 * @param workDir - The worker's work directory.
 * @param env - Environment lookup (defaults to the process environment).
 * @returns The Codex home, or `""` when no directory can be named.
 */ export function resolveCodexHome(workDir, env = processEnvLookup) {
  const explicit = env(CODEX_HOME_ENV_VAR)?.trim();
  if (explicit) return explicit;
  const root = resolveAgentStateDir(workDir);
  return root ? `${root}/codex` : "";
}
/** Seed a new durable Codex home once; never overwrite the CLI's refreshed login. */ export async function initialiseCodexHome(credentialDirectory, env) {
  const home = env(CODEX_HOME_ENV_VAR)?.trim();
  if (!home) return;
  const target = `${home}/auth.json`;
  try {
    await Deno.stat(target);
    return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const seed = `${credentialDirectory}/auth.json`;
  if (resolveCodexAuthMode(credentialDirectory, ()=>undefined).mode !== "chatgpt") {
    throw new Error(`Codex subscription login missing: initialise ${target} or provision a ChatGPT auth.json at ${seed}`);
  }
  const info = await Deno.stat(seed);
  if (info.mode !== null && (info.mode & 0o077) !== 0) {
    throw new Error(`Codex login seed ${seed} must be owner-only (0600)`);
  }
  await Deno.mkdir(home, {
    recursive: true,
    mode: 0o700
  });
  const auth = await Deno.readTextFile(seed);
  try {
    await Deno.writeTextFile(target, auth, {
      createNew: true,
      mode: 0o600
    });
  } catch (error) {
    // A concurrent initialiser won; never overwrite a login another CLI owns.
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb2RleF9hdXRoX21vZGUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBXaGljaCBraW5kIG9mIENvZGV4IGNyZWRlbnRpYWwgaXMgaW4gdXNlIOKAlCBzdWJzY3JpcHRpb24gb3IgQVBJIGtleVxuICogKElzc3VlICMxNjk3LCBwYXJlbnQgIzE2OTQpLlxuICpcbiAqIFRoZSBkaXN0aW5jdGlvbiBpcyBub3QgY29zbWV0aWM6IGEgQ2hhdEdQVCBzdWJzY3JpcHRpb24gbG9naW4gaGFzIHJvbGxpbmdcbiAqIHVzYWdlIHdpbmRvd3MgdGhlIGJhY2tlbmQgcmVwb3J0cyBhcyBwZXJjZW50YWdlcywgd2hpbGUgYW4gQVBJIGtleSBoYXMgKipub1xuICogc3VjaCB3aW5kb3cgYXQgYWxsKiog4oCUIGl0cyBzcGVuZCBpcyBib3VuZGVkIGJ5IHRoZSBhY2NvdW50J3Mgb3duIHJhdGUgbGltaXRzXG4gKiBhbmQgYmlsbGluZy4gSW52ZW50aW5nIGEgd2Vla2x5IGFsbG93YW5jZSBmb3IgYW4gQVBJLWtleSBhY2NvdW50LCBzbyB0aGVcbiAqIHBvb2wgaGFzIGEgbnVtYmVyIHRvIHJhbmsgb24sIHdvdWxkIGJlIGEgZmFicmljYXRlZCBmaWd1cmUgb2YgZXhhY3RseSB0aGVcbiAqIGtpbmQgYHByb3ZpZGVyX3Rva2VuX3VzYWdlLnRzYCBleGlzdHMgdG8gcHJldmVudC4gU28gdGhlIGJ1ZGdldCBhZGFwdGVyIGFza3NcbiAqIHRoaXMgbW9kdWxlIGZpcnN0LCBhbmQgYW5zd2VycyBgYXBpLWtleS1hY2NvdW50YCByYXRoZXIgdGhhbiBhIHBlcmNlbnRhZ2UuXG4gKlxuICogVmVyaWZpZWQgYWdhaW5zdCB0aGUgcGlubmVkIENMSSAoYG9wZW5haS9jb2RleGAgYXQgYHJ1c3QtdjAuMTQ3LjBgKTpcbiAqIGBBdXRoRG90SnNvbmAgKGBjb2RleC1ycy9sb2dpbi9zcmMvYXV0aC9zdG9yYWdlLnJzYCkgaXNcbiAqIGAkQ09ERVhfSE9NRS9hdXRoLmpzb25gIHdpdGggYW4gb3B0aW9uYWwgYGF1dGhfbW9kZWAsIGFuIGBPUEVOQUlfQVBJX0tFWWBcbiAqIHN0cmluZyBhbmQgYW4gb3B0aW9uYWwgYHRva2Vuc2Agb2JqZWN0OyBgQXV0aE1vZGVgXG4gKiAoYGNvZGV4LXJzL3Byb3RvY29sL3NyYy9hdXRoLnJzYCkgc2VyaWFsaXNlcyBgcmVuYW1lX2FsbCA9IFwibG93ZXJjYXNlXCJgIHdpdGhcbiAqIGV4cGxpY2l0IHJlbmFtZXMgZm9yIHRoZSBjYW1lbENhc2UgdmFyaWFudHMuXG4gKlxuICogVGhlIGNsYXNzaWZpZXIgcmV0dXJucyBvbmx5IGF1dGhlbnRpY2F0aW9uIG1ldGFkYXRhLCBuZXZlciBjcmVkZW50aWFsXG4gKiB2YWx1ZXMuIFRoZSBpbml0aWFsaXNlciBjb3BpZXMgbG9naW4gc3RhdGUgaW50byBhIG5ldyBwZXJzaXN0ZW50IGhvbWVcbiAqIHdpdGhvdXQgcmV0dXJuaW5nIG9yIGxvZ2dpbmcgaXRzIGNvbnRlbnRzLlxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyB0aHJvdWdob3V0IChiZWhhdmlvdXIsIG9yZ2FuaXNhdGlvbikuXG4gKi9cblxuaW1wb3J0IHsgcmVzb2x2ZUFnZW50U3RhdGVEaXIgfSBmcm9tIFwiLi9hZ2VudF9zdGF0ZV9kaXIudHNcIjtcbmltcG9ydCB7IENPREVYX0FQSV9LRVlfRU5WX1ZBUlMsIENPREVYX0hPTUVfRU5WX1ZBUiB9IGZyb20gXCIuL2NvZGV4X2F1dGgudHNcIjtcbmltcG9ydCB7IHR5cGUgRW52TG9va3VwLCBwcm9jZXNzRW52TG9va3VwIH0gZnJvbSBcIi4vZW52X2xvb2t1cC50c1wiO1xuXG4vKiogSG93IENvZGV4IGlzIGF1dGhlbnRpY2F0ZWQsIGFzIGZhciBhcyB0aGUgYnVkZ2V0IHF1ZXN0aW9uIGlzIGNvbmNlcm5lZC4gKi9cbmV4cG9ydCB0eXBlIENvZGV4QXV0aE1vZGUgPVxuICAvKiogQW4gQVBJIGtleTogbWV0ZXJlZCBzcGVuZCwgbm8gc3Vic2NyaXB0aW9uIHdpbmRvdy4gKi9cbiAgfCBcImFwaS1rZXlcIlxuICAvKiogQSBDaGF0R1BUIGxvZ2luOiByb2xsaW5nIHBlcmNlbnRhZ2Ugd2luZG93cyBleGlzdC4gKi9cbiAgfCBcImNoYXRncHRcIlxuICAvKiogTmVpdGhlciBjb3VsZCBiZSBlc3RhYmxpc2hlZC4gKi9cbiAgfCBcInVua25vd25cIjtcblxuLyoqIFdoZXJlIHRoZSBhbnN3ZXIgY2FtZSBmcm9tIOKAlCByZWNvcmRlZCBzbyBhbiBvcGVyYXRvciBjYW4gY2hlY2sgaXQuICovXG5leHBvcnQgdHlwZSBDb2RleEF1dGhNb2RlU291cmNlID1cbiAgfCBcImVudlwiXG4gIHwgXCJhdXRoLWpzb24tZmllbGRcIlxuICB8IFwiYXV0aC1qc29uLXNoYXBlXCJcbiAgfCBcImFic2VudFwiXG4gIHwgXCJyZWFkLWVycm9yXCI7XG5cbi8qKiBUaGUgcmVzb2x2ZWQgY3JlZGVudGlhbCBraW5kIGFuZCBpdHMgcHJvdmVuYW5jZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ29kZXhBdXRoTW9kZVJlc3VsdCB7XG4gIHJlYWRvbmx5IG1vZGU6IENvZGV4QXV0aE1vZGU7XG4gIHJlYWRvbmx5IHNvdXJjZTogQ29kZXhBdXRoTW9kZVNvdXJjZTtcbiAgLyoqIE9wZXJhdG9yLWZhY2luZyBjb250ZXh0OyBuZXZlciBhIGNyZWRlbnRpYWwgdmFsdWUuICovXG4gIHJlYWRvbmx5IGRldGFpbD86IHN0cmluZztcbn1cblxuLyoqIGBBdXRoTW9kZWAgc3BlbGxpbmdzIHRoYXQgbWVhbiBcIm1ldGVyZWQgQVBJIGtleSwgbm8gc3Vic2NyaXB0aW9uIHdpbmRvd1wiLiAqL1xuY29uc3QgQVBJX0tFWV9BVVRIX01PREVTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcImFwaWtleVwiLCBcImJlZHJvY2thcGlrZXlcIl07XG5cbi8qKiBgQXV0aE1vZGVgIHNwZWxsaW5ncyB0aGF0IG1lYW4gXCJDaGF0R1BUIGxvZ2luLCB3aW5kb3dzIGV4aXN0XCIuICovXG5jb25zdCBDSEFUR1BUX0FVVEhfTU9ERVM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW1wiY2hhdGdwdFwiLCBcImNoYXRncHRhdXRodG9rZW5zXCJdO1xuXG4vKiogVHJ1ZSBmb3IgYSBwbGFpbiBvYmplY3QuICovXG5mdW5jdGlvbiBpc1JlY29yZCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIiAmJiB2YWx1ZSAhPT0gbnVsbCAmJiAhQXJyYXkuaXNBcnJheSh2YWx1ZSk7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB3aGljaCBDb2RleCBjcmVkZW50aWFsIGtpbmQgaXMgaW4gcGxheS5cbiAqXG4gKiBQcmVjZWRlbmNlLCBtb3N0IGF1dGhvcml0YXRpdmUgZmlyc3Q6XG4gKiAgIDEuIGBPUEVOQUlfQVBJX0tFWWAgLyBgQ09ERVhfQVBJX0tFWWAgaW4gdGhlIGVudmlyb25tZW50IOKAlCBtZXRlcmVkIEFQSVxuICogICAgICBhdXRoZW50aWNhdGlvbi4gYENPREVYX0hPTUVgIGlzIGRlbGliZXJhdGVseSBOT1QgaW4gdGhpcyBjaGVjazogaXQgaXNcbiAqICAgICAgb25seSBhIHBvaW50ZXIgdG8gdGhlIGZpbGUtYmFja2VkIGxvZ2luIGluc3BlY3RlZCBiZWxvdyAoIzE5MjQpLlxuICogICAyLiBgYXV0aC5qc29uYCdzIG93biBgYXV0aF9tb2RlYCBmaWVsZCwgd2hlbiBpdCBuYW1lcyBhIG1vZGUuXG4gKiAgIDMuIGBhdXRoLmpzb25gJ3Mgc2hhcGU6IGEgYHRva2Vuc2Agb2JqZWN0IGlzIGEgQ2hhdEdQVCBsb2dpbjsgYSBub24tZW1wdHlcbiAqICAgICAgYE9QRU5BSV9BUElfS0VZYCBpcyBhbiBBUEkga2V5LlxuICpcbiAqIEBwYXJhbSBjb2RleEhvbWUgLSBUaGUgYENPREVYX0hPTUVgIGRpcmVjdG9yeSBob2xkaW5nIGBhdXRoLmpzb25gLlxuICogQHBhcmFtIGVudiAtIEVudmlyb25tZW50IGxvb2t1cDsgZGVmYXVsdHMgdG8gdGhlIHByb2Nlc3MgZW52aXJvbm1lbnQuXG4gKiBAcmV0dXJucyBUaGUgbW9kZSBhbmQgd2hlcmUgaXQgd2FzIGVzdGFibGlzaGVkLCBuZXZlciB0aHJvd2luZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVDb2RleEF1dGhNb2RlKFxuICBjb2RleEhvbWU6IHN0cmluZyxcbiAgZW52OiBFbnZMb29rdXAgPSBwcm9jZXNzRW52TG9va3VwLFxuKTogQ29kZXhBdXRoTW9kZVJlc3VsdCB7XG4gIGZvciAoY29uc3QgbmFtZSBvZiBDT0RFWF9BUElfS0VZX0VOVl9WQVJTKSB7XG4gICAgaWYgKChlbnYobmFtZSkgPz8gXCJcIikudHJpbSgpLmxlbmd0aCA+IDApIHtcbiAgICAgIHJldHVybiB7IG1vZGU6IFwiYXBpLWtleVwiLCBzb3VyY2U6IFwiZW52XCIsIGRldGFpbDogYCR7bmFtZX0gaXMgc2V0YCB9O1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGF1dGhQYXRoID0gYCR7Y29kZXhIb21lLnJlcGxhY2UoL1xcLyskLywgXCJcIil9L2F1dGguanNvbmA7XG4gIGxldCByYXc6IHN0cmluZztcbiAgdHJ5IHtcbiAgICByYXcgPSBEZW5vLnJlYWRUZXh0RmlsZVN5bmMoYXV0aFBhdGgpO1xuICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgIC8vIEEgbWlzc2luZyBmaWxlIGlzIHRoZSBvcmRpbmFyeSBcIm5vdCBsb2dnZWQgaW4geWV0XCIgY2FzZSwgbm90IGEgZmF1bHQuXG4gICAgaWYgKGVycm9yIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuTm90Rm91bmQpIHtcbiAgICAgIHJldHVybiB7IG1vZGU6IFwidW5rbm93blwiLCBzb3VyY2U6IFwiYWJzZW50XCIsIGRldGFpbDogXCJubyBhdXRoLmpzb25cIiB9O1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgbW9kZTogXCJ1bmtub3duXCIsXG4gICAgICBzb3VyY2U6IFwicmVhZC1lcnJvclwiLFxuICAgICAgZGV0YWlsOiBgYXV0aC5qc29uIHVucmVhZGFibGU6ICR7XG4gICAgICAgIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5uYW1lIDogXCJ1bmtub3duIGVycm9yXCJcbiAgICAgIH1gLFxuICAgIH07XG4gIH1cblxuICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG1vZGU6IFwidW5rbm93blwiLFxuICAgICAgc291cmNlOiBcInJlYWQtZXJyb3JcIixcbiAgICAgIGRldGFpbDogXCJhdXRoLmpzb24gaXMgbm90IHZhbGlkIEpTT05cIixcbiAgICB9O1xuICB9XG4gIGlmICghaXNSZWNvcmQocGFyc2VkKSkge1xuICAgIHJldHVybiB7XG4gICAgICBtb2RlOiBcInVua25vd25cIixcbiAgICAgIHNvdXJjZTogXCJyZWFkLWVycm9yXCIsXG4gICAgICBkZXRhaWw6IFwiYXV0aC5qc29uIGlzIG5vdCBhbiBvYmplY3RcIixcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgZGVjbGFyZWQgPSB0eXBlb2YgcGFyc2VkLmF1dGhfbW9kZSA9PT0gXCJzdHJpbmdcIlxuICAgID8gcGFyc2VkLmF1dGhfbW9kZS50cmltKCkudG9Mb3dlckNhc2UoKVxuICAgIDogXCJcIjtcbiAgaWYgKEFQSV9LRVlfQVVUSF9NT0RFUy5pbmNsdWRlcyhkZWNsYXJlZCkpIHtcbiAgICByZXR1cm4geyBtb2RlOiBcImFwaS1rZXlcIiwgc291cmNlOiBcImF1dGgtanNvbi1maWVsZFwiIH07XG4gIH1cbiAgaWYgKENIQVRHUFRfQVVUSF9NT0RFUy5pbmNsdWRlcyhkZWNsYXJlZCkpIHtcbiAgICByZXR1cm4geyBtb2RlOiBcImNoYXRncHRcIiwgc291cmNlOiBcImF1dGgtanNvbi1maWVsZFwiIH07XG4gIH1cblxuICBpZiAoaXNSZWNvcmQocGFyc2VkLnRva2VucykpIHtcbiAgICByZXR1cm4geyBtb2RlOiBcImNoYXRncHRcIiwgc291cmNlOiBcImF1dGgtanNvbi1zaGFwZVwiIH07XG4gIH1cbiAgaWYgKFxuICAgIHR5cGVvZiBwYXJzZWQuT1BFTkFJX0FQSV9LRVkgPT09IFwic3RyaW5nXCIgJiZcbiAgICBwYXJzZWQuT1BFTkFJX0FQSV9LRVkudHJpbSgpLmxlbmd0aCA+IDBcbiAgKSB7XG4gICAgcmV0dXJuIHsgbW9kZTogXCJhcGkta2V5XCIsIHNvdXJjZTogXCJhdXRoLWpzb24tc2hhcGVcIiB9O1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBtb2RlOiBcInVua25vd25cIixcbiAgICBzb3VyY2U6IFwiYXV0aC1qc29uLXNoYXBlXCIsXG4gICAgZGV0YWlsOiBkZWNsYXJlZC5sZW5ndGggPiAwXG4gICAgICA/IGBhdXRoX21vZGUgXCIke2RlY2xhcmVkfVwiIGNhcnJpZXMgbm8gc3Vic2NyaXB0aW9uLXdpbmRvdyBtZWFuaW5nYFxuICAgICAgOiBcImF1dGguanNvbiBuYW1lcyBuZWl0aGVyIHRva2VucyBub3IgYW4gQVBJIGtleVwiLFxuICB9O1xufVxuXG4vKipcbiAqIFdoZXJlIHRoaXMgaG9zdCBrZWVwcyBDb2RleCdzIHBlcnNpc3RlbnQgbG9naW4gc3RhdGUgKElzc3VlICMxOTIzKS5cbiAqXG4gKiBgQ09ERVhfSE9NRWAgd2lucyB3aGVuIHRoZSBvcGVyYXRvciBzZXQgb25lLiBPdGhlcndpc2UgdGhlIGxvZ2luIGxpdmVzIG9uXG4gKiB0aGUgZHVyYWJsZSBhZ2VudC1zdGF0ZSB2b2x1bWUgYmVzaWRlIHRoZSB3b3JrIGRpcmVjdG9yeSwgd2hpY2ggaXMgd2hhdFxuICogbGV0cyBhIENoYXRHUFQgc3Vic2NyaXB0aW9uIHN1cnZpdmUgdGhlIHJvdWdobHkgaG91cmx5IGNvbnRhaW5lciByZWZyZXNoLlxuICpcbiAqIFN0YXRlZCBoZXJlIOKAlCBiZXNpZGUgdGhlIGF1dGgtbW9kZSBxdWVzdGlvbiBpdCBhbnN3ZXJzIOKAlCBzbyB0aGUgcm91dGluZ1xuICogcGF0aHMgdGhhdCBuZWVkIGl0IGRvIG5vdCBlYWNoIHJlLWRlcml2ZSB0aGUgcGF0aC4gVGhlIGJpbGxpbmcgcHJvYmVcbiAqIChgcmVzb2x2ZVN0b3JlZEJpbGxpbmdgKSBubyBsb25nZXIgdXNlcyB0aGlzIGFnZW50LXN0YXRlIGZhbGxiYWNrIChJc3N1ZVxuICogIzM5NTUpOiB0aGUgY2hpbGQgQ0xJIGlzIG9ubHkgZ2l2ZW4gYENPREVYX0hPTUVgIHdoZW4gdGhlIG9wZXJhdG9yIHNldCBvbmUsXG4gKiBzbyB3aXRoIGl0IHVuc2V0IHRoZSBDTEkgcmVhZHMgYCRIT01FLy5jb2RleGAsIG5vdCB0aGlzIGRpcmVjdG9yeS5cbiAqXG4gKiBAcGFyYW0gd29ya0RpciAtIFRoZSB3b3JrZXIncyB3b3JrIGRpcmVjdG9yeS5cbiAqIEBwYXJhbSBlbnYgLSBFbnZpcm9ubWVudCBsb29rdXAgKGRlZmF1bHRzIHRvIHRoZSBwcm9jZXNzIGVudmlyb25tZW50KS5cbiAqIEByZXR1cm5zIFRoZSBDb2RleCBob21lLCBvciBgXCJcImAgd2hlbiBubyBkaXJlY3RvcnkgY2FuIGJlIG5hbWVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUNvZGV4SG9tZShcbiAgd29ya0Rpcjogc3RyaW5nLFxuICBlbnY6IEVudkxvb2t1cCA9IHByb2Nlc3NFbnZMb29rdXAsXG4pOiBzdHJpbmcge1xuICBjb25zdCBleHBsaWNpdCA9IGVudihDT0RFWF9IT01FX0VOVl9WQVIpPy50cmltKCk7XG4gIGlmIChleHBsaWNpdCkgcmV0dXJuIGV4cGxpY2l0O1xuICBjb25zdCByb290ID0gcmVzb2x2ZUFnZW50U3RhdGVEaXIod29ya0Rpcik7XG4gIHJldHVybiByb290ID8gYCR7cm9vdH0vY29kZXhgIDogXCJcIjtcbn1cblxuLyoqIFNlZWQgYSBuZXcgZHVyYWJsZSBDb2RleCBob21lIG9uY2U7IG5ldmVyIG92ZXJ3cml0ZSB0aGUgQ0xJJ3MgcmVmcmVzaGVkIGxvZ2luLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGluaXRpYWxpc2VDb2RleEhvbWUoXG4gIGNyZWRlbnRpYWxEaXJlY3Rvcnk6IHN0cmluZyxcbiAgZW52OiBFbnZMb29rdXAsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgaG9tZSA9IGVudihDT0RFWF9IT01FX0VOVl9WQVIpPy50cmltKCk7XG4gIGlmICghaG9tZSkgcmV0dXJuO1xuICBjb25zdCB0YXJnZXQgPSBgJHtob21lfS9hdXRoLmpzb25gO1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8uc3RhdCh0YXJnZXQpO1xuICAgIHJldHVybjtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoIShlcnJvciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLk5vdEZvdW5kKSkgdGhyb3cgZXJyb3I7XG4gIH1cbiAgY29uc3Qgc2VlZCA9IGAke2NyZWRlbnRpYWxEaXJlY3Rvcnl9L2F1dGguanNvbmA7XG4gIGlmIChcbiAgICByZXNvbHZlQ29kZXhBdXRoTW9kZShjcmVkZW50aWFsRGlyZWN0b3J5LCAoKSA9PiB1bmRlZmluZWQpLm1vZGUgIT09XG4gICAgICBcImNoYXRncHRcIlxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQ29kZXggc3Vic2NyaXB0aW9uIGxvZ2luIG1pc3Npbmc6IGluaXRpYWxpc2UgJHt0YXJnZXR9IG9yIHByb3Zpc2lvbiBhIENoYXRHUFQgYXV0aC5qc29uIGF0ICR7c2VlZH1gLFxuICAgICk7XG4gIH1cbiAgY29uc3QgaW5mbyA9IGF3YWl0IERlbm8uc3RhdChzZWVkKTtcbiAgaWYgKGluZm8ubW9kZSAhPT0gbnVsbCAmJiAoaW5mby5tb2RlICYgMG8wNzcpICE9PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBDb2RleCBsb2dpbiBzZWVkICR7c2VlZH0gbXVzdCBiZSBvd25lci1vbmx5ICgwNjAwKWApO1xuICB9XG4gIGF3YWl0IERlbm8ubWtkaXIoaG9tZSwgeyByZWN1cnNpdmU6IHRydWUsIG1vZGU6IDBvNzAwIH0pO1xuICBjb25zdCBhdXRoID0gYXdhaXQgRGVuby5yZWFkVGV4dEZpbGUoc2VlZCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKHRhcmdldCwgYXV0aCwgeyBjcmVhdGVOZXc6IHRydWUsIG1vZGU6IDBvNjAwIH0pO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIC8vIEEgY29uY3VycmVudCBpbml0aWFsaXNlciB3b247IG5ldmVyIG92ZXJ3cml0ZSBhIGxvZ2luIGFub3RoZXIgQ0xJIG93bnMuXG4gICAgaWYgKCEoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5BbHJlYWR5RXhpc3RzKSkgdGhyb3cgZXJyb3I7XG4gIH1cbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBd0JDLEdBRUQsU0FBUyxvQkFBb0IsUUFBUSx1QkFBdUI7QUFDNUQsU0FBUyxzQkFBc0IsRUFBRSxrQkFBa0IsUUFBUSxrQkFBa0I7QUFDN0UsU0FBeUIsZ0JBQWdCLFFBQVEsa0JBQWtCO0FBMkJuRSw4RUFBOEUsR0FDOUUsTUFBTSxxQkFBd0M7RUFBQztFQUFVO0NBQWdCO0FBRXpFLG1FQUFtRSxHQUNuRSxNQUFNLHFCQUF3QztFQUFDO0VBQVc7Q0FBb0I7QUFFOUUsNkJBQTZCLEdBQzdCLFNBQVMsU0FBUyxLQUFjO0VBQzlCLE9BQU8sT0FBTyxVQUFVLFlBQVksVUFBVSxRQUFRLENBQUMsTUFBTSxPQUFPLENBQUM7QUFDdkU7QUFFQTs7Ozs7Ozs7Ozs7Ozs7Q0FjQyxHQUNELE9BQU8sU0FBUyxxQkFDZCxTQUFpQixFQUNqQixNQUFpQixnQkFBZ0I7RUFFakMsS0FBSyxNQUFNLFFBQVEsdUJBQXdCO0lBQ3pDLElBQUksQ0FBQyxJQUFJLFNBQVMsRUFBRSxFQUFFLElBQUksR0FBRyxNQUFNLEdBQUcsR0FBRztNQUN2QyxPQUFPO1FBQUUsTUFBTTtRQUFXLFFBQVE7UUFBTyxRQUFRLEdB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
// denoCacheMetadata=7840045951052186177,16737222489841123499