/**
 * `provider.env` is data, never code (Issue #1301).
 *
 * `setup.sh` used to read a provisioned credential back with `source`, which
 * is a full bash parse: a credential holding a space was truncated at the
 * first word and the remainder was **run**, and `$(...)` was substituted at
 * read time. These tests source the real `setup.sh`, provision a credential
 * whose value carries a space, a `;`, a `$(...)` and a `#`, and assert the
 * validation path hands the agent CLI the value byte for byte while the
 * injected commands never run.
 *
 * Behavioural: each test calls the real `provision_provider_credential` /
 * `claude_credential_is_valid` functions and asserts on the file written, the
 * exit status, and the environment a stubbed `claude` actually received.
 *
 * Australian English spelling throughout (behaviour, recognised).
 */

import { assert, assertEquals } from "@std/assert";
import { removeTempTree, withTempDir } from "./support/temp_tree.ts";

const setupPath = new URL("../../../setup.sh", import.meta.url).pathname;

/** Result of running a snippet against the real setup.sh. */
interface Run {
  code: number;
  output: string;
}

/**
 * Run a bash snippet with the real `setup.sh` sourced and a stub `claude` on
 * PATH that records the credential it was handed.
 *
 * @param tmp - Temporary HOME for the run.
 * @param snippet - Bash executed after `setup.sh` is sourced.
 * @param env - Extra environment for the run.
 * @returns Exit code and combined output.
 */
async function withSetup(
  tmp: string,
  snippet: string,
  env: Record<string, string> = {},
): Promise<Run> {
  const bin = await Deno.makeTempDir({ prefix: "vibe_stub_claude_" });
  try {
    // The stub is the observation point: whatever the validation path exports
    // is what the real CLI would have authenticated with.
    await Deno.writeTextFile(
      `${bin}/claude`,
      `#!/usr/bin/env bash\n` +
        `printf '%s' "\${ANTHROPIC_API_KEY-<unset>}" > "$VIBE_TEST_RECORD"\n` +
        `echo hello\n`,
    );
    await Deno.chmod(`${bin}/claude`, 0o755);
    const script = `
      set -euo pipefail
      source "${setupPath}"
      CRED_DIR="${tmp}/.vibe-coder/credentials"
      ${snippet}
    `;
    const cmd = new Deno.Command("bash", {
      args: ["-c", script],
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: tmp,
        // Both, and identical: setup.sh refuses a host where they disagree.
        CONFIG_FILE: `${tmp}/.config.json`,
        CONFIG_PATH: `${tmp}/.config.json`,
        VIBE_TEST_RECORD: `${tmp}/claude-saw`,
        ...env,
      },
      stdin: "null",
    });
    const { code, stdout, stderr } = await cmd.output();
    return {
      code,
      output: new TextDecoder().decode(stdout) +
        new TextDecoder().decode(stderr),
    };
  } finally {
    await removeTempTree(bin);
  }
}

/** True when `path` exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("claude_credential_is_valid - exports a metacharacter credential verbatim and runs none of it", async () => {
  await withTempDir(async (tmp) => {
    const semicolon = `${tmp}/pwned-semicolon`;
    const substitution = `${tmp}/pwned-substitution`;
    // Space, `;`, `$(...)` and `#` — every shape `source` mis-parses.
    const secret =
      `sk-ant-oat01-AAA BBB; touch ${semicolon}; $(touch ${substitution})#tail`;

    const { code, output } = await withSetup(
      tmp,
      `
      provision_provider_credential "$CRED_DIR" claude \
        VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY ANTHROPIC_API_KEY quiet
      if claude_credential_is_valid "$CRED_DIR/claude/provider.env"; then
        echo 'VALID=yes'
      else
        echo 'VALID=no'
      fi
      `,
      { VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY: secret },
    );

    assertEquals(code, 0, output);
    assert(output.includes("VALID=yes"), output);

    // The CLI saw exactly what the operator supplied — not the first word.
    const saw = await Deno.readTextFile(`${tmp}/claude-saw`);
    assertEquals(saw, secret);

    // Nothing embedded in the credential was executed.
    assertEquals(await exists(semicolon), false, "`;` payload ran");
    assertEquals(await exists(substitution), false, "`$()` payload ran");
  });
});

Deno.test("provision_provider_credential - refuses a credential holding a newline", async () => {
  await withTempDir(async (tmp) => {
    const { code, output } = await withSetup(
      tmp,
      `
      if provision_provider_credential "$CRED_DIR" claude \
        VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY ANTHROPIC_API_KEY quiet; then
        echo 'WROTE=yes'
      else
        echo 'WROTE=no'
      fi
      `,
      { VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY: "sk-ant-first\nsk-ant-second" },
    );

    assertEquals(code, 0, output);
    assert(output.includes("WROTE=no"), output);
    assert(/newline/i.test(output), output);
    // A value that cannot be represented is refused, not silently truncated.
    assertEquals(
      await exists(`${tmp}/.vibe-coder/credentials/claude/provider.env`),
      false,
    );
  });
});

Deno.test("claude_credential_is_valid - reports a file holding no NAME=value line", async () => {
  await withTempDir(async (tmp) => {
    const dir = `${tmp}/.vibe-coder/credentials/claude`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/provider.env`,
      "# a comment and nothing else\nsk-ant-bare-token-with-no-name\n",
    );

    const { code, output } = await withSetup(
      tmp,
      `
      if claude_credential_is_valid "$CRED_DIR/claude/provider.env"; then
        echo 'VALID=yes'
      else
        echo 'VALID=no'
      fi
      `,
    );

    assertEquals(code, 0, output);
    assert(output.includes("VALID=no"), output);
    assert(/no .*credential/i.test(output), output);
    // The unusable file was never handed to the CLI.
    assertEquals(await exists(`${tmp}/claude-saw`), false);
  });
});
