/**
 * The Graft tools are in the agent's context from the first turn
 * (Issue #2435).
 *
 * The Claude CLI defers MCP tool definitions behind its tool-search step: the
 * agent sees a tool's name and must make an extra call to load its schema
 * before it can use it. A `grep` costs nothing extra, so the agent grepped —
 * 25 of 29 `Graft: ok` runs reported `0 queries`, and an archived session's
 * own notes read "Graft MCP tools are deferred". The CLI exempts a server
 * whose entry says `alwaysLoad: true`, per server, leaving every other tool
 * as it was.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { ensureAgentMcpConfig } from "../lib/agent_mcp_config.ts";
import { buildCodexMcpConfigArgs } from "../lib/codex_executor.ts";
import { codegraphMcpServer } from "../lib/codegraph_context.ts";
import { GRAFT_MCP_SERVER_NAME, graftMcpServer } from "../lib/graft_context.ts";

/** Write a per-run MCP config carrying `servers` and return it parsed. */
async function writtenConfig(
  servers: Record<string, ReturnType<typeof graftMcpServer>>,
): Promise<
  { json: string; mcpServers: Record<string, Record<string, unknown>> }
> {
  const dir = await Deno.makeTempDir({ prefix: "graft-always-load-2435-" });
  try {
    const path = await ensureAgentMcpConfig({
      cwd: "/w/checkout-2435",
      configDir: dir,
      playwright: false,
      servers,
    });
    assert(path, "the config must be written");
    const json = await Deno.readTextFile(path);
    return { json, mcpServers: JSON.parse(json).mcpServers };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("graft mcp - the config the Claude CLI reads exempts the graft server from deferral (Issue #2435)", async () => {
  const { mcpServers } = await writtenConfig({
    [GRAFT_MCP_SERVER_NAME]: graftMcpServer("/w/checkout-2435"),
  });
  assertEquals(mcpServers.graft?.alwaysLoad, true);
  // Still the same server: the exemption is added, nothing is replaced.
  assertEquals(mcpServers.graft?.command, "graft");
  assertEquals(mcpServers.graft?.args, ["mcp", "/w/checkout-2435"]);
});

Deno.test("codegraph mcp - the sibling server is exempted the same way (Issue #2435)", async () => {
  const { mcpServers } = await writtenConfig({
    codegraph: codegraphMcpServer("/w/checkout-2435"),
  });
  assertEquals(mcpServers.codegraph?.alwaysLoad, true);
});

Deno.test("graft mcp - Codex is handed the same command, args and env and nothing new (Issue #2435)", async () => {
  const { json } = await writtenConfig({
    [GRAFT_MCP_SERVER_NAME]: graftMcpServer("/w/checkout-2435"),
  });
  const args = buildCodexMcpConfigArgs(json);
  const keys = args.filter((a) => a !== "-c").map((a) => a.split("=")[0]);
  assertEquals(keys.sort(), [
    "mcp_servers.graft.args",
    "mcp_servers.graft.command",
    "mcp_servers.graft.env",
  ]);
});
