/**
 * setup.sh runs the credential flow of every configured provider — and only
 * those (Issue #730, part of #722).
 *
 * The reported fault: `setup.sh` probed for the `claude` CLI and prompted for
 * `CLAUDE_CODE_OAUTH_TOKEN` on a host whose `.config.json` selected Codex
 * alone, so the operator had to run `VIBE_SKIP_PREREQ_CHECK=true ./setup.sh`
 * and hand-write the configuration.
 *
 * Every test drives the real functions in the real `setup.sh` with scripted
 * stdin and asserts on what they wrote — the credential files, their
 * permissions, and the prompts the operator actually saw.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  checkCredentialPreflight,
  credentialPreflightMessage,
} from "../lib/credential_preflight.ts";
import {
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  DEFAULT_AGENT_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";

const setupPath = new URL("../../../setup.sh", import.meta.url).pathname;

/** Run one function from the real setup.sh with stdin fed and PATH set. */
async function runSetupFunction(
  tmp: string,
  call: string,
  options: {
    stdin?: string;
    path?: string;
    env?: Record<string, string>;
    configFile?: string;
  } = {},
): Promise<{ code: number; output: string }> {
  const script = `
    set -euo pipefail
    source "${setupPath}"
    ${call}
  `;
  const child = new Deno.Command("bash", {
    args: ["-c", script],
    env: {
      // No `claude` on the default PATH — the Codex host the report described.
      PATH: options.path ?? "/usr/bin:/bin",
      HOME: tmp,
      TMPDIR: tmp,
      CONFIG_FILE: options.configFile ?? `${tmp}/.config.json`,
      ...options.env,
    },
    stdin: options.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (options.stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(options.stdin));
    await writer.close();
  }
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    output: new TextDecoder().decode(stdout) +
      new TextDecoder().decode(stderr),
  };
}

/** POSIX permission bits of a path. */
async function modeOf(path: string): Promise<number> {
  const info = await Deno.stat(path);
  return (info.mode ?? 0) & 0o777;
}

/** True when a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Assert the output carries no Claude credential prompt at all. */
function assertNoClaudePrompt(output: string): void {
  assert(!output.includes("claude setup-token"), output);
  assert(!output.includes("CLAUDE_CODE_OAUTH_TOKEN"), output);
  assert(!output.includes("sk-ant-oat01-"), output);
}

const codexCredentials = resolveAgentProvider(CODEX_PROVIDER_ID).credentials;
const claudeSubdir =
  resolveAgentProvider(CLAUDE_PROVIDER_ID).credentials.subdir;

