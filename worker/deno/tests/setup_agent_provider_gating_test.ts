/**
 * Setup asks for the credentials the configured providers need — and only
 * those (Issue #730, part of #722).
 *
 * The reported fault: a Codex-only `.config.json` still had to satisfy a
 * host-fatal `claude` prerequisite and still got the Claude OAuth prompt, so
 * setup stopped before writing `.config.json` and the operator fell back to
 * `VIBE_SKIP_PREREQ_CHECK=true`.
 *
 * These tests call the real resolution and probe functions with real inputs:
 * the selection is read from a real configuration file, and the probe is
 * driven with a host where `claude` is genuinely absent.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  readConfiguredAgentProviders,
  resolveSetupAgentProviderIds,
} from "../setup/agent_providers.ts";
import {
  checkAllPrerequisites,
  checkClaudeCli,
  type PrerequisiteOptions,
  probedAgentProviders,
} from "../setup/prerequisites.ts";
import { prerequisiteSummaryLines } from "../setup/setup_cli.ts";
import {
  AGENT_PROVIDER_ENV,
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  IMAGE_AGENT_PROVIDERS_ENV,
} from "../lib/agent_provider.ts";
import type { ContainerRuntimeProbe } from "../lib/container_runtime.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

/** Write a `.config.json` holding `config` and return its path. */
async function configFile(
  dir: string,
  config: Record<string, unknown>,
): Promise<string> {
  const path = `${dir}/.config.json`;
  await Deno.writeTextFile(path, JSON.stringify(config));
  return path;
}

/** A container-runtime probe where only Docker answers. */
const dockerProbe: ContainerRuntimeProbe = (candidate) =>
  Promise.resolve(
    candidate.kind === "docker"
      ? { available: true, path: candidate.executable }
      : { available: false, reason: "not found" },
  );

/**
 * A host carrying exactly `tools` — a container-ready Linux box otherwise.
 */
