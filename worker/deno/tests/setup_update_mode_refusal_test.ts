/**
 * `update-mode` refuses to guess which default a host gets (Issue #4119).
 *
 * `setup.sh` tells `update-mode` whether `.config.json` existed before the run
 * (`--config-existed=true|false`). A missing flag must be refused, not
 * defaulted, and a refusal must leave the config alone. These tests run the
 * real entry point as a subprocess, the way `setup.sh` does, and assert on the
 * exit status, the message and the config file.
 *
 * Australian English spelling throughout (behaviour, authorised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

/** worker/deno/, resolved from this test file. */
const DENO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const REFUSAL =
  "update-mode needs --config-existed=true or --config-existed=false";

/** Deno's module cache, so the child's run stays offline. */
async function resolveDenoDir(): Promise<string> {
  const configured = Deno.env.get("DENO_DIR");
  if (configured) return configured;
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const info = JSON.parse(new TextDecoder().decode(output.stdout));
  return info.denoDir as string;
}

const DENO_DIR = await resolveDenoDir();

interface UpdateModeRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `setup_cli.ts update-mode` against a throwaway script dir and config
 * path. A pre-existing config is written first when `existingConfig` is set.
 * stdin is null, so the command never waits for a terminal, and the env is
 * cleared down to what the command needs.
 */
async function runUpdateMode(
  extraArgs: string[],
  existingConfig: string | null,
): Promise<{ run: UpdateModeRun; configAfter: string | null }> {
  const root = await Deno.makeTempDir({ prefix: "update_mode_refusal_" });
  try {
    const configPath = `${root}/.config.json`;
    if (existingConfig !== null) {
      await Deno.writeTextFile(configPath, existingConfig);
    }
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        `${DENO_ROOT}/setup/setup_cli.ts`,
        "update-mode",
        "--script-dir",
        root,
        "--config-path",
        configPath,
        ...extraArgs,
      ],
      cwd: root,
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "",
        HOME: root,
        DENO_DIR,
        NO_COLOR: "true",
        CI: "true",
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    let configAfter: string | null = null;
    try {
      configAfter = await Deno.readTextFile(configPath);
    } catch {
      // Absent after the run.
    }
    return {
      run: {
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
      },
      configAfter,
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const EXISTING_CONFIG = JSON.stringify({ repos: ["owner/repo"] }, null, 2) +
  "\n";

Deno.test("update-mode refusal - no --config-existed flag exits non-zero and leaves .config.json untouched (Issue #4119)", async () => {
  const { run, configAfter } = await runUpdateMode([], EXISTING_CONFIG);
  assert(
    run.code !== 0,
    `update-mode without the flag must not succeed:\n${run.stdout}\n${run.stderr}`,
  );
  assertStringIncludes(run.stderr, REFUSAL);
  assertEquals(
    configAfter,
    EXISTING_CONFIG,
    "a refused update-mode must not change .config.json",
  );
});

Deno.test("update-mode refusal - --config-existed=true is accepted (no refusal text) (Issue #4119)", async () => {
  const { run } = await runUpdateMode(
    ["--config-existed=true"],
    EXISTING_CONFIG,
  );
  assertEquals(
    run.code,
    0,
    `update-mode --config-existed=true failed:\n${run.stdout}\n${run.stderr}`,
  );
  assertEquals(
    run.stderr.includes(REFUSAL),
    false,
    "the refusal must not print when the flag is given",
  );
});

Deno.test("update-mode refusal - --config-existed=false is accepted (no refusal text) (Issue #4119)", async () => {
  const { run } = await runUpdateMode(["--config-existed=false"], null);
  assertEquals(
    run.code,
    0,
    `update-mode --config-existed=false failed:\n${run.stdout}\n${run.stderr}`,
  );
  assertEquals(
    run.stderr.includes(REFUSAL),
    false,
    "the refusal must not print when the flag is given",
  );
});
