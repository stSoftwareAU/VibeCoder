/**
 * Tests for threading the configured coding-agent providers into the image
 * build (Issue #729, report item 8 of #722).
 *
 * A `.config.json` selecting only Codex used to build a Claude image: the
 * launcher read the selection for credentials and mounts alone, so the build
 * always took the Containerfile's `AGENT_PROVIDERS="claude"` default. These
 * tests call the real derivation, the real plan builder and the real hashing
 * function, so a regression that drops the build argument — or lets two
 * provider sets share one image tag — fails here rather than as a
 * mysteriously-Claude image on a Codex host.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  AGENT_PROVIDERS_BUILD_ARG,
  agentProvidersBuildValue,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
import {
  buildContainerLaunchPlan,
  type ContainerLaunchInputs,
} from "../lib/container_launch.ts";
import {
  type ContainerManifest,
  parseContainerManifest,
} from "../lib/container_manifest.ts";
import {
  CONTAINER_IMAGE_INPUTS,
  resolveContainerImageReference,
} from "../lib/container_image_hash.ts";
import {
  CONTAINER_RUNTIMES,
  type ContainerRuntimeDescriptor,
} from "../lib/container_runtime.ts";
import { readConfiguredAgentProviderSet } from "../lib/agent_provider_config.ts";
import { emptyEnv } from "./support/env_lookup.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/**
 * The provider environment every resolution below is judged against
 * (Issue #944).
 *
 * The suite itself runs inside a worker image, which stamps
 * `VIBE_IMAGE_AGENT_PROVIDERS` and may carry the per-run `VIBE_AGENT_PROVIDER`
 * / `VIBE_AGENT_PROVIDERS` overrides, so a test asserting on a *configured*
 * set must not be judged against this process's own image. That used to mean
 * deleting the three variables and restoring them (`withoutProviderEnv`),
 * which raced every other test sharing the process; the resolver takes the
 * lookup as a parameter instead, so the same statement is made without
 * touching the process.
 */
const NO_PROVIDER_ENV = emptyEnv;

/** The repository's real manifest — the image default the build compares to. */
const MANIFEST: ContainerManifest = parseContainerManifest(
  await Deno.readTextFile(`${REPO_ROOT}/container/tools.json`),
);

/** The set a default image build installs, per `container/tools.json`. */
const IMAGE_DEFAULT = MANIFEST.installedProviders;

const DOCKER: ContainerRuntimeDescriptor = {
  platform: "linux",
  kind: "docker",
  executable: CONTAINER_RUNTIMES.docker.executable,
  displayName: CONTAINER_RUNTIMES.docker.displayName,
  dialect: CONTAINER_RUNTIMES.docker.dialect,
  probed: ["docker"],
};

function inputs(
  providers: readonly string[],
  overrides: Partial<ContainerLaunchInputs> = {},
): ContainerLaunchInputs {
  return {
    descriptor: DOCKER,
    manifest: MANIFEST,
    image: "vibe-coder:0123456789ab",
    containerName: "vibe-coder-4242",
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
    agentProviders: providers.map(resolveAgentProvider),
    ...overrides,
  };
}

/** The `AGENT_PROVIDERS=...` value a plan carries, or undefined when absent. */
function providerBuildArg(buildArgs: readonly string[]): string | undefined {
  const prefix = `${AGENT_PROVIDERS_BUILD_ARG}=`;
  const values = buildArgs.filter((arg) => arg.startsWith(prefix));
  assert(values.length <= 1, `expected one ${prefix} argument, got ${values}`);
  return values[0]?.slice(prefix.length);
}

// ---------------------------------------------------------------------------
// The build value derives from the enabled set, normalised once
// ---------------------------------------------------------------------------

Deno.test("agentProvidersBuildValue - the image default needs no build argument", () => {
  assertEquals(
    agentProvidersBuildValue(IMAGE_DEFAULT, IMAGE_DEFAULT),
    undefined,
  );
  // Spelling is normalised by the same parser the credential path uses, so a
  // padded id is still the default set.
  assertEquals(agentProvidersBuildValue([" claude "], ["claude"]), undefined);
});

Deno.test("agentProvidersBuildValue - a different set is passed comma-separated", () => {
  assertEquals(agentProvidersBuildValue(["codex"], ["claude"]), "codex");
  assertEquals(
    agentProvidersBuildValue(["claude", "codex", "gemini"], ["claude"]),
    "claude,codex,gemini",
  );
  // Order is part of the set: the fragments install in the order requested.
  assertEquals(
    agentProvidersBuildValue(["codex", "claude"], ["claude", "codex"]),
    "codex,claude",
  );
});

Deno.test("agentProvidersBuildValue - an unusable set fails loud", () => {
  for (
    const [set, expected] of [
      [[], "enable no provider"],
      [["codex", "codex"], "twice"],
      [[""], "not a lower-case provider id"],
      [["../escape"], "not a lower-case provider id"],
      [["Codex"], "not a lower-case provider id"],
    ] as const
  ) {
    let message = "";
    try {
      agentProvidersBuildValue(set, IMAGE_DEFAULT);
    } catch (error) {
      message = (error as Error).message;
    }
    assert(message !== "", `${JSON.stringify(set)} did not throw`);
    assertStringIncludes(message, expected);
  }
});

// ---------------------------------------------------------------------------
// The launcher reads the set the deployment configured (Issue #729)
// ---------------------------------------------------------------------------

