/**
 * Tests for the deployment's image-tag selections (Issue #743).
 *
 * The image tag covers what this deployment selected, not just the committed
 * definition, so every caller that names the tag must read the same
 * `.config.json` the launcher reads. Two callers did not — setup's worker-image
 * check and the tabletop runner — and each named a tag `./run.sh` never builds.
 *
 * What is tested here is the outcome, not the plumbing: for a
 * tools-selecting and a provider-selecting configuration, both callers report
 * exactly the reference `container-image-hash` prints. Only the tool selection
 * joins the hash on this branch, so the provider cases pin agreement rather
 * than a tag that varies with the provider set.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  CONTAINER_IMAGE_INPUTS,
  resolveContainerImageReference,
} from "../lib/container_image_hash.ts";
import {
  readDeploymentImageSelection,
  resolveDeploymentConfigFile,
} from "../lib/container_image_selection.ts";
import { containerImageHashCommand } from "../commands/container_image_hash.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  checkContainerPrerequisites,
  type PrerequisiteOptions,
} from "../setup/prerequisites.ts";
import { resolveTabletopImage } from "../lib/tabletop_container_runner.ts";
import type { ContainerRuntimeProbe } from "../lib/container_runtime.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** A valid `container_tools` entry — one tool, fully specified. */
function javaSpec(): Record<string, unknown> {
  return {
    id: "java",
    version: "21.0.5+11",
    url: {
      amd64: "https://example.com/jdk-x64.tar.gz",
      arm64: "https://example.com/jdk-aarch64.tar.gz",
    },
    sha256: { amd64: SHA_A, arm64: SHA_B },
    stripComponents: 1,
    bin: ["bin"],
  };
}

