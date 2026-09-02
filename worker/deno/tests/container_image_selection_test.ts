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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { readConfiguredAgentProviderSet } from "../lib/agent_provider_config.ts";
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
import { withoutProviderEnv } from "./fixtures/provider_env.ts";

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
  );
  return await resolveContainerImageReference(root, {
    containerTools: tools,
    ...(buildValue ? { agentProviders: buildValue } : {}),
  });
}

/** Run `fn` with the host's own config-path variables cleared. */
async function withoutConfigEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = ["CONFIG_FILE", "CONFIG_PATH"].map(
    (name) => [name, Deno.env.get(name)] as const,
  );
  for (const [name] of saved) Deno.env.delete(name);
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value !== undefined) Deno.env.set(name, value);
    }
  }
}

/** Setup's container check against a host whose image is already built. */
function prerequisiteOptions(root: string): PrerequisiteOptions {
  return {
    os: "linux",
    repoRoot: root,
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
async function setupImage(root: string): Promise<string> {
  const results = await checkContainerPrerequisites(prerequisiteOptions(root));
  const image = results.find((result) => result.tool === "worker image");
  assert(image, "the container check must report a worker image result");
  const match = image.message.match(/vibe-coder:[0-9a-f]+/);
  assert(match, `no image reference in: ${image.message}`);
  return match[0];
}

/** The three configurations, and the tag each must produce everywhere. */
const CONFIGURATIONS: Array<{ name: string; config: Record<string, unknown> }> =
  [
    { name: "no selections", config: {} },
    {
      name: "a container_tools selection",
      config: { container_tools: TOOLS_SELECTION },
    },
    {
      name: "a non-default agent_providers set",
      config: { agent_providers: ["codex"], agent_provider: "codex" },
    },
  ];

Deno.test("every caller names the image the launcher builds (Issues #743, #749)", async () => {
  await withoutProviderEnv(async () => {
    await withoutConfigEnv(async () => {
      for (const { name, config } of CONFIGURATIONS) {
        const root = await checkout(config);
        try {
          const expected = await launcherImage(root);
          assertEquals(await setupImage(root), expected, `setup: ${name}`);
          assertEquals(
            await resolveTabletopImage({ repoRoot: root }),
            expected,
            `tabletop: ${name}`,
          );
        } finally {
          await Deno.remove(root, { recursive: true });
        }
      }
    });
  });
});

Deno.test("the tag changes with the selection, for every caller (Issue #749)", async () => {
  await withoutProviderEnv(async () => {
    await withoutConfigEnv(async () => {
      const setup: string[] = [];
      const tabletop: string[] = [];
      for (const { config } of CONFIGURATIONS) {
        const root = await checkout(config);
        try {
          setup.push(await setupImage(root));
          tabletop.push(await resolveTabletopImage({ repoRoot: root }));
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
  });
});

Deno.test("a checkout with no configuration selects nothing (Issues #743, #749)", async () => {
  await withoutProviderEnv(async () => {
    await withoutConfigEnv(async () => {
      const root = await checkout(null);
      try {
        const selection = await readDeploymentImageSelection({
          repoRoot: root,
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
  });
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
      }),
      "vibe-coder:cafe",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a malformed selection fails loud rather than naming another tag (Issue #743)", async () => {
  await withoutProviderEnv(async () => {
    await withoutConfigEnv(async () => {
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
  });
});
