/** Run git-operations with a private work directory and the audit journal disabled. */
import { assertEquals } from "@std/assert";
import type { CommandResult } from "../../types.ts";
import { denoCacheEnv } from "./deno_cache_env.ts";
import { NO_HOST_GIT_CONFIG } from "./no_host_git_config.ts";

/** The request still goes through the production command's env allowlist. */
export async function runGitOperationsCommand(
  request: Record<string, unknown>,
  workDir: string,
): Promise<CommandResult> {
  const output = await new Deno.Command(Deno.execPath(), {
    cwd: new URL("../../", import.meta.url),
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      ...denoCacheEnv(),
      ...NO_HOST_GIT_CONFIG,
      HOME: workDir,
      TMPDIR: workDir,
      WORK_DIR: workDir,
    },
    args: [
      "eval",
      "--cached-only",
      `
        import { gitOperationsCommand } from "./commands/git_operations.ts";
        import { buildDefaultWorkerConfig } from "./lib/config_defaults.ts";
        const result = await gitOperationsCommand.execute(JSON.parse(Deno.args[0]), buildDefaultWorkerConfig());
        console.log(JSON.stringify(result));
      `,
      JSON.stringify(request),
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  assertEquals(
    output.code,
    0,
    `git-operations child failed:\n${stdout}\n${stderr}`,
  );
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}
