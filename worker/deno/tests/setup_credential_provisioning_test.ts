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
  DEEPSEEK_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
import { listTree, removeTempTree, withTempDir } from "./support/temp_tree.ts";

const setupPath = new URL("../../../setup.sh", import.meta.url).pathname;

/**
 * Run `fn` with a PATH whose `gh` is a stub that reaches nothing
 * (Issue #1135).
 *
 * `PATH: "/usr/bin:/bin"` was written to keep `write_gh_hosts_file`'s login
 * lookup off the network, and on a developer's machine — where `gh` lives in
 * `/opt/homebrew/bin` or `/usr/local/bin` — it does. It does **not** on CI:
 * `ubuntu-latest` ships the GitHub CLI at `/usr/bin/gh`, so every
 * provisioning case here ran the real `gh api user` against api.github.com
 * with `HOME` pointed at the test's own temp directory. That put a program
 * the test does not own inside the tree the test then deletes — measured, it
 * writes `$HOME/.local/state/gh/device-id` — on a schedule set by a network
 * round trip, and it made the resulting `hosts.yml` differ between a
 * developer's machine and CI.
 *
 * A stub that exits non-zero without printing gives every host the single
 * behaviour the comment always claimed: the lookup finds no login, nothing
 * outside setup.sh writes into `HOME`, and no test depends on the network.
 */
async function withOfflineGh<T>(
  fn: (path: string) => Promise<T>,
  ghStub: string = "#!/usr/bin/env bash\nexit 1\n",
): Promise<T> {
  const bin = await Deno.makeTempDir({ prefix: "vibe_offline_gh_" });
  try {
    await Deno.writeTextFile(`${bin}/gh`, ghStub);
    await Deno.chmod(`${bin}/gh`, 0o755);
    return await fn(`${bin}:/usr/bin:/bin`);
  } finally {
    await removeTempTree(bin);
  }
}

/**
 * A `gh` that fails the way the real one does (Issue #1146).
 *
 * `gh api` prints the API's response body to **stdout** on an HTTP error and
 * the human message to stderr, then exits non-zero. A stub that merely exits
 * non-zero silently cannot catch the defect this shape caused, because the
 * defect is precisely that the body was read as a username.
 */
const GH_REJECTS_TOKEN = `#!/usr/bin/env bash
cat <<'JSON'
{
  "message": "Bad credentials",
  "documentation_url": "https://docs.github.com/rest",
  "status": "401"
}
JSON
echo 'gh: Bad credentials (HTTP 401)' >&2
exit 1
`;

/** A `gh` that resolves the login the way a good token does. */
const GH_RESOLVES_LOGIN = `#!/usr/bin/env bash
echo 'vibe-worker-bot'
`;

/** A `gh` that exits 0 but prints something that is not a login. */
const GH_PRINTS_NON_LOGIN = `#!/usr/bin/env bash
printf 'not a login\n'
`;

