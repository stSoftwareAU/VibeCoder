/**
 * Tests for container_extension_preflight.ts — proving the declared extension
 * is actually on the host before a build spends minutes finding out
 * (Issue #982, parent #933).
 *
 * Every case drives the real preflight against a throwaway fixture directory
 * and asserts on what it throws, so each fault the operator can hit — an
 * absent directory, a file where a directory was declared, a missing
 * Containerfile, a missing start script, a symlink out of the tree — is
 * covered by its own case, and the happy path proves a complete definition is
 * not refused.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { preflightContainerExtension } from "../lib/container_extension_preflight.ts";
import type { ContainerExtensionSpec } from "../types.ts";

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

/** A throwaway extension directory carrying a complete definition. */
async function extensionDir(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "vibe-preflight-" });
  await write(
    root,
    "Containerfile",
    "ARG VIBE_BASE_IMAGE\nFROM $VIBE_BASE_IMAGE\n",
  );
  await write(root, "start.sh", "#!/bin/sh\nservice postgres start\n");
  await write(root, "seed/schema.sql", "CREATE TABLE jobs (id int);\n");
  return root;
}

/** The declaration for a directory, with the parser's own defaults. */
function spec(
  path: string,
  overrides: Partial<ContainerExtensionSpec> = {},
): ContainerExtensionSpec {
  return { path, containerfile: "Containerfile", ...overrides };
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

Deno.test("preflightContainerExtension - a complete definition passes", async () => {
  const root = await extensionDir();
  try {
    await preflightContainerExtension(spec(root, { start: "start.sh" }));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("preflightContainerExtension - a trailing separator is not a fault", async () => {
  const root = await extensionDir();
  try {
    await preflightContainerExtension(spec(`${root}/`));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("preflightContainerExtension - an absent directory names the path", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-preflight-" });
  await Deno.remove(root, { recursive: true });

  const message = await messageFrom(() =>
    preflightContainerExtension(spec(root))
  );
  assert(message !== "", "an absent extension directory did not throw");
  assertStringIncludes(message, root);
  assertStringIncludes(message, "does not exist");
  // The remedy: nothing is cloned for the operator.
  assertStringIncludes(message, "syncs their own extension");
});

Deno.test("preflightContainerExtension - a file where a directory was declared is refused", async () => {
  const parent = await Deno.makeTempDir({ prefix: "vibe-preflight-" });
  const path = `${parent}/extension`;
  try {
    await Deno.writeTextFile(path, "not a directory\n");
    const message = await messageFrom(() =>
      preflightContainerExtension(spec(path))
    );
    assertStringIncludes(message, path);
    assertStringIncludes(message, "is not a directory");
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("preflightContainerExtension - an absent Containerfile names it and the field", async () => {
  const root = await extensionDir();
  try {
    await Deno.remove(`${root}/Containerfile`);
    const message = await messageFrom(() =>
      preflightContainerExtension(spec(root))
    );
    assertStringIncludes(message, `${root}/Containerfile`);
    assertStringIncludes(message, "does not exist");
    assertStringIncludes(message, "container_extension.containerfile");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("preflightContainerExtension - a declared Containerfile that is a directory is refused", async () => {
  const root = await extensionDir();
  try {
    await Deno.remove(`${root}/Containerfile`);
    await Deno.mkdir(`${root}/Containerfile`);
    const message = await messageFrom(() =>
      preflightContainerExtension(spec(root))
    );
    assertStringIncludes(message, `${root}/Containerfile`);
    assertStringIncludes(message, "is not a file");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("preflightContainerExtension - a non-default Containerfile is the one checked", async () => {
  const root = await extensionDir();
  try {
    // The declared file is absent while the default one is present: a
    // preflight checking the default would pass this and let the build fail.
    const message = await messageFrom(() =>
      preflightContainerExtension(
        spec(root, { containerfile: "build/Containerfile.dev" }),
      )
    );
    assertStringIncludes(message, `${root}/build/Containerfile.dev`);
    assertStringIncludes(message, "does not exist");

    await write(root, "build/Containerfile.dev", "ARG VIBE_BASE_IMAGE\n");
    await preflightContainerExtension(
      spec(root, { containerfile: "build/Containerfile.dev" }),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("preflightContainerExtension - an absent start script names it and the field", async () => {
  const root = await extensionDir();
  try {
    await Deno.remove(`${root}/start.sh`);
    const message = await messageFrom(() =>
      preflightContainerExtension(spec(root, { start: "start.sh" }))
    );
    assertStringIncludes(message, `${root}/start.sh`);
    assertStringIncludes(message, "does not exist");
    assertStringIncludes(message, "container_extension.start");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("preflightContainerExtension - an undeclared start script is not demanded", async () => {
  const root = await extensionDir();
  try {
    await Deno.remove(`${root}/start.sh`);
    // A toolchain-only extension has no service to start.
    await preflightContainerExtension(spec(root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("preflightContainerExtension - a symlink escaping the directory is refused with advice", async () => {
  const root = await extensionDir();
  const outside = await Deno.makeTempDir({ prefix: "vibe-outside-" });
  try {
    await Deno.writeTextFile(`${outside}/secret.env`, "TOKEN=hunter2\n");
    await Deno.symlink(`${outside}/secret.env`, `${root}/secret.env`);

    const message = await messageFrom(() =>
      preflightContainerExtension(spec(root))
    );
    assert(message !== "", "an escaping symlink did not throw");
    assertStringIncludes(message, "secret.env");
    assertStringIncludes(message, "escapes the extension directory");
    // The advice the operator acts on, attached to the fault itself.
    assertStringIncludes(message, "Copy what the build needs");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("preflightContainerExtension - a nested symlink escaping the directory is refused", async () => {
  const root = await extensionDir();
  const outside = await Deno.makeTempDir({ prefix: "vibe-outside-" });
  try {
    await Deno.symlink(outside, `${root}/seed/host`);
    const message = await messageFrom(() =>
      preflightContainerExtension(spec(root))
    );
    assertStringIncludes(message, "seed/host");
    assertStringIncludes(message, "escapes the extension directory");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("preflightContainerExtension - a symlink inside the directory is allowed", async () => {
  const root = await extensionDir();
  try {
    await Deno.symlink(`${root}/seed/schema.sql`, `${root}/schema-link.sql`);
    await Deno.symlink(`${root}/seed`, `${root}/latest`);
    await preflightContainerExtension(spec(root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("preflightContainerExtension - a dangling symlink is refused rather than skipped", async () => {
  const root = await extensionDir();
  try {
    await Deno.symlink(`${root}/gone.sql`, `${root}/link.sql`);
    const message = await messageFrom(() =>
      preflightContainerExtension(spec(root))
    );
    assertStringIncludes(message, "link.sql");
    assertStringIncludes(message, "cannot be resolved");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("preflightContainerExtension - a symlink loop is refused rather than walked forever", async () => {
  const root = await extensionDir();
  try {
    await Deno.symlink(`${root}/seed`, `${root}/seed/self`);
    const message = await messageFrom(() =>
      preflightContainerExtension(spec(root))
    );
    assertStringIncludes(message, "seed/self");
    assertStringIncludes(message, "loops");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("preflightContainerExtension - every refusal opens with one greppable phrase", async () => {
  const root = await extensionDir();
  const absent = `${root}/nowhere`;
  try {
    const messages = [
      await messageFrom(() => preflightContainerExtension(spec(absent))),
      await messageFrom(() =>
        preflightContainerExtension(spec(root, { containerfile: "gone" }))
      ),
      await messageFrom(() =>
        preflightContainerExtension(spec(root, { start: "gone.sh" }))
      ),
    ];
    for (const message of messages) {
      assertEquals(
        message.startsWith("Cannot launch: the container_extension"),
        true,
        `a refusal did not open with the shared phrase: ${message}`,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
