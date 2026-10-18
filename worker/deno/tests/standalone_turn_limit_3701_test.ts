import { assertEquals, assertStringIncludes } from "@std/assert";
import { withAgentStub } from "./support/agent_stub.ts";

async function assertStandaloneCap(cap: number | undefined): Promise<void> {
  // Changing HOME must not silently select an empty child cache when CI uses
  // Deno's default cache location rather than an explicit DENO_DIR.
  const cacheInfo = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(
    cacheInfo.code,
    0,
    new TextDecoder().decode(cacheInfo.stderr),
  );
  const cacheDir = JSON.parse(new TextDecoder().decode(cacheInfo.stdout))
    .denoDir as string;
  await withAgentStub(
    `printf '%s\\n' "$@" > "$(dirname "$0")/argv"\nprintf '%s\\n' '{"type":"result","subtype":"success","result":"summary"}'`,
    async (stub) => {
      const configPath = `${stub.dir}/config.json`;
      if (cap === 3) {
        await Deno.writeTextFile(
          stub.path,
          `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$(dirname "$0")/argv"\nprintf '%s\\n' '{"type":"result","subtype":"error_max_turns","is_error":true}'\nexit 1\n`,
        );
      }
      await Deno.writeTextFile(
        configPath,
        JSON.stringify({
          repos: ["org/repo"],
          claude_max_turns: cap,
          agent_provider: "claude",
        }),
      );
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--cached-only",
          "--frozen",
          "--lock",
          decodeURIComponent(
            new URL("../deno.lock", import.meta.url).pathname,
          ),
          "--config",
          decodeURIComponent(
            new URL("../deno.json", import.meta.url).pathname,
          ),
          decodeURIComponent(
            new URL("../mod.ts", import.meta.url).pathname,
          ),
          "claude-runner",
          "--operation",
          "summarise-large-content",
          "--content",
          "Fixture content",
        ],
        cwd: stub.dir,
        clearEnv: true,
        env: {
          PATH: `${stub.dir}:/usr/bin:/bin`,
          HOME: stub.dir,
          DENO_DIR: cacheDir,
          CONFIG_PATH: configPath,
          VIBE_CLAUDE_MAX_TURNS: "999",
          VIBE_AGENT_NICE: "0",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(
        result.code,
        cap === 3 ? 1 : 0,
        new TextDecoder().decode(result.stderr),
      );
      if (cap === 3) {
        assertStringIncludes(
          new TextDecoder().decode(result.stdout) +
            new TextDecoder().decode(result.stderr),
          "AGENT_TURN_LIMIT",
        );
      }
      const args = (await Deno.readTextFile(`${stub.dir}/argv`)).trim()
        .split("\n");
      assertEquals(
        args[args.indexOf("--max-turns") + 1],
        String(cap ?? 100),
      );
    },
    { name: "claude" },
  );
}

Deno.test({
  name:
    "standalone command uses the configured turn cap over stale inherited transport",
  ignore: Deno.build.os === "windows",
  fn: () => assertStandaloneCap(7),
});

Deno.test({
  name:
    "standalone command defaults its turn cap over stale inherited transport",
  ignore: Deno.build.os === "windows",
  fn: () => assertStandaloneCap(undefined),
});

Deno.test({
  name:
    "standalone command reports a terminal turn cap over stale inherited transport",
  ignore: Deno.build.os === "windows",
  fn: () => assertStandaloneCap(3),
});

Deno.test("read-only CLI keeps its narrow environment permissions without agent transport access", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-mermaid-env-" });
  try {
    await Deno.writeTextFile(`${root}/README.md`, "# Fixture\n");
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--cached-only",
        "--frozen",
        "--no-prompt",
        "--allow-read",
        "--allow-env=DEBUG,LOG_LEVEL,CONFIG_FILE,CONFIG_PATH,OUTPUT_JSON",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        "--lock",
        new URL("../deno.lock", import.meta.url).pathname,
        new URL("../mod.ts", import.meta.url).pathname,
        "check-mermaid",
        "--script-dir",
        root,
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    assertStringIncludes(new TextDecoder().decode(result.stdout), "PASSED");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
