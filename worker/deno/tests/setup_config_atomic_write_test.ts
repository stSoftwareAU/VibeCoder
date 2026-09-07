/**
 * Tests for the atomic rewrite of `.config.json` in setup.sh (Issue #1298).
 *
 * `write_interactive_config` used to end with
 * `echo "$config" | jq '.' > "$CONFIG_FILE"`, which truncates the host's only
 * credential-bearing config file when the pipeline is set up — before `jq` has
 * produced a byte. A `jq` that fails, is OOM-killed, or is interrupted in that
 * window leaves `.config.json` empty, taking `allowed_authors`,
 * `service_accounts` and `imgbb_api_key` with it and nothing to restore from.
 *
 * Behavioural: each test sources the real setup.sh, points `CONFIG_FILE` at a
 * fixture, and calls the real `write_interactive_config`, asserting on the
 * file it left behind.
 *
 * Australian English spelling throughout (behaviour, authorised).
 */

import { assert, assertEquals } from "@std/assert";
import { removeTempTree, withTempDir } from "./support/temp_tree.ts";

const setupPath = new URL("../../../setup.sh", import.meta.url).pathname;

/** The config the host already has — the thing an interrupted rewrite loses. */
const ORIGINAL_CONFIG = JSON.stringify(
  {
    repos: ["stSoftwareAU/VibeCoder"],
    allowed_authors: ["operator"],
    service_accounts: ["Vibecoderbot"],
    ssh_key_path: "~/.ssh/id_vibe",
    imgbb_api_key: "existing-key",
  },
  null,
  2,
) + "\n";

/**
 * A `jq` stub that delegates to the real `jq` for the merge steps but fails
 * on the final `jq '.'` — the exact reachable trigger from the issue.
 */
function jqFailsOnFormat(realJq: string): string {
  return `#!/usr/bin/env bash
if [[ $# -eq 1 && "$1" == "." ]]; then
    echo 'jq: killed' >&2
    exit 1
fi
exec ${realJq} "$@"
`;
}

/** Resolve the real `jq` once, so the stub can delegate to it. */
async function realJqPath(): Promise<string> {
  const { code, stdout } = await new Deno.Command("bash", {
    args: ["-c", "command -v jq"],
    stdin: "null",
  }).output();
  assertEquals(code, 0, "jq is required to run these tests");
  return new TextDecoder().decode(stdout).trim();
}

/**
 * Source setup.sh and run `write_interactive_config` against `configFile`,
 * with `jqStub` (when given) shadowing `jq` on PATH.
 */
async function writeInteractiveConfig(
  configFile: string,
  env: Record<string, string>,
  jqStub?: string,
): Promise<{ code: number; output: string }> {
  const bin = await Deno.makeTempDir({ prefix: "vibe_jq_stub_" });
  try {
    if (jqStub) {
      await Deno.writeTextFile(`${bin}/jq`, jqStub);
      await Deno.chmod(`${bin}/jq`, 0o755);
    }
    const script = `
      set -euo pipefail
      source "${setupPath}"
      write_interactive_config
    `;
    const { code, stdout, stderr } = await new Deno.Command("bash", {
      args: ["-c", script],
      // clearEnv so an operator's own CONFIG_PATH cannot reach setup.sh and
      // trip its "both set and different" guard before the function runs.
      clearEnv: true,
      env: {
        PATH: `${bin}:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
        HOME: Deno.env.get("HOME") ?? "/tmp",
        CONFIG_FILE: configFile,
        ...env,
      },
      stdin: "null",
    }).output();
    return {
      code,
      output: new TextDecoder().decode(stdout) +
        new TextDecoder().decode(stderr),
    };
  } finally {
    await removeTempTree(bin);
  }
}

/** Every entry in `dir`, sorted — used to prove no temp file is left behind. */
async function entriesOf(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
}

Deno.test("write_interactive_config - keeps the existing config when the rewrite fails", async () => {
  await withTempDir(async (tmp) => {
    const configFile = `${tmp}/.config.json`;
    await Deno.writeTextFile(configFile, ORIGINAL_CONFIG);

    const { code, output } = await writeInteractiveConfig(
      configFile,
      { INTERACTIVE_IMGBB_API_KEY: "new-key" },
      jqFailsOnFormat(await realJqPath()),
    );

    // The host's config is exactly as it was — not truncated, not partial.
    assertEquals(await Deno.readTextFile(configFile), ORIGINAL_CONFIG);

    // Fails loud — the operator is told the rewrite did not happen.
    assert(code !== 0, `expected a non-zero exit, got ${code}: ${output}`);
    assert(
      output.includes(configFile),
      `the failure should name the config file: ${output}`,
    );

    // No temp file is left beside it.
    assertEquals(await entriesOf(tmp), [".config.json"]);
  });
});

Deno.test("write_interactive_config - merges the interactive answers on success", async () => {
  await withTempDir(async (tmp) => {
    const configFile = `${tmp}/.config.json`;
    await Deno.writeTextFile(configFile, ORIGINAL_CONFIG);

    const { code, output } = await writeInteractiveConfig(configFile, {
      INTERACTIVE_REPOS: "stSoftwareAU/VibeCoder, stSoftwareAU/other",
      INTERACTIVE_IMGBB_API_KEY: "new-key",
    });
    assertEquals(code, 0, output);

    const written = JSON.parse(await Deno.readTextFile(configFile));
    assertEquals(written.repos, [
      "stSoftwareAU/VibeCoder",
      "stSoftwareAU/other",
    ]);
    assertEquals(written.imgbb_api_key, "new-key");
    // Keys nobody answered survive the rewrite.
    assertEquals(written.allowed_authors, ["operator"]);
    assertEquals(written.service_accounts, ["Vibecoderbot"]);
    assertEquals(written.ssh_key_path, "~/.ssh/id_vibe");

    // The rename cleans up after itself.
    assertEquals(await entriesOf(tmp), [".config.json"]);

    // The replacement is owner-only — it carries an API key.
    if (Deno.build.os !== "windows") {
      const info = await Deno.stat(configFile);
      assertEquals((info.mode ?? 0) & 0o777, 0o600);
    }
  });
});

Deno.test("write_interactive_config - is a no-op when nothing was answered", async () => {
  await withTempDir(async (tmp) => {
    const configFile = `${tmp}/.config.json`;
    await Deno.writeTextFile(configFile, ORIGINAL_CONFIG);

    const { code, output } = await writeInteractiveConfig(configFile, {});
    assertEquals(code, 0, output);

    assertEquals(await Deno.readTextFile(configFile), ORIGINAL_CONFIG);
    assertEquals(await entriesOf(tmp), [".config.json"]);
  });
});