/** A temporary checkout carrying every enumerated container-definition input. */
async function fakeRepo(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "vibe-image-selection-" });
  for (const relative of CONTAINER_IMAGE_INPUTS) {
    const path = `${root}/${relative}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, `contents of ${relative}\n`);
  }
  return root;
}

/** Write a `.config.json` into the checkout and return its path. */
async function writeConfig(
  root: string,
  config: Record<string, unknown>,
): Promise<string> {
  const path = `${root}/.config.json`;
  await Deno.writeTextFile(path, JSON.stringify(config, null, 2));
  return path;
}

/** A probe where only Docker answers. */
const dockerProbe: ContainerRuntimeProbe = (candidate) =>
  Promise.resolve(
    candidate.kind === "docker"
      ? { available: true, path: candidate.executable }
      : { available: false, reason: "not on PATH" },
  );

/** Setup options for a host with Docker and the image already built. */
function containerReadyOpts(
  root: string,
  configPath: string,
): PrerequisiteOptions {
  return {
    os: "linux",
    repoRoot: root,
    configPath,
    containerProbe: dockerProbe,
    runCommand: (_cmd: string[]) =>
      Promise.resolve({ success: true, stdout: "[]", stderr: "" }),
  };
}

/** The reference `container-image-hash` prints for this deployment. */
async function launcherImage(
  root: string,
  configPath: string,
): Promise<string> {
  const result = await containerImageHashCommand.execute(
    { "base-dir": root, config: configPath },
    buildDefaultWorkerConfig(),
  );
  assertEquals(result.success, true, result.message);
  return result.message;
}

/** The `worker image` result out of a prerequisite probe. */
function workerImageMessage(
  results: readonly { tool: string; message: string }[],
): string {
  const result = results.find((entry) => entry.tool === "worker image");
  assert(result, "no worker image result was reported");
  return result.message;
}

// ── The selection reader ────────────────────────────────────────────────

Deno.test("readDeploymentImageSelection - carries the selected tools", async () => {
  const root = await fakeRepo();
  try {
    const configPath = await writeConfig(root, {
      container_tools: [javaSpec()],
    });
    const selection = await readDeploymentImageSelection(configPath);
    assertEquals(
      await resolveContainerImageReference(root, selection),
      await resolveContainerImageReference(root, {
        containerTools: [javaSpec()],
      }),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readDeploymentImageSelection - an absent config selects nothing", async () => {
  const root = await fakeRepo();
  try {
    const selection = await readDeploymentImageSelection(
      `${root}/.config.json`,
    );
    assertEquals(
      await resolveContainerImageReference(root, selection),
      await resolveContainerImageReference(root),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readDeploymentImageSelection - a malformed selection fails loud", async () => {
  const root = await fakeRepo();
  try {
    const configPath = await writeConfig(root, { container_tools: [{}] });
    await assertRejects(
      () => readDeploymentImageSelection(configPath),
      Error,
      "container_tools",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveDeploymentConfigFile - the caller's own path wins over CONFIG_PATH", () => {
  const env = (name: string) =>
    name === "CONFIG_PATH" ? "/etc/vibe/.config.json" : undefined;
  assertEquals(
    resolveDeploymentConfigFile("/repo", "/tmp/other.json", env),
    "/tmp/other.json",
  );
  assertEquals(
    resolveDeploymentConfigFile("/repo", undefined, env),
    "/etc/vibe/.config.json",
  );
  // A relative path resolves against the checkout, as the launcher does.
  assertEquals(
    resolveDeploymentConfigFile(
      "/repo/",
      "config/.config.json",
      () => undefined,
    ),
    "/repo/config/.config.json",
  );
});

// ── Caller 1: setup's worker-image check ────────────────────────────────

Deno.test("checkContainerPrerequisites - names the tag the launcher builds for a tools-selecting host", async () => {
  const root = await fakeRepo();
  try {
    const configPath = await writeConfig(root, {
      container_tools: [javaSpec()],
    });
    const expected = await launcherImage(root, configPath);
    const results = await checkContainerPrerequisites(
      containerReadyOpts(root, configPath),
    );

    assertEquals(
      workerImageMessage(results),
      `Worker image ${expected} is built`,
    );
    // The regression: the tools-free tag is a different image entirely.
    assert(
      expected !== await resolveContainerImageReference(root),
      "the fixture must select tools that change the tag",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// `agent_providers` does not join the hash on this branch — the provider set
// is the Containerfile's own default, so the launcher's tag does not vary with
// it either. What these two cases pin is that the check and the launcher agree
// for such a host as well; they are where the assertion grows when the set
// becomes a hash input.

Deno.test("checkContainerPrerequisites - agrees with the launcher for a provider-selecting host", async () => {
  const root = await fakeRepo();
  try {
    const configPath = await writeConfig(root, {
      agent_providers: ["codex"],
      container_tools: [javaSpec()],
    });
    const expected = await launcherImage(root, configPath);
    const results = await checkContainerPrerequisites(
      containerReadyOpts(root, configPath),
    );

    assertEquals(
      workerImageMessage(results),
      `Worker image ${expected} is built`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkContainerPrerequisites - a malformed selection fails the image check loudly", async () => {
  const root = await fakeRepo();
  try {
    const configPath = await writeConfig(root, { container_tools: [{}] });
    const results = await checkContainerPrerequisites(
      containerReadyOpts(root, configPath),
    );
    const result = results.find((entry) => entry.tool === "worker image");
    assert(result, "no worker image result was reported");
    assertEquals(result.ok, false);
    assert(
      result.message.includes("container_tools"),
      `the cause is not named: ${result.message}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ── Caller 2: the tabletop runner ───────────────────────────────────────

Deno.test("resolveTabletopImage - names the tag the launcher builds for a tools-selecting host", async () => {
  const root = await fakeRepo();
  try {
    const configPath = await writeConfig(root, {
      container_tools: [javaSpec()],
    });
    assertEquals(
      await resolveTabletopImage({ repoRoot: root, configFile: configPath }),
      await launcherImage(root, configPath),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveTabletopImage - agrees with the launcher for a provider-selecting host", async () => {
  const root = await fakeRepo();
  try {
    const configPath = await writeConfig(root, {
      agent_providers: ["codex"],
      container_tools: [javaSpec()],
    });
    assertEquals(
      await resolveTabletopImage({ repoRoot: root, configFile: configPath }),
      await launcherImage(root, configPath),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveTabletopImage - an explicit --image override still wins", async () => {
  const root = await fakeRepo();
  try {
    const configPath = await writeConfig(root, {
      container_tools: [javaSpec()],
    });
    assertEquals(
      await resolveTabletopImage({
        repoRoot: root,
        configFile: configPath,
        image: "  vibe-coder:override  ",
      }),
      "vibe-coder:override",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
