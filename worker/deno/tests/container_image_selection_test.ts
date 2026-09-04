/**
 * The deployment's selections reach every caller that names the image
 * (Issues #743, #749).
 *
 * `container_tools` (#73) and the enabled `agent_providers` set (#729) are both
 * baked into the worker image and both hashed into its tag. The launcher passed
 * them; setup's worker-image check and the tabletop runner passed neither, so a
 * host that selected either was told its built image was missing — and told to
 * build it with `./run.sh`, which builds the tag it already had.
 *
 * Each case builds a checkout fixture (the real `container/` inputs beside a
 * `.config.json`), derives the launcher's own answer from the launcher's own
 * two readers, and asserts the other callers name that same reference. The
 * tags are asserted to *differ* between the three configurations as well:
 * agreement alone would also hold if every selection were ignored, which is
 * precisely the defect.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { readConfiguredAgentProviderSet } from "../lib/agent_provider_config.ts";
import { readContainerExtensionSelection } from "../lib/container_extension_config.ts";
import {
  CONTAINER_IMAGE_INPUTS,
  resolveContainerImageReference,
} from "../lib/container_image_hash.ts";
import { readDeploymentImageSelection } from "../lib/container_image_selection.ts";
import { parseContainerManifest } from "../lib/container_manifest.ts";
import { readContainerToolsSelection } from "../lib/container_tools_config.ts";
import { resolveTabletopImage } from "../lib/tabletop_container_runner.ts";
import { checkContainerPrerequisites } from "../setup/prerequisites.ts";
import type { PrerequisiteOptions } from "../setup/prerequisites.ts";
import type { EnvLookup } from "../lib/env_lookup.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/** A `container_tools` selection that changes what the image contains. */
const TOOLS_SELECTION = [
  {
    id: "java",
    version: "21.0.5+11",
    url: {
      amd64: "https://example.com/jdk-x64.tar.gz",
      arm64: "https://example.com/jdk-aarch64.tar.gz",
    },
    sha256: { amd64: "a".repeat(64), arm64: "b".repeat(64) },
    stripComponents: 1,
    bin: ["bin"],
  },
];

/**
 * A checkout fixture: the real container inputs, plus the given configuration.
 *
 * The hash enumerates files under `container/`, so a fixture that copies them
 * hashes exactly as the real checkout does while letting each case state its
 * own `.config.json`.
 */
async function checkout(
  config: Record<string, unknown> | null,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "vibe-image-selection-" });
  for (const input of CONTAINER_IMAGE_INPUTS) {
    const target = `${root}/${input}`;
    await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.copyFile(`${REPO_ROOT}/${input}`, target);
  }
  if (config !== null) {
    await Deno.writeTextFile(
      `${root}/.config.json`,
      JSON.stringify(config, null, 2),
    );
  }
  return root;
}

/**
 * The reference the launcher resolves for this checkout.
 *
 * Derived the way `commands/container_launch_plan.ts` derives it — its own two
 * readers, then `resolveContainerImageReference` — so the expectation is
 * independent of the reader under test.
 */
async function launcherImage(root: string): Promise<string> {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(`${root}/container/tools.json`),
  );
  const { tools } = await readContainerToolsSelection(`${root}/.config.json`);
  const { buildValue } = await readConfiguredAgentProviderSet(
    `${root}/.config.json`,
    manifest.installedProviders,
    HOST_ENV,
  );
  const containerExtension = await readContainerExtensionSelection(
    `${root}/.config.json`,
  );
  return await resolveContainerImageReference(root, {
    containerTools: tools,
    ...(buildValue ? { agentProviders: buildValue } : {}),
    ...(containerExtension ? { containerExtension } : {}),
  });
}

/**
 * The environment every caller below is driven with (Issue #962).
 *
 * Deliberately empty. Two families of variable would otherwise decide the
 * answer instead of the fixture: `CONFIG_FILE` / `CONFIG_PATH`, which name a
 * different configuration file, and `VIBE_AGENT_PROVIDER` /
 * `VIBE_IMAGE_AGENT_PROVIDERS`, which override or constrain the provider set
 * the suite itself runs under. Every one of them reads as absent here, so a
 * caller that fell back to `Deno.env.get` would be answered by the host
 * rather than by this map — and the tags below would stop agreeing.
 */
const HOST_ENV = emptyEnv;

/** Setup's container check against a host whose image is already built. */
function prerequisiteOptions(
  root: string,
  env: EnvLookup = HOST_ENV,
): PrerequisiteOptions {
  return {
    os: "linux",
    repoRoot: root,
    env,
    containerProbe: (candidate) =>
      Promise.resolve(
        candidate.kind === "docker"
          ? { available: true, path: candidate.executable }
          : { available: false, reason: "not this host's runtime" },
      ),
    runCommand: () =>
      Promise.resolve({ success: true, stdout: "[]", stderr: "" }),
  };
}

/** The image reference setup's worker-image result names. */
async function setupImage(
  root: string,
  env: EnvLookup = HOST_ENV,
): Promise<string> {
  const results = await checkContainerPrerequisites(
    prerequisiteOptions(root, env),
  );
  const image = results.find((result) => result.tool === "worker image");
  assert(image, "the container check must report a worker image result");
  const match = image.message.match(/vibe-coder:[0-9a-f]+/);
  assert(match, `no image reference in: ${image.message}`);
  return match[0];
}

