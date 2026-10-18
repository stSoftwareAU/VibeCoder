/** Credential-free Codex HTTP metadata shared by both sides of the broker. */
/** Pinned HTTP metadata; outer adapters must carry these without adding auth. */
export const CODEX_SUBSCRIPTION_METADATA_HEADERS = [
  "originator",
  "user-agent",
  "version",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-turn-state",
  "x-codex-turn-metadata",
  "x-codex-window-id",
  "x-codex-parent-thread-id",
  "x-codex-installation-id",
  "x-openai-subagent",
  "x-openai-memgen-request",
  "x-openai-internal-codex-responses-lite",
] as const;
