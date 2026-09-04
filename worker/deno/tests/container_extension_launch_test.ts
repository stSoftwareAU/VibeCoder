/**
 * Tests for container_extension_launch.ts — the launch path's extension
 * resolution (Issue #982, parent #933).
 *
 * The launcher reaches the extension through exactly one function, so these
 * cases drive that function against throwaway fixture directories and then
 * feed what it returns to the real plan builder. A preflight fault must abort
 * before the plan — and therefore before the build arguments — exists at all:
 * a preflight that were written but never called would fail here even though
 * `container_extension_preflight_test.ts` still passed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { resolveContainerExtensionLaunch } from "../lib/container_extension_launch.ts";
import {
  buildContainerLaunchPlan,
  type ContainerLaunchPlan,
} from "../lib/container_launch.ts";
import {
  CONTAINER_RUNTIMES,
  type ContainerRuntimeDescriptor,
} from "../lib/container_runtime.ts";
import {
  type ContainerManifest,
  parseContainerManifest,
} from "../lib/container_manifest.ts";
import { resolveContainerImageReference } from "../lib/container_image_hash.ts";
import { envFrom } from "./support/env_lookup.ts";

const REPO_ROOT = new URL(import.meta.url).pathname.replace(
  /\/worker\/deno\/tests\/[^/]+$/,
  "",
);

/** The repository's real manifest — the source of the in-container layout. */
const MANIFEST: ContainerManifest = parseContainerManifest(
  await Deno.readTextFile(`${REPO_ROOT}/container/tools.json`),
);

/** The environment the launcher reads: a home directory and nothing else. */
const ENV = envFrom({ HOME: "/home/operator" });

/** One throwaway deployment: an extension directory and a `.config.json`. */
interface Fixture {
  /** The extension directory the declaration points at. */
  root: string;
  /** The configuration file the launcher reads the declaration from. */
  configFile: string;
  /** Remove everything the fixture created. */
  cleanup: () => Promise<void>;
}

/** Write a file inside the extension, creating its parent directories. */
async function write(
  root: string,
  relative: string,
  contents: string,
): Promise<void> {
  const path = `${root}/${relative}`;
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, contents);
}

/**
 * A deployment declaring an extension, with a complete definition on disk.
 *
 * @param declaration - The `container_extension` block, minus its `path`
 * @returns The fixture, which the caller breaks in whatever way it is testing
 */
