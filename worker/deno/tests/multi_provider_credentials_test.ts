/**
 * Tests for per-vendor credentials (Issue #4108, parent #4102, milestone
 * #4060).
 *
 * A run may enable more than one coding agent, and each vendor authenticates
 * with its own credential. These tests assert the isolation that assumption
 * needs: exactly the enabled providers' credential directories are mounted,
 * a disabled provider's directory is never mounted, a multi-provider
 * credential directory passes the preflight while unrelated material still
 * fails it, a missing credential names the provider that lacks it, and no
 * vendor's subprocess environment carries another vendor's secret.
 *
 * Every test calls the real functions with real inputs — no source scanning.
 *
 * Australian English spelling throughout (behaviour, authorised, organisation).
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type AgentProviderDescriptor,
  agentProviderIds,
  CLAUDE_PROVIDER_ID,
  ENABLED_AGENT_PROVIDERS_CONFIG_KEY,
  ENABLED_AGENT_PROVIDERS_ENV,
  enabledAgentProviders,
  IMAGE_AGENT_PROVIDERS_ENV,
  resolveAgentProvider,
  resolveEnabledAgentProviderIds,
  setConfiguredEnabledAgentProviderIds,
} from "../lib/agent_provider.ts";
import {
  buildContainerLaunchPlan,
  type ContainerLaunchInputs,
  containerTargetPaths,
} from "../lib/container_launch.ts";
import {
  CONTAINER_RUNTIMES,
  type ContainerRuntimeDescriptor,
} from "../lib/container_runtime.ts";
import {
  type ContainerManifest,
  parseContainerManifest,
} from "../lib/container_manifest.ts";
import {
  allowedCredentialEntries,
  checkCredentialPreflight,
  classifyCredentialFailure,
  credentialPreflightMessage,
} from "../lib/credential_preflight.ts";
import { loadConfig } from "../lib/config.ts";
import { envFrom } from "./support/env_lookup.ts";

const REPO_ROOT = new URL(import.meta.url).pathname.replace(
  /\/worker\/deno\/tests\/[^/]+$/,
  "",
);

const MANIFEST: ContainerManifest = parseContainerManifest(
  await Deno.readTextFile(`${REPO_ROOT}/container/tools.json`),
);

/** Every registered provider, in registration order. */
const ALL_PROVIDERS: AgentProviderDescriptor[] = agentProviderIds().map(
  resolveAgentProvider,
);

/** Launch inputs for a fixed set of host paths. */
function launchInputs(
  providers: readonly AgentProviderDescriptor[],
): ContainerLaunchInputs {
  const candidate = CONTAINER_RUNTIMES.docker;
  const descriptor: ContainerRuntimeDescriptor = {
    platform: "linux",
    kind: "docker",
    executable: candidate.executable,
    displayName: candidate.displayName,
    dialect: candidate.dialect,
    probed: ["docker"],
  };
  return {
    descriptor,
    manifest: MANIFEST,
    image: "vibe-coder:0123456789ab",
    containerName: "vibe-coder-4108",
    watchdogSeconds: 11_400,
    hostPaths: {
      homeDir: "/home/operator",
      baseDir: "/opt/VibeCoder",
      workDir: "/home/operator/auto-issue-work",
      logDir: "/home/operator/logs",
      configFile: "/opt/VibeCoder/.config.json",
      configStageDir: "/home/operator/.vibe-coder/run-config",
      credentialDir: "/home/operator/.vibe-coder/credentials",
    },
    agentProviders: providers,
  };
}

/**
 * Provision a credential directory holding `providers`' material, then run
 * `fn` against it.
 */
