/**
 * The run's MCP server entries (Issue #5343): the shared reader, the Gemini
 * mapping of it, and the runner's handling of the config for a Gemini run.
 *
 * Every expected value is a literal written out by hand. The last two tests
 * drive the real runner with a stub Gemini CLI: one with an MCP config
 * directory that cannot be created, so the config write really fails and the
 * run goes on without servers, and one with a written config, whose servers
 * must reach both the settings file and `--allowed-mcp-server-names`.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildGeminiMcpServers } from "../lib/gemini_settings.ts";
import { readMcpServerEntries } from "../lib/mcp_server_entries.ts";
import { IMAGE_AGENT_PROVIDERS_ENV } from "../lib/agent_provider.ts";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import { createLogger } from "../lib/logger.ts";
import { envFrom } from "./support/env_lookup.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

/** Whether a path exists on disk. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("readMcpServerEntries - unparsable JSON, a non-object root and a non-object mcpServers yield no servers (Issue #5343)", () => {
  assertEquals(readMcpServerEntries("{not json"), []);
  assertEquals(readMcpServerEntries("[]"), []);
  assertEquals(readMcpServerEntries('"text"'), []);
  assertEquals(readMcpServerEntries('{"mcpServers": []}'), []);
  assertEquals(readMcpServerEntries('{"mcpServers": null}'), []);
  assertEquals(readMcpServerEntries("{}"), []);
});

Deno.test("readMcpServerEntries - unsafe names and unusable specs are skipped, and each field is kept only in its shape (Issue #5343)", () => {
  const config = JSON.stringify({
    mcpServers: {
      "bad name": { command: "bad" },
      nul: null,
      arr: [],
      ok: {
        command: "node",
        args: ["a", 1],
        env: [],
      },
      typed: {
        command: 7,
        args: ["x", "y"],
        env: { KEY: "value" },
      },
    },
  });
  assertEquals(readMcpServerEntries(config), [
    { name: "ok", command: "node" },
    { name: "typed", args: ["x", "y"], env: { KEY: "value" } },
  ]);
});

Deno.test("buildGeminiMcpServers - a server without a command is skipped and alwaysLoad is not copied (Issue #5343)", () => {
  const config = JSON.stringify({
    mcpServers: {
      graft: {
        command: "graft",
        args: ["serve", "--mcp"],
        env: { GRAFT_ROOT: "/w/repo" },
        alwaysLoad: true,
      },
      remote: { url: "https://example.test/mcp", alwaysLoad: true },
    },
  });
  assertEquals(buildGeminiMcpServers(config), {
    graft: {
      command: "graft",
      args: ["serve", "--mcp"],
      env: { GRAFT_ROOT: "/w/repo" },
    },
  });
});

Deno.test("buildGeminiMcpServers - env keeps only string values under a safe key (Issue #5343)", () => {
  const config = JSON.stringify({
    mcpServers: {
      playwright: {
        command: "node",
        env: { GOOD_1: "yes", "bad key": "no", NUMERIC: 3, FLAG: true },
      },
    },
  });
  assertEquals(buildGeminiMcpServers(config), {
    playwright: { command: "node", env: { GOOD_1: "yes" } },
  });
});

Deno.test("buildGeminiMcpServers - a server named __proto__ stays an own key (Issue #5343)", () => {
  const servers = buildGeminiMcpServers(
    '{"mcpServers":{"__proto__":{"command":"x"}}}',
  );
  assertEquals(Object.keys(servers), ["__proto__"]);
  assertEquals(Object.getPrototypeOf(servers), Object.prototype);
});

Deno.test({
  name:
    "runClaudeWithTimeout - a Gemini run whose MCP config cannot be written logs config not written and runs without servers (Issue #5343)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "mcp_entries_5343_" });
    try {
      // A regular file where the worker cache directory must be made, so the
      // MCP config cannot be written beneath it.
      const workDir = `${root}/not-a-directory`;
      await Deno.writeTextFile(workDir, "x");
      const cwd = `${root}/clone`;
      await Deno.mkdir(cwd);
      const lines: string[] = [];
      const logger = createLogger({ write: (m) => lines.push(m), host: "" });
      const fixture = await Deno.readTextFile(
        new URL(
          "./fixtures/agent_output/gemini-0.68.0-success.jsonl",
          import.meta.url,
        ),
      );
      const body = `printf '%s\\n' "$@" > "$(dirname "$0")/argv.txt"
: > "$(dirname "$0")/ran"
cat <<'AGENT_FIXTURE_EOF'
${fixture}AGENT_FIXTURE_EOF
exit 0
`;
      const outcome = await withAgentStub(
        body,
        async (stub) => {
          const result = await runClaudeWithTimeout({
            clock: fakeClock(),
            prompt: "test",
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            agentProvider: "gemini",
            agentBinaryPath: stub.path,
            env: envFrom({
              [IMAGE_AGENT_PROVIDERS_ENV]: "claude,gemini",
              TMPDIR: root,
            }),
            parentEnv: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
            cwd,
            workDir,
            mcpConfig: true,
            logger,
          });
          const argv = (await Deno.readTextFile(`${stub.dir}/argv.txt`))
            .split("\n");
          return {
            result,
            argv,
            ran: await exists(`${stub.dir}/ran`),
          };
        },
        { prefix: "mcp_entries_5343_stub_" },
      );

      assert(
        outcome.result.ok,
        outcome.result.ok ? "" : outcome.result.error.message,
      );
      assert(
        lines.some((l) =>
          l.includes("Playwright MCP config not written") &&
          l.includes("runs without the requested MCP servers")
        ),
        `expected a config-not-written line, got:\n${lines.join("\n")}`,
      );
      assertEquals(outcome.ran, true, "the agent still ran");
      const flag = outcome.argv.indexOf("--allowed-mcp-server-names");
      assert(flag >= 0, `no allowed-server flag in ${outcome.argv.join(" ")}`);
      assertEquals(outcome.argv[flag + 1], "");
      assertStringIncludes(outcome.argv.join("\n"), "--prompt");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - a Gemini run with a written MCP config carries its servers in the settings file and the allow-list (Issue #5343)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "mcp_entries_5343_" });
    try {
      const workDir = `${root}/work`;
      await Deno.mkdir(workDir);
      const cwd = `${root}/clone`;
      await Deno.mkdir(cwd);
      const lines: string[] = [];
      const logger = createLogger({ write: (m) => lines.push(m), host: "" });
      const fixture = await Deno.readTextFile(
        new URL(
          "./fixtures/agent_output/gemini-0.68.0-success.jsonl",
          import.meta.url,
        ),
      );
      const body =
        `cp "$GEMINI_CLI_SYSTEM_SETTINGS_PATH" "$(dirname "$0")/settings.json"
printf '%s\\n' "$@" > "$(dirname "$0")/argv.txt"
cat <<'AGENT_FIXTURE_EOF'
${fixture}AGENT_FIXTURE_EOF
exit 0
`;
      const outcome = await withAgentStub(
        body,
        async (stub) => {
          const result = await runClaudeWithTimeout({
            clock: fakeClock(),
            prompt: "test",
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            agentProvider: "gemini",
            agentBinaryPath: stub.path,
            env: envFrom({
              [IMAGE_AGENT_PROVIDERS_ENV]: "claude,gemini",
              TMPDIR: root,
            }),
            parentEnv: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
            cwd,
            workDir,
            mcpConfig: true,
            logger,
          });
          const argv = (await Deno.readTextFile(`${stub.dir}/argv.txt`))
            .split("\n");
          const settings = JSON.parse(
            await Deno.readTextFile(`${stub.dir}/settings.json`),
          );
          return { result, argv, settings };
        },
        { prefix: "mcp_entries_5343_stub_" },
      );

      assert(
        outcome.result.ok,
        outcome.result.ok ? "" : outcome.result.error.message,
      );
      assert(
        !lines.some((l) => l.includes("config not written")),
        `the config should have been written, got:\n${lines.join("\n")}`,
      );
      assertEquals(Object.keys(outcome.settings.mcpServers), ["playwright"]);
      const command = outcome.settings.mcpServers.playwright.command;
      assert(
        typeof command === "string" && command.length > 0,
        "playwright.command must be a non-empty string",
      );
      const flag = outcome.argv.indexOf("--allowed-mcp-server-names");
      assert(flag >= 0, `no allowed-server flag in ${outcome.argv.join(" ")}`);
      assertEquals(outcome.argv[flag + 1], "playwright");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
