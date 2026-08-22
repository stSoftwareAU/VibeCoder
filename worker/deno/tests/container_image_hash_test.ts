/**
 * Tests for container_image_hash.ts and the container-image-hash command —
 * content-derived identity for the Vibe Coder container image (Issue #4062).
 *
 * Every test builds a throwaway repository layout, calls the real hashing
 * functions, and asserts on the reference they return, so the three ways
 * content-derived identity silently breaks are all covered: the hash going
 * unstable, stopping responding to a definition change, or starting to
 * respond to unrelated workspace changes.
 *
 * The deployer-selected `container_tools` spec is part of that identity too
 * (Issue #73, parent #5), so the same three failures are covered for it: the
 * no-tools tag must not churn (or the whole fleet rebuilds), two different
 * selections must not collide (or one host's cached image silently satisfies
 * another's), and a malformed spec must fail loud rather than quietly hash a
 * different selection.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  canonicalContainerToolsSpec,
  computeContainerImageHash,
  CONTAINER_IMAGE_INPUTS,
  CONTAINER_IMAGE_NAME,
  CONTAINER_TOOLS_HASH_INPUT,
  resolveContainerImageReference,
} from "../lib/container_image_hash.ts";
import { parseContainerManifest } from "../lib/container_manifest.ts";
import {
  containerImageHashCommand,
  resolveConfigFile,
} from "../commands/container_image_hash.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/** Write a file, creating its parent directories. */
async function writeInput(
  root: string,
  relative: string,
  contents: string,
): Promise<void> {
  const path = `${root}/${relative}`;
  const parent = path.slice(0, path.lastIndexOf("/"));
  await Deno.mkdir(parent, { recursive: true });
  await Deno.writeTextFile(path, contents);
}

/**
 * Create a temporary repository root carrying every enumerated input, plus
 * workspace content that is deliberately not part of the definition.
 */
async function fakeRepo(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "vibe-image-hash-" });
  for (const relative of CONTAINER_IMAGE_INPUTS) {
    await writeInput(root, relative, `contents of ${relative}\n`);
  }
  await writeInput(root, "docs/NOTES.md", "unrelated documentation\n");
  await writeInput(root, "worker/deno/mod.ts", "// unrelated source\n");
  return root;
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** A valid `container_tools` entry, cloned per case so nothing is shared. */
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
    env: { JAVA_HOME: "" },
  };
}

/** A second valid entry, so a two-tool selection can be expressed. */
function mavenSpec(): Record<string, unknown> {
  return {
    id: "maven",
    version: "3.9.9",
    url: { noarch: "https://example.com/maven.tar.gz" },
    sha256: { noarch: SHA_B },
    stripComponents: 1,
    bin: ["bin"],
  };
}

/**
 * The hashing algorithm as it stood **before** Issue #73 — the enumerated
 * files, each framed by path and byte length, and nothing else.
 *
 * The no-tools case must keep producing exactly this digest, or every host in
 * the fleet rebuilds on upgrade. Written out here rather than pinned as a
 * literal so it stays valid as `CONTAINER_IMAGE_INPUTS` grows.
 */