async function withCredentialDir(
  providers: readonly AgentProviderDescriptor[],
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  const dir = `${root}/credentials`;
  await Deno.mkdir(`${dir}/gh`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/gh/hosts.yml`,
    "github.com:\n    oauth_token: gho_worker\n    git_protocol: ssh\n",
  );
  if (Deno.build.os !== "windows") {
    await Deno.chmod(`${dir}/gh/hosts.yml`, 0o600);
  }

  for (const provider of providers) {
    const { subdir, file, envVars } = provider.credentials;
    await Deno.mkdir(`${dir}/${subdir}`, { recursive: true });
    const path = `${dir}/${subdir}/${file}`;
    await Deno.writeTextFile(path, `${envVars[0]}=secret-for-${provider.id}\n`);
    if (Deno.build.os !== "windows") await Deno.chmod(path, 0o600);
  }

  try {
    await fn(dir);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// The enabled provider set
// ---------------------------------------------------------------------------

Deno.test("resolveEnabledAgentProviderIds - defaults to the active provider alone", () => {
  setConfiguredEnabledAgentProviderIds(undefined);
  assertEquals(resolveEnabledAgentProviderIds({ env: envFrom() }), [
    CLAUDE_PROVIDER_ID,
  ]);
  // The descriptor form the preflight and the launcher consume.
  assertEquals(
    enabledAgentProviders({ env: envFrom() }).map((provider) => provider.id),
    [CLAUDE_PROVIDER_ID],
  );
});

Deno.test("resolveEnabledAgentProviderIds - configuration enables a multi-vendor set", () => {
  const ids = agentProviderIds();
  assertEquals(
    resolveEnabledAgentProviderIds({
      env: envFrom(),
      configuredProviders: ids,
    }),
    ids,
  );
});

Deno.test("resolveEnabledAgentProviderIds - configuration overrides the environment", () => {
  // This asserted the opposite until the one-source-of-truth milestone
  // inverted the precedence (Issue #1032): `.config.json` is now the answer
  // and the variable is the deprecated fallback, so a host cannot quietly run
  // a different provider set than its configuration states.
  const ids = agentProviderIds();
  assertEquals(
    resolveEnabledAgentProviderIds({
      env: envFrom({ [ENABLED_AGENT_PROVIDERS_ENV]: ` ${ids.join(" , ")} ` }),
      configuredProviders: [CLAUDE_PROVIDER_ID],
    }),
    [CLAUDE_PROVIDER_ID],
  );
});

Deno.test("resolveEnabledAgentProviderIds - the environment still answers when nothing is configured", () => {
  // The variable is deprecated, not removed: a deployment that has not moved
  // its setting into `.config.json` keeps working, and is warned rather than
  // silently reset to the active provider alone.
  const ids = agentProviderIds();
  assertEquals(
    resolveEnabledAgentProviderIds({
      env: envFrom({ [ENABLED_AGENT_PROVIDERS_ENV]: ` ${ids.join(" , ")} ` }),
    }),
    ids,
  );
});

Deno.test("resolveEnabledAgentProviderIds - an unusable set fails loudly", () => {
  const unknown = assertThrows(
    () =>
      resolveEnabledAgentProviderIds({
        env: envFrom(),
        configuredProviders: [CLAUDE_PROVIDER_ID, "aider"],
      }),
    Error,
  );
  assert(unknown.message.includes("aider"), unknown.message);
  assert(
    unknown.message.includes(CLAUDE_PROVIDER_ID),
    "the failure names the supported ids",
  );

  assertThrows(
    () =>
      resolveEnabledAgentProviderIds({
        env: envFrom(),
        configuredProviders: [CLAUDE_PROVIDER_ID, CLAUDE_PROVIDER_ID],
      }),
    Error,
    "twice",
  );

  assertThrows(
    () =>
      resolveEnabledAgentProviderIds({
        env: envFrom(),
        configuredProviders: [],
      }),
    Error,
    "no coding-agent provider",
  );
});

Deno.test("resolveEnabledAgentProviderIds - a set excluding the active provider fails loudly", () => {
  const other = ALL_PROVIDERS.find((p) => p.id !== CLAUDE_PROVIDER_ID);
  assert(other, "a second provider is registered");
  const error = assertThrows(
    () =>
      resolveEnabledAgentProviderIds({
        env: envFrom(),
        configured: CLAUDE_PROVIDER_ID,
        configuredProviders: [other.id],
      }),
    Error,
  );
  assert(error.message.includes(CLAUDE_PROVIDER_ID), error.message);
  assert(
    error.message.includes(ENABLED_AGENT_PROVIDERS_CONFIG_KEY),
    "the failure names the configuration key that fixes it",
  );
});

Deno.test("loadConfig - the enabled set comes from .config.json (Issue #962)", async () => {
  const dir = await Deno.makeTempDir();
  // The image stamp has to be the one this test states rather than whatever
  // the host carries: inside the container image the stamp is "claude" alone,
  // and the multi-provider set below would fail the installed-provider check
  // for reasons that have nothing to do with what is under test. Stated
  // through the injected lookup, which answers only from its own map — a load
  // that read `Deno.env.get` would be judged against the host's stamp.
  const imageEnv = envFrom({
    [IMAGE_AGENT_PROVIDERS_ENV]: agentProviderIds().join(","),
  });
  try {
    const path = `${dir}/.config.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        allowed_authors: ["operator"],
        repos: ["owner/repo"],
        [ENABLED_AGENT_PROVIDERS_CONFIG_KEY]: agentProviderIds(),
      }),
    );
    const config = await loadConfig(path, { env: imageEnv });
    assertEquals(config.enabledAgentProviders, agentProviderIds());

    // Default configuration is unchanged: Claude alone.
    const plain = `${dir}/plain.json`;
    await Deno.writeTextFile(
      plain,
      JSON.stringify({ allowed_authors: ["operator"], repos: ["owner/repo"] }),
    );
    assertEquals(
      (await loadConfig(plain, { env: imageEnv })).enabledAgentProviders,
      [CLAUDE_PROVIDER_ID],
    );
  } finally {
    setConfiguredEnabledAgentProviderIds(undefined);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadConfig - the image stamp is read through the injected lookup (Issue #962)", async () => {
  // The stamp decides which agents this image will run at all, so a load that
  // read it from the wrong environment would either refuse a provider the
  // image carries or accept one it does not. `codex` alone is a stamp the
  // suite's own process does not hold, so only the injected map can supply it.
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/.config.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        allowed_authors: ["operator"],
        repos: ["owner/repo"],
        [ENABLED_AGENT_PROVIDERS_CONFIG_KEY]: [CLAUDE_PROVIDER_ID],
      }),
    );
    const error = await assertRejects(
      () =>
        loadConfig(path, {
          env: envFrom({ [IMAGE_AGENT_PROVIDERS_ENV]: "codex" }),
        }),
      Error,
    );
    assert(error.message.includes(CLAUDE_PROVIDER_ID), error.message);
    assert(error.message.includes("codex"), error.message);
  } finally {
    setConfiguredEnabledAgentProviderIds(undefined);
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Mounts — exactly the enabled providers, and nothing else
// ---------------------------------------------------------------------------

Deno.test("buildContainerLaunchPlan - mounts exactly the enabled providers' credential directories", () => {
  const targets = containerTargetPaths(MANIFEST);
  const credentials = "/home/operator/.vibe-coder/credentials";
  const plan = buildContainerLaunchPlan(launchInputs(ALL_PROVIDERS));

  const credentialMounts = plan.mounts.filter((mount) =>
    mount.source.startsWith(`${credentials}/`)
  );
  assertEquals(
    credentialMounts.map((mount) => mount.source),
    ["gh", ...ALL_PROVIDERS.map((p) => p.credentials.subdir)].map((subdir) =>
      `${credentials}/${subdir}`
    ),
  );
  assertEquals(
    credentialMounts.map((mount) => mount.target),
    ["gh", ...ALL_PROVIDERS.map((p) => p.credentials.subdir)].map((subdir) =>
      `${targets.credentials}/${subdir}`
    ),
  );
  // Every credential mount is read-only — a vendor's key cannot be rewritten
  // from inside the container.
  assertEquals(
    credentialMounts.every((mount) => mount.readOnly === true),
    true,
  );
});

Deno.test("buildContainerLaunchPlan - a disabled provider's directory is never mounted", () => {
  const enabled = ALL_PROVIDERS[0]!;
  const disabled = ALL_PROVIDERS.filter((p) => p.id !== enabled.id);
  assert(disabled.length > 0, "more than one provider is registered");

  const plan = buildContainerLaunchPlan(launchInputs([enabled]));
  const sources = plan.mounts.map((mount) => mount.source);
  const rendered = plan.runArgs.join(" ");

  for (const provider of disabled) {
    const path =
      `/home/operator/.vibe-coder/credentials/${provider.credentials.subdir}`;
    assertEquals(
      sources.includes(path),
      false,
      `${provider.id} is not enabled, so ${path} must not be mounted`,
    );
    assertEquals(
      rendered.includes(path),
      false,
      `${provider.id} must not appear in the run arguments`,
    );
  }
});

// ---------------------------------------------------------------------------
// Preflight — per-provider status, still fail-loud on anything else
// ---------------------------------------------------------------------------

Deno.test("checkCredentialPreflight - accepts a multi-provider credential directory", async () => {
  await withCredentialDir(ALL_PROVIDERS, async (dir) => {
    const result = await checkCredentialPreflight({
      dir,
      env: envFrom(),
      providers: ALL_PROVIDERS,
    });
    assertEquals(result.failures, [], credentialPreflightMessage(result));
    assertEquals(result.ok, true);
    assertEquals(
      result.providers.map((p) => [p.id, p.source]),
      ALL_PROVIDERS.map((p) => [p.id, "directory"]),
    );
    // The message reports each vendor separately.
    const message = credentialPreflightMessage(result);
    for (const provider of ALL_PROVIDERS) {
      assert(
        message.includes(`${provider.id}=directory`),
        `${provider.id} status is reported: ${message}`,
      );
    }
  });
});

Deno.test("checkCredentialPreflight - a multi-provider directory still rejects unrelated material", async () => {
  await withCredentialDir(ALL_PROVIDERS, async (dir) => {
    await Deno.writeTextFile(`${dir}/aws-secret-key`, "AKIA...\n");
    const result = await checkCredentialPreflight({
      dir,
      env: envFrom(),
      providers: ALL_PROVIDERS,
    });
    assertEquals(result.ok, false);
    const unexpected = result.failures.filter(
      (f) => f.code === "unexpected-credential-material",
    );
    assertEquals(unexpected.length, 1);
    assert(unexpected[0]?.path?.endsWith("aws-secret-key"));
  });
});

Deno.test("checkCredentialPreflight - a disabled provider's directory is unrelated material", async () => {
  // The default enabled set is the active provider alone, so another vendor's
  // material sitting beside it is reported rather than silently accepted.
  const [active, ...rest] = ALL_PROVIDERS;
  assert(active && rest.length > 0);
  await withCredentialDir(ALL_PROVIDERS, async (dir) => {
    const result = await checkCredentialPreflight({
      dir,
      env: envFrom(),
      providers: [active],
    });
    assertEquals(
      result.failures.filter((f) => f.code === "unexpected-credential-material")
        .length,
      rest.length,
    );
    assertEquals(allowedCredentialEntries([active]), [
      "gh",
      active.credentials.subdir,
    ]);
  });
});

Deno.test("checkCredentialPreflight - a missing credential names the provider that lacks it", async () => {
  const [first, second] = ALL_PROVIDERS;
  assert(first && second, "at least two providers are registered");

  // Only the first provider's material is provisioned; both are enabled.
  await withCredentialDir([first], async (dir) => {
    const result = await checkCredentialPreflight({
      dir,
      env: envFrom(),
      providers: [first, second],
    });
    assertEquals(result.ok, false);

    const missing = result.failures.filter(
      (f) => f.code === "provider-credentials-missing",
    );
    assertEquals(missing.length, 1);
    const failure = missing[0]!;
    assertEquals(failure.provider, second.id);
    assert(
      failure.message.includes(second.displayName),
      `the failure names the provider: ${failure.message}`,
    );
    assert(
      failure.message.includes(second.credentials.provisionEnvVar),
      `the failure names the variable that provisions it: ${failure.message}`,
    );
    assert(
      !failure.message.includes(first.displayName),
      "the provisioned provider is not implicated",
    );
    // The failure is classified against the provider it names, not the
    // active one.
    assertEquals(classifyCredentialFailure(failure), "provider-auth");

    assertEquals(
      result.providers.map((p) => [p.id, p.source]),
      [[first.id, "directory"], [second.id, null]],
    );
  });
});

Deno.test("checkCredentialPreflight - an environment fallback satisfies one provider only", async () => {
  const [first, second] = ALL_PROVIDERS;
  assert(first && second);
  const root = await Deno.makeTempDir();
  try {
    const result = await checkCredentialPreflight({
      dir: `${root}/absent`,
      env: envFrom({
        GH_TOKEN: "gho_env",
        [second.credentials.envVars[0]!]: "secret",
      }),
      providers: [first, second],
    });
    assertEquals(result.ok, false);
    assertEquals(
      result.providers.map((p) => p.source),
      [null, "environment"],
    );
    assertEquals(
      result.failures.filter((f) => f.code === "provider-credentials-missing")
        .map((f) => f.provider),
      [first.id],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// No vendor sees another vendor's secret
// ---------------------------------------------------------------------------

Deno.test("provider child environments carry only their own vendor's secret", () => {
  // A parent environment holding every vendor's credential at once — the
  // shape a multi-provider run has.
  const parentEnv: Record<string, string> = { GH_TOKEN: "gho_worker" };
  for (const provider of ALL_PROVIDERS) {
    for (const name of provider.credentials.envVars) {
      parentEnv[name] = `secret-for-${provider.id}`;
    }
  }

  for (const provider of ALL_PROVIDERS) {
    const childEnv = provider.buildChildEnv(parentEnv);

    // Its own credential survives — the CLI cannot authenticate without it.
    for (const name of provider.credentials.envVars) {
      assertEquals(
        childEnv[name],
        `secret-for-${provider.id}`,
        `${provider.id} keeps its own ${name}`,
      );
    }

    // Every other vendor's does not — asserted by VALUE rather than by
    // variable name (Issue #414). A provider carried on another vendor's CLI
    // legitimately sets that CLI's variable from its own key: DeepSeek runs
    // the Anthropic binary, so its child holds `ANTHROPIC_AUTH_TOKEN` — with
    // DeepSeek's secret in it. What must never appear, under any name, is
    // another vendor's secret.
    const owners = new Map(
      ALL_PROVIDERS.map((p) => [`secret-for-${p.id}`, p.id]),
    );
    for (const [name, value] of Object.entries(childEnv)) {
      const owner = owners.get(value);
      if (owner === undefined) continue;
      assertEquals(
        owner,
        provider.id,
        `${provider.id} must not carry ${owner}'s secret in ${name}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// setup.sh provisions from the descriptors, not from a Claude-only branch
// ---------------------------------------------------------------------------

Deno.test("setup.sh - the provider credential table matches the registered descriptors", async () => {
  const setupPath = new URL("../../../setup.sh", import.meta.url).pathname;
  const command = new Deno.Command("bash", {
    args: [
      "-c",
      `set -euo pipefail\nsource "${setupPath}"\nvibe_provider_credential_table`,
    ],
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
    stdin: "null",
  });
  const { code, stdout, stderr } = await command.output();
  const output = new TextDecoder().decode(stdout);
  assertEquals(code, 0, new TextDecoder().decode(stderr));

  const rows = output.split("\n").filter((line) => line.trim() !== "").map(
    (line) => line.split("|"),
  );

  // Every registered descriptor must be provisionable (Issue #416):
  // registering a provider without a table row fails here, rather than
  // failing its credential preflight at first run on a live deployment.
  const bySubdir = new Map(rows.map((row) => [row[0], row]));
  for (const provider of ALL_PROVIDERS) {
    const row = bySubdir.get(provider.credentials.subdir);
    assert(
      row,
      `setup.sh offers no credential directory for ${provider.id}`,
    );
    assertEquals(
      row[1],
      provider.credentials.provisionEnvVar,
      `${provider.id} provisions from the descriptor's provisioning variable`,
    );
    assertEquals(
      row[2],
      provider.credentials.envVars.join(","),
      `${provider.id} lists the descriptor's credential variables`,
    );
  }

  // The reverse direction is deliberately looser: a row may land before its
  // descriptor is registered, so a provider is provisionable from the first
  // deployment that enables it. Such a row still has to be well formed —
  // a typo must not sit in the table waiting for a descriptor to meet it.
  assertEquals(
    rows.length,
    bySubdir.size,
    "no provider is listed twice",
  );
  for (const row of rows) {
    assertEquals(row.length, 3, `malformed row: ${row.join("|")}`);
    assert(/^[a-z][a-z0-9-]*$/.test(row[0]!), `bad sub-directory: ${row[0]}`);
    assert(
      /^VIBE_LAUNCHAGENT_[A-Z0-9]+_API_KEY$/.test(row[1]!),
      `bad provisioning variable: ${row[1]}`,
    );
    assert(
      row[2]!.split(",").every((name) => /^[A-Z][A-Z0-9_]*$/.test(name)),
      `bad credential variables: ${row[2]}`,
    );
  }
});