/** A throwaway extension directory, as an operator would sync one (#979). */
async function extensionDirectory(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "vibe-image-extension-" });
  await Deno.writeTextFile(`${root}/Containerfile`, "FROM vibe-coder:base\n");
  await Deno.mkdir(`${root}/seed`);
  await Deno.writeTextFile(
    `${root}/seed/schema.sql`,
    "CREATE TABLE jobs (id int);\n",
  );
  return root;
}

/** The four configurations, and the tag each must produce everywhere. */
function configurations(
  extension: string,
): Array<{ name: string; config: Record<string, unknown> }> {
  return [
    { name: "no selections", config: {} },
    {
      name: "a container_tools selection",
      config: { container_tools: TOOLS_SELECTION },
    },
    {
      name: "a non-default agent_providers set",
      config: { agent_providers: ["codex"], agent_provider: "codex" },
    },
    {
      name: "a container_extension declaration",
      config: { container_extension: { path: extension } },
    },
  ];
}

Deno.test("every caller names the image the launcher builds (Issues #743, #749)", async () => {
  for (const { name, config } of CONFIGURATIONS) {
    const root = await checkout(config);
    try {
      const expected = await launcherImage(root);
      assertEquals(await setupImage(root), expected, `setup: ${name}`);
      assertEquals(
        await resolveTabletopImage({ repoRoot: root, env: HOST_ENV }),
        expected,
        `tabletop: ${name}`,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("the tag changes with the selection, for every caller (Issue #749)", async () => {
  const setup: string[] = [];
  const tabletop: string[] = [];
  for (const { config } of CONFIGURATIONS) {
    const root = await checkout(config);
    try {
      setup.push(await setupImage(root));
      tabletop.push(
        await resolveTabletopImage({ repoRoot: root, env: HOST_ENV }),
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
  // Three distinct configurations, three distinct tags — agreement on one
  // tag for all three would be the defect wearing a passing test.
  assertEquals(new Set(setup).size, CONFIGURATIONS.length, setup.join(" "));
  assertEquals(
    new Set(tabletop).size,
    CONFIGURATIONS.length,
    tabletop.join(" "),
  );
});

Deno.test("a checkout with no configuration selects nothing (Issues #743, #749)", async () => {
  const root = await checkout(null);
  try {
    const selection = await readDeploymentImageSelection({
      repoRoot: root,
      env: HOST_ENV,
    });
    assertEquals(selection.tools, []);
    assertEquals(selection.agentProviders, undefined);
    assertEquals(
      await setupImage(root),
      await resolveContainerImageReference(root, {}),
      "an unconfigured checkout keeps the reference it had before",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("an explicit tabletop --image still wins (Issue #743)", async () => {
  const root = await checkout({
    agent_providers: ["codex"],
    agent_provider: "codex",
  });
  try {
    assertEquals(
      await resolveTabletopImage({
        repoRoot: root,
        image: " vibe-coder:cafe ",
        env: HOST_ENV,
      }),
      "vibe-coder:cafe",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the deployment's selections are read through the injected environment (Issue #962)", async () => {
  // Every case above states an *empty* environment, which is what the host
  // running the suite most likely holds anyway — so on its own it would not
  // tell an injected lookup apart from a fallback to `Deno.env.get`. These
  // two do: each states a value the real environment does not carry, and
  // asserts the tag moved because of it.
  const root = await checkout({});
  try {
    const plain = await setupImage(root);

    // 1. The provider set. `VIBE_AGENT_PROVIDERS` overrides the file, so the
    //    image the deployment names has to change with it.
    const codexEnv = envFrom({
      VIBE_AGENT_PROVIDER: "codex",
      VIBE_AGENT_PROVIDERS: "codex",
    });
    const codex = await resolveContainerImageReference(
      root,
      (await readDeploymentImageSelection({ repoRoot: root, env: codexEnv }))
        .options,
    );
    assertNotEquals(
      codex,
      plain,
      "a provider set stated through the lookup must move the tag",
    );

    // 2. The configuration path. `CONFIG_FILE` names a different file, and
    //    this one selects a tool — so the tag moves again, and differently.
    const elsewhere = `${root}/elsewhere.json`;
    await Deno.writeTextFile(
      elsewhere,
      JSON.stringify({ container_tools: TOOLS_SELECTION }),
    );
    const toolsEnv = envFrom({ CONFIG_FILE: elsewhere });
    const tools = await resolveContainerImageReference(
      root,
      (await readDeploymentImageSelection({ repoRoot: root, env: toolsEnv }))
        .options,
    );
    assertNotEquals(
      tools,
      plain,
      "a configuration path stated through the lookup must be the one read",
    );
    assertNotEquals(tools, codex);

    // And setup names the same image the launcher does for each, which is the
    // whole point of the one reader: the seam did not split them apart.
    assertEquals(
      await setupImage(root, codexEnv),
      codex,
      "setup follows the same lookup the launcher does",
    );
    assertEquals(await setupImage(root, toolsEnv), tools);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a malformed selection fails loud rather than naming another tag (Issue #743)", async () => {
  const root = await checkout({ container_tools: [{ id: "no-version" }] });
  try {
    const results = await checkContainerPrerequisites(
      prerequisiteOptions(root),
    );
    const image = results.find((result) => result.tool === "worker image");
    assert(image, "the container check must report a worker image result");
    assertEquals(image.ok, false);
    assertStringIncludes(image.message, "not buildable");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
