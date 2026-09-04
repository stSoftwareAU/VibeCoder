/**
 * Tests for credential_preflight.ts — the non-interactive credential gate
 * (Issue #4064, parent #4060).
 *
 * Unattended operation means the worker must never reach an interactive
 * `gh auth login` or provider login mid-run. Instead it asserts, before any
 * work starts, that the dedicated credential directory holds usable,
 * owner-only material — and fails loudly with a named, actionable message
 * when it does not.
 *
 * Every test calls the real functions against a temporary directory or
 * literal input; nothing touches the network or the operator's real
 * credentials.
 *
 * Australian English spelling throughout (behaviour, authorised, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  applyProviderCredentialEnv,
  checkCredentialPreflight,
  classifyCredentialFailure,
  type CredentialFailureCode,
  credentialPreflightMessage,
  DEFAULT_CREDENTIAL_DIR_SUFFIX,
  discoverProviderTokenFiles,
  extractGhToken,
  parseProviderCredentials,
  resolveCredentialDir,
} from "../lib/credential_preflight.ts";
// Issue #4067: the provider's credential variables and its auth predicate
// come from the provider seam, not from a second list in the preflight.
import {
  activeAgentProvider,
  CLAUDE_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  enabledAgentProviders,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
import { isGhAuthError } from "../lib/gh_auth.ts";

const PROVIDER_CREDENTIAL_ENV_VARS = activeAgentProvider().credentials.envVars;
const isClaudeAuthError = (output: string): boolean =>
  activeAgentProvider().isAuthError(output);

/** Build an env lookup from a plain map (absent names return undefined). */
function envOf(map: Record<string, string> = {}) {
  return (name: string): string | undefined => map[name];
}

/** Codes of the failures in a preflight result, in order. */
function codesOf(
  failures: readonly { code: CredentialFailureCode }[],
): CredentialFailureCode[] {
  return failures.map((f) => f.code);
}

/**
 * Provision a complete, correctly-permissioned credential directory and run
 * `fn` against it.
 */