async function preIssue73Hash(root: string): Promise<string> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const relative of CONTAINER_IMAGE_INPUTS) {
    const bytes = await Deno.readFile(`${root}/${relative}`);
    parts.push(encoder.encode(`${relative}\0${bytes.length}\0`));
    parts.push(bytes);
    parts.push(encoder.encode("\n"));
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    buffer.set(part, offset);
    offset += part.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Stability
// ---------------------------------------------------------------------------

Deno.test("computeContainerImageHash - is stable across repeated calls", async () => {
  const root = await fakeRepo();
  try {
    const first = await computeContainerImageHash(root);
    const second = await computeContainerImageHash(root);
    const third = await computeContainerImageHash(root);

    assertEquals(first, second);
    assertEquals(second, third);
    assert(/^[0-9a-f]{64}$/.test(first), `not a sha256 digest: ${first}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveContainerImageReference - returns vibe-coder:<short hash>", async () => {
  const root = await fakeRepo();
  try {
    const reference = await resolveContainerImageReference(root);
    const hash = await computeContainerImageHash(root);

    assert(
      /^vibe-coder:[0-9a-f]{12}$/.test(reference),
      `unexpected reference: ${reference}`,
    );
    assertEquals(reference, `${CONTAINER_IMAGE_NAME}:${hash.slice(0, 12)}`);
    assertEquals(reference, await resolveContainerImageReference(root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Responds to every enumerated input
// ---------------------------------------------------------------------------

Deno.test("computeContainerImageHash - changing any enumerated input changes the hash", async () => {
  const root = await fakeRepo();
  try {
    const baseline = await computeContainerImageHash(root);
    const seen = new Set<string>([baseline]);

    for (const relative of CONTAINER_IMAGE_INPUTS) {
      const original = await Deno.readTextFile(`${root}/${relative}`);
      await Deno.writeTextFile(`${root}/${relative}`, `${original}// edited\n`);

      const changed = await computeContainerImageHash(root);
      assert(
        changed !== baseline,
        `editing ${relative} left the hash unchanged`,
      );
      assert(
        !seen.has(changed),
        `editing ${relative} collided with a prior hash`,
      );
      seen.add(changed);

      await Deno.writeTextFile(`${root}/${relative}`, original);
      assertEquals(await computeContainerImageHash(root), baseline);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerImageHash - swapping contents between inputs changes the hash", async () => {
  const root = await fakeRepo();
  try {
    const [first, second] = [
      CONTAINER_IMAGE_INPUTS[0]!,
      CONTAINER_IMAGE_INPUTS[1]!,
    ];
    const baseline = await computeContainerImageHash(root);

    const a = await Deno.readTextFile(`${root}/${first}`);
    const b = await Deno.readTextFile(`${root}/${second}`);
    await Deno.writeTextFile(`${root}/${first}`, b);
    await Deno.writeTextFile(`${root}/${second}`, a);

    assert(
      await computeContainerImageHash(root) !== baseline,
      "the hash ignores which input each byte came from",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Ignores unenumerated workspace content
// ---------------------------------------------------------------------------

Deno.test("computeContainerImageHash - unenumerated workspace files do not change the hash", async () => {
  const root = await fakeRepo();
  try {
    const baseline = await computeContainerImageHash(root);

    await writeInput(root, "docs/NOTES.md", "documentation rewritten\n");
    await writeInput(root, "worker/deno/mod.ts", "// source rewritten\n");
    await writeInput(root, "container/README.md", "a note beside the image\n");
    await writeInput(root, "docs/deep/nested/file.txt", "nested\n");

    assertEquals(await computeContainerImageHash(root), baseline);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Missing input fails loud
// ---------------------------------------------------------------------------

Deno.test("computeContainerImageHash - a missing input fails loud, naming the path", async () => {
  for (const relative of CONTAINER_IMAGE_INPUTS) {
    const root = await fakeRepo();
    try {
      await Deno.remove(`${root}/${relative}`);

      let message = "";
      try {
        await computeContainerImageHash(root);
      } catch (error) {
        message = (error as Error).message;
      }

      assert(message !== "", `removing ${relative} did not throw`);
      assertStringIncludes(message, relative);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

// ---------------------------------------------------------------------------
// The selected tool spec is part of the image's identity (Issue #73)
// ---------------------------------------------------------------------------

Deno.test("computeContainerImageHash - no selected tools keeps the pre-#73 tag", async () => {
  const root = await fakeRepo();
  try {
    const legacy = await preIssue73Hash(root);

    assertEquals(await computeContainerImageHash(root), legacy);
    assertEquals(await computeContainerImageHash(root, {}), legacy);
    assertEquals(
      await computeContainerImageHash(root, { containerTools: undefined }),
      legacy,
    );
    assertEquals(
      await computeContainerImageHash(root, { containerTools: null }),
      legacy,
    );
    assertEquals(
      await computeContainerImageHash(root, { containerTools: [] }),
      legacy,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerImageHash - different tool sets give different tags", async () => {
  const root = await fakeRepo();
  try {
    const none = await resolveContainerImageReference(root);
    const java = await resolveContainerImageReference(root, {
      containerTools: [javaSpec()],
    });
    const both = await resolveContainerImageReference(root, {
      containerTools: [javaSpec(), mavenSpec()],
    });
    const maven = await resolveContainerImageReference(root, {
      containerTools: [mavenSpec()],
    });

    assertEquals(new Set([none, java, both, maven]).size, 4);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerImageHash - re-ordering keys keeps the tag", async () => {
  const root = await fakeRepo();
  try {
    const written = javaSpec();
    // The same selection, typed in a different order — including inside the
    // architecture blocks — must not churn the tag.
    const reordered: Record<string, unknown> = {
      env: { JAVA_HOME: "" },
      bin: ["bin"],
      stripComponents: 1,
      sha256: { arm64: SHA_B, amd64: SHA_A },
      url: {
        arm64: "https://example.com/jdk-aarch64.tar.gz",
        amd64: "https://example.com/jdk-x64.tar.gz",
      },
      version: "21.0.5+11",
      id: "java",
    };

    assertEquals(
      await resolveContainerImageReference(root, {
        containerTools: [reordered],
      }),
      await resolveContainerImageReference(root, { containerTools: [written] }),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerImageHash - a version, url or digest change moves the tag", async () => {
  const root = await fakeRepo();
  try {
    const baseline = await resolveContainerImageReference(root, {
      containerTools: [javaSpec()],
    });

    const bumped = { ...javaSpec(), version: "21.0.6+7" };
    const redirected = {
      ...javaSpec(),
      url: {
        amd64: "https://example.com/jdk-x64-2.tar.gz",
        arm64: "https://example.com/jdk-aarch64.tar.gz",
      },
    };
    const redigested = {
      ...javaSpec(),
      sha256: { amd64: SHA_B, arm64: SHA_B },
    };

    for (
      const [label, spec] of Object.entries({ bumped, redirected, redigested })
    ) {
      assert(
        await resolveContainerImageReference(root, {
          containerTools: [spec],
        }) !== baseline,
        `a ${label} spec left the image tag unchanged`,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerImageHash - re-ordering the tool array moves the tag", async () => {
  const root = await fakeRepo();
  try {
    // Entry order decides PATH order inside the image, so it is a real
    // difference in what the image contains.
    assert(
      await resolveContainerImageReference(root, {
        containerTools: [javaSpec(), mavenSpec()],
      }) !==
        await resolveContainerImageReference(root, {
          containerTools: [mavenSpec(), javaSpec()],
        }),
      "the tool array's order does not change the image tag",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerImageHash - a malformed spec fails loud, naming the field", async () => {
  const root = await fakeRepo();
  try {
    const malformed = { ...javaSpec(), sha256: { amd64: "not-a-digest" } };

    let message = "";
    try {
      await computeContainerImageHash(root, { containerTools: [malformed] });
    } catch (error) {
      message = (error as Error).message;
    }

    assert(message !== "", "a malformed spec did not throw");
    assertStringIncludes(message, "sha256.amd64");
    assertStringIncludes(message, "java");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("canonicalContainerToolsSpec - is key-sorted, whitespace-free and resolved", async () => {
  assertEquals(canonicalContainerToolsSpec(undefined), "");
  assertEquals(canonicalContainerToolsSpec([]), "");

  const canonical = canonicalContainerToolsSpec([mavenSpec()]);
  assert(
    !/\s/.test(canonical),
    `canonical form carries whitespace: ${canonical}`,
  );
  // Keys sorted, and the validator's defaults (here `env`) filled in.
  assertEquals(
    canonical,
    '[{"bin":["bin"],"env":{},"id":"maven","sha256":{"noarch":"' + SHA_B +
      '"},"stripComponents":1,"url":{"noarch":"https://example.com/maven.tar.gz"},"version":"3.9.9"}]',
  );
  // An upper-case digest is the same selection, so the same canonical form.
  assertEquals(
    canonicalContainerToolsSpec([
      { ...mavenSpec(), sha256: { noarch: SHA_B.toUpperCase() } },
    ]),
    canonical,
  );
  // Already-validated specs round-trip unchanged.
  assertEquals(canonicalContainerToolsSpec(JSON.parse(canonical)), canonical);
});

// ---------------------------------------------------------------------------
// The committed definition
// ---------------------------------------------------------------------------

Deno.test("container/ - the committed definition yields a reference", async () => {
  const reference = await resolveContainerImageReference(REPO_ROOT);
  assert(
    /^vibe-coder:[0-9a-f]{12}$/.test(reference),
    `unexpected reference: ${reference}`,
  );
});

Deno.test("container/ - every committed container file is enumerated", async () => {
  const enumerated = new Set(CONTAINER_IMAGE_INPUTS);
  for (const dir of ["container", "container/providers"]) {
    for await (const entry of Deno.readDir(`${REPO_ROOT}/${dir}`)) {
      if (!entry.isFile) continue;
      assert(
        enumerated.has(`${dir}/${entry.name}`),
        `${dir}/${entry.name} is not in CONTAINER_IMAGE_INPUTS — add it so ` +
          `the image tag responds to it`,
      );
    }
  }
});

Deno.test("container/ - every pinned provider fragment is enumerated", async () => {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(`${REPO_ROOT}/container/tools.json`),
  );
  const enumerated = new Set(CONTAINER_IMAGE_INPUTS);

  assert(
    manifest.providers.length > 0,
    "container/tools.json must pin at least one provider",
  );
  for (const provider of manifest.providers) {
    assert(
      enumerated.has(`container/${provider.fragment}`),
      `container/${provider.fragment} is not in CONTAINER_IMAGE_INPUTS — a ` +
        `changed fragment must change the image tag`,
    );
  }
});

// The provider set is part of the image's identity (Issues #4062, #4105):
// building a different set under the same tag would run an image whose
// contents differ from the one the tag names.
Deno.test("computeContainerImageHash - changing the installed provider set changes the tag", async () => {
  const root = await fakeRepo();
  try {
    const definition = `${root}/container/Containerfile`;
    await Deno.writeTextFile(definition, 'ARG AGENT_PROVIDERS="claude"\n');
    const single = await resolveContainerImageReference(root);

    await Deno.writeTextFile(
      definition,
      'ARG AGENT_PROVIDERS="claude,codex,gemini"\n',
    );
    const quorum = await resolveContainerImageReference(root);

    assert(
      single !== quorum,
      `the provider set does not change the image tag (${single})`,
    );

    await Deno.writeTextFile(definition, 'ARG AGENT_PROVIDERS="claude"\n');
    assertEquals(await resolveContainerImageReference(root), single);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("container/ - the committed definition installs the manifest's provider set", async () => {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(`${REPO_ROOT}/container/tools.json`),
  );
  const containerfile = await Deno.readTextFile(
    `${REPO_ROOT}/container/Containerfile`,
  );

  assert(
    manifest.installedProviders.length > 0,
    "container/tools.json must record the provider set the image installs",
  );
  assertStringIncludes(
    containerfile,
    `ARG AGENT_PROVIDERS="${manifest.installedProviders.join(",")}"`,
  );
});

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * Arguments for a command run against a throwaway repository.
 *
 * `--config` is always explicit: the command falls back to `CONFIG_PATH`, and
 * the worker's own container sets it, so leaving it out would hash whichever
 * deployment happens to be running the suite. Points at a path inside the fake
 * repo, so a case that writes no configuration selects no tools.
 */
function commandArgs(root: string): Record<string, unknown> {
  return { "base-dir": root, config: `${root}/.config.json` };
}

/** Write a `.config.json` carrying the given `container_tools` value. */
async function writeConfig(root: string, containerTools: unknown) {
  await Deno.writeTextFile(
    `${root}/.config.json`,
    JSON.stringify(
      { repos: ["stSoftwareAU/VibeCoder"], container_tools: containerTools },
      null,
      2,
    ),
  );
}

Deno.test("container-image-hash - prints the reference for the given base dir", async () => {
  const root = await fakeRepo();
  try {
    const result = await containerImageHashCommand.execute(
      commandArgs(root),
      buildDefaultWorkerConfig(),
    );

    assertEquals(result.success, true);
    assertEquals(result.message, await resolveContainerImageReference(root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("container-image-hash - reports the hash and inputs as data", async () => {
  const root = await fakeRepo();
  try {
    const result = await containerImageHashCommand.execute(
      commandArgs(root),
      buildDefaultWorkerConfig(),
    );

    const data = result.data as {
      image: string;
      hash: string;
      inputs: string[];
      configFile: string;
      containerTools: string[];
    };
    assertEquals(data.image, result.message);
    assertEquals(data.hash, await computeContainerImageHash(root));
    assertEquals(data.inputs, [...CONTAINER_IMAGE_INPUTS]);
    assertEquals(data.configFile, `${root}/.config.json`);
    assertEquals(data.containerTools, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// run.sh and run.ps1 rebuild from this command's output alone, so the spec has
// to be visible there — both in the tag and in the reported inputs (Issue #73).
Deno.test("container-image-hash - reports the selected tool spec as an input", async () => {
  const root = await fakeRepo();
  try {
    await writeConfig(root, [javaSpec()]);

    const result = await containerImageHashCommand.execute(
      commandArgs(root),
      buildDefaultWorkerConfig(),
    );

    const data = result.data as {
      image: string;
      inputs: string[];
      containerTools: string[];
    };
    assertEquals(result.success, true);
    assertEquals(
      data.inputs,
      [...CONTAINER_IMAGE_INPUTS, CONTAINER_TOOLS_HASH_INPUT],
    );
    assertEquals(data.containerTools, ["java"]);
    assertEquals(
      data.image,
      await resolveContainerImageReference(root, {
        containerTools: [javaSpec()],
      }),
    );
    assert(
      data.image !== await resolveContainerImageReference(root),
      "the selected tools do not change the reference the command prints",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("container-image-hash - a changed tool version changes the printed reference", async () => {
  const root = await fakeRepo();
  try {
    await writeConfig(root, [javaSpec()]);
    const before = await containerImageHashCommand.execute(
      commandArgs(root),
      buildDefaultWorkerConfig(),
    );

    await writeConfig(root, [{ ...javaSpec(), version: "21.0.6+7" }]);
    const after = await containerImageHashCommand.execute(
      commandArgs(root),
      buildDefaultWorkerConfig(),
    );

    assertEquals(before.success, true);
    assertEquals(after.success, true);
    assert(
      before.message !== after.message,
      `a version bump left the reference at ${before.message}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("container-image-hash - a malformed spec fails the command, naming the field", async () => {
  const root = await fakeRepo();
  try {
    await writeConfig(root, [{ ...javaSpec(), version: 21 }]);

    const result = await containerImageHashCommand.execute(
      commandArgs(root),
      buildDefaultWorkerConfig(),
    );

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "version");
    assertStringIncludes(result.message, "java");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("container-image-hash - an absent config selects no tools", async () => {
  const root = await fakeRepo();
  try {
    const result = await containerImageHashCommand.execute(
      { "base-dir": root, config: `${root}/nowhere/.config.json` },
      buildDefaultWorkerConfig(),
    );

    assertEquals(result.success, true);
    assertEquals(result.message, await resolveContainerImageReference(root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("container-image-hash - a missing input fails the command, naming the path", async () => {
  const root = await fakeRepo();
  try {
    await Deno.remove(`${root}/container/tools.json`);

    const result = await containerImageHashCommand.execute(
      commandArgs(root),
      buildDefaultWorkerConfig(),
    );

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "container/tools.json");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveConfigFile - --config wins, then CONFIG_PATH, then the checkout", () => {
  const env = (name: string) =>
    name === "CONFIG_PATH" ? "/etc/vibe/.config.json" : undefined;

  assertEquals(
    resolveConfigFile("/repo", { config: "/tmp/other.json" }, env),
    "/tmp/other.json",
  );
  assertEquals(resolveConfigFile("/repo", {}, env), "/etc/vibe/.config.json");
  assertEquals(
    resolveConfigFile("/repo/", {}, () => undefined),
    "/repo/.config.json",
  );
  // A relative CONFIG_PATH resolves against the checkout, as the launcher does.
  assertEquals(
    resolveConfigFile("/repo", {}, () => "config/.config.json"),
    "/repo/config/.config.json",
  );
});

Deno.test("container-image-hash - is registered in the worker command registry", async () => {
  const { createDefaultRegistry } = await import("../mod.ts");
  const registry = createDefaultRegistry();
  assert(
    registry.has("container-image-hash"),
    "container-image-hash is not registered in mod.ts",
  );
});
