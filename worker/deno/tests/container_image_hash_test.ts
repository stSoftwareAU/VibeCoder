/**
 * Tests for container_image_hash.ts and the container-image-hash command —
 * content-derived identity for the Vibe Coder container image (Issue #4062).
 *
 * Every test builds a throwaway repository layout, calls the real hashing
 * functions, and asserts on the reference they return, so the three ways
 * content-derived identity silently breaks are all covered: the hash going
 * unstable, stopping responding to a definition change, or starting to
 * respond to unrelated workspace changes.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  computeContainerImageHash,
  CONTAINER_IMAGE_INPUTS,
  CONTAINER_IMAGE_NAME,
  resolveContainerImageReference,
} from "../lib/container_image_hash.ts";
import { parseContainerManifest } from "../lib/container_manifest.ts";
import { containerImageHashCommand } from "../commands/container_image_hash.ts";
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

Deno.test("container-image-hash - prints the reference for the given base dir", async () => {
  const root = await fakeRepo();
  try {
    const result = await containerImageHashCommand.execute(
      { "base-dir": root },
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
      { "base-dir": root },
      buildDefaultWorkerConfig(),
    );

    const data = result.data as {
      image: string;
      hash: string;
      inputs: string[];
    };
    assertEquals(data.image, result.message);
    assertEquals(data.hash, await computeContainerImageHash(root));
    assertEquals(data.inputs, [...CONTAINER_IMAGE_INPUTS]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("container-image-hash - a missing input fails the command, naming the path", async () => {
  const root = await fakeRepo();
  try {
    await Deno.remove(`${root}/container/tools.json`);

    const result = await containerImageHashCommand.execute(
      { "base-dir": root },
      buildDefaultWorkerConfig(),
    );

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "container/tools.json");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("container-image-hash - is registered in the worker command registry", async () => {
  const { createDefaultRegistry } = await import("../mod.ts");
  const registry = createDefaultRegistry();
  assert(
    registry.has("container-image-hash"),
    "container-image-hash is not registered in mod.ts",
  );
});