async function withCredentialDir(
  fn: (dir: string) => Promise<void>,
  options: {
    ghToken?: string | null;
    providerKey?: string | null;
    /**
     * Write `provider.env` as an OAuth subscription token instead of an API
     * key — the credential the token pool of Issue #917 is made of.
     */
    oauthToken?: string;
    fileMode?: number;
  } = {},
): Promise<void> {
  const root = await Deno.makeTempDir();
  const dir = `${root}/credentials`;
  const mode = options.fileMode ?? 0o600;
  await Deno.mkdir(`${dir}/gh`, { recursive: true });
  await Deno.mkdir(`${dir}/claude`, { recursive: true });

  const ghToken = options.ghToken === undefined
    ? "gho_worker"
    : options.ghToken;
  if (ghToken !== null) {
    const hosts =
      `github.com:\n    oauth_token: ${ghToken}\n    git_protocol: ssh\n`;
    await Deno.writeTextFile(`${dir}/gh/hosts.yml`, hosts);
    if (Deno.build.os !== "windows") {
      await Deno.chmod(`${dir}/gh/hosts.yml`, mode);
    }
  }

  const providerKey = options.providerKey === undefined
    ? "sk-ant-test"
    : options.providerKey;
  const providerLine = options.oauthToken !== undefined
    ? `CLAUDE_CODE_OAUTH_TOKEN=${options.oauthToken}\n`
    : providerKey !== null
    ? `ANTHROPIC_API_KEY=${providerKey}\n`
    : null;
  if (providerLine !== null) {
    await Deno.writeTextFile(`${dir}/claude/provider.env`, providerLine);
    if (Deno.build.os !== "windows") {
      await Deno.chmod(`${dir}/claude/provider.env`, mode);
    }
  }

  try {
    await fn(dir);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("resolveCredentialDir - env override wins over the HOME default", () => {
  assertEquals(
    resolveCredentialDir(envOf({ VIBE_CREDENTIAL_DIR: "/mnt/creds" })),
    "/mnt/creds",
  );
  assertEquals(
    resolveCredentialDir(envOf({ HOME: "/home/worker" })),
    `/home/worker/${DEFAULT_CREDENTIAL_DIR_SUFFIX}`,
  );
});

Deno.test("extractGhToken - reads oauth_token and rejects placeholders", () => {
  assertEquals(
    extractGhToken("github.com:\n    oauth_token: gho_abc123\n"),
    "gho_abc123",
  );
  assertEquals(extractGhToken("github.com:\n    oauth_token:\n"), null);
  assertEquals(extractGhToken('github.com:\n    oauth_token: ""\n'), null);
  assertEquals(extractGhToken(""), null);
  assertEquals(extractGhToken("github.com:\n    user: worker\n"), null);
});

Deno.test("parseProviderCredentials - finds a recognised non-empty key", () => {
  assertEquals(
    parseProviderCredentials("ANTHROPIC_API_KEY=sk-ant-1\n"),
    "ANTHROPIC_API_KEY",
  );
  assertEquals(
    parseProviderCredentials('export CLAUDE_CODE_OAUTH_TOKEN="tok"\n'),
    "CLAUDE_CODE_OAUTH_TOKEN",
  );
  assertEquals(parseProviderCredentials("ANTHROPIC_API_KEY=\n"), null);
  assertEquals(parseProviderCredentials("# comment only\n"), null);
  assertEquals(parseProviderCredentials("UNRELATED=value\n"), null);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

Deno.test("checkCredentialPreflight - passes with valid owner-only material", async () => {
  await withCredentialDir(async (dir) => {
    const result = await checkCredentialPreflight({ dir, env: envOf() });
    assertEquals(result.failures, []);
    assertEquals(result.ok, true);
    assertEquals(result.githubSource, "directory");
    assertEquals(result.providerSource, "directory");
  });
});

Deno.test("checkCredentialPreflight - environment-provided credentials satisfy the gate", async () => {
  const root = await Deno.makeTempDir();
  try {
    const result = await checkCredentialPreflight({
      dir: `${root}/absent`,
      env: envOf({ GH_TOKEN: "gho_env", ANTHROPIC_API_KEY: "sk-ant-env" }),
    });
    assertEquals(result.ok, true);
    assertEquals(result.githubSource, "environment");
    assertEquals(result.providerSource, "environment");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkCredentialPreflight - every documented provider variable is accepted", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (const name of PROVIDER_CREDENTIAL_ENV_VARS) {
      const result = await checkCredentialPreflight({
        dir: `${root}/absent`,
        env: envOf({ GH_TOKEN: "gho_env", [name]: "secret" }),
      });
      assertEquals(result.providerSource, "environment", `for ${name}`);
      assertEquals(result.ok, true, `for ${name}`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Failure paths — missing, empty, unreadable
// ---------------------------------------------------------------------------

Deno.test("checkCredentialPreflight - missing directory fails with a named, actionable error", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = `${root}/never-provisioned`;
    const result = await checkCredentialPreflight({ dir, env: envOf() });

    assertEquals(result.ok, false);
    assert(codesOf(result.failures).includes("credential-dir-missing"));
    assert(codesOf(result.failures).includes("github-credentials-missing"));
    assert(codesOf(result.failures).includes("provider-credentials-missing"));

    const message = credentialPreflightMessage(result);
    assert(message.includes(dir), "message names the directory");
    assert(message.includes("./setup.sh"), "message names the fix");
    assert(
      !message.includes("gh auth login"),
      "the fix must not be an interactive login",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkCredentialPreflight - empty directory fails loudly", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const result = await checkCredentialPreflight({ dir, env: envOf() });
    assertEquals(result.ok, false);
    assert(codesOf(result.failures).includes("credential-dir-empty"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkCredentialPreflight - unreadable directory fails loudly", async () => {
  if (Deno.build.os === "windows") return;
  const root = await Deno.makeTempDir();
  const dir = `${root}/credentials`;
  await Deno.mkdir(dir);
  await Deno.chmod(dir, 0o000);
  try {
    // A root-owned CI container can still read a 0000 directory — skip there
    // rather than asserting a condition the OS will not produce.
    let readable = true;
    try {
      await Array.fromAsync(Deno.readDir(dir));
    } catch {
      readable = false;
    }
    if (readable) return;

    const result = await checkCredentialPreflight({ dir, env: envOf() });
    assertEquals(result.ok, false);
    assert(codesOf(result.failures).includes("credential-dir-unreadable"));
    assert(credentialPreflightMessage(result).includes(dir));
  } finally {
    await Deno.chmod(dir, 0o700);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkCredentialPreflight - a file where the directory belongs fails loudly", async () => {
  const root = await Deno.makeTempDir();
  const dir = `${root}/credentials`;
  await Deno.writeTextFile(dir, "not a directory\n");
  try {
    const result = await checkCredentialPreflight({ dir, env: envOf() });
    assertEquals(result.ok, false);
    assert(codesOf(result.failures).includes("credential-dir-not-a-directory"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Failure paths — missing or unusable material inside a provisioned directory
// ---------------------------------------------------------------------------

Deno.test("checkCredentialPreflight - missing gh token fails, provider still passes", async () => {
  await withCredentialDir(async (dir) => {
    const result = await checkCredentialPreflight({ dir, env: envOf() });
    assertEquals(result.ok, false);
    assertEquals(codesOf(result.failures), ["github-credentials-missing"]);
    assertEquals(result.providerSource, "directory");
    assertEquals(result.githubSource, null);
  }, { ghToken: null });
});

Deno.test("checkCredentialPreflight - an empty gh token is not usable material", async () => {
  await withCredentialDir(async (dir) => {
    const result = await checkCredentialPreflight({ dir, env: envOf() });
    assertEquals(codesOf(result.failures), ["github-credentials-missing"]);
  }, { ghToken: '""' });
});

Deno.test("checkCredentialPreflight - missing provider material fails loudly", async () => {
  await withCredentialDir(async (dir) => {
    const result = await checkCredentialPreflight({ dir, env: envOf() });
    assertEquals(result.ok, false);
    assertEquals(codesOf(result.failures), ["provider-credentials-missing"]);
  }, { providerKey: null });
});

Deno.test("checkCredentialPreflight - world-readable credential files fail loudly", async () => {
  if (Deno.build.os === "windows") return;
  await withCredentialDir(async (dir) => {
    const result = await checkCredentialPreflight({ dir, env: envOf() });
    assertEquals(result.ok, false);
    const openFailures = result.failures.filter(
      (f) => f.code === "credential-permissions-too-open",
    );
    assertEquals(openFailures.length, 2);
    assert(openFailures.every((f) => f.path !== undefined));
    assert(credentialPreflightMessage(result).includes("chmod 600"));
  }, { fileMode: 0o644 });
});

Deno.test("checkCredentialPreflight - unrelated material in the directory fails loudly", async () => {
  await withCredentialDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/aws-secret-key`, "AKIA...\n");
    const result = await checkCredentialPreflight({ dir, env: envOf() });
    assertEquals(result.ok, false);
    const unexpected = result.failures.filter(
      (f) => f.code === "unexpected-credential-material",
    );
    assertEquals(unexpected.length, 1);
    assert(unexpected[0]?.path?.endsWith("aws-secret-key"));
  });
});

Deno.test("checkCredentialPreflight - macOS metadata files are not treated as credentials", async () => {
  await withCredentialDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/.DS_Store`, " ");
    const result = await checkCredentialPreflight({ dir, env: envOf() });
    assertEquals(result.failures, []);
    assertEquals(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// A DeepSeek-enabled run (Issue #414) — the preflight derives the provider's
// sub-directory, credential variables and provisioning variable from its
// descriptor, so registering DeepSeek needs no edit to this module.
// ---------------------------------------------------------------------------

Deno.test("checkCredentialPreflight - a deepseek-enabled run reports the provider by name", async () => {
  const providers = enabledAgentProviders({
    configured: CLAUDE_PROVIDER_ID,
    configuredProviders: [CLAUDE_PROVIDER_ID, DEEPSEEK_PROVIDER_ID],
    env: envOf(),
  });
  assertEquals(providers.map((p) => p.id), [
    CLAUDE_PROVIDER_ID,
    DEEPSEEK_PROVIDER_ID,
  ]);

  await withCredentialDir(async (dir) => {
    const missing = await checkCredentialPreflight({
      dir,
      env: envOf(),
      providers,
    });
    assertEquals(missing.ok, false);
    const failure = missing.failures.find(
      (f) => f.provider === DEEPSEEK_PROVIDER_ID,
    );
    assert(failure, "the missing DeepSeek credential is reported");
    assertEquals(failure.code, "provider-credentials-missing");
    assertEquals(failure.path, `${dir}/deepseek/provider.env`);
    // Named vendor, named variable, named fix — not an anonymous "provider".
    assert(failure.message.includes("DeepSeek"), failure.message);
    assert(failure.message.includes("DEEPSEEK_API_KEY"), failure.message);
    assert(
      failure.message.includes("VIBE_LAUNCHAGENT_DEEPSEEK_API_KEY"),
      failure.message,
    );
    assertEquals(classifyCredentialFailure(failure), "provider-auth");

    // Claude's own credential is unaffected: one vendor's gap is reported as
    // that vendor's, not as the run's.
    assertEquals(
      missing.providers.map((p) => `${p.id}=${p.source ?? "none"}`),
      ["claude=directory", "deepseek=none"],
    );

    // Provisioning the file the descriptor names is the whole fix, and the
    // deepseek sub-directory is permitted material rather than unexpected.
    await Deno.mkdir(`${dir}/deepseek`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/deepseek/provider.env`,
      "DEEPSEEK_API_KEY=sk-deepseek-test\n",
    );
    if (Deno.build.os !== "windows") {
      await Deno.chmod(`${dir}/deepseek/provider.env`, 0o600);
    }

    const passing = await checkCredentialPreflight({
      dir,
      env: envOf(),
      providers,
    });
    assertEquals(passing.ok, true, JSON.stringify(passing.failures));
    assert(credentialPreflightMessage(passing).includes("deepseek=directory"));
  });
});

// ---------------------------------------------------------------------------
// Classification agreement with the existing auth surfaces
// ---------------------------------------------------------------------------

Deno.test("classifyCredentialFailure - agrees with isClaudeAuthError and isGhAuthError", async () => {
  const root = await Deno.makeTempDir();
  try {
    const result = await checkCredentialPreflight({
      dir: `${root}/absent`,
      env: envOf(),
    });

    const provider = result.failures.find(
      (f) => f.code === "provider-credentials-missing",
    );
    assert(provider, "provider failure present");
    assertEquals(classifyCredentialFailure(provider), "provider-auth");
    assert(
      isClaudeAuthError(provider.message),
      "the provider message must be classified as a Claude auth error",
    );

    const github = result.failures.find(
      (f) => f.code === "github-credentials-missing",
    );
    assert(github, "github failure present");
    assertEquals(classifyCredentialFailure(github), "github-auth");
    assert(
      isGhAuthError(github.message),
      "the GitHub message must be classified as a gh auth error",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("credentialPreflightMessage - success message states the sources", async () => {
  await withCredentialDir(async (dir) => {
    const result = await checkCredentialPreflight({ dir, env: envOf() });
    const message = credentialPreflightMessage(result);
    assert(message.includes("github=directory"));
    assert(message.includes("provider=directory"));
  });
});

// ---------------------------------------------------------------------------
// applyProviderCredentialEnv — the runtime half of Issue #4064. The preflight
// proves the material exists; this makes it usable: agent child environments
// are built FROM the parent env (buildChildEnv, filtered per vendor), so the
// parent process must actually carry the variables. Observed live without
// it: the contained health check failed "Not logged in · Please run /login"
// straight after a passing preflight.
// ---------------------------------------------------------------------------

Deno.test("applyProviderCredentialEnv - exports the directory credential into the environment", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/claude`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/claude/provider.env`,
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-exported\n",
    );
    const set: Array<[string, string]> = [];
    const exported = await applyProviderCredentialEnv({
      dir,
      env: () => undefined,
      setEnv: (name, value) => set.push([name, value]),
    });
    assertEquals(exported, ["CLAUDE_CODE_OAUTH_TOKEN"]);
    assertEquals(set, [["CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-exported"]]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("applyProviderCredentialEnv - an ambient variable is never clobbered", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/claude`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/claude/provider.env`,
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-from-file\n",
    );
    const set: Array<[string, string]> = [];
    const exported = await applyProviderCredentialEnv({
      dir,
      env: (name) =>
        name === "CLAUDE_CODE_OAUTH_TOKEN" ? "already-set" : undefined,
      setEnv: (name, value) => set.push([name, value]),
    });
    assertEquals(exported, []);
    assertEquals(set, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("applyProviderCredentialEnv - a missing credential file exports nothing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const set: Array<[string, string]> = [];
    const exported = await applyProviderCredentialEnv({
      dir,
      env: () => undefined,
      setEnv: (name, value) => set.push([name, value]),
    });
    assertEquals(exported, []);
    assertEquals(set, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Multiple Claude token files (Issue #917, parent #902).
//
// An operator may hold several Claude subscriptions and wants them spent
// evenly, so extra tokens sit beside claude/provider.env as provider-2.env,
// provider-3.env, ... This sub-issue only finds them, checks them and exports
// exactly one; the budget probe (#918) and the budget-based selection (#919)
// replace the deterministic first-in-order selector. A host with zero or one
// token file must be indistinguishable from before.
// ---------------------------------------------------------------------------

const CLAUDE = resolveAgentProvider(CLAUDE_PROVIDER_ID);

/** Write one Claude token file at owner-only permissions. */
async function writeTokenFile(
  dir: string,
  name: string,
  body: string,
  mode = 0o600,
): Promise<void> {
  const path = `${dir}/claude/${name}`;
  await Deno.writeTextFile(path, body);
  if (Deno.build.os !== "windows") await Deno.chmod(path, mode);
}

Deno.test("discoverProviderTokenFiles - an empty provider directory yields nothing", async () => {
  await withCredentialDir(async (dir) => {
    assertEquals(await discoverProviderTokenFiles(dir, CLAUDE), []);
  }, { providerKey: null });
});

Deno.test("discoverProviderTokenFiles - one token file is the single record it always was", async () => {
  await withCredentialDir(async (dir) => {
    const tokens = await discoverProviderTokenFiles(dir, CLAUDE);
    assertEquals(tokens.length, 1);
    assertEquals(tokens[0]?.label, "provider");
    assertEquals(tokens[0]?.path, `${dir}/claude/provider.env`);
    assertEquals(tokens[0]?.name, "CLAUDE_CODE_OAUTH_TOKEN");
    assertEquals(tokens[0]?.primary, true);
    // An OAuth subscription token is what the budget selection weighs.
    assertEquals(tokens[0]?.poolMember, true);
  }, { providerKey: null, oauthToken: "sk-ant-oat01-one" });
});

Deno.test("discoverProviderTokenFiles - numbered files follow the primary in ascending numeric order", async () => {
  await withCredentialDir(async (dir) => {
    // Written out of order, and with a two-digit ordinal, because a text sort
    // of the directory listing would put provider-10 before provider-2.
    await writeTokenFile(
      dir,
      "provider-10.env",
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-ten\n",
    );
    await writeTokenFile(
      dir,
      "provider-2.env",
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-two\n",
    );
    const tokens = await discoverProviderTokenFiles(dir, CLAUDE);
    assertEquals(tokens.map((token) => token.label), [
      "provider",
      "provider-2",
      "provider-10",
    ]);
    assertEquals(tokens.map((token) => token.primary), [true, false, false]);
    assertEquals(tokens.map((token) => token.poolMember), [true, true, true]);
    // Files that are not the pattern are not tokens: no README, backup copy
    // or editor swap file becomes a candidate credential.
    await writeTokenFile(dir, "notes.txt", "not a credential\n");
    await writeTokenFile(
      dir,
      "provider-two.env",
      "CLAUDE_CODE_OAUTH_TOKEN=x\n",
    );
    assertEquals((await discoverProviderTokenFiles(dir, CLAUDE)).length, 3);
  }, { providerKey: null, oauthToken: "sk-ant-oat01-one" });
});

Deno.test("discoverProviderTokenFiles - a provider without a pool never gains extra files", async () => {
  const deepseek = resolveAgentProvider(DEEPSEEK_PROVIDER_ID);
  assertEquals(deepseek.credentials.tokenPool, undefined);
  await withCredentialDir(async (dir) => {
    await Deno.mkdir(`${dir}/deepseek`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/deepseek/provider.env`,
      "DEEPSEEK_API_KEY=sk-deepseek-one\n",
    );
    await Deno.writeTextFile(
      `${dir}/deepseek/provider-2.env`,
      "DEEPSEEK_API_KEY=sk-deepseek-two\n",
    );
    const tokens = await discoverProviderTokenFiles(dir, deepseek);
    assertEquals(tokens.map((token) => token.label), ["provider"]);
  });
});

Deno.test("checkCredentialPreflight - a numbered token file is permission-checked too", async () => {
  if (Deno.build.os === "windows") return;
  await withCredentialDir(async (dir) => {
    await writeTokenFile(
      dir,
      "provider-2.env",
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-two\n",
      0o644,
    );
    const result = await checkCredentialPreflight({ dir, env: envOf() });
    assertEquals(result.ok, false);
    const open = result.failures.filter(
      (f) => f.code === "credential-permissions-too-open",
    );
    assertEquals(open.length, 1);
    assertEquals(open[0]?.path, `${dir}/claude/provider-2.env`);
    assert(credentialPreflightMessage(result).includes("chmod 600"));
  });
});

Deno.test("checkCredentialPreflight - a numbered token file with no recognised variable fails by name", async () => {
  await withCredentialDir(async (dir) => {
    await writeTokenFile(
      dir,
      "provider-2.env",
      "# a hand-typed mistake\nANTHROPIC_TOKEN=sk-ant-oat01-two\n",
    );
    const result = await checkCredentialPreflight({ dir, env: envOf() });
    assertEquals(result.ok, false);
    assertEquals(codesOf(result.failures), [
      "provider-token-file-unrecognised",
    ]);
    const failure = result.failures[0];
    assertEquals(failure?.path, `${dir}/claude/provider-2.env`);
    assertEquals(failure?.provider, CLAUDE_PROVIDER_ID);
    // Names the file and the variables it could have used — never a silent
    // skip that leaves the operator with a token the worker ignores.
    assert(failure?.message.includes("provider-2.env"), failure?.message);
    assert(
      failure?.message.includes("CLAUDE_CODE_OAUTH_TOKEN"),
      failure?.message,
    );
    // The token value itself never reaches the operator-facing message.
    assert(!credentialPreflightMessage(result).includes("sk-ant-oat01-two"));
  });
});

Deno.test("checkCredentialPreflight - an API-key-only numbered file passes and stays out of the pool", async () => {
  await withCredentialDir(async (dir) => {
    await writeTokenFile(
      dir,
      "provider-2.env",
      "ANTHROPIC_API_KEY=sk-ant-metered\n",
    );
    const result = await checkCredentialPreflight({ dir, env: envOf() });
    assertEquals(result.failures, []);
    assertEquals(result.ok, true);
    const tokens = await discoverProviderTokenFiles(dir, CLAUDE);
    assertEquals(tokens.map((token) => token.poolMember), [false, false]);
  });
});

Deno.test("checkCredentialPreflight - three token files still pass and still report one source", async () => {
  await withCredentialDir(async (dir) => {
    await writeTokenFile(
      dir,
      "provider-2.env",
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-two\n",
    );
    await writeTokenFile(
      dir,
      "provider-3.env",
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-three\n",
    );
    const result = await checkCredentialPreflight({ dir, env: envOf() });
    assertEquals(result.failures, []);
    assertEquals(result.ok, true);
    assertEquals(result.providerSource, "directory");
    assert(credentialPreflightMessage(result).includes("claude=directory"));
  }, { providerKey: null, oauthToken: "sk-ant-oat01-one" });
});

Deno.test("applyProviderCredentialEnv - exports exactly one token however many exist", async () => {
  await withCredentialDir(async (dir) => {
    await writeTokenFile(
      dir,
      "provider-2.env",
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-two\n",
    );
    await writeTokenFile(
      dir,
      "provider-3.env",
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-three\n",
    );
    const set: Array<[string, string]> = [];
    const exported = await applyProviderCredentialEnv({
      dir,
      env: () => undefined,
      setEnv: (name, value) => set.push([name, value]),
      providers: [CLAUDE],
    });
    // One variable, and it is the first in discovery order — the seam #919
    // replaces with the most-remaining-budget token.
    assertEquals(exported, ["CLAUDE_CODE_OAUTH_TOKEN"]);
    assertEquals(set, [["CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-one"]]);
  }, { providerKey: null, oauthToken: "sk-ant-oat01-one" });
});

Deno.test("applyProviderCredentialEnv - the selector seam decides which token is exported", async () => {
  await withCredentialDir(async (dir) => {
    await writeTokenFile(
      dir,
      "provider-2.env",
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-two\n",
    );
    const set: Array<[string, string]> = [];
    // What #918/#919 plug in: a selector that ranks the discovered pool.
    const exported = await applyProviderCredentialEnv({
      dir,
      env: () => undefined,
      setEnv: (name, value) => set.push([name, value]),
      providers: [CLAUDE],
      selectToken: (tokens) =>
        tokens.find((token) => token.label === "provider-2") ?? null,
    });
    assertEquals(exported, ["CLAUDE_CODE_OAUTH_TOKEN"]);
    assertEquals(set, [["CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-two"]]);
  }, { providerKey: null, oauthToken: "sk-ant-oat01-one" });
});