Deno.test("interactive_credentials_flow - a Codex-only host is asked for the Codex credential, never Claude's", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const { code, output } = await runSetupFunction(
      tmp,
      `interactive_credentials_flow "" ${CODEX_PROVIDER_ID}`,
      { stdin: "sk-openai-pasted\n" },
    );
    assertEquals(code, 0, output);

    const dir = `${tmp}/.vibe-coder/credentials`;
    const file = `${dir}/${codexCredentials.subdir}/${codexCredentials.file}`;
    assertEquals(
      await Deno.readTextFile(file),
      `${codexCredentials.envVars[0]}=sk-openai-pasted\n`,
    );
    if (Deno.build.os !== "windows") {
      assertEquals(await modeOf(dir), 0o700);
      assertEquals(await modeOf(`${dir}/${codexCredentials.subdir}`), 0o700);
      assertEquals(await modeOf(file), 0o600);
    }

    // Nothing Claude-shaped was asked for, offered, or written.
    assertNoClaudePrompt(output);
    assertEquals(await exists(`${dir}/${claudeSubdir}`), false);

    // The pasted secret never reaches the scrollback.
    assert(!output.includes("sk-openai-pasted"), output);

    // Which flows ran is stated, so a misconfigured provider is visible.
    assert(
      output.includes(CODEX_PROVIDER_ID),
      `the flow names the provider it ran for: ${output}`,
    );

    // The worker's own preflight accepts what setup provisioned for Codex.
    const result = await checkCredentialPreflight({
      dir,
      env: (name: string) => name === "GH_TOKEN" ? "gho_env" : undefined,
      providers: [resolveAgentProvider(CODEX_PROVIDER_ID)],
    });
    assertEquals(
      result.failures.filter((f) => f.code === "provider-credentials-missing"),
      [],
      credentialPreflightMessage(result),
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("interactive_credentials_flow - a Codex-only host with claude installed still sees no Claude prompt", async () => {
  // The gate is the configuration, not the accident of what is on PATH: a
  // host that happens to carry the claude CLI must not be pushed through the
  // Claude flow when it runs Codex.
  const tmp = await Deno.makeTempDir();
  try {
    const bin = `${tmp}/bin`;
    await Deno.mkdir(bin, { recursive: true });
    await Deno.writeTextFile(
      `${bin}/claude`,
      "#!/bin/bash\necho 'Your token: sk-ant-oat01-SHOULD_NOT_BE_USED'\n",
    );
    await Deno.chmod(`${bin}/claude`, 0o755);

    const { code, output } = await runSetupFunction(
      tmp,
      `interactive_credentials_flow "" ${CODEX_PROVIDER_ID}`,
      { stdin: "sk-openai-pasted\n", path: `${bin}:/usr/bin:/bin` },
    );
    assertEquals(code, 0, output);
    assertNoClaudePrompt(output);
    assertEquals(
      await exists(`${tmp}/.vibe-coder/credentials/${claudeSubdir}`),
      false,
    );
    assertEquals(
      await Deno.readTextFile(
        `${tmp}/.vibe-coder/credentials/${codexCredentials.subdir}/${codexCredentials.file}`,
      ),
      `${codexCredentials.envVars[0]}=sk-openai-pasted\n`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("interactive_credentials_flow - an existing Codex credential is never overwritten", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // Provision non-interactively first, exactly as an earlier run would.
    const provisioned = await runSetupFunction(
      tmp,
      "provision_vibe_credentials",
      { env: { VIBE_LAUNCHAGENT_OPENAI_API_KEY: "sk-openai-original" } },
    );
    assertEquals(provisioned.code, 0, provisioned.output);
    const file =
      `${tmp}/.vibe-coder/credentials/${codexCredentials.subdir}/${codexCredentials.file}`;
    const before = await Deno.readTextFile(file);

    // Empty stdin: the replace offer falls back to its default (keep).
    const { code, output } = await runSetupFunction(
      tmp,
      `interactive_credentials_flow "" ${CODEX_PROVIDER_ID}`,
      { stdin: "" },
    );
    assertEquals(code, 0, output);
    assertEquals(await Deno.readTextFile(file), before);
    if (Deno.build.os !== "windows") {
      assertEquals(await modeOf(file), 0o600);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("interactive_credentials_flow - a Claude-only host keeps today's behaviour", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const { code, output } = await runSetupFunction(
      tmp,
      `interactive_credentials_flow "" ${CLAUDE_PROVIDER_ID}`,
      { stdin: "sk-ant-oat01-pasted\n" },
    );
    assertEquals(code, 0, output);

    const dir = `${tmp}/.vibe-coder/credentials`;
    assertEquals(
      await Deno.readTextFile(`${dir}/${claudeSubdir}/provider.env`),
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-pasted\n",
    );
    // The Claude recipe is intact — the operator can still mint the token
    // from the prompt alone.
    assert(output.includes("claude setup-token"), output);
    assert(/subscription/i.test(output), output);
    // And no other vendor is asked for.
    assertEquals(await exists(`${dir}/${codexCredentials.subdir}`), false);
    assert(!output.includes(codexCredentials.envVars[0]!), output);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("interactive_credentials_flow - a two-provider host runs both flows", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const { code, output } = await runSetupFunction(
      tmp,
      `interactive_credentials_flow "" ${CLAUDE_PROVIDER_ID} ${CODEX_PROVIDER_ID}`,
      { stdin: "sk-ant-oat01-pasted\nsk-openai-pasted\n" },
    );
    assertEquals(code, 0, output);

    const dir = `${tmp}/.vibe-coder/credentials`;
    assertEquals(
      await Deno.readTextFile(`${dir}/${claudeSubdir}/provider.env`),
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-pasted\n",
    );
    assertEquals(
      await Deno.readTextFile(
        `${dir}/${codexCredentials.subdir}/${codexCredentials.file}`,
      ),
      `${codexCredentials.envVars[0]}=sk-openai-pasted\n`,
    );
    assert(output.includes(CLAUDE_PROVIDER_ID), output);
    assert(output.includes(CODEX_PROVIDER_ID), output);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("prompt_interactive_credentials - a run with no terminal prompts for nothing", async () => {
  // `./setup.sh < /dev/null` must complete rather than block on a paste.
  const tmp = await Deno.makeTempDir();
  try {
    const { code, output } = await runSetupFunction(
      tmp,
      `prompt_interactive_credentials ${CODEX_PROVIDER_ID}`,
    );
    assertEquals(code, 0, output);
    assertEquals(await exists(`${tmp}/.vibe-coder/credentials`), false);
    assertEquals(output.trim(), "");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("setup.sh - a Codex-only host with no claude CLI reaches the configuration-writing stage", async () => {
  // Report item 1 of Issue #722: the prerequisite probe stopped setup dead on
  // a host with no claude CLI, so `.config.json` was never written and the
  // operator wrote it by hand. This drives the real stages `main()` runs
  // before the configuration is written, against a host that carries no
  // claude at all.
  const tmp = await Deno.makeTempDir();
  try {
    const bin = `${tmp}/bin`;
    await Deno.mkdir(bin, { recursive: true });
    // A container runtime that answers its probe, and a gh that is logged in.
    await Deno.writeTextFile(`${bin}/docker`, "#!/bin/bash\nexit 0\n");
    await Deno.writeTextFile(
      `${bin}/gh`,
      '#!/bin/bash\nif [[ "$1 $2" == "api user" ]]; then echo worker; fi\nexit 0\n',
    );
    for (const stub of ["docker", "gh"]) {
      await Deno.chmod(`${bin}/${stub}`, 0o755);
    }
    for (const real of ["git", "deno"]) {
      const path = real === "deno"
        ? Deno.execPath()
        : (await new Deno.Command("bash", {
          args: ["-c", "command -v git"],
          stdout: "piped",
        }).output().then((o) => new TextDecoder().decode(o.stdout).trim()));
      await Deno.symlink(path, `${bin}/${real}`);
    }

    const config = `${tmp}/.config.json`;
    await Deno.writeTextFile(
      config,
      JSON.stringify({
        repos: ["owner/repo"],
        allowed_authors: ["operator"],
        agent_provider: CODEX_PROVIDER_ID,
      }),
    );

    // The stages main() runs before the configuration write, in order.
    const { code, output } = await runSetupFunction(
      tmp,
      [
        "run_setup_cli prerequisites",
        "provision_vibe_credentials",
        'providers="$(configured_agent_providers)"',
        "prompt_interactive_credentials $providers",
        "prompt_interactive_config",
        "run_setup_cli config",
      ].join("\n    "),
      {
        configFile: config,
        path: `${bin}:/usr/bin:/bin`,
        // VIBE_SKIP_AUTH_CHECK is deliberately NOT set: it would skip the
        // claude probe outright and hide the very gate under test.
        env: {
          DENO_DIR: Deno.env.get("DENO_DIR") ??
            `${Deno.env.get("HOME")}/.cache/deno`,
        },
      },
    );
    assertEquals(code, 0, output);

    // The configuration survived a completed run — no VIBE_SKIP_PREREQ_CHECK,
    // no hand-written file.
    const written = JSON.parse(await Deno.readTextFile(config));
    assertEquals(written.agent_provider, CODEX_PROVIDER_ID);
    assertEquals(written.repos, ["owner/repo"]);

    // And the report says which providers it probed for.
    assert(output.includes(CODEX_PROVIDER_ID), output);
    assertNoClaudePrompt(output);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("provider_credential_flow - a provider with no credential row fails loudly", async () => {
  // The credential table is what makes the loop provider-agnostic; a provider
  // missing from it must stop the flow, not be skipped into a preflight
  // failure at first run.
  const tmp = await Deno.makeTempDir();
  try {
    const { code, output } = await runSetupFunction(
      tmp,
      `provider_credential_flow "$(credential_dir)" aider`,
    );
    assertEquals(code, 1, output);
    assert(output.includes("aider"), output);
    assert(output.includes("vibe_provider_credential_table"), output);
    assertEquals(await exists(`${tmp}/.vibe-coder/credentials/aider`), false);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("configured_agent_providers - an unusable selection stops setup rather than guessing", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const config = `${tmp}/.config.json`;
    await Deno.writeTextFile(config, "{ not json");
    const { code, output } = await runSetupFunction(
      tmp,
      "configured_agent_providers",
      {
        configFile: config,
        path: `${Deno.execPath().replace(/\/[^/]+$/, "")}:/usr/bin:/bin`,
        env: {
          DENO_DIR: Deno.env.get("DENO_DIR") ??
            `${Deno.env.get("HOME")}/.cache/deno`,
        },
      },
    );
    assertEquals(code, 1, output);
    // Never a provider id on stdout: the caller must not read a guess.
    assert(
      !output.split("\n").some((line) => line.trim() === CLAUDE_PROVIDER_ID),
      `no provider id may be printed for a broken configuration: ${output}`,
    );
    assert(output.includes(config), output);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("setup.sh - the default provider mirrors the registered default", async () => {
  // VIBE_DEFAULT_AGENT_PROVIDER is a shell copy of DEFAULT_AGENT_PROVIDER_ID;
  // this fails the gate if the two ever drift.
  const tmp = await Deno.makeTempDir();
  try {
    const { code, output } = await runSetupFunction(
      tmp,
      'printf "%s\\n" "$VIBE_DEFAULT_AGENT_PROVIDER"',
    );
    assertEquals(code, 0, output);
    assertEquals(output.trim(), DEFAULT_AGENT_PROVIDER_ID);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("configured_agent_providers - setup.sh reads the selection from .config.json", async () => {
  // The shell asks the Deno seam rather than parsing JSON itself, so this
  // exercises the real round trip a run makes.
  const tmp = await Deno.makeTempDir();
  try {
    const config = `${tmp}/.config.json`;
    await Deno.writeTextFile(
      config,
      JSON.stringify({
        repos: ["owner/repo"],
        agent_provider: CODEX_PROVIDER_ID,
      }),
    );
    const { code, output } = await runSetupFunction(
      tmp,
      "configured_agent_providers",
      {
        configFile: config,
        path: `${Deno.execPath().replace(/\/[^/]+$/, "")}:/usr/bin:/bin`,
        // The temporary HOME must not send Deno looking for an empty module
        // cache: keep the runner's own.
        env: {
          DENO_DIR: Deno.env.get("DENO_DIR") ??
            `${Deno.env.get("HOME")}/.cache/deno`,
        },
      },
    );
    assertEquals(code, 0, output);
    assertEquals(output.trim(), CODEX_PROVIDER_ID);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
