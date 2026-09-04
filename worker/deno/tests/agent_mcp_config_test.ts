/**
 * Tests for the per-run Playwright MCP configuration handed to the agent
 * (Issue #4355).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  defaultMcpConfigDir,
  ensureAgentMcpConfig,
  mcpConfigFileName,
} from "../lib/agent_mcp_config.ts";
import {
  CLAUDE_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import { PLAYWRIGHT_MCP_VERSION } from "../setup/screenshot.ts";
import { type AgentStub, withAgentStub } from "./support/agent_stub.ts";
import { envFrom } from "./support/env_lookup.ts";

Deno.test("agent mcp config - writes the Playwright server config to the worker cache (never the clone) with the clone's docs/evidence as output dir and the chromium channel (Issue #4355)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mcp-cfg-" });
  try {
    const clone = "/home/vibe/auto-issue-work/stSoftwareAU/private-repo-10";
    const path = await ensureAgentMcpConfig({ cwd: clone, configDir: dir });
    assert(path, "config path returned");
    assert(path.startsWith(`${dir}/`), path);
    assert(!path.startsWith(clone), "never written into the checkout");
    const parsed = JSON.parse(await Deno.readTextFile(path));
    const server = parsed.mcpServers.playwright;
    assertEquals(server.command, "deno");
    const args: string[] = server.args;
    assert(args.includes(`npm:@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`));
    assertEquals(args[args.indexOf("--browser") + 1], "chromium");
    // Output dir is scratch, not the clone (Issue #4355): navigate snapshots
    // must not land in the repository.
    assertEquals(
      args[args.indexOf("--output-dir") + 1]!.startsWith(clone),
      false,
    );
    assert(
      args[args.indexOf("--output-dir") + 1]!.endsWith(
        "/vibe-playwright-output",
      ),
    );
    assert(args.includes("--headless"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("agent mcp config - the file name is stable per clone and differs between clones (Issue #4355)", () => {
  const a = mcpConfigFileName("/w/repo-a");
  assertEquals(a, mcpConfigFileName("/w/repo-a"));
  assert(a !== mcpConfigFileName("/w/repo-b"));
  assert(/^playwright-mcp-[0-9a-f]{8}\.json$/.test(a), a);
});

Deno.test("agent mcp config - a generation or write failure is logged and yields undefined, never throws (Issue #4355)", async () => {
  const logs: string[] = [];
  const path = await ensureAgentMcpConfig({
    cwd: "/w/repo",
    configDir: "/nonexistent",
    generate: () => {
      throw new Error("profile dir inside checkout");
    },
    log: (m) => {
      logs.push(m);
    },
  });
  assertEquals(path, undefined);
  assert(
    logs.some((l) => l.includes("Playwright MCP config not written")),
    logs.join(),
  );
});

Deno.test("agent provider - Claude invocation carries --mcp-config when a config path is supplied, and no flag when it is not (Issue #4355)", () => {
  const provider = resolveAgentProvider(CLAUDE_PROVIDER_ID);
  const withMcp = provider.buildInvocation({
    prompt: "P",
    model: "m",
    effort: "high",
    mcpConfigPath: "/work/.vibe-cache/mcp/playwright-mcp-abc.json",
  });
  const i = withMcp.indexOf("--mcp-config");
  assert(i >= 0, "expected --mcp-config");
  assertEquals(withMcp[i + 1], "/work/.vibe-cache/mcp/playwright-mcp-abc.json");
  // Before the prompt, after the standard flags.
  assert(i < withMcp.indexOf("-p"));
  const without = provider.buildInvocation({
    prompt: "P",
    model: "m",
    effort: "high",
  });
  assertEquals(without.includes("--mcp-config"), false);
});

/**
 * Run `fn` with a stub agent that records its argv and answers like the CLI.
 *
 * Named by path (`agentBinaryPath`, Issue #959) rather than installed on the
 * process-wide `PATH`, which raced every other test in the run (Issue #960).
 */
function withStubClaude<T>(
  argvFile: string,
  fn: (stub: AgentStub) => Promise<T>,
): Promise<T> {
  return withAgentStub(
    `printf '%s\\n' "$@" > "${argvFile}"\nprintf '%s\\n' '{"type":"result","result":"done"}'\nexit 0\n`,
    fn,
    { prefix: "claude_stub_mcp_" },
  );
}