/** Write a `.config.json` carrying a provider selection, and return its path. */
async function writeConfig(
  selection: Record<string, unknown>,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-provider-config-" });
  const path = `${dir}/.config.json`;
  await Deno.writeTextFile(
    path,
    JSON.stringify({ repos: ["stSoftwareAU/VibeCoder"], ...selection }),
  );
  return path;
}

Deno.test("readConfiguredAgentProviderSet - a Codex-only config resolves to a Codex build", async () => {
  const path = await writeConfig({
    agent_provider: "codex",
    agent_providers: ["codex"],
  });
  try {
    const set = await readConfiguredAgentProviderSet(
      path,
      IMAGE_DEFAULT,
      NO_PROVIDER_ENV,
    );

    // The mounts and the build follow one resolution, not two.
    assertEquals(set.providers.map((provider) => provider.id), ["codex"]);
    assertEquals(set.buildValue, "codex");
  } finally {
    await Deno.remove(path.slice(0, path.lastIndexOf("/")), {
      recursive: true,
    });
  }
});

Deno.test("readConfiguredAgentProviderSet - a Claude-only config needs no build argument", async () => {
  for (
    const selection of [
      { agent_provider: "claude", agent_providers: ["claude"] },
      // A deployment that configures nothing is the same default set.
      {},
    ]
  ) {
    const path = await writeConfig(selection);
    try {
      const set = await readConfiguredAgentProviderSet(
        path,
        IMAGE_DEFAULT,
        NO_PROVIDER_ENV,
      );

      assertEquals(set.providers.map((provider) => provider.id), ["claude"]);
      assertEquals(set.buildValue, undefined);
    } finally {
      await Deno.remove(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
    }
  }
});

Deno.test("readConfiguredAgentProviderSet - an unusable configuration fails loud", async () => {
  for (
    const [selection, expected] of [
      [{ agent_provider: "kimi" }, "Unsupported coding-agent provider"],
      [{ agent_providers: "codex" }, "must be an array of provider ids"],
      [{ agent_provider: 7 }, `"agent_provider" must be a string`],
      [
        { agent_provider: "claude", agent_providers: ["codex"] },
        "exclude the active provider",
      ],
    ] as const
  ) {
    const path = await writeConfig(selection as Record<string, unknown>);
    let message = "";
    try {
      await readConfiguredAgentProviderSet(
        path,
        IMAGE_DEFAULT,
        NO_PROVIDER_ENV,
      );
    } catch (error) {
      message = (error as Error).message;
    } finally {
      await Deno.remove(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
    }
    assertStringIncludes(message, expected);
  }
});

// ---------------------------------------------------------------------------
// The plan carries the set into the build (Issue #729)
// ---------------------------------------------------------------------------

Deno.test("buildContainerLaunchPlan - a Codex-only configuration builds a Codex image", () => {
  const plan = buildContainerLaunchPlan(inputs(["codex"]));

  assertEquals(providerBuildArg(plan.buildArgs), "codex");
  // Options precede the build context, which stays last.
  assertEquals(plan.buildArgs.at(-1), "/opt/VibeCoder/container");
  assertEquals(
    plan
      .buildArgs[
        plan.buildArgs.indexOf(`${AGENT_PROVIDERS_BUILD_ARG}=codex`) - 1
      ],
    "--build-arg",
  );
});

Deno.test("buildContainerLaunchPlan - a multi-provider configuration passes one build argument", () => {
  const plan = buildContainerLaunchPlan(
    inputs(["claude", "codex", "gemini", "deepseek"]),
  );

  assertEquals(
    providerBuildArg(plan.buildArgs),
    "claude,codex,gemini,deepseek",
  );
});

Deno.test("buildContainerLaunchPlan - a Claude-only configuration reproduces today's build arguments", () => {
  const plan = buildContainerLaunchPlan(inputs(["claude"]));

  assertEquals(plan.buildArgs, [
    "build",
    "--file",
    "/opt/VibeCoder/container/Containerfile",
    "--tag",
    "vibe-coder:0123456789ab",
    "/opt/VibeCoder/container",
  ]);
  assertEquals(providerBuildArg(plan.buildArgs), undefined);
});

// ---------------------------------------------------------------------------
// The set is part of the image's identity (Issue #729)
// ---------------------------------------------------------------------------

/** A throwaway repository root carrying every enumerated hash input. */
async function fakeRepo(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "vibe-provider-tag-" });
  for (const relative of CONTAINER_IMAGE_INPUTS) {
    const path = `${root}/${relative}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, `contents of ${relative}\n`);
  }
  return root;
}

Deno.test("resolveContainerImageReference - the image default keeps today's tag", async () => {
  const root = await fakeRepo();
  try {
    const today = await resolveContainerImageReference(root);

    assertEquals(
      await resolveContainerImageReference(root, { agentProviders: undefined }),
      today,
    );
    assertEquals(
      await resolveContainerImageReference(root, { agentProviders: "" }),
      today,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveContainerImageReference - a changed provider set changes the tag", async () => {
  const root = await fakeRepo();
  try {
    const tags = await Promise.all([
      resolveContainerImageReference(root),
      resolveContainerImageReference(root, { agentProviders: "codex" }),
      resolveContainerImageReference(root, { agentProviders: "claude,codex" }),
      resolveContainerImageReference(root, { agentProviders: "codex,claude" }),
    ]);

    // Four distinct sets, four distinct tags: no host switching providers can
    // silently reuse an image with the wrong agents baked in.
    assertEquals(new Set(tags).size, 4);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