function hostWith(
  tools: string[],
  agentProviders?: readonly string[],
): PrerequisiteOptions {
  return {
    os: "linux",
    repoRoot: REPO_ROOT,
    containerProbe: dockerProbe,
    ...(agentProviders === undefined ? {} : { agentProviders }),
    runCommand: (cmd: string[]) => {
      if (cmd[0] === "docker" && cmd[1] === "image" && cmd[2] === "inspect") {
        return Promise.resolve({ success: true, stdout: "[]", stderr: "" });
      }
      if (cmd[0] === "gh" && cmd[1] === "auth") {
        return Promise.resolve({
          success: tools.includes("gh"),
          stdout: "Logged in",
          stderr: "",
        });
      }
      if (cmd[0] === "gh" && cmd[1] === "api") {
        return Promise.resolve({
          success: tools.includes("gh"),
          stdout: "worker",
          stderr: "",
        });
      }
      const available = tools.includes(cmd[0]!);
      return Promise.resolve({
        success: available,
        stdout: available ? `${cmd[0]} 1.0.0` : "",
        stderr: available ? "" : "command not found",
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The selection setup works from
// ---------------------------------------------------------------------------

Deno.test("resolveSetupAgentProviderIds - a Codex-only configuration selects Codex alone", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = await configFile(dir, {
      repos: ["owner/repo"],
      agent_provider: CODEX_PROVIDER_ID,
    });
    assertEquals(await resolveSetupAgentProviderIds(path), [CODEX_PROVIDER_ID]);
    assertEquals(await readConfiguredAgentProviders(path), {
      active: CODEX_PROVIDER_ID,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveSetupAgentProviderIds - a two-provider configuration selects both", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = await configFile(dir, {
      agent_provider: CLAUDE_PROVIDER_ID,
      agent_providers: [CLAUDE_PROVIDER_ID, CODEX_PROVIDER_ID],
    });
    assertEquals(await resolveSetupAgentProviderIds(path), [
      CLAUDE_PROVIDER_ID,
      CODEX_PROVIDER_ID,
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveSetupAgentProviderIds - no configuration yet resolves to the default provider", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await resolveSetupAgentProviderIds(`${dir}/.config.json`), [
      CLAUDE_PROVIDER_ID,
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveSetupAgentProviderIds - VIBE_AGENT_PROVIDER selects the provider on a host with no configuration yet (Issue #962)", async () => {
  // The first ./setup.sh on a bare Codex host has no .config.json to read, so
  // the environment override is the only way to say "this host runs Codex"
  // before the file exists. It has to reach the probe, or that host is back
  // to a claude prerequisite it cannot satisfy.
  //
  // Stated through the injected lookup, which answers only from its own map:
  // a resolution that read `Deno.env.get` would see no override at all and
  // return the default provider, so Codex here is the seam's own answer.
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(
      await resolveSetupAgentProviderIds(
        `${dir}/.config.json`,
        envFrom({ [AGENT_PROVIDER_ENV]: CODEX_PROVIDER_ID }),
      ),
      [CODEX_PROVIDER_ID],
    );
    // The same bare host with nothing set resolves to the default, so the
    // case above cannot pass on a resolution that ignores the file and the
    // environment alike.
    assertEquals(
      await resolveSetupAgentProviderIds(`${dir}/.config.json`, emptyEnv),
      [CLAUDE_PROVIDER_ID],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveSetupAgentProviderIds - the image stamp never constrains setup (Issue #962)", async () => {
  // The stamp says what the *currently built* image carries; setup runs on the
  // host to configure what the next build will install. Hiding it is what lets
  // a host whose existing image predates the choice configure Codex at all —
  // and it can only be asserted now that the lookup underneath is stateable.
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(
      await resolveSetupAgentProviderIds(
        await configFile(dir, { agent_provider: CODEX_PROVIDER_ID }),
        envFrom({ [IMAGE_AGENT_PROVIDERS_ENV]: CLAUDE_PROVIDER_ID }),
      ),
      [CODEX_PROVIDER_ID],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkClaudeCli - a missing claude CLI says how to select another provider", async () => {
  const result = await checkClaudeCli(hostWith(["git", "gh", "deno"]));
  assertEquals(result.ok, false);
  assert(result.hint?.includes(AGENT_PROVIDER_ENV), result.hint);
  assert(result.hint?.includes("setup-token"), result.hint);
});

Deno.test("resolveSetupAgentProviderIds - a broken or unusable selection fails loudly", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const broken = `${dir}/broken.json`;
    await Deno.writeTextFile(broken, "{ not json");
    const jsonError = await assertRejects(
      () => resolveSetupAgentProviderIds(broken),
      Error,
    );
    assert(jsonError.message.includes(broken), jsonError.message);

    const unknown = await configFile(dir, { agent_provider: "aider" });
    const unknownError = await assertRejects(
      () => resolveSetupAgentProviderIds(unknown),
      Error,
    );
    assert(unknownError.message.includes("aider"), unknownError.message);

    const wrongType = `${dir}/wrong.json`;
    await Deno.writeTextFile(wrongType, JSON.stringify({ agent_providers: 7 }));
    await assertRejects(() => resolveSetupAgentProviderIds(wrongType), Error);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The prerequisite probe follows the selection
// ---------------------------------------------------------------------------

Deno.test("checkClaudeCli - a Codex-only host does not need the claude CLI", async () => {
  const result = await checkClaudeCli({
    ...hostWith(["git", "gh", "deno"], [CODEX_PROVIDER_ID]),
  });
  assertEquals(result.ok, true);
  assertEquals(result.informational, true);
  assert(
    result.message.includes(CODEX_PROVIDER_ID),
    `the message names the configured providers: ${result.message}`,
  );
});

Deno.test("checkAllPrerequisites - a Codex-only host with no claude CLI passes", async () => {
  // Report item 1 of Issue #722: this probe is what stopped setup before it
  // ever reached the configuration-writing stage.
  const result = await checkAllPrerequisites(
    hostWith(["git", "gh", "deno"], [CODEX_PROVIDER_ID]),
  );
  assertEquals(result.ok, true);

  const claude = result.results.find((r) => r.tool === "claude");
  assert(claude, "the probe still reports what it decided about claude");
  assertEquals(claude.ok, true);
  assertEquals(claude.informational, true);
});

Deno.test("checkAllPrerequisites - a Claude-only host still requires the claude CLI", async () => {
  const result = await checkAllPrerequisites(
    hostWith(["git", "gh", "deno"], [CLAUDE_PROVIDER_ID]),
  );
  assertEquals(result.ok, false);
  const claude = result.results.find((r) => r.tool === "claude");
  assertEquals(claude?.ok, false);
  assertEquals(claude?.informational, undefined);
});

Deno.test("checkAllPrerequisites - a two-provider host requires the claude CLI", async () => {
  const missing = await checkAllPrerequisites(
    hostWith(["git", "gh", "deno"], [CLAUDE_PROVIDER_ID, CODEX_PROVIDER_ID]),
  );
  assertEquals(missing.ok, false);

  const present = await checkAllPrerequisites(
    hostWith(["git", "gh", "deno", "claude"], [
      CLAUDE_PROVIDER_ID,
      CODEX_PROVIDER_ID,
    ]),
  );
  assertEquals(present.ok, true);
});

Deno.test("probedAgentProviders - an empty set is a fault, not a fallback to Claude", () => {
  // Omitting the option probes for the default provider (every pre-existing
  // caller); handing the probe an empty set means the resolution failed, and
  // guessing Claude there is the silent wrong answer.
  assertEquals(probedAgentProviders(), [CLAUDE_PROVIDER_ID]);
  assertEquals(probedAgentProviders({ agentProviders: [CODEX_PROVIDER_ID] }), [
    CODEX_PROVIDER_ID,
  ]);
  const error = assertThrows(
    () => probedAgentProviders({ agentProviders: [] }),
    Error,
  );
  assert(error.message.includes("empty"), error.message);
});

Deno.test("setup_cli agent-providers - prints the ids, and prints nothing at all for a broken selection", async () => {
  // The contract setup.sh depends on: ids on stdout, or a non-zero exit with
  // an empty stdout so the shell cannot read a guess.
  const dir = await Deno.makeTempDir();
  try {
    const cli = new URL("../setup/setup_cli.ts", import.meta.url).pathname;
    const run = async (config: string) => {
      const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-all",
          cli,
          "agent-providers",
          "--config-path",
          config,
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code,
        stdout: new TextDecoder().decode(stdout),
        stderr: new TextDecoder().decode(stderr),
      };
    };

    const good = await run(
      await configFile(dir, {
        agent_provider: CODEX_PROVIDER_ID,
      }),
    );
    assertEquals(good.code, 0, good.stderr);
    assertEquals(good.stdout.trim(), CODEX_PROVIDER_ID);

    const brokenPath = `${dir}/broken.json`;
    await Deno.writeTextFile(brokenPath, "{ not json");
    const broken = await run(brokenPath);
    assertEquals(broken.code, 1);
    assertEquals(broken.stdout, "");
    assert(broken.stderr.includes(brokenPath), broken.stderr);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("prerequisiteSummaryLines - names the claude CLI only when Claude is configured", () => {
  const claudeLines = prerequisiteSummaryLines(false, "container", [
    CLAUDE_PROVIDER_ID,
  ]).join(" ");
  assert(claudeLines.includes("claude CLI"), claudeLines);

  const codexLines = prerequisiteSummaryLines(false, "container", [
    CODEX_PROVIDER_ID,
  ]).join(" ");
  assert(!codexLines.includes("claude CLI"), codexLines);
  assert(codexLines.includes(CODEX_PROVIDER_ID), codexLines);
});
