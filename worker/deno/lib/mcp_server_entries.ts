/**
 * The run's MCP servers, read from the Claude-style `--mcp-config` JSON
 * (Issue #5343).
 *
 * Codex takes these servers as `-c mcp_servers.*` overrides
 * (`codex_executor.ts`) and Gemini as the `mcpServers` map of its per-run
 * settings file (`gemini_settings.ts`). This module is the one reader, so both
 * providers skip the same unsafe names and malformed fields; Gemini additionally
 * skips a server with no `command`.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

/** One MCP server as the run's config names it. */
export interface McpServerEntry {
  /** The server's name, as the config keys it. */
  name: string;
  /** The command that starts the server, when it is a string. */
  command?: string;
  /** The command's arguments, when every one is a string. */
  args?: string[];
  /** The server's environment, when it is a non-null, non-array object. */
  env?: Record<string, unknown>;
}

/** Names both providers accept for a server or an env key: no dots, quotes or spaces. */
export const SAFE_MCP_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Reads the servers the run's MCP config names.
 *
 * Unparsable JSON, a non-object root or a non-object `mcpServers` yield no
 * servers. An unsafe name, or a spec that is null, not an object or an array,
 * is skipped. Each field is kept only when it has the shape the CLIs take.
 *
 * @param configJson - The contents of the `--mcp-config` file.
 * @returns The usable servers, in the config's own order.
 */
export function readMcpServerEntries(configJson: string): McpServerEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (
    servers === null || typeof servers !== "object" || Array.isArray(servers)
  ) {
    return [];
  }
  const entries: McpServerEntry[] = [];
  for (
    const [name, spec] of Object.entries(servers as Record<string, unknown>)
  ) {
    if (!SAFE_MCP_NAME.test(name)) continue;
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      continue;
    }
    const server = spec as Record<string, unknown>;
    const entry: McpServerEntry = { name };
    if (typeof server.command === "string") entry.command = server.command;
    if (
      Array.isArray(server.args) &&
      server.args.every((a) => typeof a === "string")
    ) {
      entry.args = server.args;
    }
    if (
      server.env !== null &&
      typeof server.env === "object" &&
      !Array.isArray(server.env)
    ) {
      entry.env = server.env as Record<string, unknown>;
    }
    entries.push(entry);
  }
  return entries;
}