Deno.test({
  name:
    "claude runner - a run that declares the browser needed passes --mcp-config pointing at a written config; a cwd alone does not (Issues #4355, #192)",
  ignore: Deno.build.os === "windows",
  async fn() {
    const workDir = await Deno.makeTempDir({ prefix: "mcp-run-" });
    const argvFile = `${workDir}/argv.txt`;
    try {
      // Issue #192: the need signal, not the cwd, grants the browser. A run
      // that never asked for one is invoked with no MCP server at all.
      await withStubClaude(argvFile, async (stub) => {
        await runClaudeWithRetry(
          {
            prompt: "P",
            model: "m",
            cwd: workDir,
            workDir,
            agentBinaryPath: stub.path,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
          },
          { maxRetries: 0, maxWaitSeconds: 0, initialWaitInterval: 0 },
        );
      });
      const ungranted = (await Deno.readTextFile(argvFile)).split("\n");
      assertEquals(
        ungranted.includes("--mcp-config"),
        false,
        `a cwd alone must not wire the browser: ${ungranted.join(" ")}`,
      );

      // mcpConfig: true — the explicit need signal (Issue #192).
      await withStubClaude(argvFile, async (stub) => {
        await runClaudeWithRetry(
          {
            prompt: "P",
            model: "m",
            cwd: workDir,
            workDir,
            agentBinaryPath: stub.path,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            mcpConfig: true,
          },
          { maxRetries: 0, maxWaitSeconds: 0, initialWaitInterval: 0 },
        );
      });
      const argv = (await Deno.readTextFile(argvFile)).split("\n");
      const idx = argv.indexOf("--mcp-config");
      assert(idx >= 0, `expected --mcp-config in ${argv.join(" ")}`);
      const path = argv[idx + 1]!;
      assertStringIncludes(path, `${workDir}/.vibe-cache/mcp/`);
      assert((await Deno.stat(path)).isFile, "config file exists");
      const server =
        JSON.parse(await Deno.readTextFile(path)).mcpServers.playwright;
      assertEquals(
        server.args[server.args.indexOf("--output-dir") + 1]!.startsWith(
          workDir,
        ),
        false,
      );

      await withStubClaude(argvFile, async (stub) => {
        await runClaudeWithRetry(
          {
            prompt: "P",
            model: "m",
            cwd: workDir,
            workDir,
            agentBinaryPath: stub.path,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            mcpConfig: false,
          },
          { maxRetries: 0, maxWaitSeconds: 0, initialWaitInterval: 0 },
        );
      });
      const argv2 = (await Deno.readTextFile(argvFile)).split("\n");
      assertEquals(argv2.includes("--mcp-config"), false);

      // The need signal without a clone still wires nothing — the server is
      // configured per clone, so there is nothing to point it at.
      await withStubClaude(argvFile, async (stub) => {
        await runClaudeWithRetry(
          {
            prompt: "P",
            model: "m",
            workDir,
            agentBinaryPath: stub.path,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            mcpConfig: true,
          },
          { maxRetries: 0, maxWaitSeconds: 0, initialWaitInterval: 0 },
        );
      });
      const argv3 = (await Deno.readTextFile(argvFile)).split("\n");
      assertEquals(argv3.includes("--mcp-config"), false);
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
});

Deno.test("agent mcp config - with no WORK_DIR the config lands under the OS temp dir, never under HOME (Issue #4370)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "mcp-tmpdir-" });
  // The environment is handed over, not exported (Issue #960): `HOME` is
  // present and `WORK_DIR` absent, which is the shape that produced the
  // stray `~/auto-issue-work` this test was written for.
  const env = envFrom({ TMPDIR: tmp, HOME: "/home/vibe" });
  try {
    const path = await ensureAgentMcpConfig({ cwd: "/w/some-clone", env });
    assert(path, "config path");
    assert(path.startsWith(`${tmp}/vibe-playwright-mcp/`), path);
    assert(!path.startsWith("/home/vibe/auto-issue-work"), path);
    assertEquals(defaultMcpConfigDir({ env }), `${tmp}/vibe-playwright-mcp`);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("agent mcp config - a named work volume beats the environment (Issue #960)", () => {
  // The seam is only worth having if the named directory wins. `WORK_DIR` in
  // the lookup names a directory the assertion would notice.
  const env = envFrom({ WORK_DIR: "/from-the-environment", TMPDIR: "/t" });
  assertEquals(
    defaultMcpConfigDir({ workDir: "/named/volume", env }),
    "/named/volume/.vibe-cache/mcp",
  );
  assertEquals(
    defaultMcpConfigDir({ env }),
    "/from-the-environment/.vibe-cache/mcp",
  );
});