/** Run `provision_vibe_credentials` from the real setup.sh with `env` set. */
function provision(
  tmp: string,
  env: Record<string, string>,
  ghStub?: string,
): Promise<{ code: number; output: string }> {
  const script = `
    set -euo pipefail
    source "${setupPath}"
    provision_vibe_credentials
    printf 'PROVISIONED_GH_DIR=%s\\n' "\${VIBE_PROVISIONED_GH_CONFIG_DIR}"
  `;
  return withOfflineGh(async (path) => {
    const cmd = new Deno.Command("bash", {
      args: ["-c", script],
      env: {
        PATH: path,
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
  }, ghStub);
}

/** POSIX permission bits of a path. */
async function modeOf(path: string): Promise<number> {
  const info = await Deno.stat(path);
  return (info.mode ?? 0) & 0o777;
}

Deno.test("provision_vibe_credentials - writes owner-only credential material", async () => {
  await withTempDir(async (tmp) => {
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
  });
});

Deno.test("provision_vibe_credentials - honours VIBE_CREDENTIAL_DIR and CLAUDE_CODE_OAUTH_TOKEN", async () => {
  await withTempDir(async (tmp) => {
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
  });
});

Deno.test("provision_vibe_credentials - no credential variables leaves nothing behind and warns", async () => {
  await withTempDir(async (tmp) => {
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
  });
});

Deno.test("provision_vibe_credentials - provisions one credential per vendor", async () => {
  // Issue #4108: each provider is provisioned from its own descriptor
  // variable, into its own sub-directory, so a run can carry more than one
  // vendor's credential without either seeing the other's.
  await withTempDir(async (tmp) => {
    const { code, output } = await provision(tmp, {
      VIBE_LAUNCHAGENT_GH_TOKEN: "gho_provisioned",
      VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY: "sk-ant-provisioned",
      VIBE_LAUNCHAGENT_OPENAI_API_KEY: "sk-openai-provisioned",
      VIBE_LAUNCHAGENT_GEMINI_API_KEY: "gemini-provisioned",
      // Issue #414: DeepSeek is a registered provider too, so "every vendor"
      // now includes it.
      VIBE_LAUNCHAGENT_DEEPSEEK_API_KEY: "sk-deepseek-provisioned",
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
    assertEquals(
      await Deno.readTextFile(`${dir}/deepseek/provider.env`),
      "DEEPSEEK_API_KEY=sk-deepseek-provisioned\n",
    );

    // Every registered provider's sub-directory, derived from the descriptors
    // rather than listed, so a fifth vendor is covered without an edit here.
    const providers = agentProviderIds().map(resolveAgentProvider);
    if (Deno.build.os !== "windows") {
      for (const provider of providers) {
        const subdir = provider.credentials.subdir;
        assertEquals(await modeOf(`${dir}/${subdir}`), 0o700);
        assertEquals(
          await modeOf(`${dir}/${subdir}/${provider.credentials.file}`),
          0o600,
        );
      }
    }

    // The preflight accepts the multi-vendor directory when all of them are
    // enabled — no vendor's file is unrelated material to the others.
    const result = await checkCredentialPreflight({
      dir,
      env: () => undefined,
      providers,
    });
    assertEquals(result.ok, true, credentialPreflightMessage(result));
    assertEquals(
      result.providers.map((p) => p.source),
      providers.map(() => "directory" as const),
    );
  });
});

Deno.test("provision_vibe_credentials - an unset variable leaves that vendor untouched", async () => {
  await withTempDir(async (tmp) => {
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
  });
});

/**
 * The DeepSeek provider as the credential surfaces see it (Issue #416).
 *
 * The registered descriptor since Issue #414 — no local stand-in, so this
 * exercises the real round trip: setup.sh writes the file the descriptor names
 * and the unmodified preflight accepts it.
 */
function deepseekDescriptor(): AgentProviderDescriptor {
  return resolveAgentProvider(DEEPSEEK_PROVIDER_ID);
}

Deno.test("provision_vibe_credentials - provisions the DeepSeek API key", async () => {
  // Issue #416: DeepSeek is an API-key-only vendor, so the non-interactive
  // path is the only way it is ever provisioned.
  await withTempDir(async (tmp) => {
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
  });
});

Deno.test("provision_vibe_credentials - a claude+deepseek run passes the preflight unchanged", async () => {
  await withTempDir(async (tmp) => {
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
  });
});

Deno.test("provision_vibe_credentials - is idempotent across repeated runs", async () => {
  await withTempDir(async (tmp) => {
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
  });
});

Deno.test("provision_vibe_credentials - writes nothing into HOME beyond the credential directory", async () => {
  // Issue #1135: the teardown of the idempotency case above failed on CI
  // with ENOTEMPTY while every assertion passed. `ENOTEMPTY` from a
  // recursive remove means an entry appeared inside the tree while it was
  // being walked, so the question was who else writes into this HOME.
  //
  // `write_gh_hosts_file` runs `gh api user` whenever `command -v gh`
  // succeeds, and on `ubuntu-latest` it does — the GitHub CLI is installed
  // at `/usr/bin/gh`, which the helper's `PATH` names. The real `gh` then
  // ran against the network with `HOME` set to this directory and left
  // `.local/state/gh/device-id` behind in it. This case pins the boundary:
  // the only thing a provisioning run may create under HOME is the
  // credential directory setup.sh is asked for.
  await withTempDir(async (tmp) => {
    const { code, output } = await provision(tmp, {
      VIBE_LAUNCHAGENT_GH_TOKEN: "gho_provisioned",
      VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY: "sk-ant-provisioned",
    });
    assertEquals(code, 0, output);

    const written = await listTree(tmp);
    const foreign = written.filter((path) =>
      path !== ".vibe-coder" && !path.startsWith(".vibe-coder/")
    );
    assertEquals(
      foreign,
      [],
      `only setup.sh may write into HOME; found ${foreign.join(", ")}`,
    );
    // ...and the credential material really was written, so an empty tree
    // cannot pass this case by accident.
    assert(
      written.includes(".vibe-coder/credentials/gh/hosts.yml"),
      written.join(", "),
    );
  });
});

// ---------------------------------------------------------------------------
// Interactive credential provisioning (Issue #4161)
//
// The operator walks to each worker machine once, runs ./setup.sh, pastes the
// Max-subscription OAuth token from `claude setup-token`, and leaves. These
// tests drive the real `interactive_credentials_flow` with scripted stdin.
// ---------------------------------------------------------------------------

/** Run `interactive_credentials_flow` from the real setup.sh with stdin fed. */
function interactiveFlow(
  tmp: string,
  stdinText: string,
  ghSourceDir = "",
  // No `claude` on the default PATH, so the run-it-for-you offer is skipped
  // and the paste fallback is exercised unless a test injects a fake CLI.
  // A caller that injects its own PATH owns what `gh` resolves to; the
  // default resolves it to the offline stub for the reason above.
  path?: string,
): Promise<{ code: number; output: string }> {
  const script = `
    set -euo pipefail
    source "${setupPath}"
    interactive_credentials_flow "${ghSourceDir}"
  `;
  const run = async (resolvedPath: string) => {
    const child = new Deno.Command("bash", {
      args: ["-c", script],
      env: {
        PATH: resolvedPath,
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
  };
  return path === undefined ? withOfflineGh(run) : run(path);
}

Deno.test("interactive_credentials_flow - copies the gh identity and writes the pasted OAuth token", async () => {
  await withTempDir(async (tmp) => {
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
  });
});

Deno.test("interactive_credentials_flow - declining and skipping writes nothing and warns", async () => {
  await withTempDir(async (tmp) => {
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
  });
});

Deno.test("interactive_credentials_flow - existing material is kept by default", async () => {
  await withTempDir(async (tmp) => {
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
  });
});

Deno.test("interactive_credentials_flow - runs claude setup-token itself and captures the token", async () => {
  // The operator accepts the run-it-now offer; a fake `claude` stands in for
  // the real CLI, printing UI noise around the token exactly as setup-token
  // does. The flow must extract the token from the pty transcript and write
  // provider.env without any paste.
  await withTempDir(async (tmp) => {
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
  });
});

Deno.test("interactive_credentials_flow - replace offer rotates an expired token via paste fallback", async () => {
  await withTempDir(async (tmp) => {
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
  });
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
  await withTempDir(async (tmp) => {
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
  });
});

Deno.test("interactive_credentials_flow - a token that fails validation is never kept", async () => {
  await withTempDir(async (tmp) => {
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
  });
});

Deno.test("interactive_credentials_flow - a rate-limited token is kept, never discarded", async () => {
  // The operator may be waiting out their subscription's usage window: a
  // "limit reached" answer proves the token authenticated, so the flow must
  // keep the credential rather than deleting a perfectly good token.
  await withTempDir(async (tmp) => {
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
  });
});

Deno.test("interactive_credentials_flow - materialises a keychain-held gh token into the copy", async () => {
  // `gh auth login` on macOS stores the token in the OS keychain: the
  // source hosts.yml carries no oauth_token at all, so a plain copy hands
  // the container an unusable identity (observed live on host-23). The flow
  // must extract the token via `gh auth token` and write it inline.
  await withTempDir(async (tmp) => {
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
  });
});

Deno.test("interactive_credentials_flow - a token-less source with no gh warns instead of copying", async () => {
  await withTempDir(async (tmp) => {
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
  });
});

// ── The login lookup and gh's exit code (Issue #1146) ───────────────────
//
// `write_gh_hosts_file` used to read `gh api user --jq .login` with
// `2>/dev/null || true`, which discards the exit code — and `gh api` prints
// the API's response body to stdout on an HTTP error. On any host whose token
// gh rejects (an expired or revoked token, the ordinary case) the login
// therefore became the "Bad credentials" JSON blob, and the provisioned
// hosts.yml was corrupt YAML with JSON where the username belongs.
//
// These three pin the decision in both directions: a rejected token writes the
// token-only file, an accepted one still completes the host entry, and output
// that is not shaped like a login is refused whatever gh's exit code says.

Deno.test("write_gh_hosts_file - a token gh rejects writes a token-only hosts.yml (Issue #1146)", async () => {
  await withTempDir(async (tmp) => {
    const { code, output } = await provision(tmp, {
      VIBE_LAUNCHAGENT_GH_TOKEN: "gho_rejected",
      VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY: "sk-ant-provisioned",
    }, GH_REJECTS_TOKEN);
    // Not fatal: the token alone authenticates, so provisioning still succeeds.
    assertEquals(code, 0, output);

    const hosts = await Deno.readTextFile(
      `${tmp}/.vibe-coder/credentials/gh/hosts.yml`,
    );
    // The whole file, so nothing can hide between the assertions.
    assertEquals(
      hosts,
      "github.com:\n    oauth_token: gho_rejected\n    git_protocol: ssh\n",
    );
    // Named individually, because each is a distinct way the bug showed.
    assert(!hosts.includes("user:"), `hosts.yml carries a user key: ${hosts}`);
    assert(!hosts.includes("{"), `hosts.yml carries JSON: ${hosts}`);
    assert(
      !hosts.includes("Bad credentials"),
      `hosts.yml carries gh's error body: ${hosts}`,
    );

    // The discarded exit code is now reported rather than swallowed.
    assert(
      output.includes("gh could not resolve the token's login"),
      `the failed lookup was not reported: ${output}`,
    );
  });
});

Deno.test("write_gh_hosts_file - a token gh accepts still completes the host entry (Issue #1146)", async () => {
  await withTempDir(async (tmp) => {
    const { code, output } = await provision(tmp, {
      VIBE_LAUNCHAGENT_GH_TOKEN: "gho_accepted",
      VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY: "sk-ant-provisioned",
    }, GH_RESOLVES_LOGIN);
    assertEquals(code, 0, output);

    const hosts = await Deno.readTextFile(
      `${tmp}/.vibe-coder/credentials/gh/hosts.yml`,
    );
    assertEquals(
      hosts,
      "github.com:\n" +
        "    oauth_token: gho_accepted\n" +
        "    git_protocol: ssh\n" +
        "    user: vibe-worker-bot\n" +
        "    users:\n" +
        "        vibe-worker-bot:\n" +
        "            oauth_token: gho_accepted\n",
    );
  });
});

Deno.test("write_gh_hosts_file - output that is not a login is refused even on exit 0 (Issue #1146)", async () => {
  await withTempDir(async (tmp) => {
    const { code, output } = await provision(tmp, {
      VIBE_LAUNCHAGENT_GH_TOKEN: "gho_odd",
      VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY: "sk-ant-provisioned",
    }, GH_PRINTS_NON_LOGIN);
    assertEquals(code, 0, output);

    const hosts = await Deno.readTextFile(
      `${tmp}/.vibe-coder/credentials/gh/hosts.yml`,
    );
    assertEquals(
      hosts,
      "github.com:\n    oauth_token: gho_odd\n    git_protocol: ssh\n",
    );
    assert(
      output.includes("gh returned no usable GitHub login"),
      `the unusable login was not reported: ${output}`,
    );
  });
});
