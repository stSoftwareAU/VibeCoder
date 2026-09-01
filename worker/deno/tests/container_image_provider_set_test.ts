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

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

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
