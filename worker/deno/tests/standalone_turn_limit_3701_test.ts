import { assertEquals, assertStringIncludes } from "@std/assert";
import { withAgentStub } from "./support/agent_stub.ts";

Deno.test({
  name:
    "standalone command settles configured and default turn caps over stale inherited transport",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withAgentStub(
      `printf '%s\\n' "$@" > "$(dirname "$0")/argv"\nprintf '%s\\n' '{"type":"result","subtype":"success","result":"summary"}'`,
      async (stub) => {
        const configPath = `${stub.dir}/config.json`;
        for (const cap of [7, undefined, 3]) {
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
              DENO_DIR: Deno.env.get("DENO_DIR") ?? "",
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
        }
      },
      { name: "claude" },
    );
  },
});