async function fixture(
  declaration: Record<string, unknown> = {},
): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "vibe-ext-launch-" });
  const home = await Deno.makeTempDir({ prefix: "vibe-ext-config-" });
  await write(
    root,
    "Containerfile",
    "ARG VIBE_BASE_IMAGE\nFROM ${VIBE_BASE_IMAGE}\nRUN id\n",
  );
  await write(root, "start.sh", "#!/bin/sh\nservice postgres start\n");
  const configFile = `${home}/.config.json`;
  await Deno.writeTextFile(
    configFile,
    JSON.stringify({ container_extension: { path: root, ...declaration } }),
  );
  return {
    root,
    configFile,
    cleanup: async () => {
      // A case that removed the extension directory itself still cleans up
      // the rest, rather than failing the test on its own tidying.
      for (const path of [root, home]) {
        try {
          await Deno.remove(path, { recursive: true });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
    },
  };
}

/** Resolve the extension for a fixture, exactly as the launcher does. */
function resolve(configFile: string) {
  return resolveContainerExtensionLaunch({
    baseDir: REPO_ROOT,
    configFile,
    imageOptions: {},
    env: ENV,
  });
}

/** The Docker descriptor the plan builder is driven with. */
function descriptor(): ContainerRuntimeDescriptor {
  const candidate = CONTAINER_RUNTIMES.docker;
  return {
    platform: "linux",
    kind: "docker",
    executable: candidate.executable,
    displayName: candidate.displayName,
    dialect: candidate.dialect,
    probed: ["docker"],
  };
}

/**
 * The launch plan for one deployment, resolved and built the way the
 * `container-launch-plan` command builds it.
 *
 * @param configFile - The deployment's configuration file
 * @returns The plan, including any extension build arguments
 * @throws Whatever the extension resolution throws — before a plan exists
 */
async function planFor(configFile: string): Promise<ContainerLaunchPlan> {
  const extension = await resolve(configFile);
  return buildContainerLaunchPlan({
    descriptor: descriptor(),
    manifest: MANIFEST,
    image: "vibe-coder:0123456789ab",
    containerName: "vibe-coder-982",
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
    ...(extension ? { containerExtension: extension } : {}),
  });
}

/** The message a call threw, or `""` when it did not throw. */
async function messageFrom(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}

Deno.test("resolveContainerExtensionLaunch - a complete definition resolves the layered tag", async () => {
  const deployment = await fixture({ start: "start.sh" });
  try {
    const extension = await resolve(deployment.configFile);
    assert(extension, "a configured extension resolved to nothing");
    assertEquals(extension.spec.path, deployment.root);
    assertEquals(extension.spec.start, "start.sh");
    assertStringIncludes(extension.containerfileText, "ARG VIBE_BASE_IMAGE");

    // The layered tag covers the extension digest, so it is never the
    // standard image's tag (Issue #979).
    const standard = await resolveContainerImageReference(REPO_ROOT, {});
    assert(
      extension.image !== standard,
      "the layered image reused the standard tag",
    );
    assertEquals(extension.image.startsWith("vibe-coder:"), true);
  } finally {
    await deployment.cleanup();
  }
});

Deno.test("resolveContainerExtensionLaunch - no declaration resolves to nothing", async () => {
  const home = await Deno.makeTempDir({ prefix: "vibe-ext-config-" });
  try {
    const configFile = `${home}/.config.json`;
    await Deno.writeTextFile(configFile, JSON.stringify({ repos: [] }));
    assertEquals(await resolve(configFile), undefined);

    // And the plan is what an unconfigured deployment has always had.
    assertEquals((await planFor(configFile)).extensionBuildArgs, []);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("resolveContainerExtensionLaunch - an absent directory aborts before any build argument", async () => {
  const deployment = await fixture();
  try {
    await Deno.remove(deployment.root, { recursive: true });
    const message = await messageFrom(() => planFor(deployment.configFile));
    assert(message !== "", "an absent extension directory reached a plan");
    assertStringIncludes(message, deployment.root);
    assertStringIncludes(message, "does not exist");
  } finally {
    await deployment.cleanup();
  }
});

Deno.test("resolveContainerExtensionLaunch - a missing Containerfile aborts before any build argument", async () => {
  const deployment = await fixture();
  try {
    await Deno.remove(`${deployment.root}/Containerfile`);
    const message = await messageFrom(() => planFor(deployment.configFile));
    assertStringIncludes(message, `${deployment.root}/Containerfile`);
    assertStringIncludes(message, "container_extension.containerfile");
  } finally {
    await deployment.cleanup();
  }
});

Deno.test("resolveContainerExtensionLaunch - a missing start script aborts before any build argument", async () => {
  const deployment = await fixture({ start: "start.sh" });
  try {
    await Deno.remove(`${deployment.root}/start.sh`);
    const message = await messageFrom(() => planFor(deployment.configFile));
    assertStringIncludes(message, `${deployment.root}/start.sh`);
    assertStringIncludes(message, "container_extension.start");
  } finally {
    await deployment.cleanup();
  }
});

Deno.test("resolveContainerExtensionLaunch - an escaping symlink is heard as the preflight, not the digest", async () => {
  const deployment = await fixture();
  const outside = await Deno.makeTempDir({ prefix: "vibe-outside-" });
  try {
    await Deno.writeTextFile(`${outside}/secret.env`, "TOKEN=hunter2\n");
    await Deno.symlink(`${outside}/secret.env`, `${deployment.root}/link.env`);

    const message = await messageFrom(() => planFor(deployment.configFile));
    assertStringIncludes(message, "escapes the extension directory");
    // The preflight runs before the digest, so the operator gets the remedy
    // rather than a hashing failure.
    assertStringIncludes(message, "Copy what the build needs");
  } finally {
    await deployment.cleanup();
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("resolveContainerExtensionLaunch - a malformed declaration still names the field", async () => {
  const home = await Deno.makeTempDir({ prefix: "vibe-ext-config-" });
  try {
    const configFile = `${home}/.config.json`;
    await Deno.writeTextFile(
      configFile,
      JSON.stringify({ container_extension: { path: "relative/extension" } }),
    );
    const message = await messageFrom(() => resolve(configFile));
    assertStringIncludes(message, "container_extension.path");
    assertStringIncludes(message, "absolute host path");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("resolveContainerExtensionLaunch - a resolved extension becomes the plan's second build", async () => {
  const deployment = await fixture({ start: "start.sh" });
  try {
    const extension = await resolve(deployment.configFile);
    assert(extension, "a configured extension resolved to nothing");
    const plan = await planFor(deployment.configFile);

    assertEquals(plan.extensionBuildArgs[0], "build");
    assertEquals(
      plan.extensionBuildArgs.includes(`${deployment.root}/Containerfile`),
      true,
      "the extension build does not read the operator's Containerfile",
    );
    assertEquals(plan.extensionBuildArgs.at(-1), deployment.root);
    assertEquals(plan.runArgs.at(-1), extension.image);
  } finally {
    await deployment.cleanup();
  }
});
