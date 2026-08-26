/**
 * Tests for non-interactive credential provisioning in setup.sh
 * (Issue #4064, parent #4060).
 *
 * Behavioural: each test sources the real setup.sh, calls the real
 * `provision_vibe_credentials` function with a temporary HOME, and asserts on
 * the files it wrote — contents, owner-only permissions, and that the
 * resulting directory satisfies the worker's own credential preflight.
 *
 * Australian English spelling throughout (behaviour, authorised).
 */

import { assert, assertEquals } from "@std/assert";
import {
  checkCredentialPreflight,
  credentialPreflightMessage,
} from "../lib/credential_preflight.ts";
import {
  type AgentProviderDescriptor,
  agentProviderIds,
  CLAUDE_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";

const setupPath = new URL("../../../setup.sh", import.meta.url).pathname;

/** Run `provision_vibe_credentials` from the real setup.sh with `env` set. */
async function provision(
  tmp: string,
  env: Record<string, string>,
): Promise<{ code: number; output: string }> {
  const script = `
    set -euo pipefail
    source "${setupPath}"
    provision_vibe_credentials
    printf 'PROVISIONED_GH_DIR=%s\\n' "\${VIBE_PROVISIONED_GH_CONFIG_DIR}"
  `;
  const cmd = new Deno.Command("bash", {
    args: ["-c", script],
    env: {
      // A PATH without `gh` keeps the login lookup off the network.
      PATH: "/usr/bin:/bin",
      HOME: tmp,
      CONFIG_FILE: `${tmp}/.config.json`,
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
}

/** POSIX permission bits of a path. */
async function modeOf(path: string): Promise<number> {
  const info = await Deno.stat(path);
  return (info.mode ?? 0) & 0o777;
}

Deno.test("provision_vibe_credentials - writes owner-only credential material", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const { code, output } = await provision(tmp, {
      VIBE_LAUNCHAGENT_GH_TOKEN: "gho_provisioned",
      VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY: "sk-ant-provisioned",
    });
    assertEquals(code, 0, output);

    const dir = `${tmp}/.vibe-coder/credentials`;
    const hosts = await Deno.readTextFile(`${dir}/gh/hosts.yml`);
    assert(hosts.includes("oauth_token: gho_provisioned"), hosts);
    assert(hosts.includes("git_protocol: ssh"), hosts);

    const provider = await Deno.readTextFile(`${dir}/claude/provider.env`);
    assertEquals(provider, "ANTHROPIC_API_KEY=sk-ant-provisioned\n");

    if (Deno.build.os !== "windows") {
      assertEquals(await modeOf(dir), 0o700);
      assertEquals(await modeOf(`${dir}/gh/hosts.yml`), 0o600);
      assertEquals(await modeOf(`${dir}/claude/provider.env`), 0o600);
    }

    // The gh config directory is published for the config write-back.
    assert(
      output.includes(`PROVISIONED_GH_DIR=${dir}/gh`),
      output,
    );

    // The worker's own preflight accepts what setup provisioned.
    const result = await checkCredentialPreflight({
      dir,
      env: () => undefined,
    });
    assertEquals(result.ok, true, credentialPreflightMessage(result));
    assertEquals(result.githubSource, "directory");
    assertEquals(result.providerSource, "directory");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("provision_vibe_credentials - honours VIBE_CREDENTIAL_DIR and CLAUDE_CODE_OAUTH_TOKEN", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const dir = `${tmp}/mounted-credentials`;
    const { code, output } = await provision(tmp, {
      VIBE_CREDENTIAL_DIR: dir,
      GH_TOKEN: "gho_env",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
    });
    assertEquals(code, 0, output);

    assertEquals(
      await Deno.readTextFile(`${dir}/claude/provider.env`),
      "CLAUDE_CODE_OAUTH_TOKEN=oauth-token\n",
    );
    const result = await checkCredentialPreflight({
      dir,
      env: () => undefined,
    });
    assertEquals(result.ok, true, credentialPreflightMessage(result));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("provision_vibe_credentials - no credential variables leaves nothing behind and warns", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const { code, output } = await provision(tmp, {});
    assertEquals(code, 0, output);
    assert(
      output.includes("VIBE_LAUNCHAGENT_GH_TOKEN"),
      `expected an actionable warning, got: ${output}`,
    );
    // Issue #416: DeepSeek has no interactive login of its own, so the
    // warning must name the variable that provisions it and where the key
    // comes from — never a provider login suggestion that cannot help.
    assert(
      output.includes("VIBE_LAUNCHAGENT_DEEPSEEK_API_KEY"),
      `expected the DeepSeek variable to be named, got: ${output}`,
    );
    assert(
      output.includes("platform.deepseek.com"),
      `expected the warning to say where a DeepSeek key comes from: ${output}`,
    );
    // No login command is ever suggested here: the interactive fallback is
    // Claude's, and an operator told to run it for DeepSeek cannot obey.
    assert(
      !/\b(claude|deepseek|gh auth)\s+(login|setup-token)\b/i.test(output),
      `DeepSeek must not be pointed at an interactive login: ${output}`,
    );
    assert(output.includes("PROVISIONED_GH_DIR=\n"), output);

    // Nothing was created, so the preflight fails loudly — as it must.
    const result = await checkCredentialPreflight({
      dir: `${tmp}/.vibe-coder/credentials`,
      env: () => undefined,
    });
    assertEquals(result.ok, false);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("provision_vibe_credentials - provisions one credential per vendor", async () => {
  // Issue #4108: each provider is provisioned from its own descriptor
  // variable, into its own sub-directory, so a run can carry more than one
  // vendor's credential without either seeing the other's.
  const tmp = await Deno.makeTempDir();
  try {
    const { code, output } = await provision(tmp, {
      VIBE_LAUNCHAGENT_GH_TOKEN: "gho_provisioned",
      VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY: "sk-ant-provisioned",
      VIBE_LAUNCHAGENT_OPENAI_API_KEY: "sk-openai-provisioned",
      VIBE_LAUNCHAGENT_GEMINI_API_KEY: "gemini-provisioned",
    });
    assertEquals(code, 0, output);

    const dir = `${tmp}/.vibe-coder/credentials`;
    assertEquals(
      await Deno.readTextFile(`${dir}/claude/provider.env`),
      "ANTHROPIC_API_KEY=sk-ant-provisioned\n",
    );
    assertEquals(
      await Deno.readTextFile(`${dir}/codex/provider.env`),
      "OPENAI_API_KEY=sk-openai-provisioned\n",
    );
    assertEquals(
      await Deno.readTextFile(`${dir}/gemini/provider.env`),
      "GEMINI_API_KEY=gemini-provisioned\n",
    );

    if (Deno.build.os !== "windows") {
      for (const subdir of ["claude", "codex", "gemini"]) {
        assertEquals(await modeOf(`${dir}/${subdir}`), 0o700);
        assertEquals(await modeOf(`${dir}/${subdir}/provider.env`), 0o600);
      }
    }

    // The preflight accepts the multi-vendor directory when all three are
    // enabled — no vendor's file is unrelated material to the others.
    const providers = agentProviderIds().map(resolveAgentProvider);
    const result = await checkCredentialPreflight({
      dir,
      env: () => undefined,
      providers,
    });
    assertEquals(result.ok, true, credentialPreflightMessage(result));
    assertEquals(result.providers.map((p) => p.source), [
      "directory",
      "directory",
      "directory",
    ]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("provision_vibe_credentials - an unset variable leaves that vendor untouched", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // First run provisions Claude only — no Codex directory is created.
    await provision(tmp, {
      VIBE_LAUNCHAGENT_GH_TOKEN: "gho_provisioned",
      VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY: "sk-ant-first",
    });
    const dir = `${tmp}/.vibe-coder/credentials`;
    assertEquals(
      await Deno.stat(`${dir}/codex`).then(() => true, () => false),
      false,
      "an unprovisioned vendor gets no directory",
    );

    // Second run provisions Codex only — Claude's credential survives intact.
    const { code, output } = await provision(tmp, {
      VIBE_LAUNCHAGENT_OPENAI_API_KEY: "sk-openai-second",
    });
    assertEquals(code, 0, output);
    assertEquals(
      await Deno.readTextFile(`${dir}/claude/provider.env`),
      "ANTHROPIC_API_KEY=sk-ant-first\n",
    );
    assertEquals(
      await Deno.readTextFile(`${dir}/codex/provider.env`),
      "OPENAI_API_KEY=sk-openai-second\n",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

/**
 * The DeepSeek provider as the credential surfaces see it (Issue #416).
 *
 * Registering the descriptor is a sibling issue; the preflight reads only a
 * provider's id, name and credential facets, so an active descriptor carrying
 * DeepSeek's facets exercises the real round trip today — setup.sh writes the
 * file and the unmodified preflight accepts it.
 */
function deepseekDescriptor(): AgentProviderDescriptor {
  return {
    ...resolveAgentProvider(CLAUDE_PROVIDER_ID),
    id: "deepseek",
    displayName: "DeepSeek",
    credentials: {
      subdir: "deepseek",
      file: "provider.env",
      envVars: ["DEEPSEEK_API_KEY"],
      provisionEnvVar: "VIBE_LAUNCHAGENT_DEEPSEEK_API_KEY",
    },
  };
}

Deno.test("provision_vibe_credentials - provisions the DeepSeek API key", async () => {
  // Issue #416: DeepSeek is an API-key-only vendor, so the non-interactive
  // path is the only way it is ever provisioned.
  const tmp = await Deno.makeTempDir();
  try {
    const key = "sk-deepseek-provisioned";
    const { code, output } = await provision(tmp, {
      VIBE_LAUNCHAGENT_GH_TOKEN: "gho_provisioned",
      VIBE_LAUNCHAGENT_DEEPSEEK_API_KEY: key,
    });
    assertEquals(code, 0, output);

    const dir = `${tmp}/.vibe-coder/credentials`;
    const file = `${dir}/deepseek/provider.env`;
    assertEquals(await Deno.readTextFile(file), `DEEPSEEK_API_KEY=${key}\n`);
    // The key never reaches stdout or a log.
    assert(!output.includes(key), output);

    if (Deno.build.os !== "windows") {
      assertEquals(await modeOf(dir), 0o700);
      assertEquals(await modeOf(`${dir}/deepseek`), 0o700);
      assertEquals(await modeOf(file), 0o600);
    }

    // Re-running with the same variable rewrites nothing new: one line, same
    // contents, same owner-only mode.
    const repeat = await provision(tmp, {
      VIBE_LAUNCHAGENT_GH_TOKEN: "gho_provisioned",
      VIBE_LAUNCHAGENT_DEEPSEEK_API_KEY: key,
    });
    assertEquals(repeat.code, 0, repeat.output);
    assertEquals(await Deno.readTextFile(file), `DEEPSEEK_API_KEY=${key}\n`);
    if (Deno.build.os !== "windows") {
      assertEquals(await modeOf(file), 0o600);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("provision_vibe_credentials - a claude+deepseek run passes the preflight unchanged", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const providers = [
      resolveAgentProvider(CLAUDE_PROVIDER_ID),
      deepseekDescriptor(),
    ];
    const dir = `${tmp}/.vibe-coder/credentials`;

    // Claude alone: the preflight names the vendor that lacks a credential
    // and the variable that provisions it.
    await provision(tmp, {
      VIBE_LAUNCHAGENT_GH_TOKEN: "gho_provisioned",
      VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY: "sk-ant-provisioned",
    });
    const partial = await checkCredentialPreflight({
      dir,
      env: () => undefined,
      providers,
    });
    assertEquals(partial.ok, false);
    const missing = partial.failures.filter(
      (f) => f.code === "provider-credentials-missing",
    );
    assertEquals(missing.map((f) => f.provider), ["deepseek"]);
    assert(
      missing[0]!.message.includes("VIBE_LAUNCHAGENT_DEEPSEEK_API_KEY"),
      missing[0]!.message,
    );

    // Both provisioned: the preflight accepts the directory with no edit of
    // its own — the sub-directory it permits comes from the descriptor.
    const { code, output } = await provision(tmp, {
      VIBE_LAUNCHAGENT_DEEPSEEK_API_KEY: "sk-deepseek-provisioned",
    });
    assertEquals(code, 0, output);
    const result = await checkCredentialPreflight({
      dir,
      env: () => undefined,
      providers,
    });
    assertEquals(result.ok, true, credentialPreflightMessage(result));
    assertEquals(result.providers.map((p) => p.source), [
      "directory",
      "directory",
    ]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("provision_vibe_credentials - is idempotent across repeated runs", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const env = {
      VIBE_LAUNCHAGENT_GH_TOKEN: "gho_provisioned",
      VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY: "sk-ant-provisioned",
    };
    await provision(tmp, env);
    const dir = `${tmp}/.vibe-coder/credentials`;
    const first = await Deno.readTextFile(`${dir}/gh/hosts.yml`);

    const { code, output } = await provision(tmp, env);
    assertEquals(code, 0, output);
    assertEquals(await Deno.readTextFile(`${dir}/gh/hosts.yml`), first);
    if (Deno.build.os !== "windows") {
      assertEquals(await modeOf(`${dir}/gh/hosts.yml`), 0o600);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Interactive credential provisioning (Issue #4161)
//
// The operator walks to each worker machine once, runs ./setup.sh, pastes the
// Max-subscription OAuth token from `claude setup-token`, and leaves. These
// tests drive the real `interactive_credentials_flow` with scripted stdin.
// ---------------------------------------------------------------------------

/** Run `interactive_credentials_flow` from the real setup.sh with stdin fed. */
async function interactiveFlow(
  tmp: string,
  stdinText: string,
  ghSourceDir = "",
  // No `claude` on the default PATH, so the run-it-for-you offer is skipped
  // and the paste fallback is exercised unless a test injects a fake CLI.
  path = "/usr/bin:/bin",
): Promise<{ code: number; output: string }> {
  const script = `
    set -euo pipefail
    source "${setupPath}"
    interactive_credentials_flow "${ghSourceDir}"
  `;
  const child = new Deno.Command("bash", {
    args: ["-c", script],
    env: {
      PATH: path,
      HOME: tmp,
      // Pty transcripts land here, so the tests can assert none survive.
      TMPDIR: tmp,
      CONFIG_FILE: `${tmp}/.config.json`,
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(stdinText));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    output: new TextDecoder().decode(stdout) +
      new TextDecoder().decode(stderr),
  };
}

Deno.test("interactive_credentials_flow - copies the gh identity and writes the pasted OAuth token", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const ghSource = `${tmp}/gh-vibe`;
    await Deno.mkdir(ghSource, { recursive: true });
    const hosts = "github.com:\n    oauth_token: gho_existing\n";
    await Deno.writeTextFile(`${ghSource}/hosts.yml`, hosts);

    // Enter accepts the copy default; then the pasted token.
    const { code, output } = await interactiveFlow(
      tmp,
      "\nsk-ant-oat01-pasted\n",
      ghSource,
    );
    assertEquals(code, 0, output);

    const dir = `${tmp}/.vibe-coder/credentials`;
    assertEquals(await Deno.readTextFile(`${dir}/gh/hosts.yml`), hosts);
    assertEquals(
      await Deno.readTextFile(`${dir}/claude/provider.env`),
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-pasted\n",
    );
    if (Deno.build.os !== "windows") {
      assertEquals(await modeOf(dir), 0o700);
      assertEquals(await modeOf(`${dir}/gh/hosts.yml`), 0o600);
      assertEquals(await modeOf(`${dir}/claude/provider.env`), 0o600);
    }
    // The pasted token is never echoed back to the terminal.
    assert(!output.includes("sk-ant-oat01-pasted"), output);

    // The prompt is self-contained: an operator at the machine can mint the
    // token from these instructions alone, without looking anything up.
    assert(output.includes("claude setup-token"), output);
    assert(output.includes("second terminal"), output);
    assert(output.includes("sk-ant-oat01-"), output);
    assert(/subscription/i.test(output), output);

    // The worker's own preflight accepts the interactively provisioned dir.
    const result = await checkCredentialPreflight({
      dir,
      env: () => undefined,
    });
    assertEquals(result.ok, true, credentialPreflightMessage(result));
    assertEquals(result.githubSource, "directory");
    assertEquals(result.providerSource, "directory");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("interactive_credentials_flow - declining and skipping writes nothing and warns", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const ghSource = `${tmp}/gh-vibe`;
    await Deno.mkdir(ghSource, { recursive: true });
    await Deno.writeTextFile(`${ghSource}/hosts.yml`, "github.com:\n");

    const { code, output } = await interactiveFlow(tmp, "n\n\n", ghSource);
    assertEquals(code, 0, output);

    const dir = `${tmp}/.vibe-coder/credentials`;
    assertEquals(await exists(`${dir}/gh/hosts.yml`), false);
    assertEquals(await exists(`${dir}/claude/provider.env`), false);
    // The skip is loud: the operator is told the worker cannot launch yet.
    assert(/claude credential|preflight/i.test(output), output);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("interactive_credentials_flow - existing material is kept by default", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await provision(tmp, {
      VIBE_LAUNCHAGENT_GH_TOKEN: "gho_provisioned",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-original",
    });
    const dir = `${tmp}/.vibe-coder/credentials`;
    const hostsBefore = await Deno.readTextFile(`${dir}/gh/hosts.yml`);

    // Empty stdin: the replace offer falls back to its default (keep), so a
    // clean exit with unchanged files proves the default never clobbers.
    const { code, output } = await interactiveFlow(tmp, "", `${tmp}/gh-vibe`);
    assertEquals(code, 0, output);
    assertEquals(await Deno.readTextFile(`${dir}/gh/hosts.yml`), hostsBefore);
    assertEquals(
      await Deno.readTextFile(`${dir}/claude/provider.env`),
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-original\n",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("interactive_credentials_flow - runs claude setup-token itself and captures the token", async () => {
  // The operator accepts the run-it-now offer; a fake `claude` stands in for
  // the real CLI, printing UI noise around the token exactly as setup-token
  // does. The flow must extract the token from the pty transcript and write
  // provider.env without any paste.
  const tmp = await Deno.makeTempDir();
  try {
    const bin = `${tmp}/bin`;
    await Deno.mkdir(bin, { recursive: true });
    await Deno.writeTextFile(
      `${bin}/claude`,
      "#!/bin/bash\necho 'Opening browser...'\n" +
        "echo 'Your token: sk-ant-oat01-CAPTURED_abc123'\necho 'Done.'\n",
    );
    await Deno.chmod(`${bin}/claude`, 0o755);

    // Enter accepts the run-now default; no paste line is provided at all.
    const { code, output } = await interactiveFlow(
      tmp,
      "\n",
      "",
      `${bin}:/usr/bin:/bin`,
    );
    assertEquals(code, 0, output);

    const dir = `${tmp}/.vibe-coder/credentials`;
    assertEquals(
      await Deno.readTextFile(`${dir}/claude/provider.env`),
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-CAPTURED_abc123\n",
    );
    if (Deno.build.os !== "windows") {
      assertEquals(await modeOf(`${dir}/claude/provider.env`), 0o600);
    }
    // No pty transcript may survive — the token must not linger on disk.
    for await (const entry of Deno.readDir(tmp)) {
      assert(
        !entry.name.includes("vibe-setup-token"),
        `transcript left behind: ${entry.name}`,
      );
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("interactive_credentials_flow - replace offer rotates an expired token via paste fallback", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await provision(tmp, {
      VIBE_LAUNCHAGENT_GH_TOKEN: "gho_provisioned",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-expired",
    });
    const dir = `${tmp}/.vibe-coder/credentials`;

    // y = replace the existing credential; no fake claude on PATH, so the
    // flow falls back to the paste prompt and reads the fresh token.
    const { code, output } = await interactiveFlow(
      tmp,
      "y\nsk-ant-oat01-fresh\n",
      `${tmp}/gh-vibe`,
    );
    assertEquals(code, 0, output);
    assertEquals(
      await Deno.readTextFile(`${dir}/claude/provider.env`),
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fresh\n",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

/** True when a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("interactive_credentials_flow - an invalid stored token is detected and replaced", async () => {
  // The fake claude validates whichever token the flow exported: the stored
  // "expired" one fails `-p`, the freshly minted one passes — so the flow
  // must notice the stale credential and rotate it without being asked.
  const tmp = await Deno.makeTempDir();
  try {
    await provision(tmp, {
      VIBE_LAUNCHAGENT_GH_TOKEN: "gho_provisioned",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-expired",
    });
    const bin = `${tmp}/bin`;
    await Deno.mkdir(bin, { recursive: true });
    await Deno.writeTextFile(
      `${bin}/claude`,
      '#!/bin/bash\nif [[ "$1" == "setup-token" ]]; then\n' +
        '  echo "Your token: sk-ant-oat01-fresh_123"; exit 0\nfi\n' +
        'if [[ "${CLAUDE_CODE_OAUTH_TOKEN:-}" != *fresh* ]]; then\n' +
        '  echo "OAuth token expired · Please run /login"; exit 1\nfi\n' +
        "echo hello\n",
    );
    await Deno.chmod(`${bin}/claude`, 0o755);

    // Only one answer needed: accept the run-now offer for the replacement.
    const { code, output } = await interactiveFlow(
      tmp,
      "\n",
      `${tmp}/gh-vibe`,
      `${bin}:/usr/bin:/bin`,
    );
    assertEquals(code, 0, output);
    assertEquals(
      await Deno.readTextFile(
        `${tmp}/.vibe-coder/credentials/claude/provider.env`,
      ),
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fresh_123\n",
    );
    assert(/fail|invalid|expired/i.test(output), output);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("interactive_credentials_flow - a token that fails validation is never kept", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const bin = `${tmp}/bin`;
    await Deno.mkdir(bin, { recursive: true });
    // setup-token mints a token, but `-p` always fails: whatever is written
    // must be validated and removed rather than left for the worker to trip
    // over at 3am.
    await Deno.writeTextFile(
      `${bin}/claude`,
      '#!/bin/bash\nif [[ "$1" == "setup-token" ]]; then\n' +
        '  echo "Your token: sk-ant-oat01-bad_456"; exit 0\nfi\n' +
        'echo "Invalid API key · Please run /login"; exit 1\n',
    );
    await Deno.chmod(`${bin}/claude`, 0o755);

    // Accept the run-now offer on both attempts.
    const { code, output } = await interactiveFlow(
      tmp,
      "\n\n",
      "",
      `${bin}:/usr/bin:/bin`,
    );
    assertEquals(code, 0, output);
    assertEquals(
      await exists(`${tmp}/.vibe-coder/credentials/claude/provider.env`),
      false,
    );
    assert(/fail|invalid/i.test(output), output);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("interactive_credentials_flow - a rate-limited token is kept, never discarded", async () => {
  // The operator may be waiting out their subscription's usage window: a
  // "limit reached" answer proves the token authenticated, so the flow must
  // keep the credential rather than deleting a perfectly good token.
  const tmp = await Deno.makeTempDir();
  try {
    await provision(tmp, {
      VIBE_LAUNCHAGENT_GH_TOKEN: "gho_provisioned",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-good-but-limited",
    });
    const bin = `${tmp}/bin`;
    await Deno.mkdir(bin, { recursive: true });
    await Deno.writeTextFile(
      `${bin}/claude`,
      "#!/bin/bash\n" +
        'echo "5-hour limit reached · resets 3am"; exit 1\n',
    );
    await Deno.chmod(`${bin}/claude`, 0o755);

    // The stored credential survives; the replace offer defaults to keep.
    const { code, output } = await interactiveFlow(
      tmp,
      "",
      `${tmp}/gh-vibe`,
      `${bin}:/usr/bin:/bin`,
    );
    assertEquals(code, 0, output);
    assertEquals(
      await Deno.readTextFile(
        `${tmp}/.vibe-coder/credentials/claude/provider.env`,
      ),
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-good-but-limited\n",
    );
    assert(/rate-limited/i.test(output), output);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("interactive_credentials_flow - materialises a keychain-held gh token into the copy", async () => {
  // `gh auth login` on macOS stores the token in the OS keychain: the
  // source hosts.yml carries no oauth_token at all, so a plain copy hands
  // the container an unusable identity (observed live on host-23). The flow
  // must extract the token via `gh auth token` and write it inline.
  const tmp = await Deno.makeTempDir();
  try {
    const ghSource = `${tmp}/gh-vibe`;
    await Deno.mkdir(ghSource, { recursive: true });
    await Deno.writeTextFile(
      `${ghSource}/hosts.yml`,
      "github.com:\n    users:\n        Vibecoderbot:\n    user: Vibecoderbot\n",
    );
    const bin = `${tmp}/bin`;
    await Deno.mkdir(bin, { recursive: true });
    await Deno.writeTextFile(
      `${bin}/gh`,
      '#!/bin/bash\nif [[ "$1 $2" == "auth token" ]]; then\n' +
        '  echo "gho_from_keychain"; exit 0\nfi\nexit 1\n',
    );
    await Deno.chmod(`${bin}/gh`, 0o755);

    // Accept the copy; skip the claude token paste.
    const { code, output } = await interactiveFlow(
      tmp,
      "\n\n",
      ghSource,
      `${bin}:/usr/bin:/bin`,
    );
    assertEquals(code, 0, output);

    const hosts = await Deno.readTextFile(
      `${tmp}/.vibe-coder/credentials/gh/hosts.yml`,
    );
    assert(hosts.includes("oauth_token: gho_from_keychain"), hosts);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("interactive_credentials_flow - a token-less source with no gh warns instead of copying", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const ghSource = `${tmp}/gh-vibe`;
    await Deno.mkdir(ghSource, { recursive: true });
    await Deno.writeTextFile(`${ghSource}/hosts.yml`, "github.com:\n");

    const { code, output } = await interactiveFlow(tmp, "\n\n", ghSource);
    assertEquals(code, 0, output);
    assertEquals(
      await exists(`${tmp}/.vibe-coder/credentials/gh/hosts.yml`),
      false,
    );
    assert(/keychain/i.test(output), output);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
